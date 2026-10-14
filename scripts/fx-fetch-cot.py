"""Fetch CFTC positioning for the five pairs into data/fx-cot.json.

The CFTC's weekly Traders in Financial Futures report splits open interest in
the CME currency futures by who holds it. "Leveraged funds" are hedge funds and
CTAs — the closest FX has to the crypto ladder's top-trader filter; "asset
managers" are the big real-money funds. Each row is positions as of Tuesday,
published Friday 15:30 New York.

Written per pair, oriented to the pair (the futures are priced in USD per
foreign unit, so for USDCHF and USDJPY the sign flips): positive = net long the
pair. `t` is when the report became public (conservatively Friday 21:00 UTC),
so a replay never sees a report before it was out.

  python scripts/fx-fetch-cot.py [first_year]
"""
import csv
import io
import json
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone

import requests

FIRST = int(sys.argv[1]) if len(sys.argv) > 1 else 2018
# CFTC contract codes for the CME futures, and the sign that turns "long the
# foreign currency" into "long the pair".
CODES = {"099741": ("EURUSD", 1), "096742": ("GBPUSD", 1), "232741": ("AUDUSD", 1),
         "092741": ("USDCHF", -1), "097741": ("USDJPY", -1)}
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}


def col(header, *starts):
    """Index of the first column whose name starts with one of `starts` (case-insensitive)."""
    low = [h.strip().lower() for h in header]
    for s in starts:
        for i, h in enumerate(low):
            if h.startswith(s.lower()):
                return i
    raise KeyError(starts)


def rows_from_year(year):
    url = f"https://www.cftc.gov/files/dea/history/fut_fin_txt_{year}.zip"
    for attempt in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=120)
            if r.status_code == 200 and r.content[:2] == b"PK":
                break
            print(f"  {year}: HTTP {r.status_code}", flush=True)
            return []
        except requests.RequestException as e:
            print(f"  {year}: {e} — retry", flush=True)
            time.sleep(5 * (attempt + 1))
    else:
        return []
    out = []
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        for name in zf.namelist():
            rd = csv.reader(io.TextIOWrapper(zf.open(name), encoding="latin-1"))
            header = next(rd)
            iD = col(header, "Report_Date_as_YYYY-MM-DD", "Report_Date_as_MM_DD_YYYY")
            iC = col(header, "CFTC_Contract_Market_Code")
            iLL = col(header, "Lev_Money_Positions_Long")
            iLS = col(header, "Lev_Money_Positions_Short")
            iAL = col(header, "Asset_Mgr_Positions_Long")
            iAS = col(header, "Asset_Mgr_Positions_Short")
            for p in rd:
                code = p[iC].strip()
                if code not in CODES:
                    continue
                d = p[iD].strip()[:10]
                try:
                    day = datetime.strptime(d, "%Y-%m-%d") if "-" in d else datetime.strptime(d, "%m/%d/%Y")
                    vals = [int(float(p[i])) for i in (iLL, iLS, iAL, iAS)]
                except ValueError:
                    continue
                out.append((code, day.replace(tzinfo=timezone.utc), vals))
    print(f"  {year}: {len(out)} rows", flush=True)
    return out


def main():
    now = datetime.now(timezone.utc)
    rows = []
    for y in range(FIRST, now.year + 1):
        rows += rows_from_year(y)
        time.sleep(1)
    pairs = {p: {} for p, _ in CODES.values()}
    for code, day, (ll, ls, al, as_) in rows:
        pair, sg = CODES[code]
        public = day + timedelta(days=3, hours=21)          # Tuesday's positions, out Friday afternoon
        pairs[pair][day.date().isoformat()] = {"t": int(public.timestamp()), "date": day.date().isoformat(),
                                               "lev": sg * (ll - ls), "am": sg * (al - as_)}
    out = {"updated": now.isoformat(timespec="minutes"),
           "source": "CFTC Traders in Financial Futures (futures only), CME currency futures",
           "pairs": {p: [v[k] for k in sorted(v)] for p, v in pairs.items()}}
    if not all(out["pairs"][p] for p in out["pairs"]):
        sys.exit("CFTC: missing data for " + ", ".join(p for p in out["pairs"] if not out["pairs"][p]))
    with open("data/fx-cot.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    for p, v in out["pairs"].items():
        print(f"{p}: {len(v)} weeks, {v[0]['date']} → {v[-1]['date']} · latest lev {v[-1]['lev']:+,} am {v[-1]['am']:+,}", flush=True)


if __name__ == "__main__":
    main()
