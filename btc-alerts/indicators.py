"""Strategy primitives: swing pivots, the 4h 50% Fib step, and the 15m step."""


def find_pivots(candles, strength):
    """Return (swing_high_indices, swing_low_indices).

    A swing high at index ``i`` is strictly higher than the ``strength`` candles
    to its left and at least as high as the ``strength`` candles to its right
    (mirror for lows). Requiring ``strength`` candles on the right means only
    *confirmed* pivots are returned, so they don't shift as new candles form.
    """
    highs, lows = [], []
    n = len(candles)
    for i in range(strength, n - strength):
        h, l = candles[i]["h"], candles[i]["l"]
        left = range(i - strength, i)
        right = range(i + 1, i + strength + 1)
        if all(h > candles[j]["h"] for j in left) and all(h >= candles[j]["h"] for j in right):
            highs.append(i)
        if all(l < candles[j]["l"] for j in left) and all(l <= candles[j]["l"] for j in right):
            lows.append(i)
    return highs, lows


def compute_step1(closed, forming, strength, band):
    """Evaluate the 4h 50% retracement of the most recent confirmed swing leg.

    Returns None when no clean leg can be identified, else a dict describing
    the leg, the 50% zone, and whether price is currently tagging it.
    """
    highs, lows = find_pivots(closed, strength)
    if not highs or not lows:
        return None

    last_high_i, last_low_i = highs[-1], lows[-1]
    swing_high = closed[last_high_i]["h"]
    swing_low = closed[last_low_i]["l"]
    if swing_high <= swing_low:
        return None

    # Most recent pivot defines the leg direction and therefore the trade side.
    # Newest pivot a high  -> up-leg (low->high), uptrend, pullback DOWN -> long.
    # Newest pivot a low   -> down-leg (high->low), downtrend, pullback UP -> short.
    direction = "long" if last_high_i > last_low_i else "short"

    leg_range = swing_high - swing_low
    fib50 = (swing_high + swing_low) / 2.0
    half = band * leg_range
    zone_low, zone_high = fib50 - half, fib50 + half

    # 0.886 retracement = the stop. It sits on the LOSS side of the entry:
    #   long  -> swing_high - 0.886*range  (below the 50% entry)
    #   short -> swing_low  + 0.886*range  (above the 50% entry)
    stop_886 = swing_high - 0.886 * leg_range if direction == "long" \
        else swing_low + 0.886 * leg_range

    price = forming["c"]
    # Did the live candle trade into the zone (touched), or is price sitting in it?
    touched = forming["l"] <= zone_high and forming["h"] >= zone_low
    in_zone = (zone_low <= price <= zone_high) or touched

    # Leg invalidated once price fully retraces past the originating extreme.
    invalidated = (direction == "long" and price < swing_low) or \
                  (direction == "short" and price > swing_high)

    return {
        "direction": direction,
        "swing_high": swing_high,
        "swing_low": swing_low,
        "fib50": fib50,
        "stop_886": stop_886,
        "zone_low": zone_low,
        "zone_high": zone_high,
        "price": price,
        "in_zone": in_zone,
        "invalidated": invalidated,
        # Confirmed pivots are stable, so this id is stable for a given leg.
        "leg_id": f"{direction}:{round(swing_high)}:{round(swing_low)}",
    }


def compute_step2(closed, direction, strength, n_consecutive):
    """Evaluate the 15m market-structure shift + N consecutive confirming candles.

    For a long: a bullish MSS (latest close breaks the most recent 15m swing
    high) plus N consecutive green candles. Mirror logic for a short.
    """
    highs, lows = find_pivots(closed, strength)
    last = closed[-1]
    recent = closed[-n_consecutive:]

    if direction == "long":
        consecutive = all(c["c"] > c["o"] for c in recent)
        mss_level = closed[highs[-1]]["h"] if highs else None
        mss = mss_level is not None and last["c"] > mss_level
    else:
        consecutive = all(c["c"] < c["o"] for c in recent)
        mss_level = closed[lows[-1]]["l"] if lows else None
        mss = mss_level is not None and last["c"] < mss_level

    return {
        "mss": mss,
        "mss_level": mss_level,
        "consecutive": consecutive,
        "confirmed": mss and consecutive,
        "last_close": last["c"],
        "candles": recent,
    }


def compute_smc(closed, strength):
    """Smart Money Concepts on a candle series (open-source SMC logic, not LuxAlgo's).

    Returns the internal trend, the latest structure event (CHoCH vs BOS), the
    most recent order block, the nearest unfilled fair-value gap, equal
    highs/lows, and any recent liquidity sweep. Returns None if too few candles.
    """
    n = len(closed)
    if n < strength * 2 + 3:
        return None
    highs, lows = find_pivots(closed, strength)

    # Structure: a pivot is usable `strength` bars after it prints (confirmed).
    conf_high = {i + strength: (i, closed[i]["h"]) for i in highs}
    conf_low = {i + strength: (i, closed[i]["l"]) for i in lows}

    trend, ref_high, ref_low = 0, None, None
    events = []
    for i in range(n):
        if ref_high is not None and closed[i]["c"] > ref_high[1]:
            events.append({"i": i, "type": "CHoCH" if trend == -1 else "BOS",
                           "dir": "bull", "level": ref_high[1]})
            trend, ref_high = 1, None
        if ref_low is not None and closed[i]["c"] < ref_low[1]:
            events.append({"i": i, "type": "CHoCH" if trend == 1 else "BOS",
                           "dir": "bear", "level": ref_low[1]})
            trend, ref_low = -1, None
        if i in conf_high:
            ref_high = conf_high[i]
        if i in conf_low:
            ref_low = conf_low[i]
    last_event = events[-1] if events else None

    # Order block: last opposing candle before the move that broke structure.
    order_block = None
    if last_event:
        want_down = last_event["dir"] == "bull"   # bullish break -> last down candle = demand OB
        for j in range(last_event["i"], max(-1, last_event["i"] - 20), -1):
            is_down = closed[j]["c"] < closed[j]["o"]
            if is_down == want_down:
                order_block = {"dir": last_event["dir"], "lo": closed[j]["l"], "hi": closed[j]["h"]}
                break

    # Fair value gaps: 3-candle imbalance; keep the most recent still-unfilled.
    fvg = None
    for j in range(1, n - 1):
        if closed[j - 1]["h"] < closed[j + 1]["l"]:
            z = {"dir": "bull", "lo": closed[j - 1]["h"], "hi": closed[j + 1]["l"]}
            if not any(closed[k]["l"] <= z["lo"] for k in range(j + 2, n)):
                fvg = z
        elif closed[j - 1]["l"] > closed[j + 1]["h"]:
            z = {"dir": "bear", "lo": closed[j + 1]["h"], "hi": closed[j - 1]["l"]}
            if not any(closed[k]["h"] >= z["hi"] for k in range(j + 2, n)):
                fvg = z

    # Liquidity: equal highs/lows + a recent sweep (stop-run that closed back).
    tol = closed[-1]["c"] * 0.0008
    eqh = eql = None
    for a in range(len(highs) - 1):
        for b in range(a + 1, len(highs)):
            if abs(closed[highs[a]]["h"] - closed[highs[b]]["h"]) <= tol:
                eqh = (closed[highs[a]]["h"] + closed[highs[b]]["h"]) / 2
    for a in range(len(lows) - 1):
        for b in range(a + 1, len(lows)):
            if abs(closed[lows[a]]["l"] - closed[lows[b]]["l"]) <= tol:
                eql = (closed[lows[a]]["l"] + closed[lows[b]]["l"]) / 2

    sweep = None
    for i in range(max(0, n - 10), n):
        for hi in highs:
            if hi < i and closed[i]["h"] > closed[hi]["h"] and closed[i]["c"] < closed[hi]["h"]:
                sweep = {"dir": "bear", "level": closed[hi]["h"]}
        for lo in lows:
            if lo < i and closed[i]["l"] < closed[lo]["l"] and closed[i]["c"] > closed[lo]["l"]:
                sweep = {"dir": "bull", "level": closed[lo]["l"]}

    return {"trend": trend, "last_event": last_event, "order_block": order_block,
            "fvg": fvg, "eqh": eqh, "eql": eql, "sweep": sweep}
