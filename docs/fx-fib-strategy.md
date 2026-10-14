# FX Fib Ladder — EURUSD, GBPUSD, AUDUSD, USDCHF, USDJPY

The crypto Fib Ladder (`ladder.html`) applied to five majors. Live page:
[`forex.html`](../forex.html), the **FX** tab of the Fib Ladder. The levels, legs
and targets are identical; only the sizing changes (lots, by stop-loss budget).

## Levels — from the two prices you type

The 0.382 and 0.618 of the impulse leg pin everything: they sit 23.6% of the leg
apart, so `range = |.382 − .618| ÷ 0.236`. A .382 above the .618 is a long
(up-leg pulling back); below is a short.

| | Level |
|---|---|
| Entries | 10 limits evenly spaced 0.382 → 0.618 |
| Stop | 0.886 (override in Tune) |
| Targets | one per leg, evenly spaced −0.618 → −1.0 extension |

## Size ramp

`weight = 1 + (ratio − 1)·(i − 1)/(n − 1)` — leg 10 is 2× leg 1 by default, so the
deep legs (closer to the stop) carry the most size.

Default TP pairing: leg 1 (first filled, smallest) runs to the −1.0; the big deep
legs bank first at the −0.618. The TP button swaps it.

## FX sizing — hard $400 cap per trade

**SL $ per trade = $400** (5 pairs × $400 = $2,000, 2% of $100,000). Each pair's
whole ladder is sized so that if every leg fills and the stop hits, it loses
**no more than $400**: weights are scaled to $400, rounded to 0.01 lot, and
leftover 0.01s handed back only while the total stays ≤ $400. If the 0.01-lot
minimum on every leg would push past $400 (a very wide leg), legs are dropped
until it fits; if even two can't fit, no ladder is shown. A stop override is
sized the same way, so the cap always holds.

$10/pip/lot on EURUSD, GBPUSD, AUDUSD; USDCHF and USDJPY pip value
(10 CHF / 1,000 JPY per lot) is converted to USD at the exit price.

## Notes

- Take the .382 and .618 from the OANDA chart — that is where the stop fills.
- Each pair keeps its own levels; switching pairs doesn't lose them.
