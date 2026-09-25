"""Robustness check for the round-2 candidate: Donchian breakout + ADX filter.

Sweeps the neighbourhood of the pick (lookback, ADX floor, stop ATR, target R)
on 4H and 1H, and breaks the centre setting down by year, by side and by fee.
A real edge should hold across neighbours, most years and both fee levels.
"""
import itertools
import os
import sys

import numpy as np
import pandas as pd
from numba import njit

from backtest import load_binance, resample
from explore import adx
from tune import IS_START, OOS_START, stats


@njit(cache=True)
def sim(H, L, C, candL, candS, atr, stop_atr, rr, fee):
    """rr > 0: all out at rr·R. rr == 0: 3-ATR chandelier trail."""
    n = len(C)
    out_i = np.empty(n, np.int64)
    out_d = np.empty(n, np.int64)
    out_r = np.empty(n, np.float64)
    k = 0
    d = 0
    entry = sl = risk = ext = 0.0
    bar = -1
    for i in range(n):
        if d != 0 and i > bar:
            up = d == 1
            px = 0.0
            done = False
            if (up and L[i] <= sl) or ((not up) and H[i] >= sl):
                px, done = sl, True
            elif rr > 0:
                tp = entry + d * risk * rr
                if (up and H[i] >= tp) or ((not up) and L[i] <= tp):
                    px, done = tp, True
            else:
                ext = max(ext, H[i]) if up else min(ext, L[i])
                t = ext - d * 3.0 * atr[i]
                sl = max(sl, t) if up else min(sl, t)
            if done:
                out_i[k], out_d[k] = bar, d
                out_r[k] = d * (px - entry) / risk - 2.0 * fee * entry / risk
                k += 1
                d = 0
        nd = 1 if candL[i] else (-1 if candS[i] else 0)
        if nd == 0 or nd == d:
            continue
        if d != 0:
            out_i[k], out_d[k] = bar, d
            out_r[k] = d * (C[i] - entry) / risk - 2.0 * fee * entry / risk
            k += 1
        risk = stop_atr * atr[i]
        d, entry, bar, ext = nd, C[i], i, C[i]
        sl = entry - d * risk
    if d != 0:
        out_i[k], out_d[k] = bar, d
        out_r[k] = d * (C[n - 1] - entry) / risk - 2.0 * fee * entry / risk
        k += 1
    return out_i[:k], out_d[:k], out_r[:k]


def main():
    cache = os.environ.get("BTC_CACHE", "btc5m.pkl")
    if os.path.exists(cache):
        base = pd.read_pickle(cache)
    else:
        n = (pd.Timestamp.now(tz="UTC").year - 2020) * 12 + pd.Timestamp.now(tz="UTC").month - 1 - 8
        base = load_binance(n)
        base.to_pickle(cache)
    out = ["# Donchian + ADX candidate — robustness\n",
           f"IS {IS_START:%Y-%m} → {OOS_START - pd.Timedelta(days=1):%Y-%m} · OOS {OOS_START:%Y-%m} → "
           f"{base.index[-1]:%Y-%m}. Stop = N×ATR(14) from the close; targets in R; fee 0.05%/side unless noted.\n"]
    for tf, rule in (("4H", "4h"), ("1H", "1h")):
        df = resample(base, rule)
        H, L, C = df.high.values, df.low.values, df.close.values
        ADX, ATR = adx(df)
        sma200 = df.close.rolling(200).mean().values
        idx = df.index
        is_m = (idx >= IS_START) & (idx < OOS_START)
        oos_m = idx >= OOS_START
        y_is, y_oos = (OOS_START - IS_START).days / 365.25, (idx[-1] - OOS_START).days / 365.25

        def run(N, adx_min, stop_atr, rr, fee=0.0005):
            hi = df.high.rolling(N).max().shift(1).values
            lo = df.low.rolling(N).min().shift(1).values
            f = ADX > adx_min
            cl = (C > hi) & (C > sma200) & f
            cs = (C < lo) & (C < sma200) & f
            return sim(H, L, C, cl, cs, ATR, stop_atr, rr, fee)

        rows = []
        for N, am, sa, rr in itertools.product((20, 30, 40, 55), (20, 25, 30), (2.0, 2.5, 3.0), (2.0, 3.0, 4.0, 0.0)):
            i, d, r = run(N, am, sa, rr)
            rows.append(((N, am, sa, rr), stats(r[is_m[i]], y_is), stats(r[oos_m[i]], y_oos)))
        pos_is = np.mean([x[1]["R"] > 0 for x in rows])
        pos_oos = np.mean([x[2]["R"] > 0 for x in rows])
        both = np.mean([x[1]["R"] > 0 and x[2]["R"] > 0 for x in rows])
        out += [f"\n## {tf} — neighbourhood ({len(rows)} settings: N 20/30/40/55 · ADX 20/25/30 · stop 2/2.5/3 ATR · "
                "target 2R/3R/4R/chandelier)\n",
                f"Profitable in-sample {pos_is:.0%} · out-of-sample {pos_oos:.0%} · both {both:.0%}. "
                f"Median R/yr IS {np.median([x[1]['Ryr'] for x in rows]):+.1f} · OOS "
                f"{np.median([x[2]['Ryr'] for x in rows]):+.1f}.\n",
                "| Group | IS R/yr (mean) | OOS R/yr (mean) | OOS profitable |", "|---|---|---|---|"]
        for label, pos, vals in (("N", 0, (20, 30, 40, 55)), ("ADX >", 1, (20, 25, 30)),
                                 ("stop ATR", 2, (2.0, 2.5, 3.0)), ("target", 3, (2.0, 3.0, 4.0, 0.0))):
            for v in vals:
                g = [x for x in rows if x[0][pos] == v]
                name = "chandelier" if (pos == 3 and v == 0) else v
                out.append(f"| {label} {name} | {np.mean([x[1]['Ryr'] for x in g]):+.1f} | "
                           f"{np.mean([x[2]['Ryr'] for x in g]):+.1f} | {np.mean([x[2]['R'] > 0 for x in g]):.0%} |")

        centre = (20, 25, 2.5, 3.0)
        i, d, r = run(*centre)
        t = idx[i]
        out += [f"\n### {tf} centre setting: Donchian 20 · ADX > 25 · 2.5 ATR stop · all out at 3R\n",
                "| Slice | Trades | Win | PF | Net R | Max DD (R) |", "|---|---|---|---|---|---|"]
        for y in range(IS_START.year, idx[-1].year + 1):
            m = (t >= max(IS_START, pd.Timestamp(f"{y}-01-01", tz="UTC"))) & (t < pd.Timestamp(f"{y + 1}-01-01", tz="UTC"))
            s = stats(r[m], 1)
            out.append(f"| {y}{' (from Sep)' if y == IS_START.year else ''}{' (to Aug)' if y == idx[-1].year else ''} "
                       f"| {s['n']} | {s['win']:.0%} | {s['pf']:.2f} | {s['R']:+.1f} | {s['dd']:.1f} |")
        live = t >= IS_START
        for side, sv in (("longs", 1), ("shorts", -1)):
            for lab, m in (("IS", is_m[i]), ("OOS", oos_m[i])):
                s = stats(r[m & (d == sv)], 1)
                out.append(f"| {side} {lab} | {s['n']} | {s['win']:.0%} | {s['pf']:.2f} | {s['R']:+.1f} | {s['dd']:.1f} |")
        i2, d2, r2 = run(*centre, fee=0.001)
        for lab, m in (("fee 0.10% IS", is_m[i2]), ("fee 0.10% OOS", oos_m[i2])):
            s = stats(r2[m], 1)
            out.append(f"| {lab} | {s['n']} | {s['win']:.0%} | {s['pf']:.2f} | {s['R']:+.1f} | {s['dd']:.1f} |")
        s = stats(r[live], 1)
        out.append(f"| **all 2020-09 → end** | {s['n']} | {s['win']:.0%} | {s['pf']:.2f} | **{s['R']:+.1f}** | {s['dd']:.1f} |")
        print(f"{tf} done", file=sys.stderr)
    report = "\n".join(out)
    print(report)
    with open("validate-report.md", "w") as fh:
        fh.write(report)


if __name__ == "__main__":
    main()
