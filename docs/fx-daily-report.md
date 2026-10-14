# FX Daily 2:1 — tuning report

Generated 2026-10-14 02:48 UTC by `scripts/fx-daily-tune.mjs`.
One trade a day across EURUSD, GBPUSD, AUDUSD, USDCHF, USDJPY (first fill wins, never two open). Target 2× the stop: **risk $500 to make $1000**, every trade settled within 24 hours (closed at market if neither hits). "Any profit" counts time exits that closed up; "full wins" are the +$1000 target. Break-even ≈ 33% before spread; spread is charged on every trade.
3920 setups tried. Picked on **2019-01-01 → 2024-07-01** only (≥ 150 trades, then most profitable years, least-bad worst year, most R); checked on **2024-07-01 → 2026-10-09**, unseen.

| | trades | per year | full +$1000 wins | any profit | total | at $500/trade | worst run |
|---|---|---|---|---|---|---|---|
| **Picked** · tuning | 158 | 30 | 30% | 42% | +11.0R | +$5,481 | 7.5R |
| **Picked** · unseen | 60 | 27 | 25% | 35% | -5.8R | −$2,915 | 13.7R |

**Picked:** `d1s3 fib len3 lim0.5 stop0.786 7-16utc h24 min20p` — profitable in 5 of 6 tuning years.

**Published:** **no** — it did not make money on the unseen period.

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

Top 25 still positive unseen: **6 / 25**. All setups with enough trades positive unseen: **8%**.

## The past 50% winners — and what happened next

Every setup with at least 200 trades over the whole history, ranked by hit rate on **2019-01-01 → 2024-07-01**. A 2:1 setup needs ~34% to break even; the question is whether a high past hit rate carries on into the unseen period.

| settings | tuning: tr · hit · R | unseen: tr · hit · R |
|---|---|---|
| `d1s5+ema50 fib len10 lim0.5 stop1.13 7-16utc eod min20p` | 293 · **49%** (8% full) · -9.8 | 105 · **39%** (6% full) · -14.3 |
| `ema50 fib len10 lim0.5 stop1.13 7-16utc eod min20p` | 461 · **48%** (8% full) · -17.2 | 154 · **43%** (6% full) · -5.7 |
| `ema50+cot fib len10 lim0.5 stop1.13 7-16utc eod min20p` | 246 · **48%** (7% full) · -19.5 | 91 · **41%** (7% full) · -6.7 |
| `h4s10 fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 152 · **47%** (18% full) · 3.0 | 66 · **38%** (18% full) · -3.3 |
| `ema50+cot fib len10 lim0.382 stop1 0-24utc eod min20p` | 450 · **47%** (8% full) · -17.8 | 181 · **45%** (13% full) · -0.1 |
| `d1s5+ema50 fib len10 lim0.5 stop1.13 7-16utc eod min10p` | 358 · **47%** (9% full) · -18.3 | 127 · **42%** (9% full) · -8.2 |
| `cot fib len5 lim0.618 stop1.13 7-16utc eod min20p` | 403 · **47%** (11% full) · -15.0 | 149 · **41%** (8% full) · -12.2 |
| `ema50+cot fib len10 lim0.382 stop1 7-16utc eod min20p` | 314 · **47%** (8% full) · -15.9 | 122 · **49%** (10% full) · 4.3 |
| `d1s5+h4s10 fib len10 lim0.5 stop1.13 7-16utc eod min20p` | 291 · **47%** (8% full) · -15.2 | 101 · **39%** (5% full) · -15.2 |
| `ema50+cot fib len10 lim0.382 stop1 7-16utc h24 min20p` | 296 · **47%** (16% full) · 10.7 | 118 · **46%** (16% full) · 2.2 |
| `ema50 fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 162 · **47%** (19% full) · 9.9 | 64 · **42%** (19% full) · -0.7 |
| `d1s5+ema50 fib len10 lim0.382 stop1 7-16utc eod min20p` | 361 · **47%** (7% full) · -26.6 | 128 · **40%** (6% full) · -15.3 |
| `ema50+cot fib len10 lim0.382 stop1 0-24utc h24 min20p` | 419 · **47%** (15% full) · 16.4 | 172 · **43%** (17% full) · -0.6 |
| `d1s5+cot fib len5 lim0.5 stop1.13 7-16utc eod min20p` | 368 · **47%** (7% full) · -14.1 | 142 · **44%** (6% full) · -1.3 |
| `h4s10 fib len10 lim0.5 stop1.13 7-16utc eod min20p` | 411 · **47%** (8% full) · -19.5 | 135 · **40%** (5% full) · -11.9 |

Setups that won ≥ 50% of trades in the tuning period: **0**; of those, still ≥ 50% unseen: **0**.

## Picked, if each pair traded alone

| pair | tuning | unseen |
|---|---|---|
| EURUSD | 38 tr · 37% · -7.6R | 9 tr · 22% · -5.5R |
| GBPUSD | 76 tr · 38% · 5.4R | 13 tr · 38% · 0.3R |
| AUDUSD | 18 tr · 39% · -0.6R | 1 tr · 0% · -1.1R |
| USDCHF | 17 tr · 53% · 2.1R | 8 tr · 25% · -2.5R |
| USDJPY | 45 tr · 44% · 6.1R | 40 tr · 38% · -0.2R |
