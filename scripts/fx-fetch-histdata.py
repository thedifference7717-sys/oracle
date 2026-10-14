"""Fetch FX history from histdata.com into the tuner's cache.

Downloads histdata's free 1-minute bars (generic ASCII) for the five pairs —
a zip per past year, a zip per month of the current year — and rolls them up
to 1-hour candles in UTC, written as .cache/fx/<PAIR>.json for
scripts/fx-tune.mjs. histdata stamps bars in EST with no daylight saving
(always UTC-5).

  python scripts/fx-fetch-histdata.py [first_year]
"""
import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timezone

import requests

PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "USDCHF", "USDJPY"]
FIRST = int(sys.argv[1]) if len(sys.argv) > 1 else 2019
PAGE = "https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/"
EST = 5 * 3600

S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def fetch_zip(pair, year, month=None):
    """One histdata zip (year, or year+month), or None when it isn't there."""
    ref = PAGE + f"{pair.lower()}/{year}" + (f"/{month}" if month else "")
    for attempt in range(3):
        try:
            r = S.get(ref, timeout=60)
            m = re.search(r'id="tk"[^>]*value="([^"]+)"', r.text) or re.search(r'value="([^"]+)"[^>]*id="tk"', r.text)
            if r.status_code != 200 or not m:
                return None
            data = {"tk": m.group(1), "date": str(year),
                    "datemonth": f"{year}{month:02d}" if month else str(year),
                    "platform": "ASCII", "timeframe": "M1", "fxpair": pair}
            z = S.post("https://www.histdata.com/get.php", data=data, timeout=180,
                       headers={"Referer": ref, "Origin": "https://www.histdata.com"})
            if z.status_code == 200 and z.content[:2] == b"PK":
                return z.content
            return None
        except requests.RequestException as e:
            print(f"    {pair} {year}{'/' + str(month) if month else ''}: {e} — retry", flush=True)
            time.sleep(5 * (attempt + 1))
    return None


def bars_from_zip(blob, hours):
    """Fold 1-minute rows into the `hours` dict {utc_hour_start: [o, h, l, c]}."""
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for name in zf.namelist():
            if not name.lower().endswith(".csv"):
                continue
            for line in io.TextIOWrapper(zf.open(name), encoding="ascii", errors="ignore"):
                p = line.strip().split(";")
                if len(p) < 5:
                    continue
                try:
                    dt = datetime.strptime(p[0], "%Y%m%d %H%M%S").replace(tzinfo=timezone.utc)
                    o, h, l, c = float(p[1]), float(p[2]), float(p[3]), float(p[4])
                except ValueError:
                    continue
                t = int(dt.timestamp()) + EST
                k = t - t % 3600
                b = hours.get(k)
                if b is None:
                    hours[k] = [o, h, l, c, t]
                else:
                    if t < b[4]:
                        b[0], b[4] = o, t      # earlier minute → its open
                    b[1] = max(b[1], h)
                    b[2] = min(b[2], l)
                    if t >= b[4]:
                        b[3] = c


def main():
    now = datetime.now(timezone.utc)
    os.makedirs(".cache/fx", exist_ok=True)
    for pair in PAIRS:
        hours = {}
        jobs = [(y, None) for y in range(FIRST, now.year)] + [(now.year, m) for m in range(1, now.month + 1)]
        for y, m in jobs:
            blob = fetch_zip(pair, y, m)
            n0 = len(hours)
            if blob:
                bars_from_zip(blob, hours)
            print(f"  {pair} {y}{'/' + str(m) if m else ''}: {'+' + str(len(hours) - n0) + ' hours' if blob else 'not available'}", flush=True)
            time.sleep(1)
        if not hours:
            print(f"{pair}: no data from histdata", flush=True)
            continue
        out = [{"t": k, "o": v[0], "h": v[1], "l": v[2], "c": v[3]} for k, v in sorted(hours.items())]
        with open(f".cache/fx/{pair}.json", "w") as f:
            json.dump(out, f)
        a = datetime.fromtimestamp(out[0]["t"], timezone.utc).date()
        b = datetime.fromtimestamp(out[-1]["t"], timezone.utc).date()
        print(f"{pair}: {len(out)} hourly candles, {a} → {b}", flush=True)


if __name__ == "__main__":
    main()
