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

    fib50 = (swing_high + swing_low) / 2.0
    half = band * (swing_high - swing_low)
    zone_low, zone_high = fib50 - half, fib50 + half

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
