"""Account state: what is open, what capital is locked, and when it comes back.

The scanner answers "is this a good trade". This module answers the question
that actually governs a prediction-market account: **do I have the cash, and
when do I get it back?**

Positions here are reconstructed from the ledger rather than held in memory, so
a scheduled run that starts cold still knows what it is holding. A position is
treated as released once its resolution time has passed -- an approximation,
since settlement can lag resolution by hours or days, and a deliberately
*optimistic* one, so it is paired with a settlement buffer in free_c().
"""
import time
from dataclasses import dataclass, field
from typing import List, Optional

import ledger

SECONDS_PER_DAY = 86_400.0

# Settlement is not instantaneous: a market can resolve and still hold your
# cash while the venue processes it. Capital is treated as locked for this long
# past resolution so the account does not commit money it does not yet have.
SETTLEMENT_BUFFER_DAYS = 2.0


@dataclass
class Position:
    key: str
    title: str
    cost_c: int
    payout_c: int
    contracts: int
    opened_ts: float
    resolves_at: Optional[float] = None
    venues: List[str] = field(default_factory=list)
    status: str = "open"

    @property
    def profit_c(self) -> int:
        return self.payout_c - self.cost_c

    @property
    def released_at(self) -> Optional[float]:
        if self.resolves_at is None:
            return None
        return self.resolves_at + SETTLEMENT_BUFFER_DAYS * SECONDS_PER_DAY

    def is_locked(self, now=None):
        """Capital still committed.

        A position with no known resolution date is treated as locked
        indefinitely. Assuming it has freed up would let the account spend the
        same dollar twice.
        """
        if self.status not in ("open", "filled", "partial", "paper"):
            return False
        if self.released_at is None:
            return True
        return (now or time.time()) < self.released_at

    @property
    def days_remaining(self) -> Optional[float]:
        if self.resolves_at is None:
            return None
        return max(0.0, (self.resolves_at - time.time()) / SECONDS_PER_DAY)


@dataclass
class Portfolio:
    positions: List[Position] = field(default_factory=list)

    @classmethod
    def from_ledger(cls, path):
        """Rebuild open positions from execution records.

        Executions are keyed by opportunity key; a later record for the same
        key supersedes an earlier one, so a re-run that upgrades a partial to
        a fill does not double-count the capital.
        """
        by_key = {}
        for row in ledger.read_all(path):
            if row.get("kind") != "execution":
                continue
            if row.get("status") not in ("filled", "partial", "paper"):
                continue
            key = row.get("key")
            if not key:
                continue
            filled = int(row.get("filled") or 0)
            requested = int(row.get("requested") or filled or 1)
            # A partial fill locks only the capital that actually filled.
            scale = (filled / requested) if requested else 1.0
            by_key[key] = Position(
                key=key,
                title=row.get("title", ""),
                cost_c=int(round(int(row.get("cost_c") or 0) * scale)),
                payout_c=int(round(int(row.get("payout_c") or 0) * scale)),
                contracts=filled,
                opened_ts=float(row.get("ts") or time.time()),
                resolves_at=row.get("resolves_at"),
                venues=list(row.get("venues") or []),
                status=row.get("status", "open"),
            )
        return cls(positions=list(by_key.values()))

    # --- Capital ----------------------------------------------------------
    @property
    def open_positions(self) -> List[Position]:
        return [p for p in self.positions if p.is_locked()]

    @property
    def locked_c(self) -> int:
        return sum(p.cost_c for p in self.open_positions)

    @property
    def pending_profit_c(self) -> int:
        return sum(p.profit_c for p in self.open_positions)

    def free_c(self, bankroll_c: int) -> int:
        return max(0, bankroll_c - self.locked_c)

    def exposure_to(self, key_prefix: str) -> int:
        """Capital locked in positions sharing an identity prefix.

        Used to cap how much rides on one event or one venue: several baskets
        on the same underlying event are one bet on that event's settlement
        behaving as written, not several independent ones.
        """
        return sum(p.cost_c for p in self.open_positions
                   if p.key.startswith(key_prefix))

    def venue_exposure_c(self, venue: str) -> int:
        return sum(p.cost_c for p in self.open_positions if venue in p.venues)

    # --- Timing -----------------------------------------------------------
    def release_schedule(self, horizon_days=90):
        """Capital coming back, soonest first, within the horizon.

        This is the schedule that tells you whether the account is about to be
        cash-starved or about to have idle money looking for a home.
        """
        now = time.time()
        rows = []
        for p in self.open_positions:
            if p.released_at is None:
                continue
            days = (p.released_at - now) / SECONDS_PER_DAY
            if 0 <= days <= horizon_days:
                rows.append((days, p))
        return sorted(rows, key=lambda r: r[0])

    def weighted_hold_days(self) -> float:
        """Capital-weighted average lockup -- the account's money velocity.

        Falling is good: it means the same bankroll is turning over more times
        a year, which is where compounding actually comes from.
        """
        locked = self.locked_c
        if not locked:
            return 0.0
        total = 0.0
        for p in self.open_positions:
            days = p.days_remaining
            total += p.cost_c * (days if days is not None else 90.0)
        return total / locked

    def summary(self, bankroll_c: int):
        locked = self.locked_c
        hold = self.weighted_hold_days()
        # Annualised return on the *whole account*, not on individual trades:
        # idle cash is part of the denominator, which is the honest way to see
        # whether the bankroll is sized right for the opportunity flow.
        annual = 0.0
        if bankroll_c and hold > 0:
            annual = (self.pending_profit_c / bankroll_c) * (365.0 / hold)
        return {
            "open_positions": len(self.open_positions),
            "bankroll_usd": round(bankroll_c / 100.0, 2),
            "locked_usd": round(locked / 100.0, 2),
            "free_usd": round(self.free_c(bankroll_c) / 100.0, 2),
            "utilisation": round(locked / bankroll_c, 4) if bankroll_c else 0.0,
            "pending_profit_usd": round(self.pending_profit_c / 100.0, 2),
            "weighted_hold_days": round(hold, 1),
            "implied_annual_return": round(annual, 4),
        }
