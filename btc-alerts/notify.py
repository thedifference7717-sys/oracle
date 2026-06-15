"""Telegram delivery. Falls back to stdout when credentials are absent."""
import requests

_TIMEOUT = 20


def send(token, chat_id, text):
    """Send a Telegram message. Returns True on success.

    With no token/chat_id (e.g. a manual dry run) the message is printed
    instead of sent, so the strategy logic can be exercised without secrets.
    """
    if not token or not chat_id:
        print("[DRY-RUN no telegram creds] would send:\n" + text)
        return False
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text,
                  "parse_mode": "HTML", "disable_web_page_preview": True},
            timeout=_TIMEOUT,
        )
        if not r.ok:
            print(f"[telegram error {r.status_code}] {r.text}")
        return r.ok
    except Exception as e:  # noqa: BLE001
        print(f"[telegram exception] {e}")
        return False
