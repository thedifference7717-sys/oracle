"""Offline self-test of the arbitrage logic against synthetic books.

No network needed. Every assertion here encodes a way this system could quietly
lose money -- inverted book semantics, best-ask sizing, fees ignored, a basket
missing an outcome, a half-filled multi-leg position left unhedged. Run:

    python arb/selftest.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config          # noqa: E402
import detect          # noqa: E402
import fees            # noqa: E402
import ledger          # noqa: E402
import scan            # noqa: E402
import sizing          # noqa: E402
from execute import execute_opportunity  # noqa: E402
from models import Level, Quote          # noqa: E402
from venues import kalshi, polymarket    # noqa: E402


def cfg(**over):
    c = config.load()
    c.bankroll_c = 100_000
    c.max_stake_per_opp_c = 100_000
    c.max_deployed_c = 100_000
    c.max_contracts = 500
    c.min_profit_c = 1
    c.min_roi = 0.0
    c.safety_margin_c = 0
    c.poly_taker_bps = 0.0
    c.poly_fixed_cost_c = 0
    for k, v in over.items():
        setattr(c, k, v)
    return c


def q(label, levels, venue="kalshi", side="yes"):
    return Quote(venue, label, side, label, [Level(p, s) for p, s in levels])


# --- 1. Fees --------------------------------------------------------------
def test_fees():
    # Kalshi's published curve, peaking at 50c and vanishing at the extremes.
    assert fees.kalshi_fee_c(100, 50) == 175, fees.kalshi_fee_c(100, 50)
    assert fees.kalshi_fee_c(100, 20) == 112, fees.kalshi_fee_c(100, 20)
    assert fees.kalshi_fee_c(1, 50) == 2
    assert fees.kalshi_fee_c(0, 50) == 0
    # A sweep is priced level by level, so it must land strictly between
    # pricing the whole order at the cheap level and at the dear one.
    walked = fees.kalshi_fee_walked([Level(20, 50), Level(50, 50)], 100)
    assert walked == 144, walked
    assert fees.kalshi_fee_c(100, 20) < walked < fees.kalshi_fee_c(100, 50)
    # Polymarket defaults to free but the knob must actually bite when set.
    assert polymarket_zero() == 0
    assert fees.polymarket_fee_c(100, 50, taker_bps=100) == 50
    print("  fees                          OK")


def polymarket_zero():
    return fees.polymarket_fee_c(100, 50, taker_bps=0.0)


# --- 2. Book semantics ----------------------------------------------------
def test_kalshi_book_mirroring():
    """Kalshi returns BIDS on both sides; asks are the mirrored opposite side.

    Reading book["yes"] as a YES ask ladder inverts the market and invents
    arbitrage, so this is asserted directly.
    """
    yes, no = kalshi.parse_orderbook(
        {"yes": [[35, 200], [34, 500]], "no": [[62, 100], [61, 300]]}, "T")
    assert [(l.price_c, l.size) for l in yes.asks] == [(38, 100), (39, 300)]
    assert [(l.price_c, l.size) for l in no.asks] == [(65, 200), (66, 500)]
    # A well-formed book must NOT look like an arb: best asks sum above 100.
    assert yes.best_ask_c + no.best_ask_c > 100
    # Malformed levels are dropped, not priced.
    junk, _ = kalshi.parse_orderbook(
        {"no": [[62, 100], None, ["x", "y"], [0, 5], [100, 5]]}, "T")
    assert [(l.price_c, l.size) for l in junk.asks] == [(38, 100)]
    print("  kalshi book mirroring         OK")


def test_polymarket_rounding():
    """Prices round up and sizes round down: both directions against us."""
    book = {"asks": [{"price": "0.534", "size": "120.7"},
                     {"price": "0.52", "size": "40"},
                     {"price": "0.51", "size": "0.4"}]}
    p = polymarket.parse_book(book, "tok", "yes")
    assert [(l.price_c, l.size) for l in p.asks] == [(52, 40), (54, 120)], p.asks
    assert polymarket.market_tokens(
        {"clobTokenIds": '["111","222"]', "outcomes": '["No","Yes"]'}) == ("222", "111")
    assert polymarket.market_tokens({"clobTokenIds": "[]"}) == (None, None)
    print("  polymarket parsing            OK")


# --- 3. Detection ---------------------------------------------------------
def test_dutch_book_found():
    c = cfg()
    qs = [q("A", [(28, 50), (30, 100)]), q("B", [(29, 50), (31, 100)]),
          q("C", [(31, 50), (33, 100)])]
    opp = detect.find_dutch_book(qs, "k", "3-way", c)
    assert opp and opp.profit_c > 0
    assert opp.payout_c == 100 * opp.contracts
    assert opp.cost_c == sum(l.total_c for l in opp.legs)
    # Fees are actually charged on every leg, not assumed away.
    assert all(l.fee_c > 0 for l in opp.legs)
    print(f"  dutch book detected           OK "
          f"({opp.contracts}x, +${opp.profit_c/100:.2f}, {opp.roi:.2%})")


def test_fees_kill_thin_edge():
    """A gross edge smaller than the fee load must be rejected.

    The threshold is not obvious. Kalshi applies its ceiling per *order*, not
    per contract, so per-contract fees fall as size grows: near 32c the three
    legs cost about 4.6c/contract combined once amortised. A 4c gross edge is
    therefore not an edge at all, while a 6c one survives -- which is exactly
    why fees are modelled rather than approximated with a flat haircut.
    """
    c = cfg()
    thin = [q("A", [(31, 100)]), q("B", [(32, 100)]), q("C", [(33, 100)])]
    assert 100 - (31 + 32 + 33) == 4
    assert detect.find_dutch_book(thin, "k", "thin", c) is None

    fat = [q("A", [(30, 100)]), q("B", [(31, 100)]), q("C", [(33, 100)])]
    assert 100 - (30 + 31 + 33) == 6
    survives = detect.find_dutch_book(fat, "k", "fat", c)
    assert survives and survives.profit_c > 0
    print("  fee-eaten edge rejected       OK (4c no, 6c yes)")


def test_depth_awareness():
    """Sizing must stop at the cheap level, not sweep into expensive depth."""
    c = cfg()
    qs = [q("A", [(20, 3), (48, 500)]), q("B", [(21, 3), (48, 500)]),
          q("C", [(22, 3), (48, 500)])]
    opp = detect.find_dutch_book(qs, "k", "thin-top", c)
    assert opp and opp.contracts == 3, opp.contracts if opp else None
    # Priced off best-ask alone this would claim 500 contracts and lose on 497.
    assert opp.cost_c < 100 * opp.contracts
    print("  depth-aware sizing            OK")


def test_non_exhaustive_rejected():
    """A basket missing an outcome is not a dutch book -- the gap can win."""
    markets = [{"ticker": "A"}, {"ticker": "B"}, {"ticker": "C"}]
    assert detect.is_exhaustive(markets, [1, 2, 3])
    assert not detect.is_exhaustive(markets, [1, 2])
    assert not detect.is_exhaustive([{"ticker": "A"}], [1])
    print("  exhaustiveness enforced       OK")


def test_empty_leg_rejected():
    c = cfg()
    qs = [q("A", [(20, 50)]), q("B", [])]
    assert detect.find_dutch_book(qs, "k", "empty", c) is None
    print("  unquotable leg rejected       OK")


def test_safety_margin_bites():
    c = cfg(safety_margin_c=0)
    qs = [q("A", [(40, 100)]), q("B", [(50, 100)])]
    base = detect.find_dutch_book(qs, "k", "m", c)
    assert base, "expected an edge before the margin is applied"
    tight = detect.find_dutch_book(qs, "k", "m", cfg(safety_margin_c=20))
    assert tight is None or tight.profit_c < base.profit_c
    print("  safety margin applied         OK")


def test_cross_venue_unverified_flagged():
    c = cfg()
    yes = q("kalshi-yes", [(40, 100)])
    no = q("poly-no", [(50, 100)], venue="polymarket", side="no")
    opp = detect.find_cross_venue(yes, no, "x", "T", c, verified=False)
    assert opp and not opp.verified_pair
    assert any("UNVERIFIED" in n for n in opp.notes)
    ok = detect.find_cross_venue(yes, no, "x", "T", c, verified=True)
    assert ok.verified_pair and not any("UNVERIFIED" in n for n in ok.notes)
    print("  cross-venue verification      OK")


# --- 4. Allocation --------------------------------------------------------
def test_allocation():
    c = cfg(max_deployed_c=5_000, max_stake_per_opp_c=100_000)
    qs = [q("A", [(28, 200)]), q("B", [(29, 200)]), q("C", [(31, 200)])]
    big = detect.find_dutch_book(qs, "big", "big", c)
    unver = detect.find_cross_venue(
        q("y", [(40, 100)]), q("n", [(50, 100)], venue="polymarket", side="no"),
        "u", "u", c, verified=False)

    accepted, skipped = sizing.allocate([big, unver], c)
    assert unver not in accepted, "unverified pairs must never auto-trade"
    assert any("unverified" in r for _, r in skipped)
    # Budget already spent leaves nothing fundable.
    none_left, blocked = sizing.allocate([big], c, already_deployed_c=5_000)
    assert none_left == [] and blocked, "must refuse to exceed the deployed cap"
    print("  allocation + budget caps      OK")


# --- 5. Execution ---------------------------------------------------------
class FakeExecutor:
    """Fills each leg with a scripted count and records unwind sells."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def place(self, leg, contracts, action="buy"):
        self.calls.append((leg.quote.market_id, action, contracts))
        if action == "sell":
            return contracts, "sell-1"
        return self.script.pop(0), f"ord-{len(self.calls)}"


def _three_leg(c):
    qs = [q("A", [(28, 200)]), q("B", [(29, 200)]), q("C", [(31, 200)])]
    opp = detect.find_dutch_book(qs, "k", "3-way", c)
    opp.contracts = 50
    for leg in opp.legs:
        leg.contracts = 50
    return opp


def test_execution_paper():
    opp = _three_leg(cfg())
    res = execute_opportunity(opp, None, dry_run=True)
    assert res["status"] == "paper" and res["filled"] == opp.contracts
    print("  paper execution               OK")


def test_execution_levels_down_on_partial():
    """The core safety property: a partial basket is forced back into balance.

    Legs fill 50/50/30, so the hedged size is 30 and the two 20-contract
    excesses must be sold back. Carrying them would be a 40-contract naked
    directional position nobody chose to take.
    """
    opp = _three_leg(cfg())
    ex = FakeExecutor([50, 50, 30])
    res = execute_opportunity(opp, ex, dry_run=False)
    assert res["status"] == "partial", res["status"]
    assert res["filled"] == 30, res["filled"]
    sells = [c for c in ex.calls if c[1] == "sell"]
    assert len(sells) == 2 and all(s[2] == 20 for s in sells), ex.calls
    assert not any("UNHEDGED" in e for e in res["errors"])
    print("  partial fill levelled down    OK")


def test_execution_unwinds_when_a_leg_dies():
    """First leg fills, second gets nothing -> everything filled is sold back."""
    opp = _three_leg(cfg())
    ex = FakeExecutor([40, 0, 0])
    res = execute_opportunity(opp, ex, dry_run=False)
    assert res["filled"] == 0
    assert res["status"] in ("no_fill", "failed")
    sells = [c for c in ex.calls if c[1] == "sell"]
    assert sum(s[2] for s in sells) == 40, ex.calls
    print("  dead leg unwound              OK")


def test_execution_flags_failed_unwind():
    """If the unwind itself cannot complete, say UNHEDGED loudly."""
    class StuckExecutor(FakeExecutor):
        def place(self, leg, contracts, action="buy"):
            if action == "sell":
                self.calls.append((leg.quote.market_id, "sell", contracts))
                return 0, "stuck"          # nothing sold back
            return super().place(leg, contracts, action)

    opp = _three_leg(cfg())
    res = execute_opportunity(opp, StuckExecutor([50, 50, 30]), dry_run=False)
    assert any("UNHEDGED" in e for e in res["errors"]), res["errors"]
    print("  failed unwind surfaced        OK")


# --- 6. Scan wiring -------------------------------------------------------
class FakeKalshi:
    venue = "kalshi"

    def __init__(self, events, books):
        self._events, self._books = events, books

    def events(self, limit=None):
        return self._events

    def quotes(self, ticker, label=""):
        return kalshi.parse_orderbook(self._books.get(ticker, {}), ticker, label)


def test_scan_end_to_end():
    """A mutually exclusive 3-way priced at 84c is found; a 1-way is not."""
    events = [
        {"event_ticker": "E1", "title": "Who wins", "mutually_exclusive": True,
         "markets": [{"ticker": "A", "status": "active", "title": "A"},
                     {"ticker": "B", "status": "active", "title": "B"},
                     {"ticker": "C", "status": "active", "title": "C"}]},
        {"event_ticker": "E2", "title": "Not exclusive", "mutually_exclusive": False,
         "markets": [{"ticker": "D", "status": "active", "title": "D"}]},
    ]
    # NO bids at 72/71/69 mirror to YES asks at 28/29/31 -> 88c basket.
    books = {"A": {"no": [[72, 200]]}, "B": {"no": [[71, 200]]},
             "C": {"no": [[69, 200]]}, "D": {"no": [[50, 200]]}}
    found, errors = scan.scan_kalshi(FakeKalshi(events, books), cfg())
    assert not errors, errors
    assert len(found) == 1, [o.title for o in found]
    assert found[0].key == "kalshi:E1" and found[0].profit_c > 0
    print(f"  kalshi scan end-to-end        OK (+${found[0].profit_c/100:.2f})")


def test_scan_skips_inactive_outcome():
    """An event with a non-active outcome is skipped, not partially priced."""
    events = [{"event_ticker": "E3", "title": "Partial", "mutually_exclusive": True,
               "markets": [{"ticker": "A", "status": "active"},
                           {"ticker": "B", "status": "active"},
                           {"ticker": "C", "status": "settled"}]}]
    books = {"A": {"no": [[72, 200]]}, "B": {"no": [[71, 200]]},
             "C": {"no": [[69, 200]]}}
    found, _ = scan.scan_kalshi(FakeKalshi(events, books), cfg())
    assert found == [], "must not price a basket that is missing an outcome"
    print("  incomplete event skipped      OK")


# --- 7. Ledger ------------------------------------------------------------
def test_ledger(tmp="arb/.selftest-ledger.jsonl"):
    if os.path.exists(tmp):
        os.remove(tmp)
    opp = _three_leg(cfg())
    ledger.record(tmp, "opportunity", {"scan_id": "s1", **ledger.opportunity_row(opp)})
    ledger.record(tmp, "execution", {"scan_id": "s1", "status": "paper",
                                     "cost_c": opp.cost_c, "profit_c": opp.profit_c,
                                     "errors": []})
    stats = ledger.summarise(tmp)
    assert stats["opportunities_found"] == 1 and stats["booked"] == 1
    assert stats["profit_usd"] == round(opp.profit_c / 100.0, 2)
    os.remove(tmp)
    print("  ledger round-trip             OK")


def main():
    print("arb self-test")
    for fn in (test_fees, test_kalshi_book_mirroring, test_polymarket_rounding,
               test_dutch_book_found, test_fees_kill_thin_edge,
               test_depth_awareness, test_non_exhaustive_rejected,
               test_empty_leg_rejected, test_safety_margin_bites,
               test_cross_venue_unverified_flagged, test_allocation,
               test_execution_paper, test_execution_levels_down_on_partial,
               test_execution_unwinds_when_a_leg_dies,
               test_execution_flags_failed_unwind,
               test_scan_end_to_end, test_scan_skips_inactive_outcome,
               test_ledger):
        fn()
    print("\nALL SELF-TESTS PASSED")


if __name__ == "__main__":
    main()
