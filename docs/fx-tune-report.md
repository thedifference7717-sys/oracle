# FX Fib Ladder — tuning report

Generated 2026-10-14 02:04 UTC by `scripts/fx-tune.mjs`.
Data: histdata.com 1-minute, rolled up to hourly, 2019-01-01 → 2026-10-09, OANDA (New York close) candle timing.
Costs: round-trip spread per lot (EURUSD 1.2, GBPUSD 1.8, AUDUSD 1.4, USDCHF 1.8, USDJPY 1.4 pips). No swap or slippage.
Sizing: $400 max at the stop per trade; R = net $ ÷ $400. 3240 settings tried; picked on **2019-01-01 → 2024-07-01** only (≥ 60 trades, positive on ≥ 3 of 5 pairs, then the most profitable years, the least-bad worst year, the most R), then checked on **2024-07-01 → 2026-10-09**, which the pick never saw.

| | trades | hit | total | R/trade | worst run | net $ |
|---|---|---|---|---|---|---|
| **Picked** · tuning | 90 | 60% | +21.2R | 0.236 | 6.9R | $8,494 |
| **Picked** · unseen | 45 | 24% | -22.9R | -0.508 | 22.9R | $-9,146 |
| Crypto rules · tuning | 185 | 76% | -9.9R | -0.053 | 12.0R | $-3,959 |
| Crypto rules · unseen | 89 | 76% | -6.4R | -0.072 | 9.6R | $-2,550 |
| Most R on tuning · tuning | 533 | 43% | +39.4R | 0.074 | 34.3R | $15,763 |
| Most R on tuning · unseen | 174 | 38% | -21.1R | -0.121 | 30.4R | $-8,440 |

**Picked:** `8h len20 0.5-0.786 sl1.272 tp-0.272 adx0 usd16h` — made money in 6 of 6 tuning years, worst year 1.1R.

**Published:** **no** — it lost on the unseen period, so forex.html keeps the crypto rules and says no FX tuning held up.

## Picked, per pair

| pair | tuning | unseen |
|---|---|---|
| EURUSD | 20 tr · 50% · -2.3R | 8 tr · 38% · -2.9R |
| GBPUSD | 17 tr · 65% · 6.3R | 11 tr · 18% · -5.8R |
| AUDUSD | 15 tr · 73% · 10.5R | 11 tr · 27% · -4.9R |
| USDCHF | 15 tr · 53% · 0.6R | 8 tr · 25% · -4.2R |
| USDJPY | 23 tr · 61% · 6.1R | 7 tr · 14% · -5.2R |

## Top 25 on the tuning period (with how each did unseen)

| settings | up years | tuning: tr · hit · R · worst | unseen: tr · hit · R · worst |
|---|---|---|---|
| `8h len20 0.5-0.786 sl1.272 tp-0.272 adx0 usd16h` | 6/6 | 90 · 60% · 21.2 · 6.9 | 45 · 24% · -22.9 · 22.9 |
| `8h len10 0.236-0.5 sl1.618 tp0 adx20 usd24h` | 6/6 | 117 · 89% · 8.5 · 2.9 | 45 · 80% · -2.9 · 4.0 |
| `4h len10 0.382-0.618 sl1.618 tp-0.272 adx25 nousd` | 6/6 | 149 · 70% · 14.1 · 7.7 | 72 · 64% · -1.8 · 6.8 |
| `8h len20 0.382-0.618 sl1.618 tp0 adx20 nousd` | 6/6 | 74 · 81% · 8.1 · 2.0 | 42 · 79% · 1.6 · 2.7 |
| `8h len30 0.236-0.618 sl1.618 tp0 adx20 nousd` | 6/6 | 65 · 89% · 8.2 · 1.5 | 29 · 79% · -1.0 · 3.6 |
| `4h len30 0.5-0.786 sl1 tp0.236 adx20 usd24h` | 6/6 | 114 · 68% · 8.8 · 5.5 | 46 · 52% · -6.9 · 10.8 |
| `4h len30 0.5-0.786 sl1.272 tp0.236 adx25 usd24h` | 6/6 | 71 · 79% · 6.4 · 3.4 | 28 · 54% · -7.2 · 9.3 |
| `1h len10 0.5-0.786 sl1.618 tp-0.272 adx25 usd24h` | 6/6 | 465 · 64% · 34.5 · 13.4 | 159 · 55% · -15.8 · 26.0 |
| `8h len20 0.236-0.618 sl1.618 tp0 adx20 nousd` | 6/6 | 84 · 89% · 9.8 · 1.8 | 42 · 90% · 3.6 · 1.9 |
| `4h len20 0.382-0.618 sl1 tp0 adx25 usd24h` | 5/6 | 95 · 72% · 16.7 · 5.6 | 28 · 50% · -5.9 · 11.2 |
| `8h len10 0.382-0.618 sl1.618 tp-0.272 adx20 usd16h` | 5/6 | 74 · 73% · 10.3 · 4.5 | 37 · 51% · -7.8 · 8.3 |
| `8h len20 0.236-0.5 sl1.618 tp0 adx20 nousd` | 5/6 | 98 · 87% · 5.8 · 3.2 | 60 · 88% · 2.8 · 3.9 |
| `4h len30 0.382-0.618 sl1.618 tp-0.272 adx25 nousd` | 5/6 | 63 · 70% · 7.9 · 4.2 | 30 · 60% · -3.3 · 6.0 |
| `8h len10 0.236-0.618 sl1.618 tp0 adx20 usd24h` | 5/6 | 117 · 89% · 8.5 · 2.9 | 45 · 82% · -1.7 · 2.4 |
| `4h len30 0.382-0.618 sl1.618 tp-0.272 adx0 usd8h` | 5/6 | 111 · 72% · 14.8 · 4.2 | 60 · 68% · 2.7 · 3.5 |
| `1h len10 0.236-0.618 sl1.618 tp0 adx25 usd24h` | 5/6 | 673 · 86% · 8.3 · 11.0 | 243 · 82% · -12.8 · 18.8 |
| `4h len30 0.5-0.786 sl1.618 tp0.236 adx25 usd24h` | 5/6 | 61 · 87% · 8.0 · 1.0 | 25 · 60% · -5.1 · 6.4 |
| `4h len30 0.382-0.618 sl1.618 tp0 adx25 nousd` | 5/6 | 103 · 78% · 7.6 · 3.7 | 35 · 69% · -3.4 · 4.9 |
| `8h len10 0.5-0.786 sl1.618 tp-0.272 adx25 nousd` | 5/6 | 63 · 68% · 13.1 · 4.9 | 38 · 61% · 2.9 · 3.9 |
| `8h len30 0.382-0.618 sl1.618 tp0 adx20 nousd` | 5/6 | 60 · 83% · 8.3 · 2.4 | 23 · 57% · -5.4 · 6.3 |
| `4h len30 0.382-0.618 sl1.618 tp0.236 adx25 usd24h` | 5/6 | 78 · 94% · 6.0 · 3.0 | 28 · 79% · -3.0 · 4.3 |
| `4h len30 0.5-0.786 sl1.272 tp0 adx20 usd24h` | 5/6 | 94 · 63% · 5.1 · 8.5 | 41 · 39% · -14.1 · 15.2 |
| `4h len30 0.382-0.618 sl1.618 tp0.236 adx25 usd8h` | 5/6 | 101 · 92% · 5.8 · 3.3 | 36 · 75% · -5.9 · 7.3 |
| `4h len20 0.382-0.618 sl1.618 tp0.236 adx25 usd8h` | 5/6 | 111 · 91% · 4.1 · 3.4 | 44 · 77% · -6.0 · 7.7 |
| `8h len20 0.236-0.5 sl1.618 tp0 adx25 nousd` | 5/6 | 61 · 84% · 2.6 · 3.5 | 27 · 81% · -0.4 · 4.0 |

How many of the top 25 stayed positive unseen: **5 / 25**.
