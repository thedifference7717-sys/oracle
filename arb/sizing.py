"""Portfolio-level allocation across the opportunities a scan turned up.

Per-opportunity ceilings live in the detector. This module answers the question
the detector cannot: given everything found this scan, and capital already
locked in unsettled positions, what do we actually take?

Capital in a prediction market is locked until the market resolves, which can be
months. Free cash, not bankroll, is the binding constraint, and that is what
makes "how much to deposit" a real question rather than a formality.
"""


def rank(opportunities):
    """Best risk-adjusted first: verified structures ahead of unverified ones,
    then by ROI, then by absolute profit as the tiebreak."""
    return sorted(
        opportunities,
        key=lambda o: (o.verified_pair, o.roi, o.profit_c),
        reverse=True,
    )


def allocate(opportunities, cfg, already_deployed_c=0):
    """Pick the subset we can fund, in rank order.

    Returns (accepted, skipped) where skipped carries a reason per opportunity,
    so a scan that finds edge but cannot fund it says so instead of silently
    reporting nothing.
    """
    accepted, skipped = [], []
    budget = cfg.max_deployed_c - already_deployed_c
    if cfg.bankroll_c:
        budget = min(budget, cfg.bankroll_c - already_deployed_c)

    for opp in rank(opportunities):
        if not opp.verified_pair:
            skipped.append((opp, "unverified pair - review only"))
            continue
        if opp.cost_c > budget:
            skipped.append((opp, f"needs ${opp.cost_c/100:.2f}, "
                                 f"${max(budget,0)/100:.2f} free"))
            continue
        accepted.append(opp)
        budget -= opp.cost_c
    return accepted, skipped


def capital_required(opportunities):
    """Total cash the accepted set locks up until settlement."""
    return sum(o.cost_c for o in opportunities)
