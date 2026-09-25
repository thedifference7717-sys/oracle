"""Backtest Oracle Trendline on BTCUSDT (Binance spot) across chart timeframes.

A line-for-line port of oracle-trendline.pine with its default inputs:
same MA stack, slope/separation filter, touch-and-reconfirm entry, 8-TF
confluence (previous closed HTF bar), swing stop, 1R/2R/3R targets, stop to
entry after TP1, stop checked before targets inside a bar.

Data: monthly 5m kline dumps from data.binance.vision (reachable from CI; the
sandbox can't reach exchanges). 15m / 1h and every HTF are resampled from 5m,
UTC-aligned like TradingView's BINANCE:BTCUSDT.

Usage:  python backtest.py [months=12] [--fee 0.0005]
        python backtest.py --csv candles.csv       (t,o,h,l,c; t in epoch s/ms)
"""
import argparse
import io
import json
import sys
import urllib.request
import zipfile
from datetime import date

import numpy as np
import pandas as pd

P = dict(t1=20, t2=50, t3=200, slopeLen=5, slopeMin=0.01, slopeMinBase=0.0, sepMin=0.05,
         confirmBars=3, minConf=3, swingLen=10, atrLen=14, atrBuf=0.25, rr=(1.0, 2.0, 3.0))
HTFS = {"5m": "5min", "15m": "15min", "30m": "30min", "1H": "1h", "2H": "2h",
        "4H": "4h", "12H": "12h", "D": "1D"}
SECS = {"5m": 300, "15m": 900, "30m": 1800, "1H": 3600, "2H": 7200, "4H": 14400, "12H": 43200, "D": 86400}
WARMUP_MONTHS = 8  # the daily SMA 200 needs ~200 days before the test window


# ───────────────────────────── data ─────────────────────────────
def month_list(n):
    y, m = date.today().year, date.today().month
    out = []
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append(f"{y}-{m:02d}")
    return out[::-1]  # oldest first, last full month last


def load_binance(months):
    frames = []
    for ym in month_list(months + WARMUP_MONTHS):
        url = f"https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/5m/BTCUSDT-5m-{ym}.zip"
        try:
            raw = urllib.request.urlopen(url, timeout=60).read()
        except Exception as e:  # noqa: BLE001
            print(f"  skip {ym}: {e}", file=sys.stderr)
            continue
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            df = pd.read_csv(z.open(z.namelist()[0]), header=None, usecols=[0, 1, 2, 3, 4])
        frames.append(df)
        print(f"  {ym}: {len(df)} bars", file=sys.stderr)
    if not frames:
        raise SystemExit("no data downloaded")
    return to_frame(pd.concat(frames))


def to_frame(df):
    df.columns = ["t", "open", "high", "low", "close"]
    t = df["t"].astype("int64")
    t = np.where(t > 1e14, t // 1_000_000, np.where(t > 1e11, t // 1000, t))  # µs / ms / s → s
    df.index = pd.to_datetime(t, unit="s", utc=True)
    df = df[["open", "high", "low", "close"]].astype(float)
    return df[~df.index.duplicated()].sort_index()


def resample(df, rule):
    return df.resample(rule, label="left", closed="left").agg(
        dict(open="first", high="max", low="min", close="last")).dropna()


# ───────────────────────────── indicator ─────────────────────────────
def state(df):
    c = df.close
    f = c.ewm(span=P["t1"], adjust=False).mean()
    m = c.ewm(span=P["t2"], adjust=False).mean()
    s = c.rolling(P["t3"]).mean()
    k = P["slopeLen"]
    slope = lambda x: (x - x.shift(k)) / x.shift(k) * 100 / k  # noqa: E731
    sf, sm, sb = slope(f), slope(m), slope(s)
    spaced = np.minimum((f - m).abs(), (m - s).abs()) / c * 100 >= P["sepMin"]
    bull = (f > m) & (m > s) & (sf > P["slopeMin"]) & (sm > P["slopeMin"]) & (sb > P["slopeMinBase"]) & spaced
    bear = (f < m) & (m < s) & (sf < -P["slopeMin"]) & (sm < -P["slopeMin"]) & (sb < -P["slopeMinBase"]) & spaced
    return f, m, pd.Series(np.where(bull, 1, np.where(bear, -1, 0)), index=df.index)


def run(base5, chart_tf, test_start):
    df = base5 if chart_tf == "5m" else resample(base5, HTFS[chart_tf])
    fast, med, trend = state(df)

    bullN = np.zeros(len(df), int)
    bearN = np.zeros(len(df), int)
    active = 0
    for name, rule in HTFS.items():
        if SECS[name] < SECS[chart_tf]:
            continue  # the Pine script skips timeframes below the chart's
        active += 1
        if name == chart_tf:
            v = trend.values
        else:  # previous closed HTF bar (request.security(...[1], lookahead_on))
            hs = state(resample(base5, rule))[2].shift(1)
            v = hs.reindex(df.index.floor(rule)).fillna(0).astype(int).values
        bullN += v == 1
        bearN += v == -1
    need = min(P["minConf"], active)

    prev_c = df.close.shift()
    tr = np.maximum(df.high - df.low, np.maximum((df.high - prev_c).abs(), (df.low - prev_c).abs()))
    atr = tr.ewm(alpha=1 / P["atrLen"], adjust=False).mean().values
    swLo = df.low.rolling(P["swingLen"]).min().values
    swHi = df.high.rolling(P["swingLen"]).max().values

    O, H, L, C = (df[k].values for k in ("open", "high", "low", "close"))
    F, M, T = fast.values, med.values, trend.values
    start = df.index.searchsorted(test_start)
    trades, t = [], None
    bT = aT = lastB = lastA = None

    def close_trade(i, reason, px):
        t.update(end=i, reason=reason, exit=px)

    for i in range(len(df)):
        # 1) manage the open trade — stop first, then TP1..TP3
        if t and i > t["bar"]:
            up = t["dir"] == 1
            if (L[i] <= t["sl"]) if up else (H[i] >= t["sl"]):
                close_trade(i, "SL" if t["hits"] == 0 else "BE", t["sl"])
                t = None
            else:
                for k in (1, 2, 3):
                    tp = t["tp"][k - 1]
                    if t["hits"] < k and ((H[i] >= tp) if up else (L[i] <= tp)):
                        t["hits"] = k
                        if k == 1:
                            t["sl"] = t["entry"]
                if t["hits"] == 3:
                    close_trade(i, "TP3", t["tp"][2])
                    t = None
        # 2) touch → re-confirm within N candles
        if T[i] == 1 and L[i] <= F[i]:
            bT = i
        if T[i] == -1 and H[i] >= F[i]:
            aT = i
        freshB = bT is not None and i - bT <= P["confirmBars"] and (lastB is None or bT > lastB)
        freshA = aT is not None and i - aT <= P["confirmBars"] and (lastA is None or aT > lastA)
        buy = T[i] == 1 and bullN[i] >= need and freshB and C[i] > F[i] and C[i] > O[i] and not (t and t["dir"] == 1)
        sell = T[i] == -1 and bearN[i] >= need and freshA and C[i] < F[i] and C[i] < O[i] and not (t and t["dir"] == -1)
        if not (buy or sell):
            continue
        # 3) open (an opposite signal reverses at this close)
        d = 1 if buy else -1
        if t:
            close_trade(i, "REV", C[i])
        raw = swLo[i] - atr[i] * P["atrBuf"] if d == 1 else swHi[i] + atr[i] * P["atrBuf"]
        risk = max(d * (C[i] - raw), atr[i] * 0.25)
        t = dict(dir=d, bar=i, time=df.index[i], entry=C[i], risk=risk, sl=C[i] - d * risk, hits=0,
                 tp=[C[i] + d * risk * r for r in P["rr"]], end=None, reason="OPEN", exit=C[-1])
        if d == 1:
            lastB = i
        else:
            lastA = i
        trades.append(t)
    trades = [x for x in trades if x["bar"] >= start]
    return trades, df.index[start], df.index[-1]


# ───────────────────────────── scoring ─────────────────────────────
def r_multiple(t, plan):
    """R for one trade. plan: 'thirds' (scale out 1/3 at each TP) or 1/2/3 (all out at that TP)."""
    open_r = t["dir"] * (t["exit"] - t["entry"]) / t["risk"]  # for REV / still-open trades
    rest = open_r if t["reason"] in ("REV", "OPEN") else (0.0 if t["hits"] else -1.0)
    if plan == "thirds":
        got = sum(P["rr"][:t["hits"]]) / 3
        return got + rest * (3 - t["hits"]) / 3
    return P["rr"][plan - 1] if t["hits"] >= plan else rest


def score(trades, fee):
    if not trades:
        return dict(trades=0)
    risk_pct = np.array([t["risk"] / t["entry"] * 100 for t in trades])
    cost = np.array([2 * fee * t["entry"] / t["risk"] for t in trades])  # round-trip fee in R
    out = dict(trades=len(trades),
               longs=sum(t["dir"] == 1 for t in trades),
               tp1=np.mean([t["hits"] >= 1 for t in trades]),
               tp2=np.mean([t["hits"] >= 2 for t in trades]),
               tp3=np.mean([t["hits"] >= 3 for t in trades]),
               full_sl=np.mean([t["reason"] == "SL" for t in trades]),
               med_risk_pct=float(np.median(risk_pct)),
               fee_r=float(np.mean(cost)))
    for plan in ("thirds", 1, 2, 3):
        g = np.array([r_multiple(t, plan) for t in trades])
        n = g - cost
        eq = np.cumsum(n)
        wins, losses = n[n > 0].sum(), -n[n < 0].sum()
        out[f"plan_{plan}"] = dict(gross_R=float(g.sum()), net_R=float(n.sum()), avg_net_R=float(n.mean()),
                                   win=float(np.mean(n > 0)), pf=float(wins / losses) if losses else float("inf"),
                                   max_dd_R=float((np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]).max()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("months", nargs="?", type=int, default=12)
    ap.add_argument("--fee", type=float, default=0.0005, help="per side, fraction of price")
    ap.add_argument("--csv")
    ap.add_argument("--json", default="backtest-results.json")
    a = ap.parse_args()

    base = to_frame(pd.read_csv(a.csv).iloc[:, :5]) if a.csv else load_binance(a.months)
    test_start = base.index[-1] - pd.DateOffset(months=a.months)
    results, lines = {}, []
    for tf in ("5m", "15m", "1H"):
        trades, s, e = run(base, tf, test_start)
        results[tf] = sc = score(trades, a.fee)
        results[tf]["window"] = f"{s:%Y-%m-%d} → {e:%Y-%m-%d}"
        if not sc["trades"]:
            lines.append(f"| {tf} | 0 | | | | | | | | |")
            continue
        th = sc["plan_thirds"]
        best = max((1, 2, 3), key=lambda k: sc[f"plan_{k}"]["net_R"])
        lines.append(
            f"| {tf} | {sc['trades']} | {sc['tp1']:.0%} / {sc['tp2']:.0%} / {sc['tp3']:.0%} | {sc['full_sl']:.0%} "
            f"| {sc['med_risk_pct']:.2f}% | {sc['fee_r']:.2f} | {th['gross_R']:+.1f} | {th['net_R']:+.1f} "
            f"| {th['pf']:.2f} | {th['max_dd_R']:.1f} | TP{best}: {sc[f'plan_{best}']['net_R']:+.1f} |")

    hdr = ("| TF | Trades | TP1/TP2/TP3 hit | Full SL | Median risk | Fee (R) | Gross R | Net R | PF (net) | Max DD (R) | Best single target (net R) |\n"
           "|---|---|---|---|---|---|---|---|---|---|---|")
    report = (f"## Oracle Trendline — BTCUSDT backtest ({results['5m'].get('window', '')}, fee {a.fee:.2%}/side)\n\n"
              "Scale-out plan: ⅓ off at TP1 / TP2 / TP3, stop to entry after TP1.\n\n" + hdr + "\n" + "\n".join(lines))
    print(report)
    print(json.dumps(results, indent=1, default=float))
    with open(a.json, "w") as fh:
        json.dump(results, fh, indent=1, default=float)
    return report


if __name__ == "__main__":
    main()
