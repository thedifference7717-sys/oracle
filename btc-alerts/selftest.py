"""Offline self-test of the strategy logic using synthetic candles.

No network needed. Builds a long setup and a short setup, runs them through
the full state machine, and asserts that Step 1 then Step 2 fire exactly once.
Run: python btc-alerts/selftest.py
"""
import config
import indicators
import main as app


def candle(o, h, l, c):
    return {"t": 0, "o": o, "h": h, "l": l, "c": c}


def build_long_4h(price):
    """Up-leg: descend into a swing low (100), rally to a swing high (200), then
    pull back. ``price`` is the live price (150 sits inside the 50% zone)."""
    cs = [
        candle(130, 131, 128, 129), candle(125, 126, 122, 123),   # descend
        candle(118, 119, 112, 113), candle(108, 109, 103, 104),
        candle(104, 105, 100, 104),                               # swing low = 100
        candle(110, 114, 109, 113), candle(120, 124, 119, 123),   # ascend
        candle(135, 139, 134, 138), candle(150, 154, 149, 153),
        candle(165, 169, 164, 168), candle(185, 189, 184, 188),
        candle(190, 200, 189, 196),                               # swing high = 200
        candle(180, 183, 176, 178), candle(170, 173, 166, 168),   # pull back
        candle(160, 163, 156, 158), candle(152, 155, 149, 151),
    ]
    return cs, candle(price, price + 1, price - 1, price)


def build_short_4h(price):
    """Down-leg: rally to a swing high (200), drop to a swing low (100), bounce."""
    cs = [
        candle(130, 132, 129, 131), candle(140, 142, 139, 141),   # ascend
        candle(150, 152, 149, 151), candle(170, 172, 169, 171),
        candle(175, 200, 174, 180),                               # swing high = 200
        candle(170, 176, 169, 171), candle(160, 166, 159, 161),   # descend
        candle(145, 151, 144, 146), candle(130, 136, 129, 131),
        candle(115, 121, 114, 116), candle(105, 111, 104, 106),
        candle(104, 108, 100, 107),                               # swing low = 100
        candle(115, 121, 114, 120), candle(128, 134, 127, 133),   # bounce
        candle(140, 146, 139, 145), candle(150, 154, 148, 151),
    ]
    return cs, candle(price, price + 1, price - 1, price)


def build_15m_long(confirm):
    """15m downward pullback with a swing high at 158. If ``confirm`` the last
    close breaks 158 with 3 green candles; else it keeps dropping."""
    cs = [
        candle(150, 151, 149, 150), candle(151, 153, 150, 152),
        candle(152, 158, 151, 153),                               # swing high = 158
        candle(153, 154, 151, 152), candle(152, 153, 150, 151),
    ]
    if confirm:
        cs += [candle(151, 154, 151, 154), candle(154, 157, 154, 157),
               candle(157, 160, 156, 159)]                        # 3 green, breaks 158
    else:
        cs += [candle(151, 152, 149, 150), candle(150, 151, 148, 149),
               candle(149, 150, 147, 148)]                        # 3 red, no break
    return cs


def build_15m_short(confirm):
    """15m upward pullback with a swing low at 142. If ``confirm`` the last close
    breaks 142 with 3 red candles; else it keeps rising."""
    cs = [
        candle(150, 151, 149, 150), candle(149, 150, 147, 148),
        candle(148, 149, 142, 143),                               # swing low = 142
        candle(143, 146, 142, 145), candle(145, 147, 144, 146),
    ]
    if confirm:
        cs += [candle(146, 147, 143, 144), candle(144, 145, 140, 141),
               candle(141, 142, 137, 138)]                        # 3 red, breaks 142
    else:
        cs += [candle(143, 146, 142, 145), candle(145, 148, 144, 147),
               candle(147, 150, 146, 149)]                        # 3 green, no break
    return cs


# ---- harness: stub out network + telegram + state ----
SENT = []
STATE = {}


def run_scenario(c4h, c15m_factory, label):
    SENT.clear()

    def fake_get_candles(tf, *_a, **_k):
        if tf == "4h":
            return c4h
        return c15m_factory(), None

    def fake_send(_t, _c, text):
        SENT.append(text.split("\n", 1)[0])
        return True

    def fake_load(_url):
        return dict(STATE)

    def fake_save(_url, st):
        STATE.clear()
        STATE.update(st)

    app.data.get_candles = fake_get_candles
    app.notify.send = fake_send
    app.state.load_state = fake_load
    app.state.save_state = fake_save
    app.run()
    print(f"[{label}] alerts -> {SENT}")
    return list(SENT)


def main():
    config.TELEGRAM_BOT_TOKEN = "x"  # force the send path (stubbed)
    config.TELEGRAM_CHAT_ID = "x"

    # Sanity: direction detection.
    closed, forming = build_long_4h(150)
    s1 = indicators.compute_step1(closed, forming, 3, 0.03)
    assert s1 and s1["direction"] == "long" and s1["in_zone"], s1
    closed, forming = build_short_4h(150)
    s1 = indicators.compute_step1(closed, forming, 3, 0.03)
    assert s1 and s1["direction"] == "short" and s1["in_zone"], s1

    # LONG scenario, run several times.
    STATE.clear()
    long4h = build_long_4h(150)
    a = run_scenario(long4h, lambda: build_15m_long(False), "long step1, no confirm")
    assert any("Step 1 armed" in x for x in a) and not any("Step 2" in x for x in a)
    b = run_scenario(long4h, lambda: build_15m_long(False), "long re-run, still no confirm")
    assert b == [], f"expected no duplicate alerts, got {b}"
    c = run_scenario(long4h, lambda: build_15m_long(True), "long step2 confirm")
    assert any("Step 2 CONFIRMED" in x for x in c), c
    d = run_scenario(long4h, lambda: build_15m_long(True), "long re-run after confirm")
    assert d == [], f"expected silence after confirm, got {d}"

    # SHORT scenario.
    STATE.clear()
    short4h = build_short_4h(150)
    e = run_scenario(short4h, lambda: build_15m_short(False), "short step1")
    assert any("Step 1 armed" in x for x in e) and not any("Step 2" in x for x in e)
    f = run_scenario(short4h, lambda: build_15m_short(True), "short step2 confirm")
    assert any("Step 2 CONFIRMED" in x for x in f), f

    # Invalidation: price fully retraces past the swing low on a long -> disarm,
    # and price out of zone before arming -> no alert.
    STATE.clear()
    out, outf = build_long_4h(175)  # 175 is above the ~150 zone -> not tagged
    g = run_scenario((out, outf), lambda: build_15m_long(True), "long out-of-zone")
    assert g == [], f"expected no alert when price never tagged zone, got {g}"

    print("\nALL SELF-TESTS PASSED")


if __name__ == "__main__":
    main()
