"""Backtest the 4h 50% Fib + 15m SMC strategy on historical BTC.

This replays the EXACT live logic (``indicators.compute_step1`` /
``compute_step2``) bar-by-bar with no look-ahead, simulates the entry, the
0.886 stop and the trailing stop, applies fees, and reports edge metrics.

A backtest is NOT a promise of future profit. It only measures whether the
rules had an edge on this sample, under the assumptions you give it. Treat a
thin sample (few trades / short history) with suspicion.

Usage:
    python btc-alerts/backtest.py                 # fetch recent 15m and test
    python btc-alerts/backtest.py 8               # fetch 8 pages (~more history)
    python btc-alerts/backtest.py data.csv        # backtest a CSV you provide
        CSV columns: time,open,high,low,close  (header optional)
"""
import csv as _csv
import json
import sys
import urllib.request

import config
import indicators


# ── data ────────────────────────────────────────────────────────────────────
def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "btc-backtest"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def fetch_15m(pages=4):
    """Pull recent 15m BTC/USD bars from CryptoCompare (keyless), paging back."""
    merged, to_ts = {}, None
    for _ in range(pages):
        url = ("https://min-api.cryptocompare.com/data/v2/histominute"
               "?fsym=BTC&tsym=USD&aggregate=15&limit=2000")
        if to_ts:
            url += f"&toTs={to_ts}"
        data = (_get(url).get("Data") or {}).get("Data") or []
        if not data:
            break
        for d in data:
            if d["close"] > 0:
                merged[d["time"]] = {"t": d["time"], "o": d["open"], "h": d["high"],
                                     "l": d["low"], "c": d["close"]}
        to_ts = data[0]["time"] - 1
    return [merged[t] for t in sorted(merged)]


def load_csv(path):
    """OHLC from CSV columns time,open,high,low,close (header tolerated)."""
    rows = []
    with open(path) as f:
        for row in _csv.reader(f):
            if not row or len(row) < 5:
                continue
            try:
                o, h, l, c = (float(row[1]), float(row[2]), float(row[3]), float(row[4]))
            except ValueError:
                continue  # header row
            try:
                t = int(float(row[0]))
            except ValueError:
                t = len(rows)
            rows.append({"t": t, "o": o, "h": h, "l": l, "c": c})
    rows.sort(key=lambda b: b["t"])
    return rows


def aggregate_4h(c15):
    """Aggregate ascending 15m bars into 4h buckets (no look-ahead)."""
    out, bucket = [], None
    for b in c15:
        k = b["t"] - (b["t"] % 14400)
        if bucket is None or bucket["t"] != k:
            bucket = {"t": k, "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"]}
            out.append(bucket)
        else:
            bucket["h"] = max(bucket["h"], b["h"])
            bucket["l"] = min(bucket["l"], b["l"])
            bucket["c"] = b["c"]
    return out


# ── replay ──────────────────────────────────────────────────────────────────
def _close_trade(trade, exit_px, fee, trades):
    entry, R, d = trade["entry"], trade["R"], trade["dir"]
    gross = (exit_px - entry) if d == "long" else (entry - exit_px)
    net = gross - fee * (entry + exit_px)      # taker fee on entry + exit notional
    trades.append({"dir": d, "entry": entry, "exit": exit_px, "r_mult": net / R})


def run_backtest(c15, *, fee=0.0005, warmup=200):
    """Replay the strategy. One position at a time. Returns list of trades."""
    trades, st, trade = [], {"leg_id": None, "armed": False}, None
    p4h = config.PIVOT_STRENGTH_4H

    for i in range(warmup, len(c15)):
        bar, closed15 = c15[i], c15[:i + 1]

        # 1) Manage an open position against this bar (stop / trailing stop).
        if trade:
            if trade["dir"] == "long":
                trade["best"] = max(trade["best"], bar["h"])
                trail = max(trade["stop0"], trade["best"] - trade["R"])
                if bar["l"] <= trail:
                    _close_trade(trade, trail, fee, trades); trade = None
            else:
                trade["best"] = min(trade["best"], bar["l"])
                trail = min(trade["stop0"], trade["best"] + trade["R"])
                if bar["h"] >= trail:
                    _close_trade(trade, trail, fee, trades); trade = None
            if trade:
                continue                       # don't seek a new entry while in one

        # 2) Flat → evaluate the staged setup exactly like the live bot.
        c4h = aggregate_4h(closed15)
        if len(c4h) < p4h * 2 + 3:
            continue
        s1 = indicators.compute_step1(c4h[:-1], c4h[-1], p4h, config.FIB_ZONE_BAND)
        if not s1:
            continue
        if st["leg_id"] != s1["leg_id"]:
            st = {"leg_id": s1["leg_id"], "armed": False}
        if s1["invalidated"]:
            st["armed"] = False
            continue
        if s1["in_zone"]:
            st["armed"] = True
        if not st["armed"]:
            continue
        s2 = indicators.compute_step2(closed15, s1["direction"],
                                      config.PIVOT_STRENGTH_15M, config.CONSECUTIVE_CANDLES)
        if s2["confirmed"]:
            entry, stop0 = s2["last_close"], s1["stop_886"]
            R = abs(entry - stop0)
            if R > 0:
                trade = {"dir": s1["direction"], "entry": entry, "stop0": stop0,
                         "R": R, "best": entry}
                st["armed"] = False            # require a fresh zone tag to re-arm
    return trades


# ── metrics ─────────────────────────────────────────────────────────────────
def report(trades, capital=46900.0, risk_pct=2.0):
    n = len(trades)
    print("=" * 56)
    print(f"Trades: {n}")
    if n == 0:
        print("No setups triggered on this sample — widen the dataset.")
        print("=" * 56)
        return
    rs = [t["r_mult"] for t in trades]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    total_R = sum(rs)
    gross_win, gross_loss = sum(wins), -sum(losses)
    pf = gross_win / gross_loss if gross_loss > 0 else float("inf")
    eq = peak = mdd = 0.0
    for r in rs:
        eq += r; peak = max(peak, eq); mdd = min(mdd, eq - peak)
    risk_usd = capital * risk_pct / 100.0
    longs = sum(1 for t in trades if t["dir"] == "long")

    print(f"Win rate:        {len(wins)/n*100:5.1f}%   ({len(wins)}W / {len(losses)}L)")
    print(f"Avg win:         {(gross_win/len(wins) if wins else 0):+5.2f} R")
    print(f"Avg loss:        {(sum(losses)/len(losses) if losses else 0):+5.2f} R")
    print(f"Expectancy:      {total_R/n:+5.2f} R per trade")
    print(f"Profit factor:   {pf:5.2f}")
    print(f"Total:           {total_R:+6.2f} R")
    print(f"Max drawdown:    {mdd:6.2f} R")
    print(f"Direction mix:   {longs} long / {n - longs} short")
    print("-" * 56)
    print(f"At {risk_pct:.0f}% risk on ${capital:,.0f}  (1R = ${risk_usd:,.0f}):")
    print(f"  Net P/L:       ${total_R * risk_usd:+,.0f}")
    print(f"  Max drawdown:  ${mdd * risk_usd:,.0f}")
    print("=" * 56)
    print("Backtest ≠ future results. Validate on out-of-sample data before trusting it.")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0].endswith(".csv"):
        c15 = load_csv(a[0]); src = a[0]
    else:
        c15 = fetch_15m(pages=int(a[0]) if a and a[0].isdigit() else 4); src = "CryptoCompare 15m"
    print(f"Loaded {len(c15)} 15m bars from {src}")
    report(run_backtest(c15))
