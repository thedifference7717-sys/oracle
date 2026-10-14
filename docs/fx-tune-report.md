# FX Fib Ladder — tuning report

Generated 2026-10-14 01:58 UTC by `scripts/fx-tune.mjs`.
Data: histdata.com 1-minute, rolled up to hourly, 2019-01-01 → 2026-10-09, OANDA (New York close) candle timing.
Costs: round-trip spread per lot (EURUSD 1.2, GBPUSD 1.8, AUDUSD 1.4, USDCHF 1.8, USDJPY 1.4 pips). No swap or slippage.
Sizing: $400 max at the stop per trade; R = net $ ÷ $400. 3240 settings tried; picked on **2019-01-01 → 2024-07-01** only (≥ 60 trades, positive on ≥ 3 of 5 pairs, most net), then checked on **2024-07-01 → 2026-10-09**, which the pick never saw.

| | trades | hit | total | R/trade | worst run | net $ |
|---|---|---|---|---|---|---|
| **Picked** · tuning | 533 | 43% | +39.4R | 0.074 | 34.3R | $15,763 |
| **Picked** · unseen | 174 | 38% | -21.1R | -0.121 | 30.4R | $-8,440 |
| Crypto rules · tuning | 185 | 76% | -9.9R | -0.053 | 12.0R | $-3,959 |
| Crypto rules · unseen | 89 | 76% | -6.4R | -0.072 | 9.6R | $-2,550 |

**Picked:** `1h len10 0.5-0.786 sl1 tp-0.272 adx25 usd24h`

## Picked, per pair

| pair | tuning | unseen |
|---|---|---|
| EURUSD | 116 tr · 45% · 20.2R | 35 tr · 31% · -4.8R |
| GBPUSD | 118 tr · 46% · 18.4R | 51 tr · 45% · -7.7R |
| AUDUSD | 107 tr · 41% · 1.0R | 33 tr · 33% · -7.4R |
| USDCHF | 102 tr · 40% · -4.6R | 27 tr · 37% · 1.9R |
| USDJPY | 90 tr · 42% · 4.5R | 28 tr · 39% · -3.1R |

## Top 25 on the tuning period (with how each did unseen)

| settings | tuning: tr · hit · R · worst | unseen: tr · hit · R · worst |
|---|---|---|
| `1h len10 0.5-0.786 sl1 tp-0.272 adx25 usd24h` | 533 · 43% · 39.4 · 34.3 | 174 · 38% · -21.1 · 30.4 |
| `1h len10 0.5-0.786 sl1.618 tp-0.272 adx25 usd24h` | 465 · 64% · 34.5 · 13.4 | 159 · 55% · -15.8 · 26.0 |
| `1h len10 0.5-0.786 sl1.272 tp-0.272 adx25 usd24h` | 512 · 54% · 31.5 · 19.8 | 173 · 46% · -24.0 · 32.1 |
| `1h len5 0.5-0.786 sl1.272 tp-0.272 adx25 usd24h` | 1000 · 53% · 28.2 · 27.8 | 406 · 44% · -62.7 · 74.8 |
| `1h len10 0.382-0.618 sl1 tp-0.272 adx25 usd24h` | 561 · 51% · 28.0 · 29.0 | 195 · 49% · -5.9 · 16.3 |
| `1h len30 0.5-0.786 sl1.272 tp-0.272 adx20 usd2h` | 290 · 53% · 26.6 · 10.3 | 134 · 49% · -7.3 · 16.1 |
| `1h len10 0.236-0.618 sl1.272 tp-0.272 adx20 usd24h` | 910 · 69% · 25.7 · 17.7 | 361 · 63% · -24.6 · 39.0 |
| `1h len10 0.382-0.618 sl1.272 tp-0.272 adx25 usd24h` | 545 · 60% · 25.2 · 21.7 | 187 · 56% · -10.1 · 20.3 |
| `1h len10 0.236-0.618 sl1 tp-0.272 adx20 usd24h` | 946 · 62% · 23.7 · 31.4 | 371 · 58% · -18.1 · 33.1 |
| `1h len10 0.236-0.618 sl1.272 tp-0.272 adx25 usd24h` | 578 · 70% · 22.8 · 13.9 | 207 · 68% · -2.5 · 11.3 |
| `8h len20 0.5-0.786 sl1 tp0 adx20 usd16h` | 70 · 63% · 22.6 · 5.7 | 38 · 29% · -18.6 · 18.6 |
| `1h len10 0.382-0.618 sl1.618 tp-0.272 adx25 usd24h` | 509 · 68% · 21.9 · 16.5 | 174 · 63% · -9.9 · 17.2 |
| `8h len5 0.5-0.786 sl1 tp0 adx0 usd16h` | 340 · 53% · 21.4 · 15.0 | 147 · 35% · -45.7 · 46.4 |
| `8h len20 0.5-0.786 sl1.272 tp-0.272 adx0 usd16h` | 90 · 60% · 21.2 · 6.9 | 45 · 24% · -22.9 · 22.9 |
| `8h len5 0.5-0.786 sl1 tp0 adx25 usd16h` | 104 · 61% · 21.1 · 10.2 | 62 · 37% · -18.5 · 19.0 |
| `8h len5 0.382-0.618 sl1 tp-0.272 adx25 usd24h` | 103 · 57% · 21.0 · 5.3 | 51 · 27% · -26.1 · 27.3 |
| `8h len5 0.5-0.786 sl1 tp0 adx25 usd24h` | 102 · 61% · 20.9 · 6.5 | 52 · 46% · -9.8 · 13.2 |
| `8h len5 0.382-0.618 sl1 tp0 adx25 nousd` | 224 · 66% · 20.6 · 14.9 | 132 · 55% · -14.6 · 21.1 |
| `4h len30 0.5-0.786 sl1.272 tp-0.272 adx0 usd8h` | 128 · 58% · 20.6 · 7.5 | 62 · 42% · -13.1 · 15.1 |
| `8h len5 0.382-0.618 sl1 tp-0.272 adx25 usd16h` | 100 · 56% · 19.2 · 5.5 | 61 · 18% · -40.7 · 40.7 |
| `8h len10 0.5-0.786 sl1.618 tp-0.272 adx20 nousd` | 99 · 68% · 19.1 · 9.0 | 51 · 67% · 7.5 · 3.0 |
| `8h len5 0.5-0.786 sl1 tp-0.272 adx25 usd24h` | 94 · 48% · 18.8 · 6.3 | 46 · 20% · -26.0 · 30.0 |
| `1h len10 0.236-0.618 sl1 tp-0.272 adx25 usd24h` | 592 · 63% · 18.7 · 22.1 | 210 · 63% · 8.8 · 8.3 |
| `4h len10 0.5-0.786 sl1.618 tp-0.272 adx0 nousd` | 326 · 64% · 18.7 · 18.6 | 153 · 62% · 8.5 · 10.4 |
| `4h len30 0.5-0.786 sl1 tp0 adx25 usd24h` | 73 · 58% · 18.6 · 7.4 | 28 · 25% · -17.2 · 17.2 |

How many of the top 25 stayed positive unseen: **3 / 25**.
