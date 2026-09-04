"""Polymarket market data adapter (Gamma for metadata, CLOB for books).

Unlike Kalshi, the CLOB returns real bids and asks per token, and each binary
market has two token ids -- one for YES, one for NO -- so "buy NO" is just
taking asks on the NO token rather than mirroring a ladder.

Two conversions matter:

* Prices arrive as decimal-dollar strings ("0.53"). We hold cents as integers
  and round asks **up**, so a sub-cent tick can only ever make an opportunity
  look worse than it is. A real edge may be shaved; a fake one is never created.
* Sizes are fractional shares. We floor to whole contracts for the same reason.

Neg-risk events are the interesting structure: their markets' YES outcomes form
one mutually exclusive, exhaustive set, which is exactly what the dutch-book
detector consumes.
"""
import json
import math

import requests

from models import Level, Quote

GAMMA_BASE = "https://gamma-api.polymarket.com"
CLOB_BASE = "https://clob.polymarket.com"


def _jlist(value):
    """Gamma returns some arrays as JSON-encoded strings; accept either."""
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


class PolymarketClient:
    venue = "polymarket"

    def __init__(self, cfg, session=None, gamma_base=GAMMA_BASE, clob_base=CLOB_BASE):
        self.cfg = cfg
        self.gamma = gamma_base.rstrip("/")
        self.clob = clob_base.rstrip("/")
        self.s = session or requests.Session()

    def _get(self, base, path, params=None):
        r = self.s.get(f"{base}{path}", params=params,
                       timeout=self.cfg.request_timeout)
        r.raise_for_status()
        return r.json()

    # --- Metadata ---------------------------------------------------------
    def events(self, limit=None):
        """Open events with nested markets, paged by offset."""
        limit = limit or self.cfg.max_events
        out, offset = [], 0
        while len(out) < limit:
            batch = self._get(self.gamma, "/events", {
                "closed": "false", "limit": min(100, limit - len(out)),
                "offset": offset,
            })
            if not isinstance(batch, list) or not batch:
                break
            out.extend(batch)
            offset += len(batch)
            if len(batch) < 100:
                break
        return out[:limit]

    # --- Books ------------------------------------------------------------
    def book(self, token_id):
        return self._get(self.clob, "/book", {"token_id": token_id})

    def books(self, token_ids):
        """Batch book fetch; falls back to per-token GETs if the batch fails.

        The batch endpoint is a large win on a wide scan (one round trip per
        event instead of one per outcome), but it is not worth failing a scan
        over, so a failure degrades rather than raises.
        """
        if not token_ids:
            return {}
        try:
            payload = [{"token_id": t} for t in token_ids]
            r = self.s.post(f"{self.clob}/books", json=payload,
                            timeout=self.cfg.request_timeout)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list) and data:
                return {b.get("asset_id"): b for b in data if b.get("asset_id")}
        except (requests.RequestException, ValueError):
            pass
        out = {}
        for t in token_ids:
            try:
                out[t] = self.book(t)
            except (requests.RequestException, ValueError):
                continue
        return out

    def quote(self, token_id, side, label, book=None):
        book = book if book is not None else self.book(token_id)
        return parse_book(book, token_id, side, label)


def parse_book(book, token_id, side, label=""):
    """Build an ask ladder (in cents) from a CLOB book payload."""
    asks = []
    for entry in (book or {}).get("asks") or []:
        try:
            price = float(entry["price"])
            size = float(entry["size"])
        except (KeyError, TypeError, ValueError):
            continue
        # Round the price up and the size down: both directions are against us,
        # which is the only safe way to discretise a book we intend to trade.
        price_c = math.ceil(round(price * 100.0, 6))
        contracts = int(size)
        if contracts > 0 and 0 < price_c < 100:
            asks.append(Level(price_c, contracts))
    asks.sort(key=lambda l: l.price_c)
    return Quote("polymarket", str(token_id), side, label or str(token_id), asks)


def market_tokens(market):
    """Extract (yes_token, no_token) from a Gamma market, or (None, None).

    Gamma orders clobTokenIds to match the outcomes array, so the YES token is
    whichever index holds the "Yes" outcome rather than always index 0.
    """
    ids = _jlist(market.get("clobTokenIds"))
    outcomes = [str(o).strip().lower() for o in _jlist(market.get("outcomes"))]
    if len(ids) != 2:
        return None, None
    if len(outcomes) == 2 and "yes" in outcomes:
        yi = outcomes.index("yes")
        return str(ids[yi]), str(ids[1 - yi])
    return str(ids[0]), str(ids[1])
