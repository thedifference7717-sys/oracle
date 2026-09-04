"""Portfolio allocation across the opportunities a scan turned up.

Per-opportunity ceilings live in the detector; risk limits live in risk.py.
This module answers the remaining question: given everything found, the capital
already locked, and a fixed budget, **which subset do we actually take?**

The ordering is the whole point. Capital is returned at settlement, not at fill,
so two opportunities with the same ROI are not equally good -- the one that
resolves sooner returns the dollar to be used again. Ranking on raw ROI fills
the account with slow money and leaves nothing free when fast edges appear.
So the sort key is annualised return on locked capital.

This is a greedy knapsack: optimal only when the budget binds loosely, which is
the normal case here because opportunities are scarce relative to bankroll. When
capital is genuinely tight, greedy-by-density is still the right heuristic and
its failure mode (skipping one large basket for two smaller ones) is benign.
"""
from risk import RiskGate


def rank(opportunities):
    """Best capital efficiency first.

    Verified structures outrank unverified ones unconditionally -- an unproven
    resolution equivalence is not a small penalty, it is a different asset --
    then annualised return, then absolute profit per day as the tiebreak so a
    trivially small fast basket cannot outrank a materially larger one.
    """
    return sorted(
        opportunities,
        key=lambda o: (o.verified_pair, o.annualized_roi, o.profit_per_day_c),
        reverse=True,
    )


def allocate(opportunities, cfg, already_deployed_c=0, portfolio=None):
    """Pick the fundable subset in efficiency order.

    Returns (accepted, skipped) where skipped carries a reason per opportunity,
    so a scan that finds edge it cannot fund says so rather than reporting
    nothing and looking like a quiet night.
    """
    accepted, skipped = [], []
    gate = RiskGate(cfg, portfolio)

    budget = cfg.max_deployed_c - already_deployed_c
    if cfg.bankroll_c:
        budget = min(budget, cfg.bankroll_c - already_deployed_c)

    for opp in rank(opportunities):
        reason = gate.check(opp)
        if reason:
            skipped.append((opp, reason))
            continue
        if opp.cost_c > budget:
            skipped.append((opp, f"needs ${opp.cost_c/100:.2f}, "
                                 f"${max(budget, 0)/100:.2f} free"))
            continue
        accepted.append(opp)
        gate.commit(opp)
        budget -= opp.cost_c
    return accepted, skipped


def capital_required(opportunities):
    """Total cash the accepted set locks up until settlement."""
    return sum(o.cost_c for o in opportunities)


def blended_annual_return(opportunities, bankroll_c):
    """What this set would earn the *account*, not the individual trades.

    Per-trade ROI flatters an account that cannot keep its capital busy. This
    divides by the whole bankroll, so idle cash shows up as the drag it is.
    """
    if not bankroll_c:
        return 0.0
    return sum(o.profit_per_day_c for o in opportunities) * 365.0 / bankroll_c
