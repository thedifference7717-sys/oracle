"""Quick-trade research: short-hold BTCUSDT systems on 5m / 15m, walk-forward.

Families
  rsi2     Connors-style: RSI(2) extreme against the move, exit on close back
           through SMA 5 or after N bars
  bband    close beyond k·σ of the 20-bar mean, exit at the mean or after N bars
  vwap     close k·ATR away from the UTC-day VWAP, exit at VWAP or after N bars
  orb      opening-range breakout at 00:00 / 08:00 / 13:30 UTC, one trade per
           session, stop at the far side or middle of the range, exit at a
           target or when the session window ends
  sweep    wick through the N-bar low/high that closes back inside (stop-hunt
           reversal), stop beyond the wick, target in R, time stop
  burst    big candle (k·ATR body) with optional volume spike, trade it as
           continuation or fade, fixed hold

Every trade is flat within a few hours. Entries fill at the signal bar's close;
inside a bar the stop is assumed to hit before the target. Returns are % of
notional at 1× (no leverage), after fees for:
  taker 0.05%/side (market orders)   maker 0.02%/side (limit orders)

Settings are ranked on IN-SAMPLE 2020-09 → 2024-08 only; OUT-OF-SAMPLE is
2024-09 → end of data.
"""
import io
import itertools
import os
import sys
import urllib.request
import zipfile

import numpy as np
import pandas as pd
from numba import njit

from backtest import month_list

IS_START, OOS_START = pd.Timestamp("2020-09-01", tz="UTC"), pd.Timestamp("2024-09-01", tz="UTC")
FEES = {"taker": 0.0005, "maker": 0.0002}


# ───────────────────────────── data ─────────────────────────────
def load():
    cache = os.environ.get("BTC_CACHE_V", "btc5m_v.pkl")
    if os.path.exists(cache):
        return pd.read_pickle(cache)
    now = pd.Timestamp.now(tz="UTC")
    frames = []
    for ym in month_list((now.year - 2020) * 12 + now.month - 1):
        url = f"https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/5m/BTCUSDT-5m-{ym}.zip"
        try:
            raw = urllib.request.urlopen(url, timeout=60).read()
        except Exception as e:  # noqa: BLE001
            print(f"  skip {ym}: {e}", file=sys.stderr)
            continue
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            frames.append(pd.read_csv(z.open(z.namelist()[0]), header=None, usecols=[0, 1, 2, 3, 4, 5, 9]))
    df = pd.concat(frames)
    df.columns = ["t", "open", "high", "low", "close", "volume", "taker_buy"]
    t = df["t"].astype("int64").values
    t = np.where(t > 1e14, t // 1_000_000, np.where(t > 1e11, t // 1000, t))
    df.index = pd.to_datetime(t, unit="s", utc=True)
    df = df.drop(columns="t").astype(float)
    df = df[~df.index.duplicated()].sort_index()
    df.to_pickle(cache)
    return df


def resample(df, rule):
    return df.resample(rule, label="left", closed="left").agg(
        dict(open="first", high="max", low="min", close="last", volume="sum", taker_buy="sum")).dropna()


# ───────────────────────────── engine ─────────────────────────────
@njit(cache=True)
def sim(H, L, C, sigL, sigS, sdL, sdS, tdL, tdS, exL, exS, maxb):
    """sd*/td* = stop / target distance in price (NaN = none). ex* = exit at close. maxb = time stop."""
    n = len(C)
    o_i = np.empty(n, np.int64)
    o_g = np.empty(n, np.float64)
    o_h = np.empty(n, np.int64)
    k = 0
    d = 0
    entry = stop = tgt = 0.0
    bar = -1
    for i in range(n):
        if d != 0 and i > bar:
            px = np.nan
            if d == 1:
                if L[i] <= stop:
                    px = stop
                elif tgt == tgt and H[i] >= tgt:
                    px = tgt
                elif exL[i] or i - bar >= maxb:
                    px = C[i]
            else:
                if H[i] >= stop:
                    px = stop
                elif tgt == tgt and L[i] <= tgt:
                    px = tgt
                elif exS[i] or i - bar >= maxb:
                    px = C[i]
            if px == px:
                o_i[k] = bar
                o_g[k] = d * (px - entry) / entry
                o_h[k] = i - bar
                k += 1
                d = 0
        nd = 1 if sigL[i] else (-1 if sigS[i] else 0)
        if nd == 0 or nd == d:
            continue
        if d != 0:
            o_i[k] = bar
            o_g[k] = d * (C[i] - entry) / entry
            o_h[k] = i - bar
            k += 1
        sd = sdL[i] if nd == 1 else sdS[i]
        td = tdL[i] if nd == 1 else tdS[i]
        entry = C[i]
        stop = entry - nd * sd if sd == sd else (-1e18 if nd == 1 else 1e18)
        tgt = entry + nd * td if td == td else np.nan
        d = nd
        bar = i
    return o_i[:k], o_g[:k], o_h[:k]


def stats(g, held, fee, years, bar_min):
    if len(g) == 0:
        return dict(n=0, ny=0.0, bps=0.0, win=0.0, pf=0.0, ret=0.0, ryr=0.0, dd=0.0, t=0.0, hold=0.0)
    r = g - 2 * fee
    eq = np.r_[0, np.cumsum(r)]
    loss = -r[r < 0].sum()
    sd = r.std(ddof=1) if len(r) > 1 else 0.0
    return dict(n=len(r), ny=len(r) / years, bps=float(r.mean() * 1e4), win=float((r > 0).mean()),
                pf=float(r[r > 0].sum() / loss) if loss else 99.0, ret=float(r.sum() * 100),
                ryr=float(r.sum() * 100 / years), dd=float((np.maximum.accumulate(eq) - eq).max() * 100),
                t=float(r.mean() / sd * np.sqrt(len(r))) if sd > 0 else 0.0,
                hold=float(np.mean(held) * bar_min))


# ───────────────────────────── features ─────────────────────────────
def features(df, base5, rule):
    C, H, L, O = df.close, df.high, df.low, df.open
    prev = C.shift()
    tr = np.maximum(H - L, np.maximum((H - prev).abs(), (L - prev).abs()))
    f = dict(atr=tr.ewm(alpha=1 / 14, adjust=False).mean())
    d = C.diff()
    up = d.clip(lower=0).ewm(alpha=1 / 2, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / 2, adjust=False).mean()
    f["rsi2"] = (100 - 100 / (1 + up / dn.replace(0, np.nan))).fillna(100)
    f["sma5"] = C.rolling(5).mean()
    f["sma20"] = C.rolling(20).mean()
    f["sd20"] = C.rolling(20).std()
    f["sma200"] = C.rolling(200).mean()
    day = df.index.floor("1D")
    tp = (H + L + C) / 3
    f["vwap"] = (tp * df.volume).groupby(day).cumsum() / df.volume.groupby(day).cumsum()
    f["vol_avg"] = df.volume.rolling(50).mean()
    h1 = resample(base5, "1h")
    e50 = h1.close.ewm(span=50, adjust=False).mean()
    above = (h1.close > e50).astype(float).shift(1).reindex(df.index.floor("1h")).values  # previous closed hour
    f["up1h"], f["dn1h"] = above == 1.0, above == 0.0
    return {k: (v.values if hasattr(v, "values") else v) for k, v in f.items()}


def trend_masks(df, f, mode):
    C = df.close.values
    if mode == "none":
        return np.ones(len(C), bool), np.ones(len(C), bool)
    if mode == "sma200":
        return C > f["sma200"], C < f["sma200"]
    return f["up1h"], f["dn1h"]


def configs(df, f, bar_min):
    """Yield (family, params, arrays) for every setting in the grid."""
    n = len(df)
    C, H, L, O = (df[c].values for c in ("close", "high", "low", "open"))
    atr = f["atr"]
    nan = np.full(n, np.nan)
    false = np.zeros(n, bool)
    per_h = 60 // bar_min

    for trend in ("none", "sma200", "1h-ema50"):
        tl, ts = trend_masks(df, f, trend)
        # rsi2
        for lvl, ex, stop in itertools.product((5, 10, 20), ("sma5", "time1h", "time2h"), (2.0, 3.0)):
            sl, ss = (f["rsi2"] < lvl) & tl, (f["rsi2"] > 100 - lvl) & ts
            exL, exS = (C > f["sma5"], C < f["sma5"]) if ex == "sma5" else (false, false)
            mb = 4 * per_h if ex == "sma5" else (per_h if ex == "time1h" else 2 * per_h)
            yield "rsi2", dict(trend=trend, rsi=lvl, exit=ex, stop=stop), (sl, ss, stop * atr, stop * atr, nan, nan, exL, exS, mb)
        # bollinger stretch
        z = (C - f["sma20"]) / f["sd20"]
        for k, ex, stop in itertools.product((2.0, 2.5, 3.0), ("mean", "time2h"), (2.0, 3.0)):
            sl, ss = (z < -k) & tl, (z > k) & ts
            exL, exS = (C >= f["sma20"], C <= f["sma20"]) if ex == "mean" else (false, false)
            yield "bband", dict(trend=trend, k=k, exit=ex, stop=stop), (sl, ss, stop * atr, stop * atr, nan, nan, exL, exS, 4 * per_h if ex == "mean" else 2 * per_h)
        # vwap stretch
        dev = (C - f["vwap"]) / atr
        for k, ex, stop in itertools.product((2.0, 3.0, 4.0), ("vwap", "time2h"), (2.0, 3.0)):
            sl, ss = (dev < -k) & tl, (dev > k) & ts
            exL, exS = (C >= f["vwap"], C <= f["vwap"]) if ex == "vwap" else (false, false)
            yield "vwap", dict(trend=trend, k=k, exit=ex, stop=stop), (sl, ss, stop * atr, stop * atr, nan, nan, exL, exS, 4 * per_h if ex == "vwap" else 2 * per_h)
        # liquidity sweep reversal
        for N, strong, R, hold in itertools.product((20, 50, 100), (False, True), (1.0, 1.5, 2.0), (1, 3)):
            pl = pd.Series(L).rolling(N).min().shift(1).values
            ph = pd.Series(H).rolling(N).max().shift(1).values
            rng = np.maximum(H - L, 1e-9)
            sl = (L < pl) & (C > pl) & tl
            ss = (H > ph) & (C < ph) & ts
            if strong:
                sl &= (C - L) / rng >= 0.6
                ss &= (H - C) / rng >= 0.6
            sdl = C - L + 0.1 * atr
            sds = H - C + 0.1 * atr
            yield "sweep", dict(trend=trend, N=N, strong=strong, R=R, hold_h=hold), (sl, ss, sdl, sds, R * sdl, R * sds, false, false, hold * per_h)
        # momentum burst
        body = C - O
        for k, volx, mode, hold, stop in itertools.product((1.5, 2.5), (0.0, 2.0), ("cont", "fade"), (1, 3), (1.5, 3.0)):
            big = np.abs(body) > k * atr
            if volx:
                big &= df.volume.values > volx * f["vol_avg"]
            bull, bear = big & (body > 0), big & (body < 0)
            sl, ss = (bull, bear) if mode == "cont" else (bear, bull)
            yield "burst", dict(trend=trend, k=k, volx=volx, mode=mode, hold_h=hold, stop=stop), (sl & tl, ss & ts, stop * atr, stop * atr, nan, nan, false, false, hold * per_h)

    # opening-range breakout (trend filter: none / sma200)
    idx = df.index
    day = idx.floor("1D")
    mins = ((idx - day).total_seconds() // 60).values
    for (s_name, s_min), orl, stopm, tgt, win, trend in itertools.product(
            (("00:00", 0), ("08:00", 480), ("13:30", 810)), (30, 60), ("far", "mid"), (1.0, 2.0, 0.0), (120, 240),
            ("none", "sma200")):
        if orl % bar_min or s_min % bar_min:
            continue
        rel = mins - s_min
        in_or = (rel >= 0) & (rel < orl)
        in_win = (rel >= orl) & (rel < orl + win)
        orh = pd.Series(np.where(in_or, H, np.nan)).groupby(day).transform("max").values
        orlo = pd.Series(np.where(in_or, L, np.nan)).groupby(day).transform("min").values
        brk = in_win & ((C > orh) | (C < orlo))
        first = brk & (pd.Series(brk.astype(int)).groupby(day).cumsum().values == 1)
        tl, ts = trend_masks(df, f, trend)
        sl, ss = first & (C > orh) & tl, first & (C < orlo) & ts
        far_l, far_s = C - orlo, orh - C
        mid = (orh + orlo) / 2
        sdl = far_l if stopm == "far" else C - mid
        sds = far_s if stopm == "far" else mid - C
        end = in_win & (rel >= orl + win - bar_min)
        tdl = tgt * sdl if tgt else nan
        tds = tgt * sds if tgt else nan
        yield "orb", dict(session=s_name, or_min=orl, stop=stopm, tgt=tgt or "session-end", win_min=win, trend=trend), \
            (sl, ss, sdl, sds, tdl, tds, end, end, 10 ** 9)


def fmt(p):
    return " · ".join(f"{k}={v}" for k, v in p.items())


def main():
    base = load()
    print(f"data {base.index[0]:%Y-%m-%d} → {base.index[-1]:%Y-%m-%d}", file=sys.stderr)
    y_is = (OOS_START - IS_START).days / 365.25
    out = ["# Quick-trade research — BTCUSDT 5m / 15m\n",
           f"In-sample {IS_START:%Y-%m} → {OOS_START - pd.Timedelta(days=1):%Y-%m} (ranking) · out-of-sample "
           f"{OOS_START:%Y-%m} → {base.index[-1]:%Y-%m}. Returns are % of notional at 1×, after fees; bps = "
           "average net return per trade in hundredths of a percent. Stop assumed hit before target inside a bar.\n"]
    for tf, rule, bar_min in (("5m", None, 5), ("15m", "15min", 15)):
        df = base if rule is None else resample(base, rule)
        f = features(df, base, rule)
        H, L, C = df.high.values, df.low.values, df.close.values
        idx = df.index
        y_oos = (idx[-1] - OOS_START).days / 365.25
        rows = []
        for fam, p, (sl, ss, sdl, sds, tdl, tds, exl, exs, mb) in configs(df, f, bar_min):
            sl = np.asarray(sl, bool) & (idx >= IS_START)
            ss = np.asarray(ss, bool) & (idx >= IS_START)
            i, g, h = sim(H, L, C, sl, ss, np.asarray(sdl, float), np.asarray(sds, float), np.asarray(tdl, float),
                          np.asarray(tds, float), np.asarray(exl, bool), np.asarray(exs, bool), int(mb))
            t = idx[i]
            m_is, m_oos = t < OOS_START, t >= OOS_START
            res = {fee_name: (stats(g[m_is], h[m_is], fee, y_is, bar_min), stats(g[m_oos], h[m_oos], fee, y_oos, bar_min))
                   for fee_name, fee in FEES.items()}
            res["gross"] = (stats(g[m_is], h[m_is], 0.0, y_is, bar_min), stats(g[m_oos], h[m_oos], 0.0, y_oos, bar_min))
            rows.append((fam, p, res))
        print(f"{tf}: {len(rows)} configs", file=sys.stderr)
        out.append(f"\n## {tf} — {len(rows)} settings\n")
        out += ["### Families (share of settings with positive out-of-sample return)\n",
                "| Family | Settings | Gross avg bps IS / OOS | OOS + (gross) | OOS + (maker) | OOS + (taker) |",
                "|---|---|---|---|---|---|"]
        for fam in ("rsi2", "bband", "vwap", "orb", "sweep", "burst"):
            g = [r for r in rows if r[0] == fam and r[2]["gross"][0]["n"] >= 30 * y_is]
            if not g:
                continue
            out.append(f"| {fam} | {len(g)} | {np.mean([r[2]['gross'][0]['bps'] for r in g]):+.1f} / "
                       f"{np.mean([r[2]['gross'][1]['bps'] for r in g]):+.1f} | "
                       f"{np.mean([r[2]['gross'][1]['ret'] > 0 for r in g]):.0%} | "
                       f"{np.mean([r[2]['maker'][1]['ret'] > 0 for r in g]):.0%} | "
                       f"{np.mean([r[2]['taker'][1]['ret'] > 0 for r in g]):.0%} |")
        for fee_name in ("taker", "maker"):
            ok = [r for r in rows if r[2][fee_name][0]["n"] >= 30 * y_is]
            ok.sort(key=lambda r: r[2][fee_name][0]["t"], reverse=True)
            top = ok[:12]
            oos_top = [r[2][fee_name][1]["ret"] for r in ok[:20]]
            out += [f"\n### Top 12 by in-sample t-stat at {fee_name} fees ({FEES[fee_name]:.2%}/side)\n",
                    f"Top-20 picks profitable out-of-sample: {sum(v > 0 for v in oos_top)}/20.\n",
                    "| # | Family · settings | IS trades/yr | IS bps | IS %/yr | IS t | OOS trades/yr | **OOS bps** | "
                    "**OOS %/yr** | OOS PF | OOS win | OOS max DD % | OOS t | avg hold |",
                    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
            for n_, (fam, p, res) in enumerate(top, 1):
                a, b = res[fee_name]
                out.append(f"| {n_} | **{fam}** · {fmt(p)} | {a['ny']:.0f} | {a['bps']:+.1f} | {a['ryr']:+.1f} | {a['t']:+.2f} | "
                           f"{b['ny']:.0f} | **{b['bps']:+.1f}** | **{b['ryr']:+.1f}** | {b['pf']:.2f} | {b['win']:.0%} | "
                           f"{b['dd']:.1f} | {b['t']:+.2f} | {b['hold']:.0f} min |")
    report = "\n".join(out)
    print(report)
    with open("scalp-report.md", "w") as fh:
        fh.write(report)


if __name__ == "__main__":
    main()
