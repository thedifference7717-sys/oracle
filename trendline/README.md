# Oracle Trendline (TradingView indicator)

A from-scratch Pine Script v5 indicator that works the way the public
description of **ZynAlgo Trendline** says it works. ZynAlgo's script is
invite-only and closed source, so this code is not copied from it. It follows
their published feature list, and every threshold is a setting you can change.

![Oracle Trendline on a 15m chart (simulated data)](./preview.png)

*Preview drawn from a Python port of the script's logic on simulated prices, not a TradingView screenshot.*

> Not financial advice. It draws levels and sends alerts. It never places a trade.

## Install

1. TradingView → **Pine Editor** → *Open → New blank indicator*.
2. Paste the contents of [`oracle-trendline.pine`](./oracle-trendline.pine) → **Save** → **Add to chart**.

## How it works

| Piece | Logic |
|---|---|
| **3 MA layers** | Type 1 = fast (EMA 20), Type 2 = medium (EMA 50), Trendline = base (SMA 200). Each can be SMA / EMA / WMA / RMA / HMA / SWMA / ALMA / VWMA / VWAP. |
| **Trend** | **Bull** when Type 1 > Type 2 > Trendline, all three slope up, and the MAs are spaced apart. **Bear** is the mirror. Anything else counts as **Sideways**. |
| **Chop filter** | Type 1 and Type 2 each need a slope above *Min slope* (% per bar over the lookback). The Trendline needs a slope above its own minimum (default: just positive or negative). The MAs must be at least *Min separation* % of price apart. |
| **Candle colours** | Green = uptrend, red = downtrend, white = sideways / no-trade. |
| **Entry** | While trending, price touches the confirmation line (Type 1 or Type 2). Within *N* candles it then closes back on the trend side with a candle in the trend direction. Each touch gives at most one signal. |
| **Multi-timeframe** | Up to 8 timeframes (5m, 15m, 30m, 1H, 2H, 4H, 12H, D) run the same trend test. A signal counts only if at least *Min timeframes agreeing* of them match. Timeframes below the chart's are skipped. |
| **SL** | *Swing*: lowest low / highest high of the last N bars ± an ATR buffer. *ATR*: entry ± ATR × multiplier. *Type 2 line*: the medium MA ± an ATR buffer. |
| **TP1-TP3** | Entry + risk × R:R (default 1R / 2R / 3R). Optionally moves the stop to entry after TP1. |
| **Tracking** | Entry, SL and TP lines extend until the trade ends. The chart marks TP hits and SL/BE exits. An opposite signal reverses the trade. |
| **Dashboard** | Chart trend, each timeframe's vote, confluence count, open position with its levels, and TP hit rates. |

### No repainting

- Signals and trade management run only on **closed** bars (`barstate.isconfirmed`).
- Higher-timeframe values use the previous **closed** HTF bar
  (`f_trend()[1]` with `lookahead_on`), the standard non-repainting pattern.

When the stop and a target fall inside the same candle, the indicator assumes
the stop was hit first (the conservative choice).

## Alerts

- **Simple conditions:** *Buy signal*, *Sell signal*, *Trend turned bullish / bearish / sideways*.
- **Full detail:** create an alert with condition **Any alert() function call**.
  You get messages like
  `BUY XAUUSD [15] entry 2650.10 | SL 2644.80 | TP1 2655.40 | TP2 2660.70 | TP3 2666.00 | HTF 5/7`,
  plus TP1/TP2/TP3 hits and SL/BE exits.

To get these on your phone, point the alert's webhook at the existing
[`tv-webhook`](../tv-webhook) Cloudflare Worker. It relays any plain-text alert to Telegram.

## Tuning tips

- **Gold / forex scalping (1-5m):** keep MTF on with *Min timeframes agreeing* 3-4, and set *Min slope* to 0.005-0.01.
- **Too few signals:** lower *Min slope* or *Min separation*, raise *Re-confirm within*, or switch the confirmation line to Type 2.
- **Too many signals in chop:** raise *Min slope* or *Min timeframes agreeing*.

## Backtest (BTCUSDT, default settings)

`backtest.py` replays the script's default logic on Binance BTCUSDT 5m klines.
It builds 15m, 1H and every higher timeframe from those 5m candles. The
[`trendline-backtest`](../.github/workflows/trendline-backtest.yml) workflow
runs it in Actions, where exchange data is reachable.

Test window: 2025-09-01 → 2026-08-31. Fee: 0.05% per side. Plan: take ⅓ off at
TP1, TP2 and TP3, and move the stop to entry after TP1.

| TF | Trades | TP1 / TP2 / TP3 hit | Full SL | Median risk | Gross R | Net R | PF (net) | Max DD |
|---|---|---|---|---|---|---|---|---|
| 5m | 405 | 50% / 25% / 16% | 50% | 0.40% | −6.0 | **−125.2** | 0.54 | 125 R |
| 15m | 237 | 50% / 25% / 17% | 50% | 0.64% | +1.0 | **−46.9** | 0.68 | 55 R |
| 1H | 80 | 51% / 28% / 19% | 49% | 1.15% | +4.3 | **−4.3** | 0.90 | 9 R |

Before fees, every timeframe is roughly breakeven. Fees cost 0.29 R per trade
on 5m, 0.20 R on 15m and 0.11 R on 1H, so the shorter timeframes lose the most.
With the default settings, none of them made money over this period.

## Tuning (walk-forward, BTCUSDT 2020 → 2026)

`tune.py` tried 2,880 setting combinations per timeframe. They cover the
slope and separation filters, the HTF rule (3 / 4 / all of the timeframes, with
or without requiring 4H and D to agree), the confirmation line, the stop
(swing, 1.5 or 2.5 ATR, Type 2 line) and the exit plan (thirds, all out at 2R,
all out at 3R, half at 1R then a runner, or trend-flip exit). Settings were
chosen on **2020-09 → 2024-08** only and then tested on **2024-09 → 2026-08**.
The workflow is [`trendline-tune`](../.github/workflows/trendline-tune.yml).

**Result: no setting shows a reliable edge.**

- **15m:** 87% of the combinations lost money in the test period. The best
  in-sample picks came out between −1 and +2 R per year, from about 20 trades.
- **1H:** 63% lost money. The only group that made money in both periods is
  *slope 0–0.01 · 3-of-N · Type 1 · 2.5 ATR stop · all out at 3R*. It made
  about +6 R/yr in the tuning period and +9–11 R/yr in the test period, with a
  profit factor around 1.2, 31% winners and a 10–13 R max drawdown. Its
  in-sample t-stat is below 1, and 2,880 combinations were tried, so a result
  this good is likely to appear by luck. Treat it as a hypothesis, not a proven
  edge.

## Round 2: new entry ideas → the tested preset

[`explore.py`](./explore.py) tried pullback-high breakouts and Donchian
breakouts. It combined them with ADX, daily-trend, confluence and trading-hours
filters, and with trailing-stop and trend-flip exits, on 15m, 1H and 4H. The
walk-forward split was the same as above.
[`validate.py`](./validate.py) then checked the best idea's nearby settings,
each year, each side and double fees.

- **15m:** still nothing. 84% of combinations lost money in the test period.
- **1H Donchian:** positive in the test period, but flat to negative in
  2021–2023, with drawdowns above 30 R.
- **4H Donchian + ADX:** the only robust result. Of 144 nearby settings
  (lookback 20–55, ADX 20–30, 2–3 ATR stop, 2R/3R/4R/trailing exit), 90%
  made money in both the tuning and the test period.

**Preset "BTC 4H Breakout (tested)"** (the new default):

- **Buy** on a 4H close above the previous 20-bar high while price is above the
  SMA 200 and ADX(14) > 25. **Sell** is the mirror image.
- **Stop** at 2.5 × ATR(14). **Target:** everything out at 3R. An opposite
  signal reverses the position.

| Period (fee 0.05%/side) | Trades | Win | PF | Net R | Max DD |
|---|---|---|---|---|---|
| Tuning 2020-09 → 2024-08 | 109 | 40% | 1.9 | +59.8 | ≈ 6 R |
| **Test 2024-09 → 2026-08** | 54 | 39% | 1.45 | **+15.4** | 7.5 R |
| All 2020-09 → 2026-08 | 163 | 40% | 1.78 | +75.1 | 7.5 R |
| Test period at double fees (0.10%/side) | 54 | 35% | 1.38 | +13.6 | 8.5 R |

- **By year:** 2020 +12.7, 2021 +8.2, 2022 +1.7, 2023 +25.6, 2024 +18.0,
  2025 **−5.2**, 2026 to Aug +14.0 R.
- **By side:** longs made most of the profit (+57 R in the tuning period,
  +12 R in the test period). Shorts were roughly breakeven (+2.6 / +3.7 R).
- **What to expect:** about +5 to +10 R a year, from roughly 25 trades a year,
  with losing streaks of 7–8 R. That is a modest edge, not a money machine. At
  1% risk per trade, that is roughly 5–10% a year with 7–8% drawdowns. Results
  on one market over six years can still change. Paper-trade it first.

## Quick trades (holds of minutes to a few hours)

[`scalp.py`](./scalp.py) tested 474 settings each on BTCUSDT 5m and 15m across
six families: RSI(2), Bollinger and VWAP stretch fades, session
opening-range breakouts, liquidity-sweep reversals and momentum bursts.
[`scalp_validate.py`](./scalp_validate.py) then stress-tested the one family
that survived. Both use the same split: settings chosen on 2020-09 → 2024-08,
tested on 2024-09 → 2026-08. Returns are % of notional at 1×. The workflow is
[`quick-trades`](../.github/workflows/quick-trades.yml).

- **5m:** nothing beats fees. Raw edges are 1–3 bps (0.01–0.03%) per trade,
  and a round trip costs 4–10 bps.
- **Mean reversion, VWAP, ORB and sweeps:** most show a small raw edge, and
  fees wipe it out.
- **15m momentum-burst continuation** is the only survivor. When a 15m candle's
  body is larger than 2.5 × ATR(14), trade in its direction with a 1.5 × ATR
  stop and exit after a set time. It averages about +11 bps per trade before
  fees, so **the result depends on fees**:

| Fee per side | Neighbouring settings profitable in both periods (of 240) | Centre setting, test period (next-open entry) |
|---|---|---|
| 0.00% | 95% | — |
| 0.02% (limit orders) | 78% | +15.6%/yr, PF 1.33, max DD 12% |
| 0.035% (mixed) | 48% | +9.8%/yr, PF 1.19, max DD 14% |
| 0.05% (market orders) | 22% | +3.9%/yr, PF 1.07, max DD 17% |

**Weak points:**

- It lost money in 2022 (−6%) and 2023 (−16%) at 0.035% fees.
- It does not carry over to 5m or 30m, so it looks specific to 15m.
- At market-order fees, the tuning period is negative with next-open fills
  (−4.7%/yr, 61% drawdown).

It is only worth trading with limit-order (maker) fees, and even then it is a
thin, uneven edge.
