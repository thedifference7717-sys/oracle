"""Tiny state store backed by a keyless jsonblob blob.

State carries the staged-alert bookkeeping between cron runs so we send each
alert exactly once per setup. If no blob URL is configured the functions
degrade to a no-op in-memory store (useful for local dry runs).
"""
import requests

_TIMEOUT = 20


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
        requests.put(
            url, json=state,
            headers={"Content-Type": "application/json"}, timeout=_TIMEOUT,
        )
    except Exception:  # noqa: BLE001 - state is best-effort, never crash the run
        pass
