"""Risk limits that apply regardless of how good a trade looks.

Every rule here exists to stop a *correct* per-trade decision from producing an
incorrect account. The detector is happy to hand back twenty baskets on the
same event; taking all of them is one concentrated bet on that event settling
as written, not twenty independent edges.
"""


def event_root(key: str) -> str:
    """Identity of the underlying event, ignoring the structure traded on it.

    "kalshi:E1" and "cross:E1:kalshiYES/polyNO" are the same event and must
    share one exposure budget.
    """
    parts = key.split(":")
    return parts[1] if len(parts) > 1 else key


class RiskGate:
    """Accept/reject with a reason, tracking exposure as decisions accumulate.

    Stateful on purpose: limits have to account for what earlier opportunities
    in this same scan already consumed, not just what was on the books when the
    scan started.
    """

    def __init__(self, cfg, portfolio=None):
        self.cfg = cfg
        self.bankroll_c = cfg.bankroll_c or cfg.max_deployed_c
        self.event_c = {}
        self.venue_c = {}
        if portfolio:
            for p in portfolio.open_positions:
                root = event_root(p.key)
                self.event_c[root] = self.event_c.get(root, 0) + p.cost_c
                for v in p.venues:
                    self.venue_c[v] = self.venue_c.get(v, 0) + p.cost_c

    def _cap(self, fraction):
        return int(self.bankroll_c * fraction) if self.bankroll_c else 0

    def check(self, opp):
        """Return None if acceptable, else a human-readable rejection reason."""
        if not opp.verified_pair:
            return "unverified pair - review only"

        if opp.profit_c <= 0:
            return "no profit after fees"

        # Concentration: one event must not be able to hurt the account badly
        # even if its settlement turns out to be ambiguous.
        root = event_root(opp.key)
        cap = self._cap(self.cfg.max_event_fraction)
        if cap and self.event_c.get(root, 0) + opp.cost_c > cap:
            return (f"event exposure cap: ${(self.event_c.get(root,0)+opp.cost_c)/100:.2f} "
                    f"> ${cap/100:.2f}")

        # Venue exposure is counterparty risk, not market risk. It is the one
        # exposure that no amount of hedging inside the venue can reduce.
        vcap = self._cap(self.cfg.max_venue_fraction)
        if vcap:
            for v in opp.venues:
                if self.venue_c.get(v, 0) + opp.cost_c > vcap:
                    return (f"{v} exposure cap: "
                            f"${(self.venue_c.get(v,0)+opp.cost_c)/100:.2f} > ${vcap/100:.2f}")

        # A basket that locks capital past the horizon is not wrong, but it is
        # not what this account is for: it converts a trading strategy into a
        # bond with counterparty risk and no coupon.
        if self.cfg.max_hold_days and opp.hold_days > self.cfg.max_hold_days:
            return (f"lockup {opp.hold_days:.0f}d exceeds "
                    f"{self.cfg.max_hold_days:.0f}d horizon")

        if (self.cfg.min_annualized_roi
                and opp.annualized_roi < self.cfg.min_annualized_roi):
            return (f"annualised {opp.annualized_roi:.1%} below "
                    f"{self.cfg.min_annualized_roi:.1%} floor")
        return None

    def commit(self, opp):
        """Record an accepted opportunity against the running limits."""
        root = event_root(opp.key)
        self.event_c[root] = self.event_c.get(root, 0) + opp.cost_c
        for v in opp.venues:
            self.venue_c[v] = self.venue_c.get(v, 0) + opp.cost_c


def kelly_fraction(win_prob: float, net_odds: float, cap=0.25) -> float:
    """Fractional Kelly stake for a *probabilistic* edge.

    Unused by the structural detectors -- a filled dutch book has no losing
    branch, so Kelly is undefined and full size is correct. This exists for any
    strategy where the edge is an estimate rather than an identity, and it is
    capped hard: full Kelly assumes your probability is exactly right, and an
    overestimated edge sizes up precisely when it should size down.
    """
    if net_odds <= 0 or not 0 < win_prob < 1:
        return 0.0
    f = (win_prob * (net_odds + 1) - 1) / net_odds
    return max(0.0, min(f, cap))
