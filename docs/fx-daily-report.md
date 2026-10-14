# FX Daily 2:1 — tuning report

Generated 2026-10-14 20:11 UTC by `scripts/fx-daily-tune.mjs`.
One trade a day across EURUSD, GBPUSD, AUDUSD, USDCHF, USDJPY (first fill wins, never two open). Target 2× the stop: **risk $500 to make $1000**, every trade settled within 24 hours (closed at market if neither hits). "Any profit" counts time exits that closed up; "full wins" are the +$1000 target. Break-even ≈ 33% before spread; spread is charged on every trade.
4856 setups tried. Picked on **2019-01-01 → 2024-07-01** only (≥ 150 trades, then most profitable years, least-bad worst year, most R); checked on **2024-07-01 → 2026-10-09**, unseen.

| | trades | per year | full +$1000 wins | any profit | total | at $500/trade | worst run |
|---|---|---|---|---|---|---|---|
| **Picked** · tuning | 158 | 30 | 30% | 42% | +11.0R | +$5,481 | 7.5R |
| **Picked** · unseen | 60 | 27 | 25% | 35% | -5.8R | −$2,915 | 13.7R |

**Picked:** `d1s3 fib len3 lim0.5 stop0.786 7-16utc h24 min20p` — profitable in 5 of 6 tuning years.

**Published:** **no** — it did not make money on the unseen period.

## The every-day trade (at market, 9:00 am New York)

A trade every weekday — no waiting for a setup. 936 variations: direction filter × stop (ATR or recent swing; never under 10 pips) × which pair (strongest 4h ADX, or a fixed one) × exit. Picked the same way, on the tuning period only, among those trading ≥ 200 days a year whose full +$1000 target hit ≥ 20% of the time.

| | trades | per year | full +$1000 wins | any profit | total | at $500/trade | worst run |
|---|---|---|---|---|---|---|---|
| **Every day** · tuning | 1365 | 250 | 27% | 40% | +15.0R | +$7,509 | 32.6R |
| **Every day** · unseen | 589 | 260 | 26% | 36% | -46.7R | −$23,363 | 77.2R |

**Picked:** `ema50 9am-NY market stop-atr1.5 pair-GBPUSD h24`. **Published:** **no** — it lost on the unseen period; the alert still sends it each day, marked untested.

| top 10 every-day settings | up yrs | tuning: tr · full · any · R | unseen: tr · full · any · R |
|---|---|---|---|
| `ema50 9am-NY market stop-atr1.5 pair-GBPUSD h24` | 4/6 | 1365 · 27% · 40% · 15.0 | 589 · 26% · 36% · -46.7 |
| `h4s10 9am-NY market stop-atr1.5 pair-GBPUSD h24` | 3/6 | 1366 · 27% · 40% · 16.4 | 589 · 26% · 37% · -52.6 |
| `d1s5 9am-NY market stop-atr1.5 pair-GBPUSD h24` | 3/6 | 1334 · 26% · 39% · -31.5 | 589 · 25% · 37% · -51.5 |
| `prevday 9am-NY market stop-atr1.5 pair-EURUSD h24` | 3/6 | 1345 · 28% · 38% · -25.3 | 580 · 27% · 39% · -2.9 |
| `ema50 9am-NY market stop-swing12 pair-GBPUSD h24` | 2/6 | 1109 · 20% · 41% · -25.6 | 472 · 17% · 38% · -53.7 |
| `d1s3 9am-NY market stop-atr1.5 pair-GBPUSD h24` | 2/6 | 1358 · 26% · 38% · -37.7 | 589 · 24% · 35% · -80.2 |
| `h4s10 9am-NY market stop-atr1.5 pair-AUDUSD h24` | 2/6 | 1360 · 26% · 38% · -65.2 | 588 · 24% · 37% · -61.7 |
| `usd 9am-NY market stop-atr1.5 pair-AUDUSD h24` | 2/6 | 1348 · 26% · 38% · -75.4 | 588 · 26% · 38% · -40.9 |
| `prevday 9am-NY market stop-atr1.5 pair-adx h24` | 2/6 | 1422 · 26% · 38% · -78.5 | 589 · 23% · 34% · -93.9 |
| `d1s3 9am-NY market stop-atr1.5 pair-AUDUSD h24` | 2/6 | 1353 · 25% · 37% · -82.0 | 588 · 23% · 35% · -97.4 |

Every-day variations positive unseen: **6%**.

## Best by direction filter (ranked on the tuning period)

| direction | settings | tuning: tr · hit · R | unseen: tr · hit · R |
|---|---|---|---|
| none | `none fib len3 lim0.5 stop0.786 7-16utc h24 min20p` | 292 · 39% · 7.0 | 121 · 40% · 7.9 |
| prevday | `prevday fib len3 lim0.5 stop0.786 0-24utc h24 min20p` | 231 · 42% · 22.0 | 109 · 28% · -29.8 |
| d1s3 | `d1s3 fib len3 lim0.5 stop0.786 7-16utc h24 min20p` | 158 · 42% · 11.0 | 60 · 35% · -5.8 |
| d1s5 | `d1s5 fib len5 lim0.5 stop0.786 7-16utc h24 min20p` | 155 · 42% · 9.4 | 62 · 34% · -8.3 |
| h4s10 | `h4s10 fib len3 lim0.5 stop0.786 0-24utc eod min20p` | 208 · 44% · 2.4 | 108 · 36% · -4.4 |
| usd | `usd fib len3 lim0.5 stop0.786 7-16utc h24 min20p` | 156 · 42% · 9.0 | 60 · 42% · 6.5 |
| ema50 | `ema50 fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 162 · 47% · 9.9 | 64 · 42% · -0.7 |
| cot | `cot fib len10 lim0.382 stop1 7-16utc h24 min20p` | 464 · 45% · -1.8 | 182 · 42% · -6.0 |
| d1s5+h4s10 | `d1s5+h4s10 fib len10 lim0.618 stop1.13 7-16utc h24 min10p` | 268 · 40% · 2.1 | 92 · 39% · -9.6 |
| d1s5+cot | `d1s5+cot fib len3 lim0.5 stop1 7-16utc h24 min20p` | 307 · 36% · -17.2 | 116 · 31% · -29.8 |
| d1s5+usd | `d1s5+usd fib len3 lim0.5 stop0.786 0-24utc h24 min20p` | 160 · 40% · 7.5 | 83 · 35% · -3.3 |
| h4s10+cot | `h4s10+cot fib len10 lim0.382 stop0.786 0-24utc eod min20p` | 263 · 44% · -12.0 | 84 · 42% · -7.4 |
| ema50+cot | `ema50+cot fib len10 lim0.382 stop1 7-16utc h24 min10p` | 360 · 45% · 2.6 | 138 · 48% · 8.7 |
| d1s5+ema50 | `d1s5+ema50 fib len5 lim0.5 stop0.786 0-24utc h24 min20p` | 153 · 40% · 9.4 | 68 · 25% · -22.0 |

## Top 25 on the tuning period

| settings | up yrs | tuning: tr · hit · R | unseen: tr · hit · R |
|---|---|---|---|
| `d1s3 fib len3 lim0.5 stop0.786 7-16utc h24 min20p` | 5/6 | 158 · 42% · 11.0 | 60 · 35% · -5.8 |
| `d1s5+ema50 fib len5 lim0.5 stop0.786 0-24utc h24 min20p` | 5/6 | 153 · 40% · 9.4 | 68 · 25% · -22.0 |
| `h4s10 fib len3 lim0.5 stop0.786 0-24utc eod min20p` | 5/6 | 208 · 44% · 2.4 | 108 · 36% · -4.4 |
| `ema50+cot fib len10 lim0.382 stop1 7-16utc h24 min10p` | 5/6 | 360 · 45% · 2.6 | 138 · 48% · 8.7 |
| `d1s5+ema50 fib len5 lim0.5 stop0.786 0-24utc eod min20p` | 5/6 | 153 · 44% · 11.4 | 68 · 28% · -21.8 |
| `d1s5+cot fib len3 lim0.5 stop1 7-16utc h24 min20p` | 5/6 | 307 · 36% · -17.2 | 116 · 31% · -29.8 |
| `d1s5 fib len5 lim0.5 stop0.786 7-16utc h24 min20p` | 4/6 | 155 · 42% · 9.4 | 62 · 34% · -8.3 |
| `ema50+cot fib len10 lim0.382 stop1 7-16utc h24 min20p` | 4/6 | 296 · 47% · 10.7 | 118 · 46% · 2.2 |
| `ema50+cot fib len10 lim0.382 stop1 0-24utc h24 min20p` | 4/6 | 419 · 47% · 16.4 | 172 · 43% · -0.6 |
| `h4s10 fib len10 lim0.5 stop0.786 0-24utc eod min20p` | 4/6 | 192 · 43% · 6.4 | 75 · 33% · -13.6 |
| `usd fib len3 lim0.5 stop0.786 7-16utc h24 min20p` | 4/6 | 156 · 42% · 9.0 | 60 · 42% · 6.5 |
| `h4s10 fib len3 lim0.5 stop0.786 7-16utc h24 min20p` | 4/6 | 152 · 41% · 3.7 | 65 · 35% · -9.4 |
| `d1s5+usd fib len3 lim0.5 stop0.786 0-24utc h24 min20p` | 4/6 | 160 · 40% · 7.5 | 83 · 35% · -3.3 |
| `d1s5+usd fib len10 lim0.5 stop0.786 0-24utc h24 min20p` | 4/6 | 154 · 39% · 2.4 | 58 · 34% · -6.9 |
| `h4s10 fib len10 lim0.5 stop0.786 0-24utc h24 min20p` | 4/6 | 192 · 42% · 12.9 | 75 · 36% · -8.3 |
| `d1s5 fib len10 lim0.618 stop1 7-16utc h24 min20p` | 4/6 | 154 · 40% · 11.7 | 59 · 34% · -11.1 |
| `d1s5+ema50 fib len10 lim0.618 stop1 0-24utc eod min20p` | 4/6 | 187 · 43% · 0.0 | 75 · 32% · -13.2 |
| `usd fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 4/6 | 156 · 46% · 3.6 | 60 · 45% · 7.3 |
| `usd fib len5 lim0.5 stop0.786 7-16utc h24 min20p` | 4/6 | 160 · 43% · 11.6 | 61 · 43% · 6.4 |
| `ema50 fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 4/6 | 162 · 47% · 9.9 | 64 · 42% · -0.7 |
| `d1s5+ema50 fib len10 lim0.5 stop0.886 7-16utc h24 min20p` | 4/6 | 164 · 45% · 13.8 | 63 · 40% · -2.7 |
| `h4s10 fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 4/6 | 152 · 47% · 3.0 | 66 · 38% · -3.3 |
| `d1s5+h4s10 fib len10 lim0.618 stop1.13 7-16utc h24 min10p` | 4/6 | 268 · 40% · 2.1 | 92 · 39% · -9.6 |
| `d1s5+ema50 fib len5 lim0.705 stop1.13 7-16utc eod min20p` | 4/6 | 183 · 44% · 3.1 | 60 · 42% · 0.9 |
| `d1s5+usd fib len5 lim0.5 stop0.786 0-24utc h24 min20p` | 4/6 | 171 · 39% · 3.4 | 82 · 28% · -22.9 |

Top 25 still positive unseen: **6 / 25**. All setups with enough trades positive unseen: **7%**.

## The past 50% winners — and what happened next

Every setup with at least 200 trades over the whole history, ranked by hit rate on **2019-01-01 → 2024-07-01**. A 2:1 setup needs ~34% to break even; the question is whether a high past hit rate carries on into the unseen period.

| settings | tuning: tr · hit · R | unseen: tr · hit · R |
|---|---|---|
| `h4s10 9am-NY market stop-atr4 pair-GBPUSD eod` | 1366 · **51%** (0% full) · 3.7 | 589 · **47%** (1% full) · -18.8 |
| `h4s10+cot 9am-NY market stop-atr4 pair-GBPUSD eod` | 632 · **51%** (0% full) · -2.5 | 261 · **45%** (2% full) · -5.8 |
| `h4s10+cot 9am-NY market stop-atr4 pair-adx eod` | 1354 · **50%** (1% full) · -38.5 | 568 · **45%** (1% full) · -18.4 |
| `ema50+cot 9am-NY market stop-atr3 pair-GBPUSD eod` | 621 · **50%** (1% full) · 2.1 | 299 · **45%** (4% full) · -6.7 |
| `ema50+cot 9am-NY market stop-atr4 pair-GBPUSD eod` | 621 · **50%** (0% full) · -6.1 | 299 · **44%** (1% full) · -8.5 |
| `ema50 9am-NY market stop-atr4 pair-GBPUSD eod` | 1365 · **50%** (0% full) · -4.0 | 589 · **46%** (1% full) · -19.3 |
| `d1s5+h4s10 9am-NY market stop-atr4 pair-GBPUSD eod` | 918 · **50%** (0% full) · 3.3 | 396 · **46%** (1% full) · -21.8 |
| `h4s10 9am-NY market stop-atr3 pair-GBPUSD eod` | 1366 · **50%** (2% full) · 5.3 | 589 · **46%** (4% full) · -24.1 |
| `ema50 9am-NY market stop-atr3 pair-GBPUSD eod` | 1365 · **50%** (2% full) · 3.6 | 589 · **45%** (4% full) · -20.6 |
| `h4s10+cot 9am-NY market stop-atr4 pair-AUDUSD h24` | 640 · **50%** (3% full) · 3.3 | 299 · **45%** (2% full) · -19.6 |
| `h4s10+cot 9am-NY market stop-atr3 pair-GBPUSD eod` | 632 · **50%** (2% full) · 1.4 | 261 · **44%** (4% full) · -9.0 |
| `d1s3 9am-NY market stop-atr4 pair-GBPUSD eod` | 1358 · **50%** (1% full) · -14.1 | 589 · **46%** (1% full) · -46.4 |
| `d1s5+ema50 9am-NY market stop-atr4 pair-GBPUSD eod` | 827 · **50%** (0% full) · -2.7 | 366 · **45%** (1% full) · -22.1 |
| `prevday 9am-NY market stop-atr4 pair-GBPUSD eod` | 1370 · **50%** (0% full) · -18.9 | 589 · **47%** (1% full) · -41.6 |
| `h4s10+cot 9am-NY market stop-atr4 pair-AUDUSD eod` | 640 · **50%** (0% full) · -11.3 | 299 · **46%** (0% full) · -18.5 |

Setups that won ≥ 50% of trades in the tuning period: **7**; of those, still ≥ 50% unseen: **0**.

## Picked, if each pair traded alone

| pair | tuning | unseen |
|---|---|---|
| EURUSD | 38 tr · 37% · -7.6R | 9 tr · 22% · -5.5R |
| GBPUSD | 76 tr · 38% · 5.4R | 13 tr · 38% · 0.3R |
| AUDUSD | 18 tr · 39% · -0.6R | 1 tr · 0% · -1.1R |
| USDCHF | 17 tr · 53% · 2.1R | 8 tr · 25% · -2.5R |
| USDJPY | 45 tr · 44% · 6.1R | 40 tr · 38% · -0.2R |
