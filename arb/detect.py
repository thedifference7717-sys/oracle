"""Arbitrage detection.

Two structures are worth hunting, and they are not equally safe:

**dutch_book** -- one mutually exclusive, exhaustive outcome set on a single
venue. Buy one contract of every outcome; exactly one settles at $1. If the
fee-inclusive cost of the basket is under $1 the profit is locked by the
exchange's own settlement rules, with no resolution risk at all. This is the
only structure this system is willing to trade unattended.

**cross_venue** -- YES on one venue against NO on another for "the same" event.
The payoff is only guaranteed if both venues resolve identically: same source,
same cutoff, same edge-case handling. Two markets with matching titles routinely
resolve differently, and when they do the position is not an arb, it is a
naked directional bet on a technicality. So these are surfaced for review and
executed only from a human-verified pairs file.

Sizing walks the real ladders instead of assuming the best ask holds. Cost is
convex in size and payout is linear, so profit is concave: we sweep the feasible
sizes and keep the best.
"""
from models import Leg, Opportunity
from fees import fee_for

PAYOUT_C = 100  # every contract settles at $1.00 or $0.00


def _price_legs(quotes, contracts, cfg):
    """Cost out one contract-count across all legs, or None if not fillable."""
    legs = []
    for q in quotes:
        gross = q.cost_for(contracts)
        if gross is None:
            return None
        legs.append(Leg(q, contracts, gross, fee_for(q.venue, q.asks, contracts, cfg)))
    return legs


def _max_size(quotes, cfg):
    """Largest size every leg can fill, bounded by the configured ceiling."""
    depth = min((q.depth for q in quotes), default=0)
    return min(depth, cfg.max_contracts)


def _best_basket(quotes, cfg, payout_per_contract=PAYOUT_C):
    """Find the size maximising fee-inclusive profit for a set of legs.

    Returns (legs, contracts, profit_c) or None. The safety margin is charged
    per contract so a stale book or a one-tick move does not turn a booked edge
    negative -- the edge has to clear the noise, not just clear zero.
    """
    ceiling = _max_size(quotes, cfg)
    if ceiling <= 0:
        return None

    best = None
    for n in range(1, ceiling + 1):
        legs = _price_legs(quotes, n, cfg)
        if legs is None:
            break
        cost = sum(l.total_c for l in legs)
        if cost > cfg.max_stake_per_opp_c:
            break
        profit = payout_per_contract * n - cost - cfg.safety_margin_c * n
        if profit <= 0:
            continue
        if best is None or profit > best[2]:
            best = (legs, n, profit)
    return best


def _passes(profit_c, cost_c, cfg):
    if cost_c <= 0:
        return False
    return profit_c >= cfg.min_profit_c and (profit_c / cost_c) >= cfg.min_roi


def find_dutch_book(quotes, key, title, cfg, resolves_at=None, notes=None):
    """Mutually exclusive + exhaustive basket priced under its $1 payout.

    ``quotes`` must be the YES leg of *every* outcome in the set. A missing
    outcome breaks the guarantee -- the uncovered outcome is the one that wins.
    """
    if len(quotes) < 2 or any(not q.asks for q in quotes):
        return None
    found = _best_basket(quotes, cfg)
    if not found:
        return None
    legs, n, profit = found
    cost = sum(l.total_c for l in legs)
    if not _passes(profit, cost, cfg):
        return None
    return Opportunity(
        kind="dutch_book", key=key, title=title, legs=legs, contracts=n,
        payout_c=PAYOUT_C * n, verified_pair=True, resolves_at=resolves_at,
        notes=list(notes or []),
    )


def find_cross_venue(yes_quote, no_quote, key, title, cfg, verified,
                     resolves_at=None, notes=None):
    """YES here against NO there: a two-leg basket with the same $1 payout.

    Structurally identical to a dutch book, but only an arb if the two markets
    resolve identically -- hence ``verified``, which gates execution downstream.
    """
    if not yes_quote.asks or not no_quote.asks:
        return None
    found = _best_basket([yes_quote, no_quote], cfg)
    if not found:
        return None
    legs, n, profit = found
    cost = sum(l.total_c for l in legs)
    if not _passes(profit, cost, cfg):
        return None
    extra = list(notes or [])
    if not verified:
        extra.append("UNVERIFIED PAIR - resolution equivalence not confirmed; "
                     "review before trading")
    return Opportunity(
        kind="cross_venue", key=key, title=title, legs=legs, contracts=n,
        payout_c=PAYOUT_C * n, verified_pair=verified, resolves_at=resolves_at,
        notes=extra,
    )


def is_exhaustive(event_markets, quotes):
    """True when we hold a live quote for every outcome in the event.

    A basket priced on a subset of outcomes is not a dutch book, and the gap is
    silent: it looks cheaper precisely because coverage is missing.
    """
    return len(event_markets) >= 2 and len(quotes) == len(event_markets)
