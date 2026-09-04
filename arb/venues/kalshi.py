"""Kalshi market data adapter.

The one thing worth getting right here is book semantics. Kalshi's orderbook
endpoint returns **resting bids on both sides**, not bids and asks:

    {"orderbook": {"yes": [[price_c, size], ...], "no": [[price_c, size], ...]}}

A resting NO bid at p is someone willing to buy NO at p, which is the same as
offering YES at (100 - p). So the ask ladder we can actually lift is the
*opposite* side's bids, mirrored:

    YES asks = [(100 - p, size) for p, size in book["no"]]
    NO  asks = [(100 - p, size) for p, size in book["yes"]]

Reading book["yes"] as a YES ask ladder inverts the market and manufactures
arbitrage that is not there -- it is the single most common way this goes wrong.
"""
import requests

from models import Level, Quote


class KalshiClient:
    venue = "kalshi"

    def __init__(self, cfg, session=None):
        self.cfg = cfg
        self.base = cfg.kalshi_api_base.rstrip("/")
        self.s = session or requests.Session()

    # --- HTTP -------------------------------------------------------------
    def _get(self, path, params=None):
        r = self.s.get(f"{self.base}{path}", params=params,
                       timeout=self.cfg.request_timeout)
        r.raise_for_status()
        return r.json()

    # --- Market data ------------------------------------------------------
    def events(self, limit=None):
        """Open events with their nested markets, following the cursor.

        Only mutually exclusive events matter for the dutch-book detector, but
        the flag is returned per event so the caller decides.
        """
        limit = limit or self.cfg.max_events
        out, cursor = [], None
        while len(out) < limit:
            params = {"status": "open", "with_nested_markets": "true",
                      "limit": min(200, limit - len(out))}
            if cursor:
                params["cursor"] = cursor
            data = self._get("/events", params)
            batch = data.get("events") or []
            if not batch:
                break
            out.extend(batch)
            cursor = data.get("cursor")
            if not cursor:
                break
        return out[:limit]

    def orderbook(self, ticker):
        """Raw orderbook for one market ticker."""
        data = self._get(f"/markets/{ticker}/orderbook",
                         {"depth": self.cfg.book_depth})
        return (data or {}).get("orderbook") or {}

    def quotes(self, ticker, label=""):
        """Return (yes_quote, no_quote) as *ask ladders we can lift*."""
        return parse_orderbook(self.orderbook(ticker), ticker, label)


def _mirror(levels):
    """Turn one side's bid levels into the opposite side's ask ladder.

    Kalshi may hand back levels in either order and occasionally a null entry;
    normalise to ascending-by-cost and drop anything unusable rather than
    letting a malformed level price a trade.
    """
    asks = []
    for entry in levels or []:
        if not entry or len(entry) < 2:
            continue
        try:
            bid_c, size = int(entry[0]), int(entry[1])
        except (TypeError, ValueError):
            continue
        ask_c = 100 - bid_c
        if size > 0 and 0 < ask_c < 100:
            asks.append(Level(ask_c, size))
    asks.sort(key=lambda l: l.price_c)
    return asks


def parse_orderbook(book, ticker, label=""):
    """Split a Kalshi orderbook payload into YES and NO ask ladders."""
    yes = Quote("kalshi", ticker, "yes", label or ticker,
                _mirror((book or {}).get("no")))
    no = Quote("kalshi", ticker, "no", label or ticker,
               _mirror((book or {}).get("yes")))
    return yes, no
