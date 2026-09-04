"""Core value types shared by the venue adapters, detector and executor.

Everything internal is expressed in **cents** (integers) for prices and whole
contracts for size. Cents keep the arithmetic exact: a dutch book is decided by
sub-penny margins, and float dollars round the answer away.
"""
from dataclasses import dataclass, field
from typing import List, Optional, Tuple


@dataclass(frozen=True)
class Level:
    """One order book price level we can trade against.

    price_c is what *we pay per contract* to lift this level, in cents.
    """
    price_c: int
    size: int


@dataclass
class Quote:
    """The ask ladder for one tradable leg (a YES or a NO on one market).

    ``asks`` is ascending by price: the cheapest contracts first. A leg with an
    empty ladder is untradable, not free -- the detector must skip it.
    """
    venue: str
    market_id: str
    side: str                      # "yes" | "no"
    label: str                     # human-readable outcome name
    asks: List[Level] = field(default_factory=list)

    @property
    def best_ask_c(self) -> Optional[int]:
        return self.asks[0].price_c if self.asks else None

    @property
    def depth(self) -> int:
        return sum(l.size for l in self.asks)

    def cost_for(self, contracts: int) -> Optional[int]:
        """Cents to buy ``contracts`` by walking the ladder. None if too thin.

        This is the honest cost of *taking* liquidity. Using the best ask for
        the whole size is the classic way to book an arb that is not there.
        """
        if contracts <= 0:
            return None
        remaining, total = contracts, 0
        for lvl in self.asks:
            take = min(remaining, lvl.size)
            total += take * lvl.price_c
            remaining -= take
            if remaining == 0:
                return total
        return None


@dataclass
class Leg:
    """A sized leg of a proposed trade."""
    quote: Quote
    contracts: int
    gross_c: int                   # cost before fees
    fee_c: int

    @property
    def total_c(self) -> int:
        return self.gross_c + self.fee_c

    @property
    def vwap_c(self) -> float:
        return self.gross_c / self.contracts if self.contracts else 0.0

    @property
    def limit_c(self) -> int:
        """The worst price this leg touches -- the limit price to send.

        Quoting the limit at the worst level (not the best ask) is what lets a
        single order sweep the ladder without ever paying above what we priced.
        """
        remaining, worst = self.contracts, 0
        for lvl in self.quote.asks:
            if remaining <= 0:
                break
            worst = lvl.price_c
            remaining -= min(remaining, lvl.size)
        return worst


@dataclass
class Opportunity:
    """A complete, sized, fee-inclusive arbitrage candidate."""
    kind: str                      # "dutch_book" | "cross_venue"
    key: str                       # stable identity, for dedupe across scans
    title: str
    legs: List[Leg]
    contracts: int
    payout_c: int                  # guaranteed gross return at settlement
    verified_pair: bool = True     # False => resolution equivalence is unproven
    notes: List[str] = field(default_factory=list)

    @property
    def cost_c(self) -> int:
        return sum(l.total_c for l in self.legs)

    @property
    def profit_c(self) -> int:
        return self.payout_c - self.cost_c

    @property
    def roi(self) -> float:
        return self.profit_c / self.cost_c if self.cost_c else 0.0

    @property
    def venues(self) -> Tuple[str, ...]:
        return tuple(sorted({l.quote.venue for l in self.legs}))
