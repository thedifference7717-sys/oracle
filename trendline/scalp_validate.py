"""Stress test for the one quick-trade candidate scalp.py surfaced: momentum-burst continuation.

Rule: a candle whose body is larger than k × ATR(14) → trade in its direction,
stop s × ATR, flat after h hours. Optional trend filter.

Checks: neighbourhood (k, stop, hold, trend) on 5m / 15m / 30m, a fee sweep,
entry at the NEXT bar's open (realistic fill) versus the signal close, per-year
and per-side splits of the centre setting.
"""
import itertools
import sys

import numpy as np
import pandas as pd

from scalp import IS_START, OOS_START, features, load, resample, sim, stats, trend_masks

FEE_SWEEP = (0.0, 0.0002, 0.00035, 0.0005)


def main():
    base = load()
    y_is = (OOS_START - IS_START).days / 365.25
    out = ["# Momentum-burst continuation — stress test\n",
           f"IS {IS_START:%Y-%m} → {OOS_START - pd.Timedelta(days=1):%Y-%m} · OOS {OOS_START:%Y-%m} → "
           f"{base.index[-1]:%Y-%m}. %/yr at 1× notional. Fee levels per side: 0 · 0.02% (maker) · 0.035% "
           "(maker/taker mix) · 0.05% (taker).\n"]
    for tf, rule, bar_min in (("5m", None, 5), ("15m", "15min", 15), ("30m", "30min", 30)):
        df = base if rule is None else resample(base, rule)
        f = features(df, base, rule)
        O, H, L, C = (df[c].values for c in ("open", "high", "low", "close"))
        idx = df.index
        y_oos = (idx[-1] - OOS_START).days / 365.25
        atr = f["atr"]
        live = idx >= IS_START
        per_h = 60 // bar_min
        false = np.zeros(len(C), bool)
        nan = np.full(len(C), np.nan)

        def run(k, stop, hold_h, trend, next_open=False):
            tl, ts = trend_masks(df, f, trend)
            body = C - O
            big = np.abs(body) > k * atr
            sl, ss = big & (body > 0) & tl & live, big & (body < 0) & ts & live
            mb = max(1, int(round(hold_h * per_h)))
            if not next_open:
                return sim(H, L, C, sl, ss, stop * atr, stop * atr, nan, nan, false, false, mb)
            # enter at the next bar's open: shift signals one bar and let the engine fill at that bar's
            # close, then correct the return for the open→close move of the entry bar (the stop is not
            # checked inside the entry bar itself, a small optimistic bias)
            sl2, ss2 = np.r_[False, sl[:-1]], np.r_[False, ss[:-1]]
            i, g, h = sim(H, L, C, sl2, ss2, stop * atr, stop * atr, nan, nan, false, false, mb)
            side = np.where(sl2[i], 1.0, -1.0)
            adj = side * (C[i] - O[i]) / O[i]  # move from the open fill to the engine's close fill
            return i, g * C[i] / O[i] + adj, h

        rows = []
        for k, stop, hold, trend in itertools.product((2.0, 2.5, 3.0, 3.5), (1.0, 1.5, 2.0, 3.0),
                                                      (0.5, 1, 2, 3, 4), ("none", "sma200", "1h-ema50")):
            i, g, h = run(k, stop, hold, trend)
            t = idx[i]
            m_is, m_oos = t < OOS_START, t >= OOS_START
            rows.append(((k, stop, hold, trend), {fee: (stats(g[m_is], h[m_is], fee, y_is, bar_min),
                                                        stats(g[m_oos], h[m_oos], fee, y_oos, bar_min))
                                                  for fee in FEE_SWEEP}))
        out += [f"\n## {tf} — {len(rows)} neighbouring settings (k 2–3.5 · stop 1–3 ATR · hold 0.5–4 h · 3 trend filters)\n",
                "| Fee / side | Profitable IS | Profitable OOS | Both | Median OOS %/yr | Median OOS bps/trade |",
                "|---|---|---|---|---|---|"]
        for fee in FEE_SWEEP:
            a = [r[1][fee][0] for r in rows]
            b = [r[1][fee][1] for r in rows]
            out.append(f"| {fee:.3%} | {np.mean([x['ret'] > 0 for x in a]):.0%} | {np.mean([x['ret'] > 0 for x in b]):.0%} | "
                       f"{np.mean([x['ret'] > 0 and y['ret'] > 0 for x, y in zip(a, b)]):.0%} | "
                       f"{np.median([x['ryr'] for x in b]):+.1f} | {np.median([x['bps'] for x in b]):+.1f} |")
        out += ["\nMean OOS %/yr at 0.035%/side by setting:\n", "| Setting | Values |", "|---|---|"]
        for label, pos, vals in (("k (body/ATR)", 0, (2.0, 2.5, 3.0, 3.5)), ("stop ATR", 1, (1.0, 1.5, 2.0, 3.0)),
                                 ("hold h", 2, (0.5, 1, 2, 3, 4)), ("trend", 3, ("none", "sma200", "1h-ema50"))):
            cells = [f"{v}: {np.mean([r[1][0.00035][1]['ryr'] for r in rows if r[0][pos] == v]):+.1f}" for v in vals]
            out.append(f"| {label} | {' · '.join(cells)} |")

        centre = (2.5, 1.5, 1, "none")
        out += [f"\n### {tf} centre: body > 2.5 ATR · stop 1.5 ATR · 1 h hold · no trend filter\n",
                "| Slice | Trades | Win | PF | %/yr or % | bps/trade | Max DD % |", "|---|---|---|---|---|---|---|"]
        for label, nxt in (("signal-close entry", False), ("next-open entry", True)):
            i, g, h = run(*centre, next_open=nxt)
            t = idx[i]
            for fee in (0.0002, 0.00035, 0.0005):
                for lab, m, yrs in (("IS", t < OOS_START, y_is), ("OOS", t >= OOS_START, y_oos)):
                    s = stats(g[m], h[m], fee, yrs, bar_min)
                    out.append(f"| {label} · fee {fee:.3%} · {lab} | {s['n']} | {s['win']:.0%} | {s['pf']:.2f} | "
                               f"{s['ryr']:+.1f}/yr | {s['bps']:+.1f} | {s['dd']:.1f} |")
        i, g, h = run(*centre)
        t = idx[i]
        body_sign = np.sign(C[i] - O[i])
        for y in range(IS_START.year, idx[-1].year + 1):
            m = (t >= max(IS_START, pd.Timestamp(f"{y}-01-01", tz="UTC"))) & (t < pd.Timestamp(f"{y + 1}-01-01", tz="UTC"))
            s = stats(g[m], h[m], 0.00035, 1, bar_min)
            out.append(f"| {y} · fee 0.035% | {s['n']} | {s['win']:.0%} | {s['pf']:.2f} | {s['ret']:+.1f} | {s['bps']:+.1f} | {s['dd']:.1f} |")
        for lab, sv in (("longs", 1), ("shorts", -1)):
            m = body_sign == sv
            s = stats(g[m], h[m], 0.00035, 1, bar_min)
            out.append(f"| {lab} all years · fee 0.035% | {s['n']} | {s['win']:.0%} | {s['pf']:.2f} | {s['ret']:+.1f} | {s['bps']:+.1f} | {s['dd']:.1f} |")
        print(f"{tf} done", file=sys.stderr)
    report = "\n".join(out)
    print(report)
    with open("scalp-validate-report.md", "w") as fh:
        fh.write(report)


if __name__ == "__main__":
    main()
