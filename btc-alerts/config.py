"""Configuration, read from environment variables with sensible defaults.

All strategy knobs are tunable without code changes by setting repository
variables / secrets (see README). Defaults match the strategy as described:
4h 50% Fibonacci retrace -> 15m market-structure shift + 3 confirming candles.
"""
import os


def _f(name, default):
    try:
        return float(os.getenv(name, "").strip() or default)
    except ValueError:
        return float(default)


def _i(name, default):
    try:
        return int(float(os.getenv(name, "").strip() or default))
    except ValueError:
        return int(default)


# --- Market / data ---
# Kraken pair (primary source). Binance symbol is derived for the fallback.
KRAKEN_PAIR = os.getenv("BTC_KRAKEN_PAIR", "XBTUSD").strip() or "XBTUSD"
BINANCE_SYMBOL = os.getenv("BTC_BINANCE_SYMBOL", "BTCUSDT").strip() or "BTCUSDT"

# --- Step 1: 4h Fibonacci ---
# Pivot "strength": a swing high/low needs this many candles on each side.
PIVOT_STRENGTH_4H = _i("PIVOT_STRENGTH_4H", 3)
# Half-width of the 50% zone as a fraction of the swing leg's range.
# 0.03 => price counts as "at the 50% Fib" anywhere between ~47% and ~53%.
FIB_ZONE_BAND = _f("FIB_ZONE_BAND", 0.03)

# --- Step 2: 15m structure shift ---
PIVOT_STRENGTH_15M = _i("PIVOT_STRENGTH_15M", 2)
CONSECUTIVE_CANDLES = _i("CONSECUTIVE_CANDLES", 3)

# --- Telegram ---
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()

# --- State persistence (keyless jsonblob URL) ---
STATE_BLOB_URL = os.getenv("STATE_BLOB_URL", "").strip()
