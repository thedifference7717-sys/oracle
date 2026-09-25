"""Walk-forward tuning for Oracle Trendline on BTCUSDT.

Settings are ranked on the IN-SAMPLE window only (2020-09 → 2024-08) and then
reported on the untouched OUT-OF-SAMPLE window (2024-09 → end of data). The
out-of-sample numbers are the ones to believe; in-sample is what the search
optimised and is always flattering.

Grid (per chart timeframe 15m and 1H):
  slope filter · MA separation · HTF confluence rule (3 / 4 / all, ± 4H+D anchor)
  · confirmation line · stop placement · exit plan

Exit plans
  thirds   ⅓ at 1R / 2R / 3R, stop to entry after TP1      (the indicator today)
  fix2     all out at 2R
  fix3     all out at 3R
  runner   ½ at 1R, stop to entry, rest held until the trend (candle colour) flips
  trend    whole position held until the trend flips (initial stop only)

Usage:  python tune.py [--csv 5m.csv] [--fee 0.0005]
"""
import argparse
import itertools
import os
import sys

import numpy as np
import pandas as pd
from numba import njit

from backtest import HTFS, SECS, load_binance, resample, to_frame

IS_START, OOS_START = pd.Timestamp("2020-09-01", tz="UTC"), pd.Timestamp("2024-09-01", tz="UTC")
PLANS = ["thirds", "fix2", "fix3", "runner", "trend"]
SLS = ["swing", "atr1.5", "atr2.5", "type2"]
CONFS = ["3of", "4of", "all", "3of+4H/D", "4of+4H/D", "all+4H/D"]
SLOPES = [0.0, 0.01, 0.02, 0.04]
SEPS = [0.0, 0.05, 0.15]
LINES = ["type1", "type2"]
DEFAULT = dict(slope=0.01, sep=0.05, conf="3of", line="type1", sl="swing", plan="thirds")


def trend_state(df, slope_min, sep_min, t1=20, t2=50, t3=200, k=5):
    c = df.close
    f = c.ewm(span=t1, adjust=False).mean()
    m = c.ewm(span=t2, adjust=False).mean()
    s = c.rolling(t3).mean()
    sl = lambda x: (x - x.shift(k)) / x.shift(k) * 100 / k  # noqa: E731
    sf, sm, sb = sl(f), sl(m), sl(s)
    spaced = np.minimum((f - m).abs(), (m - s).abs()) / c * 100 >= sep_min
    bull = (f > m) & (m > s) & (sf > slope_min) & (sm > slope_min) & (sb > 0) & spaced
    bear = (f < m) & (m < s) & (sf < -slope_min) & (sm < -slope_min) & (sb < 0) & spaced
    return f.values, m.values, np.where(bull, 1, np.where(bear, -1, 0)).astype(np.int8)


@njit(cache=True)
def sim(O, H, L, C, F, M, T, okB, okS, atr, swLo, swHi, line, sl_mode, plan, fee, confirm):
    n = len(C)
    out_i = np.empty(n, np.int64)
    out_r = np.empty(n, np.float64)
    k = 0
    d = 0
    entry = sl = risk = 0.0
    hits = 0
    bar = -1
    rem = 1.0
    got = 0.0
    bT = aT = lastB = lastA = -1
    for i in range(n):
        closed = False
        if d != 0 and i > bar:
            up = d == 1
            if (up and L[i] <= sl) or ((not up) and H[i] >= sl):
                got += rem * d * (sl - entry) / risk
                closed = True
            else:
                if plan == 0:
                    for j in range(1, 4):
                        tp = entry + d * risk * j
                        if hits < j and ((up and H[i] >= tp) or ((not up) and L[i] <= tp)):
                            hits = j
                            got += j / 3.0
                            rem -= 1.0 / 3.0
                            if j == 1:
                                sl = entry
                    if hits == 3:
                        closed = True
                elif plan == 1 or plan == 2:
                    tp = entry + d * risk * (plan + 1)
                    if (up and H[i] >= tp) or ((not up) and L[i] <= tp):
                        got += plan + 1.0
                        rem = 0.0
                        closed = True
                else:
                    if plan == 3 and hits == 0:
                        tp = entry + d * risk
                        if (up and H[i] >= tp) or ((not up) and L[i] <= tp):
                            hits = 1
                            got += 0.5
                            rem = 0.5
                            sl = entry
                    if T[i] != d:
                        got += rem * d * (C[i] - entry) / risk
                        closed = True
            if closed:
                out_i[k] = bar
                out_r[k] = got - 2.0 * fee * entry / risk
                k += 1
                d = 0
        ln = F[i] if line == 0 else M[i]
        if T[i] == 1 and L[i] <= ln:
            bT = i
        if T[i] == -1 and H[i] >= ln:
            aT = i
        freshB = bT >= 0 and i - bT <= confirm and bT > lastB
        freshA = aT >= 0 and i - aT <= confirm and aT > lastA
        buy = T[i] == 1 and okB[i] and freshB and C[i] > ln and C[i] > O[i] and d != 1
        sell = (not buy) and T[i] == -1 and okS[i] and freshA and C[i] < ln and C[i] < O[i] and d != -1
        if not (buy or sell):
            continue
        nd = 1 if buy else -1
        if d != 0:  # reverse at this close
            got += rem * d * (C[i] - entry) / risk
            out_i[k] = bar
            out_r[k] = got - 2.0 * fee * entry / risk
            k += 1
        if sl_mode == 0:
            raw = swLo[i] - atr[i] * 0.25 if nd == 1 else swHi[i] + atr[i] * 0.25
        elif sl_mode == 1:
            raw = C[i] - nd * atr[i] * 1.5
        elif sl_mode == 2:
            raw = C[i] - nd * atr[i] * 2.5
        else:
            raw = M[i] - nd * atr[i] * 0.25
        risk = max(nd * (C[i] - raw), atr[i] * 0.25)
        d = nd
        entry = C[i]
        sl = entry - d * risk
        hits = 0
        rem = 1.0
        got = 0.0
        bar = i
        if nd == 1:
            lastB = i
        else:
            lastA = i
    if d != 0:
        got += rem * d * (C[n - 1] - entry) / risk
        out_i[k] = bar
        out_r[k] = got - 2.0 * fee * entry / risk
        k += 1
    return out_i[:k], out_r[:k]


def stats(r, years):
    if len(r) == 0:
        return dict(n=0, R=0.0, Ryr=0.0, pf=0.0, win=0.0, dd=0.0, t=0.0)
    eq = np.r_[0, np.cumsum(r)]
    loss = -r[r < 0].sum()
    sd = r.std(ddof=1) if len(r) > 1 else 0.0
    return dict(n=len(r), R=float(r.sum()), Ryr=float(r.sum() / years),
                pf=float(r[r > 0].sum() / loss) if loss else 99.0, win=float((r > 0).mean()),
                dd=float((np.maximum.accumulate(eq) - eq).max()),
                t=float(r.mean() / sd * np.sqrt(len(r))) if sd > 0 else 0.0)


def prepare(base5, chart_tf):
    df = base5 if chart_tf == "5m" else resample(base5, HTFS[chart_tf])
    prev = df.close.shift()
    tr = np.maximum(df.high - df.low, np.maximum((df.high - prev).abs(), (df.low - prev).abs()))
    ctx = dict(df=df, O=df.open.values, H=df.high.values, L=df.low.values, C=df.close.values,
               atr=tr.ewm(alpha=1 / 14, adjust=False).mean().values,
               swLo=df.low.rolling(10).min().values, swHi=df.high.rolling(10).max().values,
               htf={name: resample(base5, rule) for name, rule in HTFS.items()
                    if SECS[name] > SECS[chart_tf]})
    idx = df.index
    ctx["is_mask"] = lambda i: (idx[i] >= IS_START) & (idx[i] < OOS_START)  # noqa: E731
    ctx["oos_mask"] = lambda i: idx[i] >= OOS_START  # noqa: E731
    ctx["yrs_is"] = (OOS_START - max(IS_START, idx[0])).days / 365.25
    ctx["yrs_oos"] = (idx[-1] - OOS_START).days / 365.25
    return ctx


def votes(ctx, chart_tf, slope, sep):
    df = ctx["df"]
    F, M, T = trend_state(df, slope, sep)
    vs = {chart_tf: T}
    for name, h in ctx["htf"].items():
        rule = HTFS[name]
        hs = pd.Series(trend_state(h, slope, sep)[2], index=h.index).shift(1)
        vs[name] = hs.reindex(df.index.floor(rule)).fillna(0).astype(np.int8).values
    V = np.vstack(list(vs.values()))
    names = list(vs.keys())
    ok = {}
    for conf in CONFS:
        base, _, anchor = conf.partition("+")
        need = len(names) if base == "all" else min(int(base[0]), len(names))
        b = (V == 1).sum(0) >= need
        s = (V == -1).sum(0) >= need
        if anchor:
            for a in ("4H", "D"):
                if a in vs:
                    b &= vs[a] == 1
                    s &= vs[a] == -1
        ok[conf] = (b, s)
    return F, M, T, ok


def run_cfg(ctx, F, M, T, ok, cfg, fee):
    okB, okS = ok[cfg["conf"]]
    i, r = sim(ctx["O"], ctx["H"], ctx["L"], ctx["C"], F, M, T, okB, okS, ctx["atr"], ctx["swLo"], ctx["swHi"],
               LINES.index(cfg["line"]), SLS.index(cfg["sl"]), PLANS.index(cfg["plan"]), fee, 3)
    return (stats(r[ctx["is_mask"](i)], ctx["yrs_is"]), stats(r[ctx["oos_mask"](i)], ctx["yrs_oos"]))


def fmt(cfg):
    return f"slope {cfg['slope']} · sep {cfg['sep']} · {cfg['conf']} · {cfg['line']} · SL {cfg['sl']} · {cfg['plan']}"


def row(label, s):
    return (f"| {label} | {s['n']} | {s['win']:.0%} | {s['pf']:.2f} | {s['R']:+.1f} | {s['Ryr']:+.1f} | "
            f"{s['dd']:.1f} | {s['t']:+.2f} |")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    ap.add_argument("--fee", type=float, default=0.0005)
    ap.add_argument("--min-trades-per-year", type=float, default=15)
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
    print(f"data {base.index[0]:%Y-%m-%d} → {base.index[-1]:%Y-%m-%d} ({len(base)} 5m bars)", file=sys.stderr)

    hdr = "| Config | Trades | Win | PF | Net R | R / yr | Max DD (R) | t-stat |\n|---|---|---|---|---|---|---|---|"
    out = [f"# Oracle Trendline tuning — BTCUSDT, fee {a.fee:.2%}/side\n",
           f"In-sample {IS_START:%Y-%m} → {OOS_START - pd.Timedelta(days=1):%Y-%m} (search) · "
           f"out-of-sample {OOS_START:%Y-%m} → {base.index[-1]:%Y-%m} (never seen by the search).\n",
           "Ranking = in-sample t-stat of per-trade net R (mean / sd × √n), min trades/yr applied.\n"]
    picks = {}
    for tf in ("15m", "1H"):
        ctx = prepare(base, tf)
        res = []
        for slope, sep in itertools.product(SLOPES, SEPS):
            F, M, T, ok = votes(ctx, tf, slope, sep)
            for conf, line, sl, plan in itertools.product(CONFS, LINES, SLS, PLANS):
                cfg = dict(slope=slope, sep=sep, conf=conf, line=line, sl=sl, plan=plan)
                s_is, s_oos = run_cfg(ctx, F, M, T, ok, cfg, a.fee)
                res.append((cfg, s_is, s_oos))
        print(f"{tf}: {len(res)} configs", file=sys.stderr)
        ok_res = [x for x in res if x[1]["n"] >= a.min_trades_per_year * ctx["yrs_is"]]
        ok_res.sort(key=lambda x: x[1]["t"], reverse=True)
        top = ok_res[:15]
        d = next(x for x in res if all(x[0][k] == v for k, v in DEFAULT.items()))
        oos_top20 = [x[2]["R"] for x in ok_res[:20]]
        oos_all = np.array([x[2]["R"] for x in ok_res])
        out += [f"\n## {tf}\n",
                f"{len(res)} configs tested, {len(ok_res)} with enough in-sample trades. "
                f"Out-of-sample net R — top-20 in-sample picks: median {np.median(oos_top20):+.1f}, "
                f"{sum(v > 0 for v in oos_top20)}/20 profitable · all configs: median {np.median(oos_all):+.1f}, "
                f"{(oos_all > 0).mean():.0%} profitable.\n",
                "### Default settings\n", hdr, row("in-sample", d[1]), row("**out-of-sample**", d[2]),
                "\n### Top 15 by in-sample t-stat (IS → OOS)\n",
                "| # | Config | IS trades | IS R/yr | IS PF | IS t | OOS trades | **OOS R/yr** | **OOS PF** | OOS DD | OOS win |",
                "|---|---|---|---|---|---|---|---|---|---|---|"]
        for n, (cfg, si, so) in enumerate(top, 1):
            out.append(f"| {n} | {fmt(cfg)} | {si['n']} | {si['Ryr']:+.1f} | {si['pf']:.2f} | {si['t']:+.2f} | "
                       f"{so['n']} | **{so['Ryr']:+.1f}** | **{so['pf']:.2f}** | {so['dd']:.1f} | {so['win']:.0%} |")
        # which single choices generalise? mean OOS R/yr across all configs sharing each value
        out += ["\n### Out-of-sample R/yr by setting (mean over every config with that value)\n",
                "| Setting | Values |", "|---|---|"]
        for key, vals in (("plan", PLANS), ("sl", SLS), ("conf", CONFS), ("line", LINES),
                          ("slope", SLOPES), ("sep", SEPS)):
            cells = []
            for v in vals:
                xs = [x[2]["Ryr"] for x in ok_res if x[0][key] == v]
                cells.append(f"{v}: {np.mean(xs):+.1f}" if xs else f"{v}: —")
            out.append(f"| {key} | {' · '.join(cells)} |")
        picks[tf] = top[0]
    report = "\n".join(out)
    print(report)
    with open("tune-report.md", "w") as fh:
        fh.write(report)


if __name__ == "__main__":
    main()
