"""Telegram delivery, mirroring btc-alerts/notify.py."""
import requests

_TIMEOUT = 20


def send(token, chat_id, text):
    """Send a Telegram message. Returns True on success.

    Without credentials the message is printed, so a dry run exercises the full
    formatting path without secrets.
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


def format_opportunity(opp, executed=False):
    tag = "FILLED" if executed else ("PAPER" if opp.verified_pair else "REVIEW")
    lines = [
        f"<b>[{tag}] {opp.kind.replace('_', ' ').title()}</b>",
        f"{opp.title}",
        f"venues: {', '.join(opp.venues)}  |  {opp.contracts} contracts",
        f"cost ${opp.cost_c/100:.2f} -> payout ${opp.payout_c/100:.2f}",
        f"<b>profit ${opp.profit_c/100:.2f} ({opp.roi:.2%} on capital)</b>",
        "",
    ]
    for leg in opp.legs:
        lines.append(
            f"  {leg.quote.venue} {leg.quote.side.upper()} {leg.quote.label} "
            f"x{leg.contracts} @ <={leg.limit_c}c "
            f"(vwap {leg.vwap_c:.1f}c, fee {leg.fee_c}c)")
    for note in opp.notes:
        lines.append(f"\n  NOTE: {note}")
    return "\n".join(lines)
