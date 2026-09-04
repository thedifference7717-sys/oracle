"""Fee models, in cents.

An arbitrage is decided in the third decimal place, so fees are not a footnote
here -- they are the thing that kills most apparent edges. Every detector path
charges **taker** fees on every leg, because crossing the spread is exactly what
taking an arb requires. Never price an arb at maker rates you will not get.
"""
import math

# Ceilings on a float are one ULP away from being wrong: 0.07*100*.5*.5*100
# evaluates to 175.00000000000003, which would round a 175c fee up to 176c.
# Snap to a sane precision before every ceiling.
_EPS_DIGITS = 9


def _ceil_c(raw: float) -> int:
    return math.ceil(round(raw, _EPS_DIGITS))

# Kalshi's published trading fee: ceil(rate * C * P * (1-P)) to the next cent,
# with P the price in dollars and C the contract count. The curve is parabolic,
# peaking at 50c (1.75c/contract) and vanishing at the extremes.
KALSHI_TAKER_RATE = 0.07
KALSHI_MAKER_RATE = 0.0175


def kalshi_fee_c(contracts: int, price_c: int, rate: float = KALSHI_TAKER_RATE) -> int:
    """Kalshi fee in cents for an order of ``contracts`` at ``price_c``.

    Rounded up on the *order*, matching Kalshi's formula. Callers holding a
    swept ladder should pass the VWAP: the curve is concave, so VWAP slightly
    understates a fee spread across levels -- ``kalshi_fee_walked`` is exact.
    """
    if contracts <= 0:
        return 0
    p = price_c / 100.0
    return _ceil_c(rate * contracts * p * (1.0 - p) * 100.0)


def kalshi_fee_walked(levels, contracts: int, rate: float = KALSHI_TAKER_RATE) -> int:
    """Exact Kalshi fee when an order sweeps several price levels.

    Fees are assessed per fill price, so a sweep is priced level by level and
    the ceiling applied once at the end -- the conservative reading.
    """
    remaining, raw = contracts, 0.0
    for lvl in levels:
        if remaining <= 0:
            break
        take = min(remaining, lvl.size)
        p = lvl.price_c / 100.0
        raw += rate * take * p * (1.0 - p) * 100.0
        remaining -= take
    return _ceil_c(raw)


def polymarket_fee_c(contracts: int, price_c: int, taker_bps: float = 0.0) -> int:
    """Polymarket fee in cents.

    Base CLOB trading has historically been 0% for makers and takers, but fees
    have been switched on for some categories, so the rate stays a knob rather
    than a hardcoded zero. ``taker_bps`` is basis points of notional.
    """
    if contracts <= 0 or taker_bps <= 0:
        return 0
    notional_c = contracts * price_c
    return _ceil_c(notional_c * taker_bps / 10_000.0)


def fee_for(venue: str, levels, contracts: int, cfg) -> int:
    """Dispatch to the right fee model for a swept ladder."""
    if venue == "kalshi":
        return kalshi_fee_walked(levels, contracts, cfg.kalshi_taker_rate)
    if venue == "polymarket":
        gross = sum(min(contracts, l.size) * l.price_c for l in levels)
        vwap = gross / contracts if contracts else 0
        base = polymarket_fee_c(contracts, int(round(vwap)), cfg.poly_taker_bps)
        return base + cfg.poly_fixed_cost_c
    raise ValueError(f"unknown venue: {venue}")
