# FX Daily 2:1 — tuning report

Generated 2026-10-14 02:34 UTC by `scripts/fx-daily-tune.mjs`.
One trade a day across EURUSD, GBPUSD, AUDUSD, USDCHF, USDJPY (first fill wins, never two open). Target 2× the stop: **risk $500 to make $1000**. Break-even ≈ 33% before spread; spread is charged on every trade.
1664 setups tried. Picked on **2019-01-01 → 2024-07-01** only (≥ 150 trades, then most profitable years, least-bad worst year, most R); checked on **2024-07-01 → 2026-10-09**, unseen.

| | trades | per year | hit | total | at $500/trade | worst run |
|---|---|---|---|---|---|---|
| **Picked** · tuning | 208 | 38 | 44% | +2.4R | +$1,200 | 14.4R |
| **Picked** · unseen | 108 | 48 | 36% | -4.4R | −$2,214 | 16.6R |

**Picked:** `h4s10 fib len3 lim0.5 stop0.786 0-24utc eod min20p` — profitable in 5 of 6 tuning years.

**Published:** **no** — it did not make money on the unseen period.

## Best by direction filter (ranked on the tuning period)

| direction | settings | tuning: tr · hit · R | unseen: tr · hit · R |
|---|---|---|---|
| none | `none fib len5 lim0.5 stop0.786 7-16utc hold min20p` | 277 · 35% · -7.1 | 123 · 37% · 2.4 |
| prevday | `prevday fib len3 lim0.5 stop0.786 0-24utc hold min20p` | 230 · 40% · 29.2 | 108 · 28% · -26.5 |
| d1s3 | `d1s3 fib len3 lim0.5 stop0.786 7-16utc hold min20p` | 158 · 37% · 7.9 | 59 · 34% · -4.3 |
| d1s5 | `d1s5 fib len5 lim0.5 stop0.786 7-16utc hold min20p` | 155 · 38% · 7.1 | 61 · 33% · -6.0 |
| h4s10 | `h4s10 fib len3 lim0.5 stop0.786 0-24utc eod min20p` | 208 · 44% · 2.4 | 108 · 36% · -4.4 |
| usd | `usd fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 156 · 46% · 3.6 | 60 · 45% · 7.3 |
| ema50 | `ema50 fib len3 lim0.5 stop0.786 0-24utc hold min20p` | 222 · 39% · 17.7 | 102 · 34% · -5.4 |
| cot | `cot fib len10 lim0.382 stop1 7-16utc hold min20p` | 419 · 42% · 13.6 | 160 · 41% · -2.3 |

## Top 25 on the tuning period

| settings | up yrs | tuning: tr · hit · R | unseen: tr · hit · R |
|---|---|---|---|
| `h4s10 fib len3 lim0.5 stop0.786 0-24utc eod min20p` | 5/6 | 208 · 44% · 2.4 | 108 · 36% · -4.4 |
| `prevday fib len3 lim0.5 stop0.786 0-24utc hold min20p` | 5/6 | 230 · 40% · 29.2 | 108 · 28% · -26.5 |
| `ema50 fib len3 lim0.5 stop0.786 0-24utc hold min20p` | 5/6 | 222 · 39% · 17.7 | 102 · 34% · -5.4 |
| `d1s5 fib len5 lim0.5 stop0.786 7-16utc hold min20p` | 4/6 | 155 · 38% · 7.1 | 61 · 33% · -6.0 |
| `d1s3 fib len3 lim0.5 stop0.786 7-16utc hold min20p` | 4/6 | 158 · 37% · 7.9 | 59 · 34% · -4.3 |
| `h4s10 fib len3 lim0.5 stop0.786 7-16utc hold min20p` | 4/6 | 151 · 36% · 2.6 | 64 · 33% · -8.3 |
| `h4s10 fib len10 lim0.5 stop0.786 0-24utc eod min20p` | 4/6 | 192 · 43% · 6.4 | 75 · 33% · -13.6 |
| `usd fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 4/6 | 156 · 46% · 3.6 | 60 · 45% · 7.3 |
| `ema50 fib len3 lim0.5 stop0.786 7-16utc hold min20p` | 4/6 | 162 · 38% · 12.5 | 62 · 37% · -0.2 |
| `ema50 fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 4/6 | 162 · 47% · 9.9 | 64 · 42% · -0.7 |
| `h4s10 fib len3 lim0.5 stop0.786 7-16utc eod min20p` | 4/6 | 152 · 47% · 3.0 | 66 · 38% · -3.3 |
| `h4s10 fib len10 lim0.5 stop0.786 0-24utc hold min20p` | 4/6 | 190 · 39% · 10.7 | 75 · 32% · -8.2 |
| `d1s3 fib len10 lim0.618 stop1.13 7-16utc hold min10p` | 4/6 | 346 · 39% · 15.1 | 122 · 34% · -11.3 |
| `usd fib len5 lim0.5 stop0.786 7-16utc eod min20p` | 4/6 | 161 · 43% · 0.3 | 61 · 43% · 4.3 |
| `usd fib len5 lim0.5 stop0.786 7-16utc hold min20p` | 4/6 | 159 · 38% · 7.9 | 60 · 42% · 10.1 |
| `h4s10 fib len3 lim0.5 stop0.786 0-24utc hold min20p` | 4/6 | 205 · 36% · -0.7 | 107 · 33% · -10.6 |
| `d1s3 fib len5 lim0.5 stop0.786 0-24utc eod min20p` | 4/6 | 219 · 43% · 7.9 | 98 · 27% · -32.3 |
| `h4s10 fib len5 lim0.5 stop0.786 0-24utc eod min20p` | 4/6 | 218 · 43% · 2.4 | 100 · 29% · -26.2 |
| `prevday fib len3 lim0.5 stop0.786 0-24utc eod min20p` | 4/6 | 231 · 45% · 23.1 | 111 · 28% · -33.6 |
| `d1s3 fib len3 lim0.5 stop0.786 0-24utc hold min20p` | 4/6 | 206 · 36% · 5.1 | 105 · 32% · -9.9 |
| `usd fib len10 lim0.5 stop0.786 0-24utc hold min20p` | 4/6 | 185 · 38% · 6.9 | 68 · 38% · 2.4 |
| `cot fib len10 lim0.382 stop1 7-16utc hold min20p` | 4/6 | 419 · 42% · 13.6 | 160 · 41% · -2.3 |
| `ema50 fib len3 lim0.5 stop0.786 0-24utc eod min20p` | 4/6 | 223 · 44% · 13.1 | 104 · 38% · -6.6 |
| `d1s5 fib len3 lim0.5 stop0.786 0-24utc hold min20p` | 4/6 | 196 · 36% · -2.2 | 101 · 32% · -11.7 |
| `ema50 fib len5 lim0.5 stop0.786 0-24utc hold min20p` | 4/6 | 232 · 36% · 0.5 | 101 · 28% · -24.1 |

Top 25 still positive unseen: **4 / 25**. All setups with enough trades positive unseen: **12%**.

## Picked, if each pair traded alone

| pair | tuning | unseen |
|---|---|---|
| EURUSD | 44 tr · 43% · -9.2R | 17 tr · 18% · -9.1R |
| GBPUSD | 104 tr · 38% · -7.4R | 22 tr · 41% · 1.5R |
| AUDUSD | 27 tr · 37% · -4.7R | 5 tr · 20% · -2.3R |
| USDCHF | 21 tr · 52% · 3.9R | 9 tr · 33% · 0.1R |
| USDJPY | 76 tr · 46% · 4.3R | 83 tr · 36% · -6.5R |
