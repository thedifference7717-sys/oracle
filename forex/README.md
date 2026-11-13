# Trading Walk — 5 Minute Strategy

Coded from the video **"5 Minute Trading Strategy: Where I Put My Stop Loss"** by
[Trading Walk](https://www.youtube.com/@tradingwalk) (`youtu.be/-Um9-oqjU0o`).

`trading-walk-5min.pine` — Pine Script v5 **strategy** for TradingView. It plots the
setup, entry, stop and target on the chart and runs in the Strategy Tester.

> **Read this first.** I could not watch the video — this session can't play video or
> read a transcript, and the rules aren't published in text anywhere I could find. So
> the logic below is Trading Walk's *documented* pullback method (their published
> candlestick/trend pages use the same shape: EMA trend, rejection candle at the EMA,
> stop-order entry on the break of that candle, stop just beyond its extreme).
> **Every rule is an input**, so where the video differs, change a setting rather than
> the code. The section "If the video says something different" below maps each
> likely difference onto the input that controls it.

## How to use it

1. TradingView → **Pine Editor** → paste the contents of `trading-walk-5min.pine`.
2. **Add to chart**, then open any 5-minute chart (the script works on any timeframe,
   but defaults are tuned for 5m).
3. **Strategy Tester** tab for the backtest; the gear icon for the inputs.

## The rules as coded

| Step | Rule | Default |
|---|---|---|
| **Trend** | EMAs stacked in order — fast > mid > slow for longs, inverted for shorts | 8 / 21 / 55 EMA |
| **Pullback** | The bar's low must reach down to the fast EMA (within a tolerance) while its high stays above it | touch fast EMA, tolerance 0.10 × ATR |
| **Setup bar** | A rejection candle: small body, and the rejection wick at least as long as the body and longer than the opposite wick | body ≤ 45% of range, wick ≥ 1.0 × body |
| **Entry** | Buy-stop a couple of ticks above the setup bar's high (sell-stop below its low). Unfilled orders are cancelled | 2 ticks, cancel after 3 bars |
| **Stop loss** | Just beyond the setup bar's extreme, pushed out by an ATR buffer so it sits outside the noise instead of on the wick | setup bar extreme − 0.10 × ATR |
| **Target** | Fixed multiple of the risk | 2 R |
| **Break-even** | Stop moves to entry once the trade is 1 R in profit | on, at 1 R |
| **Risk** | Position size derived from the stop distance | 1% of equity per trade |

Trend direction shades the background (green up, red down), setup bars are marked with
a triangle, and the live entry / stop / target levels plot as blue / red / green lines.

### Why the ATR buffer on the stop

This is the part of the video the title points at. A stop sitting exactly on the setup
candle's wick gets picked off by a single tick of spread or a stop-hunt wick, turning a
trade that would have worked into a loss. The buffer (`stopBufAtr`, default 0.10 × ATR,
with a floor of one tick) places the stop *past* the level in proportion to current
volatility — wider when the market is moving, tighter when it isn't. Set it to `0` for
the stop exactly on the extreme.

## Inputs

**1 · Direction & trend filter** — longs/shorts on or off; `useTrend` to disable the
filter entirely; trend definition (EMA stack / fast vs mid / price vs slow EMA); the
three EMA lengths.

**2 · Pullback & setup candle** — setup type (`Doji or pin bar`, `Engulfing`,
`Any pullback candle`); doji body-size and wick-ratio thresholds; which EMA the pullback
must touch; touch tolerance in ATR.

**3 · Entry** — entry buffer in ticks; how many bars the pending order stays live;
whether to cancel when the trend flips.

**4 · Stop loss** — placement mode (`Setup bar extreme`, `Swing extreme`,
`ATR multiple`, `Fixed pips`); ATR buffer; swing lookback; ATR multiple; fixed pip
distance; ATR length; pip size override (`0` = auto: 10 ticks on FX, 1 tick elsewhere).

**5 · Targets & exits** — target in R; break-even move and its trigger in R; trailing
stop on the fast EMA; time stop after N bars.

**6 · Risk & session** — risk % per trade or a fixed quantity; session window and its
timezone; max new trades per day; skip trades whose stop is narrower/wider than X pips.

**7 · Display** — EMAs, levels and setup markers on/off.

## If the video says something different

| If the video… | Change |
|---|---|
| uses different EMAs (e.g. 9/20/50, or only two) | `Fast/Mid/Slow EMA`, and `Trend definition` → `Fast vs mid EMA` |
| enters at the candle's close, not on a stop order | `Entry buffer` → `0` and `Cancel unfilled order after N bars` → `1` (fills on the next bar) |
| puts the stop at the recent swing, not the setup candle | `Stop placement` → `Swing extreme` |
| puts the stop a fixed number of pips away | `Stop placement` → `Fixed pips` + `Fixed stop (pips)` |
| puts the stop at an ATR multiple | `Stop placement` → `ATR multiple` |
| wants the stop exactly on the wick | `Stop buffer beyond level` → `0` |
| targets 1:1, or 3:1 | `Target (R multiple)` |
| trails the stop instead of using a fixed target | `Trail stop on fast EMA` → on, `Target (R multiple)` → a large number |
| doesn't move to break-even | `Move stop to break-even` → off |
| needs no rejection candle, just a pullback | `Setup candle` → `Any pullback candle` |
| trades only a session (e.g. London open) | `Restrict to session` → on, set `Session` + timezone |

## Notes and limits

- **Position sizing** assumes P&L scales as `quantity × price move`, which holds for FX,
  CFDs and crypto on TradingView. On futures, set `Size position by risk %` off and use
  a fixed quantity, or the sizing will be wrong by the contract multiplier.
- **Spread and commission** default to zero. For a realistic 5-minute backtest set
  commission in the `strategy()` properties and account for spread — on a 10-pip stop,
  a 1-pip spread is 10% of your risk.
- **No repainting**: setups are confirmed on bar close (`barstate.isconfirmed`) and the
  entry is a stop order placed for the following bars.
- The protective stop and target are submitted *with* the entry order, so the stop is
  live from the moment the entry fills rather than from the next bar's close.
- **Intrabar ambiguity**: when a bar's range contains both the stop and the target,
  TradingView can't know which came first. Enable *Bar Magnifier* in the Strategy Tester
  properties (or backtest on 1-minute data) if that matters for your numbers.
- Backtest results are not a forecast. A 5-minute strategy is especially sensitive to
  spread, slippage and session choice.
