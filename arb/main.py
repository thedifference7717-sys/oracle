"""Entry point: scan, size, (paper-)execute, record, alert.

Usage:
    python arb/main.py              # one scan, paper mode
    python arb/main.py --probe      # connectivity + auth check, no trading
    python arb/main.py --summary    # print ledger stats
    python arb/main.py --plan 500   # capital plan for a $500 deposit
"""
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config           # noqa: E402
import ledger           # noqa: E402
import notify           # noqa: E402
import scan             # noqa: E402
import sizing           # noqa: E402
import state            # noqa: E402
from execute import KalshiExecutor, execute_opportunity  # noqa: E402
from venues.kalshi import KalshiClient      # noqa: E402
from venues.polymarket import PolymarketClient  # noqa: E402


def run_scan(cfg):
    """Collect opportunities across every enabled venue."""
    opportunities, errors = [], []
    kalshi = KalshiClient(cfg) if (cfg.scan_kalshi or cfg.cross_venue) else None
    poly = PolymarketClient(cfg) if (cfg.scan_polymarket or cfg.cross_venue) else None

    if cfg.scan_kalshi and kalshi:
        try:
            found, errs = scan.scan_kalshi(kalshi, cfg)
            opportunities += found
            errors += errs
        except Exception as e:  # noqa: BLE001 - one venue down must not end the run
            errors.append(f"kalshi scan failed: {e}")

    if cfg.scan_polymarket and poly:
        try:
            found, errs = scan.scan_polymarket(poly, cfg)
            opportunities += found
            errors += errs
        except Exception as e:  # noqa: BLE001
            errors.append(f"polymarket scan failed: {e}")

    if cfg.cross_venue and kalshi and poly:
        try:
            found, errs = scan.scan_cross_venue(kalshi, poly, cfg)
            opportunities += found
            errors += errs
        except Exception as e:  # noqa: BLE001
            errors.append(f"cross-venue scan failed: {e}")

    return opportunities, errors


def main():
    cfg = config.load()
    args = sys.argv[1:]

    if "--summary" in args:
        stats = ledger.summarise(cfg.ledger_path)
        for k, v in stats.items():
            print(f"{k:26} {v}")
        return 0

    if "--plan" in args:
        idx = args.index("--plan")
        usd = float(args[idx + 1]) if len(args) > idx + 1 else 500.0
        return _print_plan(usd, cfg)

    if "--probe" in args:
        return _probe(cfg)

    scan_id = uuid.uuid4().hex[:12]
    live = config.can_trade_live(cfg)
    mode = "LIVE" if live else "PAPER"
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime())}] "
          f"scan {scan_id} mode={mode}")

    opportunities, errors = run_scan(cfg)
    for err in errors:
        print(f"  [warn] {err}")

    st = state.prune(state.load_state(cfg.state_blob_url))
    deployed_c = int(st.get("deployed_c", 0))
    accepted, skipped = sizing.allocate(opportunities, cfg, deployed_c)

    print(f"  found={len(opportunities)} fundable={len(accepted)} "
          f"skipped={len(skipped)} deployed=${deployed_c/100:.2f}")
    for opp, reason in skipped:
        print(f"  [skip] {opp.title[:60]} :: {reason}")

    executor = KalshiExecutor(cfg) if live else None
    messages = []
    for opp in accepted:
        ledger.record(cfg.ledger_path, "opportunity",
                      {"scan_id": scan_id, **ledger.opportunity_row(opp)})

        # Kalshi is the only venue this wires up for order placement; a
        # Polymarket leg needs on-chain signing, so those stay alert-only
        # rather than half-executing a basket that cannot be completed.
        can_execute = all(l.quote.venue == "kalshi" for l in opp.legs)
        dry = (not live) or (not can_execute)

        result = execute_opportunity(opp, executor, dry_run=dry)
        result.update(scan_id=scan_id, cost_c=opp.cost_c, profit_c=opp.profit_c)
        ledger.record(cfg.ledger_path, "execution", result)

        if result["status"] in ("filled", "partial"):
            deployed_c += opp.cost_c
        print(f"  [{result['status']}] {opp.title[:60]} "
              f"${opp.profit_c/100:.2f} on ${opp.cost_c/100:.2f}")
        for err in result["errors"]:
            print(f"      ! {err}")

        if not state.seen_recently(st, opp.key):
            state.mark_seen(st, opp.key)
            messages.append(notify.format_opportunity(
                opp, executed=result["status"] == "filled"))

    # Unverified cross-venue candidates never trade, but they are the reason to
    # maintain the pairs file, so they still get surfaced.
    for opp, reason in skipped:
        if not opp.verified_pair and not state.seen_recently(st, opp.key):
            state.mark_seen(st, opp.key)
            messages.append(notify.format_opportunity(opp))

    if messages:
        notify.send(cfg.telegram_token, cfg.telegram_chat_id,
                    "\n\n———\n\n".join(messages[:5]))

    st["deployed_c"] = deployed_c
    state.save_state(cfg.state_blob_url, st)
    return 0


def _probe(cfg):
    """Connectivity and credential check -- never places an order."""
    ok = True
    try:
        events = KalshiClient(cfg).events(limit=5)
        me = sum(1 for e in events if e.get("mutually_exclusive"))
        print(f"kalshi        OK  {len(events)} events ({me} mutually exclusive)")
    except Exception as e:  # noqa: BLE001
        ok = False
        print(f"kalshi        FAIL  {e}")
    try:
        events = PolymarketClient(cfg).events(limit=5)
        nr = sum(1 for e in events if e.get("negRisk"))
        print(f"polymarket    OK  {len(events)} events ({nr} neg-risk)")
    except Exception as e:  # noqa: BLE001
        ok = False
        print(f"polymarket    FAIL  {e}")
    if config.can_trade_live(cfg):
        try:
            print(f"kalshi auth   OK  balance "
                  f"${KalshiExecutor(cfg).balance_c()/100:.2f}")
        except Exception as e:  # noqa: BLE001
            ok = False
            print(f"kalshi auth   FAIL  {e}")
    else:
        print("kalshi auth   SKIP  paper mode (set ARB_DRY_RUN=false ARB_LIVE=1)")
    return 0 if ok else 1


def _print_plan(usd, cfg):
    """Translate a deposit into what it can actually do.

    The binding constraint is not the size of the bankroll but how long each
    basket locks it up: capital is returned at settlement, not at fill.
    """
    stats = ledger.summarise(cfg.ledger_path)
    bankroll_c = int(usd * 100)
    per_opp_c = min(cfg.max_stake_per_opp_c, bankroll_c // 4)
    print(f"deposit                    ${usd:,.2f}")
    print(f"max stake per opportunity  ${per_opp_c/100:,.2f} "
          f"(keeps >=4 concurrent baskets)")
    print(f"max simultaneously locked  ${min(cfg.max_deployed_c, bankroll_c)/100:,.2f}")
    print(f"per-leg contract ceiling   {cfg.max_contracts}")
    print(f"min edge accepted          {cfg.min_profit_c}c and {cfg.min_roi:.2%} ROI")
    print()
    print("Observed so far (from the ledger -- run in paper mode to fill this in):")
    print(f"  opportunities found      {stats['opportunities_found']}")
    print(f"  capital deployed         ${stats['capital_deployed_usd']:,.2f}")
    print(f"  profit                   ${stats['profit_usd']:,.2f}")
    print(f"  return on deployed       {stats['return_on_deployed']:.2%}")
    print(f"  no-fill / partial        {stats['no_fill']} / {stats['partial']}")
    print(f"  unhedged incidents       {stats['unhedged_incidents']}")
    print()
    print("Capital is locked until each market RESOLVES, not until it fills.")
    print("Size the deposit off observed opportunity rate and hold time, not off")
    print("the per-trade ROI -- a 4% edge that ties up cash for six months is")
    print("worse than a savings account.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
