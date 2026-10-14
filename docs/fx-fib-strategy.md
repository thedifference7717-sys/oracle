# FX Fib strategy — EURUSD, GBPUSD, AUDUSD, USDCHF, USDJPY

The crypto desk's setup (`btc.html`, `btc-alerts/`) carried over to five majors.
Live page: [`forex.html`](../forex.html), the **FX** tab of the Fib Ladder.

## Core (same as crypto)

1. **Leg** — latest confirmed 4h swing high and low (3 bars each side). Newest
   extreme a high → long only; a low → short only.
2. **Step 1 (arm)** — price trades into the 50% retracement ± 3% of the leg.
3. **Step 2 (enter)** — after the touch, a 15m candle closes beyond the latest
   15m swing (high for longs, low for shorts) as the 3rd consecutive candle in the
   trade direction. Enter at that close.
4. **Stop** — the 0.886 retracement.

## FX additions

| Rule | Why |
|---|---|
| Minimum leg: EURUSD 40, GBPUSD 50, AUDUSD 30, USDCHF 35, USDJPY 50 pips | A thin leg puts the 0.886 inside spread and noise |
| Stop = 0.886 **+ 2-pip buffer** | Spread / stop-hunt wicks |
| Step 2 only in session: London 07–16, NY 12–20 UTC; AUDUSD & USDJPY also Asia 23–07 | Off-session breaks are thin and fake out |
| No new entries after Fri 18:00 UTC | Weekend gap |
| Step 2 close must be at or deeper than the 0.382 | Later than that TP1 is under ~0.75R — don't chase |
| Stop hit before Step 2 → setup dead; price back past the swing extreme → missed | One trade per leg |
| A higher low inside an up-leg (lower high inside a down-leg) keeps the leg | The bounce off the 50% is the pullback, not a new leg |
| Avoid ±30 min around high-impact news | Not visible to the page — check the calendar |
| EURUSD/GBPUSD/USDCHF moving together = one USD bet | Halve risk on each or take the cleaner one |

## Exits

Thirds: TP1 at the swing extreme (0.0) and stop to break-even, TP2 at −0.272,
TP3 at −0.618. From a 50% entry that is ≈1.3R / 2R / 2.9R.

## Size

`lots = risk $ ÷ (|entry − stop| × 100,000 ÷ quote rate)`, rounded **down** to
0.01. $10/pip/lot on the USD-quoted pairs; USDCHF and USDJPY convert at the stop.

## Ladder alternative

Resting limits 0.382 → 0.618, sizes ramping deeper, stop 0.886 + buffer, targets
spread −0.618 → −1.0 — the crypto Fib Ladder, sized so the full ladder loses the
risk % at the stop.

## Data

Kraken FX spot (no key) by default; a free Twelve Data key in **Tune** switches to
interbank-composite candles, rationed to the free tier (selected pair every
4 min, the rest every 20). Candles are UTC-aligned; broker charts on New York
close may show slightly different 4h swings — use the overrides.
