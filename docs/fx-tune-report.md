# FX Fib Ladder — tuning report

Generated 2026-10-14 02:17 UTC by `scripts/fx-tune.mjs`.
Data: histdata.com 1-minute, rolled up to hourly, 2019-01-01 → 2026-10-09, OANDA (New York close) candle timing.
Costs: round-trip spread per lot (EURUSD 1.2, GBPUSD 1.8, AUDUSD 1.4, USDCHF 1.8, USDJPY 1.4 pips). No swap or slippage.
Sizing: $400 max at the stop per trade; R = net $ ÷ $400. 12960 settings tried; picked on **2019-01-01 → 2024-07-01** only (≥ 60 trades, positive on ≥ 3 of 5 pairs, then the most profitable years, the least-bad worst year, the most R), then checked on **2024-07-01 → 2026-10-09**, which the pick never saw.

| | trades | hit | total | R/trade | worst run | net $ |
|---|---|---|---|---|---|---|
| **Picked** · tuning | 90 | 60% | +21.2R | 0.236 | 6.9R | $8,494 |
| **Picked** · unseen | 45 | 24% | -22.9R | -0.508 | 22.9R | $-9,146 |
| Crypto rules · tuning | 185 | 76% | -9.9R | -0.053 | 12.0R | $-3,959 |
| Crypto rules · unseen | 89 | 76% | -6.4R | -0.072 | 9.6R | $-2,550 |
| Most R on tuning · tuning | 533 | 43% | +39.4R | 0.074 | 34.3R | $15,763 |
| Most R on tuning · unseen | 174 | 38% | -21.1R | -0.121 | 30.4R | $-8,440 |

**Picked:** `8h len20 0.5-0.786 sl1.272 tp-0.272 adx0 usd16h cot-off` — made money in 6 of 6 tuning years, worst year 1.1R.

**Published:** **no** — it lost on the unseen period, so forex.html keeps the crypto rules and says no FX tuning held up.

## The hedge-fund (positioning) filter

CFTC Traders in Financial Futures: skip a trade unless the group is on its side (net), or — "weekly change" — added to its side in the latest report public at the break.

**The crypto rules, with each filter:**

| filter | tuning: tr · hit · R | unseen: tr · hit · R |
|---|---|---|
| no positioning filter | 185 · 76% · -9.9 | 89 · 76% · -6.4 |
| with hedge funds (net) | 107 · 80% · 1.8 | 41 · 73% · -4.4 |
| with asset managers (net) | 116 · 81% · 1.1 | 49 · 76% · -3.9 |
| with hedge funds' weekly change | 101 · 70% · -12.6 | 50 · 78% · -1.8 |

**The best-ranked setting under each filter** (ranked on the tuning period only):

| filter | rank | settings | tuning: tr · hit · R | unseen: tr · hit · R |
|---|---|---|---|---|
| no positioning filter | 1 | `8h len20 0.5-0.786 sl1.272 tp-0.272 adx0 usd16h cot-off` | 90 · 60% · 21.2 | 45 · 24% · -22.9 |
| with hedge funds (net) | 3 | `8h len20 0.236-0.5 sl1.618 tp-0.272 adx0 nousd cot-lev` | 83 · 82% · 13.6 | 42 · 71% · -0.6 |
| with asset managers (net) | 6 | `1h len10 0.236-0.618 sl1.272 tp-0.272 adx20 usd24h cot-am` | 593 · 70% · 25.2 | 214 · 64% · -9.4 |
| with hedge funds' weekly change | 2 | `8h len5 0.382-0.618 sl1 tp0 adx0 usd16h cot-levchg` | 222 · 64% · 16.6 | 97 · 48% · -21.7 |

Of all 12960 settings, share that made money unseen, by filter: no positioning filter 14% · with hedge funds (net) 14% · with asset managers (net) 8% · with hedge funds' weekly change 28%.

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
| `8h len20 0.5-0.786 sl1.272 tp-0.272 adx0 usd16h cot-off` | 6/6 | 90 · 60% · 21.2 · 6.9 | 45 · 24% · -22.9 · 22.9 |
| `8h len5 0.382-0.618 sl1 tp0 adx0 usd16h cot-levchg` | 6/6 | 222 · 64% · 16.6 · 7.4 | 97 · 48% · -21.7 · 23.0 |
| `8h len20 0.236-0.5 sl1.618 tp-0.272 adx0 nousd cot-lev` | 6/6 | 83 · 82% · 13.6 · 2.7 | 42 · 71% · -0.6 · 3.9 |
| `8h len10 0.382-0.618 sl1.618 tp0 adx0 usd16h cot-lev` | 6/6 | 130 · 84% · 14.8 · 2.9 | 45 · 71% · -1.1 · 2.8 |
| `4h len30 0.382-0.618 sl1.618 tp0 adx25 nousd cot-lev` | 6/6 | 66 · 82% · 7.7 · 2.2 | 25 · 52% · -6.9 · 7.3 |
| `1h len10 0.236-0.618 sl1.272 tp-0.272 adx20 usd24h cot-am` | 6/6 | 593 · 70% · 25.2 · 11.9 | 214 · 64% · -9.4 · 21.9 |
| `4h len10 0.5-0.786 sl1.272 tp0.236 adx25 usd24h cot-levchg` | 6/6 | 68 · 82% · 10.5 · 3.4 | 19 · 68% · -3.0 · 4.0 |
| `8h len20 0.236-0.618 sl1.618 tp-0.272 adx0 nousd cot-lev` | 6/6 | 85 · 82% · 13.7 · 2.7 | 41 · 71% · -0.0 · 4.0 |
| `4h len30 0.382-0.618 sl1.618 tp0 adx0 nousd cot-lev` | 6/6 | 142 · 77% · 7.0 · 3.8 | 53 · 66% · -5.5 · 6.8 |
| `8h len5 0.236-0.5 sl1 tp-0.272 adx0 usd16h cot-levchg` | 6/6 | 204 · 66% · 21.8 · 8.5 | 96 · 51% · -15.7 · 21.2 |
| `4h len20 0.5-0.786 sl1 tp0.236 adx25 usd24h cot-lev` | 6/6 | 61 · 74% · 7.9 · 4.5 | 14 · 36% · -6.9 · 6.9 |
| `8h len5 0.5-0.786 sl1 tp0 adx0 usd16h cot-levchg` | 6/6 | 201 · 55% · 21.2 · 6.8 | 88 · 36% · -27.1 · 27.2 |
| `4h len10 0.382-0.618 sl1 tp0.236 adx20 usd24h cot-lev` | 6/6 | 175 · 81% · 6.6 · 4.6 | 44 · 70% · -4.4 · 7.3 |
| `4h len20 0.236-0.618 sl1.618 tp0 adx25 usd24h cot-lev` | 6/6 | 64 · 91% · 6.8 · 1.8 | 14 · 50% · -5.3 · 5.3 |
| `8h len10 0.236-0.5 sl1.618 tp0 adx0 usd16h cot-lev` | 6/6 | 149 · 90% · 12.3 · 2.3 | 53 · 81% · -2.3 · 3.0 |
| `4h len20 0.382-0.618 sl1.618 tp0 adx0 usd8h cot-lev` | 6/6 | 147 · 80% · 9.5 · 3.7 | 48 · 77% · 2.4 · 2.4 |
| `8h len20 0.382-0.618 sl1.618 tp0.236 adx20 nousd cot-lev` | 6/6 | 70 · 96% · 7.4 · 1.0 | 28 · 82% · -1.3 · 2.8 |
| `8h len10 0.236-0.5 sl1.618 tp0 adx20 usd24h cot-off` | 6/6 | 117 · 89% · 8.5 · 2.9 | 45 · 80% · -2.9 · 4.0 |
| `4h len10 0.382-0.618 sl1.618 tp-0.272 adx25 nousd cot-off` | 6/6 | 149 · 70% · 14.1 · 7.7 | 72 · 64% · -1.8 · 6.8 |
| `4h len20 0.382-0.618 sl1.618 tp0 adx25 nousd cot-lev` | 6/6 | 84 · 85% · 11.1 · 2.5 | 27 · 56% · -6.2 · 7.0 |
| `8h len10 0.236-0.618 sl1.618 tp0 adx0 usd16h cot-lev` | 6/6 | 149 · 89% · 11.8 · 2.2 | 52 · 81% · -1.7 · 2.9 |
| `8h len10 0.236-0.5 sl1.618 tp0 adx20 usd24h cot-am` | 6/6 | 72 · 93% · 8.4 · 1.0 | 29 · 86% · 0.1 · 2.2 |
| `1h len20 0.5-0.786 sl1.618 tp0 adx25 usd2h cot-lev` | 6/6 | 155 · 75% · 14.3 · 6.7 | 70 · 71% · -0.7 · 5.4 |
| `8h len20 0.382-0.618 sl1.618 tp0 adx20 nousd cot-off` | 6/6 | 74 · 81% · 8.1 · 2.0 | 42 · 79% · 1.6 · 2.7 |
| `4h len30 0.5-0.786 sl1.618 tp0.236 adx25 nousd cot-lev` | 6/6 | 65 · 83% · 4.4 · 3.0 | 26 · 73% · -1.2 · 2.9 |

How many of the top 25 stayed positive unseen: **3 / 25**.
