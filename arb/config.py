"""Configuration from environment variables, following btc-alerts/config.py.

Every strategy and safety knob is settable as a repository variable/secret so
the scanner can be retuned without a code change. Defaults are deliberately
conservative: paper mode, small size, edge thresholds that reject the marginal
opportunities where a fee or depth error would flip the sign.
"""
import os
from dataclasses import dataclass


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


def _b(name, default=False):
    v = os.getenv(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


@dataclass
class Config:
    # --- Mode ---
    # DRY_RUN is the default and has to be turned off explicitly. Live order
    # placement additionally requires ARB_LIVE=1 *and* credentials; two gates,
    # because a stray env var should not be able to start spending money.
    dry_run: bool = True
    live: bool = False

    # --- Capital ---
    bankroll_c: int = 0            # settled cash available, in cents
    max_stake_per_opp_c: int = 0   # ceiling on cost of any single opportunity
    max_deployed_c: int = 0        # ceiling on total capital locked at once
    max_contracts: int = 0         # per-leg contract ceiling

    # --- Edge thresholds ---
    min_profit_c: int = 0          # absolute floor, in cents
    min_roi: float = 0.0           # profit / capital-at-risk
    safety_margin_c: int = 0       # cents/contract shaved off every edge

    # --- Fees ---
    kalshi_taker_rate: float = 0.07
    poly_taker_bps: float = 0.0
    poly_fixed_cost_c: int = 0

    # --- Scanning ---
    book_depth: int = 0
    max_events: int = 0
    request_timeout: int = 0
    scan_kalshi: bool = True
    scan_polymarket: bool = True
    cross_venue: bool = False

    # --- Plumbing ---
    telegram_token: str = ""
    telegram_chat_id: str = ""
    state_blob_url: str = ""
    ledger_path: str = ""
    pairs_path: str = ""
    kalshi_api_base: str = ""
    kalshi_key_id: str = ""
    kalshi_private_key: str = ""
    kalshi_bearer: str = ""


def load() -> Config:
    return Config(
        dry_run=_b("ARB_DRY_RUN", True),
        live=_b("ARB_LIVE", False),

        bankroll_c=_i("ARB_BANKROLL_USD", 0) * 100,
        max_stake_per_opp_c=_i("ARB_MAX_STAKE_USD", 100) * 100,
        max_deployed_c=_i("ARB_MAX_DEPLOYED_USD", 500) * 100,
        max_contracts=_i("ARB_MAX_CONTRACTS", 500),

        min_profit_c=_i("ARB_MIN_PROFIT_C", 25),
        min_roi=_f("ARB_MIN_ROI", 0.01),
        safety_margin_c=_i("ARB_SAFETY_MARGIN_C", 1),

        kalshi_taker_rate=_f("ARB_KALSHI_TAKER_RATE", 0.07),
        poly_taker_bps=_f("ARB_POLY_TAKER_BPS", 0.0),
        poly_fixed_cost_c=_i("ARB_POLY_FIXED_COST_C", 0),

        book_depth=_i("ARB_BOOK_DEPTH", 10),
        max_events=_i("ARB_MAX_EVENTS", 400),
        request_timeout=_i("ARB_TIMEOUT", 20),
        scan_kalshi=_b("ARB_SCAN_KALSHI", True),
        scan_polymarket=_b("ARB_SCAN_POLYMARKET", True),
        cross_venue=_b("ARB_CROSS_VENUE", False),

        telegram_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
        telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID", "").strip(),
        state_blob_url=os.getenv("STATE_BLOB_URL", "").strip(),
        ledger_path=os.getenv("ARB_LEDGER", "arb/ledger.jsonl").strip(),
        pairs_path=os.getenv("ARB_PAIRS", "arb/pairs.json").strip(),
        kalshi_api_base=os.getenv(
            "KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2").strip(),
        kalshi_key_id=os.getenv("KALSHI_KEY_ID", "").strip(),
        kalshi_private_key=os.getenv("KALSHI_PRIVATE_KEY", "").strip(),
        kalshi_bearer=os.getenv("KALSHI_BEARER", "").strip(),
    )


def can_trade_live(cfg: Config) -> bool:
    """Both gates plus real credentials, or we stay on paper."""
    return (not cfg.dry_run) and cfg.live and bool(
        cfg.kalshi_bearer or (cfg.kalshi_key_id and cfg.kalshi_private_key))
