# FX Fib Ladder — EURUSD, GBPUSD, AUDUSD, USDCHF, USDJPY

The crypto Fib Ladder's tuned rules ("Best found by tuning (Oct 5)") run on five
FX majors. Live page: [`forex.html`](../forex.html), the **FX** tab of the Fib
Ladder. The page finds the setups and lists the orders; you place them on OANDA.

## When it looks for a trade

- 4h candles, checked as each closes (6 a day). Default timing is OANDA's
  New York close (bars open 17:00 New York); UTC is an option.
- Swing high/low = 20 candles each side (LuxAlgo Market Structure Breakers, length 20).
- Triggers: any close through the latest unbroken swing — **MSS** (against the
  prior trend) or **MSB** (with it), long or short.
- Fib on the move that made the break: long → swing high = 0, swing low = 1
  (the lowest low since the broken swing high); shorts mirrored.
- While price extends and nothing has filled, the ladder moves to each new
  high/low. A newer break replaces an unfilled ladder.
- Skipped if the break candle closed already past the .5.

## Entries

- 10 limits evenly from the **.236 to the .5**, ramping so the deepest is 2× the
  first; orders price has already passed are left out. Full fill averages ≈ .38.

## Exits

- Every leg's target is the **0** (swing high for longs, low for shorts).
- One stop for the whole position at the **1.272**.
- When the target fills, cancel the unfilled entries. (Targets share one price,
  so they fill together; any leg left goes to break-even and trails.)
- No recovery trades. An opposite break never closes a filled trade; it can only
  replace an unfilled ladder.

## Filters (all must pass)

1. **USD 8h structure** (FX stand-in for BTC 8h): an equal-weight dollar index
   from the five pairs; trade only the side that agrees with its latest 8h break
   (USD down → long EURUSD/GBPUSD/AUDUSD, short USDCHF/USDJPY; USD up → reverse).
2. **Trend strength:** the pair's 4h ADX(14) ≥ 20.
3. Funding and 4. top traders: crypto-only (perp funding, Hyperliquid
   leaderboard) — no FX equivalent, not applied.

## Size — $400 max SL per trade

Instead of $250 notional, each ladder is sized so the orders on it, all filled,
lose no more than **$400** at the 1.272 (5 pairs × $400 = $2,000, 2% of
$100,000). Lots round to 0.01 without going over; if the 0.01 minimum would
overshoot, the shallowest orders are dropped. The stop is far and the target
near, so a full-fill win is ≈ 0.4R; the edge is the hit rate (break-even ≈ 70%).

## Data and replay

Kraken FX spot with no key (1h candles ≈ 30 days with OANDA timing, 4h ≈ 4 months
with UTC), or a free Twelve Data key (≈ 7 months). The page replays the rules
over what it loaded: limits fill at their price, the stop wins when a candle
spans both, spread and swap are ignored — a sanity check, not a backtest.
