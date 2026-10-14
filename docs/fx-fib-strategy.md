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

## FX sizing

One stop-loss budget shared by the pairs: **$2,000 total ÷ 5 = $400 per pair's
ladder** (2% of $100,000 if every pair stops out). The weights are scaled so the
whole ladder filled loses that $400 at the stop, then rounded to 0.01 lot without
going over. $10/pip/lot on EURUSD, GBPUSD, AUDUSD; USDCHF and USDJPY pip value
(10 CHF / 1,000 JPY per lot) is converted to USD at the exit price.

## Notes

- Take the .382 and .618 from the OANDA chart — that is where the stop fills.
- Each pair keeps its own levels; switching pairs doesn't lose them.
