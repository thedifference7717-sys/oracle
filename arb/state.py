"""Cross-run state: which opportunities we have already acted on or alerted.

Backed by the same keyless jsonblob store the BTC alerts use, so a scheduled
run has memory without a database. Degrades to an in-memory no-op when no blob
URL is configured, which keeps local dry runs working.
"""
import time

import requests

_TIMEOUT = 20
_TTL_S = 6 * 3600


def load_state(url):
    if not url:
        return {}
    try:
        r = requests.get(url, timeout=_TIMEOUT)
        if r.ok:
            data = r.json()
            return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 - treat any failure as empty state
        pass
    return {}


def save_state(url, state):
    if not url:
        return
    try:
        requests.put(url, json=state,
                     headers={"Content-Type": "application/json"},
                     timeout=_TIMEOUT)
    except Exception:  # noqa: BLE001 - state is best-effort, never crash a run
        pass


def seen_recently(state, key, ttl_s=_TTL_S):
    """True if we already alerted on this key inside the TTL.

    Books repeat the same stale edge scan after scan; without this the alert
    channel becomes unreadable and the real new signal is lost in it.
    """
    ts = (state.get("seen") or {}).get(key)
    return bool(ts) and (time.time() - ts) < ttl_s


def mark_seen(state, key):
    state.setdefault("seen", {})[key] = time.time()


def prune(state, ttl_s=_TTL_S):
    now = time.time()
    state["seen"] = {k: v for k, v in (state.get("seen") or {}).items()
                     if now - v < ttl_s}
    return state
