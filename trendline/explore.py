"""Round 2: new entry ideas for Oracle Trendline, same walk-forward split as tune.py.

Entries (all require the chart's MA trend framework for context)
  pullback      the current indicator: touch Type 1, re-confirm within 3 candles
  pb-break{W}   touch Type 1, then enter on a close above the pullback's high
                (below its low for shorts) within W candles
  donchian{N}   close beyond the prior N-bar high/low, on the side of the 200 base

Filters   regime (none / ADX>20 / ADX>25) · higher-TF (none / daily MA stack /
          3-of-N confluence) · session (all hours / 12-21 UTC, intraday only)
Stops     2.5 ATR · swing (10-bar extreme ± 0.25 ATR)
Exits     fix2 / fix3 (all out at 2R / 3R) · chand (3 ATR trailing stop from the
          best price since entry) · flip (exit when the candle colour changes)

Picked on 2020-09 → 2024-08, reported on 2024-09 → end of data.
"""
import argparse
import itertools
import os
import sys

import numpy as np
import pandas as pd
from numba import njit

from backtest import HTFS, SECS, load_binance, resample, to_frame
from tune import IS_START, OOS_START, stats, trend_state

ENTRIES = ["pullback", "pb-break3", "pb-break6", "pb-break10", "donchian20", "donchian55"]
REGIMES = ["none", "adx20", "adx25"]
HTFF = ["none", "D-stack", "3ofN"]
SESS = ["all", "12-21UTC"]
STOPS = ["atr2.5", "swing"]
EXITS = ["fix2", "fix3", "chand", "flip"]


@njit(cache=True)
def pullback_cands(H, L, C, O, F, T, mode, W):
    """mode 0: re-confirm close beyond Type 1 (the indicator). mode 1: break of the pullback extreme."""
    n = len(C)
    cl = np.zeros(n, np.bool_)
    cs = np.zeros(n, np.bool_)
    tB = tA = -1
    usedB = usedA = -1
    pbH = pbL = 0.0
    for i in range(n):
        if T[i] == 1 and L[i] <= F[i]:
            if tB < 0 or i - tB > W or usedB == tB:
                pbH = H[i]
                tB = i
            else:
                pbH = max(pbH, H[i])
                tB = i if mode == 0 else tB
        if T[i] == -1 and H[i] >= F[i]:
            if tA < 0 or i - tA > W or usedA == tA:
                pbL = L[i]
                tA = i
            else:
                pbL = min(pbL, L[i])
                tA = i if mode == 0 else tA
        if tB >= 0 and usedB != tB and T[i] == 1 and i - tB <= W:
            ok = (C[i] > F[i] and C[i] > O[i]) if mode == 0 else (i > tB and C[i] > pbH)
            if ok:
                cl[i] = True
                usedB = tB
        if tA >= 0 and usedA != tA and T[i] == -1 and i - tA <= W:
            ok = (C[i] < F[i] and C[i] < O[i]) if mode == 0 else (i > tA and C[i] < pbL)
            if ok:
                cs[i] = True
                usedA = tA
        if mode == 1:  # extend the pullback extreme after the check
            if tB >= 0 and i > tB:
                pbH = max(pbH, H[i]) if not cl[i] else pbH
            if tA >= 0 and i > tA:
                pbL = min(pbL, L[i]) if not cs[i] else pbL
    return cl, cs


@njit(cache=True)
def sim(H, L, C, T, candL, candS, atr, swLo, swHi, stop_mode, exit_mode, fee):
    n = len(C)
    out_i = np.empty(n, np.int64)
    out_r = np.empty(n, np.float64)
    k = 0
    d = 0
    entry = sl = risk = ext = 0.0
    bar = -1
    for i in range(n):
        if d != 0 and i > bar:
            up = d == 1
            done = False
            px = 0.0
            if (up and L[i] <= sl) or ((not up) and H[i] >= sl):
                px = sl
                done = True
            elif exit_mode <= 1:
                tp = entry + d * risk * (exit_mode + 2)
                if (up and H[i] >= tp) or ((not up) and L[i] <= tp):
                    px = tp
                    done = True
            elif exit_mode == 3 and T[i] != d:
                px = C[i]
                done = True
            if exit_mode == 2 and not done:  # chandelier: trail after the bar is checked
                ext = max(ext, H[i]) if up else min(ext, L[i])
                trail = ext - d * 3.0 * atr[i]
                sl = max(sl, trail) if up else min(sl, trail)
            if done:
                out_i[k] = bar
                out_r[k] = d * (px - entry) / risk - 2.0 * fee * entry / risk
                k += 1
                d = 0
        nd = 1 if candL[i] else (-1 if candS[i] else 0)
        if nd == 0 or nd == d:
            continue
        if d != 0:
            out_i[k] = bar
            out_r[k] = d * (C[i] - entry) / risk - 2.0 * fee * entry / risk
            k += 1
        raw = C[i] - nd * atr[i] * 2.5 if stop_mode == 0 else (
            swLo[i] - atr[i] * 0.25 if nd == 1 else swHi[i] + atr[i] * 0.25)
        risk = max(nd * (C[i] - raw), atr[i] * 0.25)
        d = nd
        entry = C[i]
        sl = entry - d * risk
        ext = C[i]
        bar = i
    if d != 0:
        out_i[k] = bar
        out_r[k] = d * (C[n - 1] - entry) / risk - 2.0 * fee * entry / risk
        k += 1
    return out_i[:k], out_r[:k]


def adx(df, n=14):
    up, dn = df.high.diff(), -df.low.diff()
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    ndm = np.where((dn > up) & (dn > 0), dn, 0.0)
    prev = df.close.shift()
    tr = np.maximum(df.high - df.low, np.maximum((df.high - prev).abs(), (df.low - prev).abs()))
    a = lambda x: pd.Series(x, index=df.index).ewm(alpha=1 / n, adjust=False).mean()  # noqa: E731
    atr_ = a(tr)
    pdi, ndi = 100 * a(pdm) / atr_, 100 * a(ndm) / atr_
    dx = 100 * (pdi - ndi).abs() / (pdi + ndi).replace(0, np.nan)
    return a(dx.fillna(0).values).values, atr_.values


def htf_state(base5, df, rule, slope, sep):
    h = resample(base5, rule)
    s = pd.Series(trend_state(h, slope, sep)[2], index=h.index).shift(1)
    return s.reindex(df.index.floor(rule)).fillna(0).astype(np.int8).values


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    ap.add_argument("--fee", type=float, default=0.0005)
    a = ap.parse_args()
    cache = os.environ.get("BTC_CACHE", "btc5m.pkl")
    if a.csv:
        base = to_frame(pd.read_csv(a.csv).iloc[:, :5])
    elif os.path.exists(cache):
        base = pd.read_pickle(cache)
    else:
        n = (pd.Timestamp.now(tz="UTC").year - 2020) * 12 + pd.Timestamp.now(tz="UTC").month - 1 - 8
        base = load_binance(n)
        base.to_pickle(cache)

    out = [f"# Oracle Trendline — round 2 entry ideas (BTCUSDT, fee {a.fee:.2%}/side)\n",
           f"Pick on {IS_START:%Y-%m} → {OOS_START - pd.Timedelta(days=1):%Y-%m}; report on "
           f"{OOS_START:%Y-%m} → {base.index[-1]:%Y-%m}. Ranking = in-sample t-stat of per-trade net R.\n"]
    for tf in ("15m", "1H", "4H"):
        df = resample(base, HTFS[tf]) if tf != "4H" else resample(base, "4h")
        O, H, L, C = (df[c].values for c in ("open", "high", "low", "close"))
        F, M, T = trend_state(df, 0.01, 0.05)
        base200 = df.close.rolling(200).mean().values
        ADX, ATR = adx(df)
        swLo, swHi = df.low.rolling(10).min().values, df.high.rolling(10).max().values
        dstate = htf_state(base, df, "1D", 0.0, 0.0)
        names = [n for n in HTFS if SECS[n] > SECS[tf]]
        V = np.vstack([T] + [htf_state(base, df, HTFS[n], 0.01, 0.05) for n in names])
        need = min(3, V.shape[0])
        conf_b, conf_s = (V == 1).sum(0) >= need, (V == -1).sum(0) >= need
        hour = df.index.hour.values
        idx = df.index
        is_m = lambda i: (idx[i] >= IS_START) & (idx[i] < OOS_START)  # noqa: E731
        oos_m = lambda i: idx[i] >= OOS_START  # noqa: E731
        y_is = (OOS_START - IS_START).days / 365.25
        y_oos = (idx[-1] - OOS_START).days / 365.25

        cands = {}
        for e in ENTRIES:
            if e == "pullback":
                cands[e] = pullback_cands(H, L, C, O, F, T, 0, 3)
            elif e.startswith("pb-break"):
                cands[e] = pullback_cands(H, L, C, O, F, T, 1, int(e[8:]))
            else:
                N = int(e[8:])
                hi = df.high.rolling(N).max().shift(1).values
                lo = df.low.rolling(N).min().shift(1).values
                cands[e] = ((C > hi) & (C > base200), (C < lo) & (C < base200))

        res = []
        sess_opts = SESS if tf != "4H" else ["all"]
        for e, rg, hf, ss, st, ex in itertools.product(ENTRIES, REGIMES, HTFF, sess_opts, STOPS, EXITS):
            cl, cs = cands[e]
            m = np.ones(len(C), bool)
            if rg != "none":
                m &= ADX > int(rg[3:])
            if ss != "all":
                m &= (hour >= 12) & (hour < 21)
            mb, ms = m.copy(), m.copy()
            if hf == "D-stack":
                mb &= dstate == 1
                ms &= dstate == -1
            elif hf == "3ofN":
                mb &= conf_b
                ms &= conf_s
            i, r = sim(H, L, C, T, cl & mb, cs & ms, ATR, swLo, swHi, STOPS.index(st), EXITS.index(ex), a.fee)
            cfg = dict(entry=e, regime=rg, htf=hf, session=ss, stop=st, exit=ex)
            res.append((cfg, stats(r[is_m(i)], y_is), stats(r[oos_m(i)], y_oos)))
        minN = 15 * y_is if tf != "4H" else 6 * y_is
        good = sorted([x for x in res if x[1]["n"] >= minN], key=lambda x: x[1]["t"], reverse=True)
        oos_all = np.array([x[2]["Ryr"] for x in good])
        top20 = [x[2]["Ryr"] for x in good[:20]]
        out += [f"\n## {tf}\n",
                f"{len(res)} configs, {len(good)} with ≥ {minN:.0f} in-sample trades. OOS R/yr — top-20 picks: "
                f"median {np.median(top20):+.1f}, {sum(v > 0 for v in top20)}/20 profitable · all: median "
                f"{np.median(oos_all):+.1f}, {(oos_all > 0).mean():.0%} profitable.\n",
                "| # | Entry · regime · HTF · session · stop · exit | IS n | IS R/yr | IS PF | IS t | OOS n | "
                "**OOS R/yr** | **OOS PF** | OOS t | OOS DD | OOS win |",
                "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for n, (c, si, so) in enumerate(good[:15], 1):
            out.append(f"| {n} | {' · '.join(c.values())} | {si['n']} | {si['Ryr']:+.1f} | {si['pf']:.2f} | "
                       f"{si['t']:+.2f} | {so['n']} | **{so['Ryr']:+.1f}** | **{so['pf']:.2f}** | {so['t']:+.2f} | "
                       f"{so['dd']:.1f} | {so['win']:.0%} |")
        out += ["\nMean OOS R/yr by setting:\n", "| Setting | Values |", "|---|---|"]
        for key, vals in (("entry", ENTRIES), ("regime", REGIMES), ("htf", HTFF), ("session", sess_opts),
                          ("stop", STOPS), ("exit", EXITS)):
            cells = []
            for v in vals:
                xs = [x[2]["Ryr"] for x in good if x[0][key] == v]
                cells.append(f"{v}: {np.mean(xs):+.1f} ({np.mean([x > 0 for x in xs]):.0%}+)" if xs else f"{v}: —")
            out.append(f"| {key} | {' · '.join(cells)} |")
        print(f"{tf}: done", file=sys.stderr)
    report = "\n".join(out)
    print(report)
    with open("explore-report.md", "w") as fh:
        fh.write(report)


if __name__ == "__main__":
    main()
