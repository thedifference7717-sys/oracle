"""BTC staged-alert checker.

Run once per invocation (designed for a ~5-minute cron). It:

  1. Pulls 4h and 15m OHLC.
  2. STEP 1 - finds the most recent 4h swing leg and its 50% Fib zone. When
     price tags that zone it "arms" the setup and sends a Step 1 alert.
  3. STEP 2 - while armed, watches 15m for a market-structure shift plus N
     consecutive candles in the trade direction, then sends a Step 2 alert.

State (stored in a jsonblob) guarantees each alert fires once per setup. A new
swing leg resets everything; a fully-retraced (invalidated) leg disarms.

This is an alerting aid, not financial advice. Always confirm on your chart.
"""
from datetime import datetime, timezone

import config
import data
import indicators
import notify
import state


def _money(x):
    return f"${x:,.1f}" if x is not None else "n/a"


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _arrow(direction):
    return "🟢 LONG" if direction == "long" else "🔴 SHORT"


def step1_message(s1):
    trend = "up-leg (uptrend)" if s1["direction"] == "long" else "down-leg (downtrend)"
    pull = "down into" if s1["direction"] == "long" else "up into"
    return (
        f"⚡️ <b>BTC — Step 1 armed</b>  {_arrow(s1['direction'])}\n"
        f"Price pulled back {pull} the 50% Fib of the latest 4h {trend}.\n\n"
        f"Swing high: {_money(s1['swing_high'])}\n"
        f"Swing low:  {_money(s1['swing_low'])}\n"
        f"50% Fib:    {_money(s1['fib50'])}  "
        f"(zone {_money(s1['zone_low'])}–{_money(s1['zone_high'])})\n"
        f"Price:      {_money(s1['price'])}\n\n"
        f"Now watching 15m for a structure shift + "
        f"{config.CONSECUTIVE_CANDLES} candles. ({_now_iso()})"
    )


def _smc_lines(smc, direction):
    """Render the SMC context (CHoCH/BOS, order block, FVG, liquidity) for the alert."""
    if not smc:
        return ""
    lines = []
    ev = smc.get("last_event")
    if ev:
        arrow = "↑" if ev["dir"] == "bull" else "↓"
        lines.append(f"Structure: <b>{ev['type']}</b> {arrow} @ {_money(ev['level'])}")
    ob = smc.get("order_block")
    if ob:
        kind = "demand" if ob["dir"] == "bull" else "supply"
        lines.append(f"Order block ({kind}): {_money(ob['lo'])}–{_money(ob['hi'])}")
    fvg = smc.get("fvg")
    if fvg:
        lines.append(f"FVG ({fvg['dir']}, unfilled): {_money(fvg['lo'])}–{_money(fvg['hi'])}")
    if smc.get("sweep"):
        sw = smc["sweep"]
        lines.append(f"Liquidity sweep {sw['dir']} @ {_money(sw['level'])}")
    return ("\n" + "\n".join(lines)) if lines else ""


def step2_message(s1, s2, smc=None):
    if s1["direction"] == "long":
        shift = f"15m close {_money(s2['last_close'])} broke <b>above</b> swing high {_money(s2['mss_level'])}"
        candles = f"{config.CONSECUTIVE_CANDLES} consecutive green 15m candles"
    else:
        shift = f"15m close {_money(s2['last_close'])} broke <b>below</b> swing low {_money(s2['mss_level'])}"
        candles = f"{config.CONSECUTIVE_CANDLES} consecutive red 15m candles"
    entry = s2["last_close"]
    stop = s1["stop_886"]
    risk_per_coin = abs(entry - stop)
    side = "below" if s1["direction"] == "long" else "above"
    # Label the shift with the SMC structure type (CHoCH/BOS) when available.
    shift_type = smc["last_event"]["type"] if smc and smc.get("last_event") else "MSS"
    return (
        f"🚨 <b>BTC — Step 2 CONFIRMED</b>  {_arrow(s1['direction'])}\n"
        f"Full setup complete at the 4h 50% Fib ({_money(s1['fib50'])}).\n\n"
        f"✅ {shift_type}: {shift}\n"
        f"✅ {candles}\n"
        f"Entry (3rd candle close): {_money(entry)}\n"
        f"Stop — 0.886 level: {_money(stop)} ({side} entry)\n"
        f"Risk/coin: {_money(risk_per_coin)} → size 2% of account ÷ that."
        f"{_smc_lines(smc, s1['direction'])}\n\n"
        f"Manage risk per your prop-firm rules. ({_now_iso()})"
    )


def run():
    c4h_closed, c4h_forming = data.get_candles("4h", config.KRAKEN_PAIR, config.BINANCE_SYMBOL)
    s1 = indicators.compute_step1(
        c4h_closed, c4h_forming, config.PIVOT_STRENGTH_4H, config.FIB_ZONE_BAND)

    st = state.load_state(config.STATE_BLOB_URL)

    if s1 is None:
        print("No clean 4h swing leg yet; nothing to do.")
        state.save_state(config.STATE_BLOB_URL, st)
        return

    print(f"Step1 {s1['direction']} leg {s1['leg_id']} fib50={_money(s1['fib50'])} "
          f"price={_money(s1['price'])} in_zone={s1['in_zone']} invalid={s1['invalidated']}")

    # New swing leg -> fresh setup. Reset all bookkeeping.
    if st.get("leg_id") != s1["leg_id"]:
        st = {"leg_id": s1["leg_id"], "direction": s1["direction"],
              "armed": False, "step1_sent": False, "step2_sent": False}

    # Invalidated leg -> disarm and wait for the next one.
    if s1["invalidated"]:
        st["armed"] = False
        print("Leg invalidated (price beyond originating extreme); disarmed.")
        state.save_state(config.STATE_BLOB_URL, st)
        return

    # STEP 1: price tagged the 50% zone.
    if s1["in_zone"] and not st.get("step1_sent"):
        if notify.send(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID, step1_message(s1)):
            print("Sent Step 1 alert.")
        st["step1_sent"] = True
        st["armed"] = True
        st["armed_at"] = _now_iso()

    # STEP 2: armed and waiting on the 15m confirmation.
    if st.get("armed") and not st.get("step2_sent"):
        c15_closed, _ = data.get_candles("15m", config.KRAKEN_PAIR, config.BINANCE_SYMBOL)
        s2 = indicators.compute_step2(
            c15_closed, s1["direction"], config.PIVOT_STRENGTH_15M, config.CONSECUTIVE_CANDLES)
        smc = indicators.compute_smc(c15_closed, config.PIVOT_STRENGTH_15M)
        print(f"Step2 mss={s2['mss']} (level={_money(s2['mss_level'])}) "
              f"consecutive={s2['consecutive']} confirmed={s2['confirmed']} "
              f"smc={smc['last_event'] if smc else None}")
        if s2["confirmed"]:
            if notify.send(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID, step2_message(s1, s2, smc)):
                print("Sent Step 2 alert.")
            st["step2_sent"] = True
            st["armed"] = False  # require a fresh tag of the zone to re-arm

    state.save_state(config.STATE_BLOB_URL, st)


if __name__ == "__main__":
    run()
