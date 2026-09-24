# Kalshi ⇄ Polymarket arb

Finds the same question listed on both exchanges and checks whether buying
**YES on one + the opposite side on the other** costs less than the $1 that
exactly one of them pays at settlement, **after both venues' taker fees**,
sized to real orderbook depth. It can also place both legs.

```
node arb/scan.mjs discover --series KXNFLGAME    # find matching markets → arb/candidates.json
node arb/scan.mjs pairs                          # price arb/pairs.json on live books, after fees
node arb/bot.mjs                                 # watch loop, DRY RUN (prints + logs, never trades)
node arb/bot.mjs --live --min-edge 0.02 --max-contracts 20 --max-exposure 200
node arb/arb.test.mjs                            # tests (no network)
```

No dependencies for scanning. Live Polymarket trading needs the official SDK: `npm i --prefix arb`.

## It does not lock in a 100% win

The math is risk-free only if both markets settle on the same fact. Here is
what goes wrong in practice, and what the bot does about each:

| Risk | What happens | What the bot does |
|---|---|---|
| **Resolution mismatch** | The two venues word the question differently: tie or overtime rules, postponements, cut-off times, data source. One settles YES and the other settles "50/50" or NO, so you lose one leg or both. | Trades only pairs that you mark `"verified": true` after reading **both** rulebooks. Discovery output is always `verified: false`. |
| **Leg risk** | The first order fills, then the price moves before the second fills. You now hold a one-sided bet. | Both legs are fill-or-kill. If the Polymarket leg misses, the bot retries once at break-even. If that also misses, it sells the Kalshi leg back, logs `UNHEDGED_UNWIND`, and **halts**. An unwind can lose money. |
| **Fees** | Kalshi charges 0.07·C·P·(1−P), rounded up to the cent. Polymarket charges C·rate·p·(1−p), where the rate is set per market. At 50/50 prices, fees can eat about 2.5¢ of a 3¢ gap. | Every edge shown by `pairs` and `bot` is net of both fees. `--min-edge` is in dollars per contract after fees. |
| **Capital lock-up** | Your money sits on both venues until settlement. 1% profit over 3 months is a poor return. | Shows annualised return next to each opportunity. |
| **Venue risk / access** | Separate accounts and balances: USD on Kalshi, USDC on Polygon for Polymarket. The international Polymarket exchange **does not accept US persons**, and many of its markets are flagged `restricted`. Polymarket US is a separate CFTC-regulated venue with its own API, which this code does not support. | Only trade where you are allowed to. The scanner reads public data only. |

**What the live scan found (2026-09-24):** all 15 NFL games this week are
listed on both venues, and every one is priced within ±1¢ of $1 at the top of
the book, i.e. no gap even before fees. The cheapest pair would have *lost*
about 1.6% after fees. Gaps like this get closed quickly by professional
market makers. Expect real opportunities to be rare, small, and short-lived.
The bot is built to wait for them and to do nothing otherwise.

## Setup for live trading

Kalshi: create an API key under Account → API Keys.
```
export KALSHI_API_KEY_ID=...
export KALSHI_PRIVATE_KEY_PATH=~/kalshi-key.pem
```
Polymarket (only if you are eligible to use it):
```
npm i --prefix arb
export POLY_PRIVATE_KEY=0x...           # the wallet key that signs orders
export POLY_FUNDER=0x...                # your Polymarket profile/proxy address, if you use one
export POLY_SIGNATURE_TYPE=1            # 0 = plain wallet, 1 = email/Magic login, 2 = browser-wallet proxy
```
Start with `--max-contracts 5 --max-exposure 25` and watch `arb/trades.jsonl`.

## pairs.json

```json
{
  "name": "Cincinnati vs Pittsburgh — Pittsburgh",
  "kalshi": "KXNFLGAME-26SEP27CINPIT-PIT",
  "polySlug": "nfl-cin-pit-2026-09-27",
  "polyOutcomeSameAsKalshiYes": "Steelers",
  "verified": false
}
```
`polyOutcomeSameAsKalshiYes` is the Polymarket outcome that pays in exactly
the cases where Kalshi YES pays. Get it wrong and the bot buys the **same**
side twice. Discovery fills it in only when team codes or Yes/No labels make
it unambiguous; check it anyway.

## Files

- `lib/math.mjs`: fee formulas and the two-book fill planner (pure, tested)
- `lib/kalshi.mjs`: public data, orderbook conversion (Kalshi lists only bids; a NO bid at p is a YES ask at 1−p), RSA-PSS request signing, FOK orders
- `lib/polymarket.mjs`: Gamma keyset paging, CLOB books, FOK orders via `@polymarket/clob-client`
- `lib/match.mjs`: game matching by league + team codes + date (Kalshi uses cities, Polymarket uses nicknames), plus fuzzy title matching for everything else
- `lib/pairs.mjs`: prices a pair on live books and picks the better of its two routes
- `bot.mjs`: the loop, exposure cap, execution, unwind, and halt
- Local only, gitignored: `state.json`, `trades.jsonl`, `candidates.json`
