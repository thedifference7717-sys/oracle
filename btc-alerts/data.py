"""OHLC fetching.

Primary source is Kraken, because (a) it exposes both a native 4h (240m) and
15m interval, and (b) its public API is reachable from cloud/CI IPs where
Binance often returns HTTP 451. Binance is used as a fallback.

A "candle" is a dict: {"t": epoch_seconds, "o", "h", "l", "c": floats}.
Both sources return the still-forming (unclosed) candle as the last element,
so callers receive (closed, forming) where ``forming`` is that live candle.
"""
import requests

_TIMEOUT = 20

_KRAKEN_INTERVAL = {"4h": 240, "15m": 15}
_BINANCE_INTERVAL = {"4h": "4h", "15m": "15m"}


def _fetch_kraken(pair, tf):
    r = requests.get(
        "https://api.kraken.com/0/public/OHLC",
        params={"pair": pair, "interval": _KRAKEN_INTERVAL[tf]},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    j = r.json()
    if j.get("error"):
        raise RuntimeError(f"kraken error: {j['error']}")
    result = j["result"]
    key = next(k for k in result if k != "last")
    rows = result[key]
    return [
        {"t": int(x[0]), "o": float(x[1]), "h": float(x[2]),
         "l": float(x[3]), "c": float(x[4])}
        for x in rows
    ]


def _fetch_binance(symbol, tf):
    r = requests.get(
        "https://api.binance.com/api/v3/klines",
        params={"symbol": symbol, "interval": _BINANCE_INTERVAL[tf], "limit": 500},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    rows = r.json()
    return [
        {"t": int(x[0]) // 1000, "o": float(x[1]), "h": float(x[2]),
         "l": float(x[3]), "c": float(x[4])}
        for x in rows
    ]


def get_candles(tf, kraken_pair, binance_symbol):
    """Return (closed_candles, forming_candle) for the timeframe ``tf``."""
    errors = []
    for name, fn, arg in (
        ("kraken", _fetch_kraken, kraken_pair),
        ("binance", _fetch_binance, binance_symbol),
    ):
        try:
            candles = fn(arg, tf)
            if len(candles) < 5:
                raise RuntimeError(f"too few candles ({len(candles)})")
            return candles[:-1], candles[-1]
        except Exception as e:  # noqa: BLE001 - try the next source
            errors.append(f"{name}: {e}")
    raise RuntimeError("all data sources failed -> " + " | ".join(errors))
