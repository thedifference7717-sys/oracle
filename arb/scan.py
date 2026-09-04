"""Scanning: turn venue data into candidate opportunities.

Kept separate from main.py so the whole detection path can be driven from
fixtures in selftest.py without touching the network.
"""
import calendar
import json
import os
import time

import detect
from venues import polymarket as poly


def parse_ts(value):
    """Parse an ISO-8601 timestamp to unix seconds, or None.

    Both venues publish close/end times as ISO strings with assorted precision
    and a Z suffix. A missing or unparseable date is returned as None rather
    than guessed: models.Opportunity treats unknown lockup pessimistically, and
    a wrong date would distort the capital-efficiency ranking that everything
    downstream sorts on.
    """
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("Z", "+0000")
    if "." in text:  # drop fractional seconds, formats vary
        head, _, tail = text.partition(".")
        text = head + ("+" + tail.split("+", 1)[1] if "+" in tail else "")
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M:%S%z", "%Y-%m-%d"):
        try:
            parsed = time.strptime(text, fmt)
        except ValueError:
            continue
        if "%z" in fmt:
            return calendar.timegm(parsed) - (parsed.tm_gmtoff or 0)
        return calendar.timegm(parsed)
    return None


def _resolves_at(items, *keys):
    """Latest resolution time across an event's markets.

    The basket only frees its capital when the *last* leg settles, so the
    conservative aggregate is the max, not the min.
    """
    stamps = [parse_ts(item.get(k)) for item in items for k in keys]
    stamps = [s for s in stamps if s]
    return max(stamps) if stamps else None


def _title(event, fallback=""):
    for k in ("title", "sub_title", "question", "name"):
        v = event.get(k)
        if v:
            return str(v)
    return fallback


def scan_kalshi(client, cfg):
    """Dutch books inside Kalshi's mutually exclusive events.

    Only events Kalshi itself flags mutually exclusive are eligible: that flag
    is the exchange's own guarantee that exactly one nested market settles YES,
    which is the guarantee the whole structure rests on. Inferring exclusivity
    from a title would be guessing about settlement rules.
    """
    found, errors = [], []
    for event in client.events():
        if not event.get("mutually_exclusive"):
            continue
        markets = [m for m in (event.get("markets") or [])
                   if m.get("status") == "active"]
        if len(markets) < 2:
            continue
        # Every outcome must be quotable. A basket missing one outcome is not a
        # dutch book -- the missing leg is exactly the one that can win.
        if len(markets) != len(event.get("markets") or []):
            continue
        quotes = []
        try:
            for m in markets:
                yes, _ = client.quotes(m["ticker"], _title(m, m["ticker"]))
                if not yes.asks:
                    quotes = []
                    break
                quotes.append(yes)
        except Exception as e:  # noqa: BLE001 - one bad event must not end the scan
            errors.append(f"kalshi {event.get('event_ticker')}: {e}")
            continue
        if not detect.is_exhaustive(markets, quotes):
            continue
        opp = detect.find_dutch_book(
            quotes,
            key=f"kalshi:{event.get('event_ticker')}",
            title=_title(event, event.get("event_ticker", "")),
            cfg=cfg,
            resolves_at=_resolves_at(markets, "close_time", "expiration_time"),
            notes=[f"{len(quotes)}-way mutually exclusive event"],
        )
        if opp:
            found.append(opp)
    return found, errors


def scan_polymarket(client, cfg):
    """Dutch books inside Polymarket neg-risk events.

    negRisk is Polymarket's own mutually-exclusive flag; the YES outcomes across
    an event's markets form the exhaustive set.
    """
    found, errors = [], []
    for event in client.events():
        if not event.get("negRisk"):
            continue
        markets = [m for m in (event.get("markets") or [])
                   if m.get("active") and not m.get("closed")]
        if len(markets) < 2 or len(markets) != len(event.get("markets") or []):
            continue

        token_by_market, tokens = {}, []
        for m in markets:
            yes_tok, _ = poly.market_tokens(m)
            if not yes_tok:
                token_by_market = {}
                break
            token_by_market[m.get("id") or yes_tok] = (yes_tok, m)
            tokens.append(yes_tok)
        if not token_by_market:
            continue

        try:
            books = client.books(tokens)
        except Exception as e:  # noqa: BLE001
            errors.append(f"polymarket {event.get('slug')}: {e}")
            continue

        quotes = []
        for yes_tok, m in token_by_market.values():
            q = poly.parse_book(books.get(yes_tok), yes_tok, "yes",
                                _title(m, yes_tok))
            if not q.asks:
                quotes = []
                break
            quotes.append(q)
        if not quotes or not detect.is_exhaustive(markets, quotes):
            continue

        opp = detect.find_dutch_book(
            quotes,
            key=f"polymarket:{event.get('slug') or event.get('id')}",
            title=_title(event, str(event.get("slug", ""))),
            cfg=cfg,
            resolves_at=_resolves_at(markets, "endDate", "end_date_iso"),
            notes=[f"{len(quotes)}-way neg-risk event"],
        )
        if opp:
            found.append(opp)
    return found, errors


def load_pairs(path):
    """Human-verified cross-venue pairs.

    Each entry asserts that a Kalshi market and a Polymarket token resolve
    identically. That assertion is the whole basis of a cross-venue arb and it
    cannot be derived from titles, so it is a file a person maintains.
    """
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError) as e:
        print(f"[pairs load error] {e}")
        return []


def scan_cross_venue(kalshi_client, poly_client, cfg):
    """Kalshi YES against Polymarket NO, and the reverse, for verified pairs."""
    found, errors = [], []
    for pair in load_pairs(cfg.pairs_path):
        ticker = pair.get("kalshi_ticker")
        yes_tok, no_tok = pair.get("poly_token_yes"), pair.get("poly_token_no")
        if not (ticker and yes_tok and no_tok):
            continue
        verified = bool(pair.get("verified"))
        title = pair.get("title") or ticker
        try:
            k_yes, k_no = kalshi_client.quotes(ticker, f"kalshi {title}")
            books = poly_client.books([yes_tok, no_tok])
        except Exception as e:  # noqa: BLE001
            errors.append(f"pair {ticker}: {e}")
            continue
        p_yes = poly.parse_book(books.get(yes_tok), yes_tok, "yes", f"poly {title}")
        p_no = poly.parse_book(books.get(no_tok), no_tok, "no", f"poly {title}")

        # Both directions: whichever venue is cheap on YES pairs with the other
        # being cheap on NO.
        for a, b, tag in ((k_yes, p_no, "kalshiYES/polyNO"),
                          (p_yes, k_no, "polyYES/kalshiNO")):
            opp = detect.find_cross_venue(
                a, b, key=f"cross:{ticker}:{tag}", title=f"{title} [{tag}]",
                cfg=cfg, verified=verified,
                resolves_at=parse_ts(pair.get("resolves_at")),
                notes=[pair["note"]] if pair.get("note") else None)
            if opp:
                found.append(opp)
    return found, errors
