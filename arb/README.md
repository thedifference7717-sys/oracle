# arb — prediction market arbitrage scanner

Finds and (optionally) trades **structural** mispricings on Kalshi and
Polymarket: baskets whose fee-inclusive cost is below their guaranteed payout.

Runs paper-only by default. Two separate gates must be flipped before it can
place a real order.

```bash
python arb/selftest.py       # 29 offline tests, no network
python arb/main.py --probe   # connectivity + credential check, never trades
python arb/main.py           # one scan (paper mode)
python arb/main.py --account # positions, locked capital, release schedule
python arb/main.py --summary # what the ledger has recorded so far
python arb/main.py --plan 500
```

---

## The organizing principle: return per dollar per *day*

This is the one idea the rest of the system is built around, and it is the
difference between a profitable account and a collection of profitable trades.

**Capital is returned at settlement, not at fill.** A prediction market position
locks your cash until the event resolves — days to months. So ROI is the wrong
way to rank opportunities, and ranking on it is actively harmful:

| Opportunity | ROI | Resolves in | Annualised |
|---|---|---|---|
| A | 2% | 3 days | **243%** |
| B | 4% | 30 days | 49% |
| C | 20% | 400 days | 18% |

Sorted by ROI you take **C** and lock your bankroll for over a year at an
effective 18%/yr. Sorted by annualised return you take **A**, and the same
dollar comes back in three days to do it again — roughly **13× more** return on
the same capital.

Worse, an account full of C has no free cash when A appears. The cost of
ranking wrong is not just the weaker trade; it is every trade you then cannot
fund. So `sizing.rank()` sorts on `annualized_roi`, `risk.py` enforces a
minimum annualised return (default 15%/yr) and a maximum lockup (default 180d),
and `--account` reports **utilisation** and **weighted hold days** — because a
great edge deployed on 5% of your bankroll is a mediocre account.

Unknown resolution dates are treated as 90-day locks: pessimistic on purpose,
so a missing date can never outrank a known-short one.

## Account management

`portfolio.py` rebuilds open positions from the ledger on every run, rather
than keeping a running counter — a counter drifts whenever a run dies mid-scan,
and never notices a position settling and freeing its cash. Capital is treated
as locked until resolution **plus a 2-day settlement buffer**, so the account
never commits money it does not yet have back.

```
$ python arb/main.py --account
open_positions             3
locked_usd                 640.00
free_usd                   360.00
utilisation                0.64
weighted_hold_days         18.4
implied_annual_return      0.31
```

Risk limits in `risk.py`, all as fractions of bankroll:

- **Event concentration** (default 25%) — several baskets on one event are one
  bet on that event settling as written, not several independent edges.
  `cross:E1:...` and `kalshi:E1` share the budget.
- **Venue concentration** (default 60%) — counterparty risk. This is the one
  exposure no amount of hedging *inside* a venue can reduce.
- **Hold horizon** (default 180d) — past this, a trading strategy has quietly
  become an unsecured loan to an exchange with no coupon.

---

## Read this before funding anything

**No, it cannot be 100% wins.** Three claims get conflated; only the first is
true.

1. *An individual dutch book, once filled, carries no market risk.* True. If you
   hold one contract on every outcome of a mutually exclusive, exhaustive event
   and paid less than $1.00 all-in, exactly one leg settles at $1.00. You do not
   care who wins. The exchange's settlement rules guarantee it.

2. *Therefore every trade wins.* False. You are not guaranteed to **get** the
   fill. Legs fill independently, and a basket that half-fills is not a hedge —
   it is a naked directional position you did not choose. The system sells the
   excess back immediately (`execute.py`), and that unwind usually realises a
   small **loss**. Losing trades are a normal, designed-for outcome here.

3. *Therefore the system makes money.* Not established. That depends on how
   often real edges appear, how much depth they have, and how many you actually
   win. Nobody can tell you that from a code review — which is why paper mode
   is the default and `--plan` reads from the ledger instead of quoting you a
   return.

The residual risks are operational, not directional:

| Risk | Why it bites | Mitigation here |
|---|---|---|
| **Leg risk** | Legs fill independently; a partial basket is unhedged | Level down to min fill, sell back the excess, flag `UNHEDGED` if the unwind fails |
| **Latency** | Your book is stale the moment you read it | Limit prices pinned to the worst level priced; IOC orders; per-contract safety margin |
| **Speed** | Market makers hunt these with colocated infra | See "you will lose most races" below |
| **Fees** | A 4¢ edge on a 3-way is *negative* after Kalshi fees | Exact published formula, charged taker on every leg |
| **Resolution mismatch** | Cross-venue "same" markets can settle differently | Cross-venue trades require a human-verified `pairs.json` entry |
| **Capital lockup** | Cash is returned at *settlement*, not at fill | Deployed-capital cap and portfolio budget |
| **Counterparty** | Venue insolvency, halts, settlement disputes | Not mitigated. Do not deposit more than you can lose entirely |

### You will lose most races

These edges exist for seconds and are hunted by firms with colocated servers.
A scheduled scan is structurally late to nearly all of them. What survives at
this cadence is the slow, ugly stuff: wide multi-outcome events, thin books, and
markets nobody is making. That is a real but **small and infrequent** niche.
Expect long stretches of finding nothing. Finding nothing is the system working
correctly, not a bug to tune away.

---

## Kalshi or Polymarket?

**Use Kalshi for automated execution.** Not because its edges are better —
Polymarket's zero trading fee is a genuine structural advantage — but because
everything else about no-touch operation is simpler:

| | Kalshi | Polymarket |
|---|---|---|
| Trading fees | ~1.75¢/contract at 50¢, → 0 at the extremes | 0% on most markets (a real edge) |
| Order API | Official REST, API key + RSA signing | CLOB API, wallet/EIP-712 signing per order |
| Funding | USD, bank transfer | USDC on Polygon; bridging, gas, wallet custody |
| Regulation | CFTC-regulated designated contract market | Has been restricted for US persons; check your own status |
| Automation cost | Low | Meaningfully higher |

**The fee difference is not decisive; the operational difference is.** A
private key that can sign unlimited on-chain transactions sitting in CI is a
much larger blast radius than a Kalshi API key with a per-order cap.

So: this repo wires **order placement for Kalshi only**. Polymarket is fully
supported for market data and detection, and its opportunities are alerted, but
they are never auto-executed. Baskets containing a Polymarket leg fall back to
paper regardless of your settings — see `can_execute` in `main.py`.

---

## How much do I need to deposit?

The honest answer is that the deposit is not the binding constraint, and anyone
who gives you a number without seeing your ledger is guessing. Three things
actually set it:

**1. A floor set by fees.** Kalshi's fee ceiling is applied per *order*, so
per-contract cost falls as size rises. Tiny baskets are disproportionately
expensive. Below roughly 20–30 contracts per leg the fee rounding alone eats
most thin edges. That argues for a few hundred dollars minimum per basket, not
$20.

**2. Concurrency, not trade size.** Capital is locked until each market
**resolves** — days to months, not minutes. A $500 deposit fully committed to
one six-month basket at 3% is earning you 6% annualised and is *unavailable* for
the next opportunity. The default config caps any one basket at 1/4 of bankroll
for exactly this reason. Your deposit needs to cover the number of baskets you
expect to hold *simultaneously*, times their size.

**3. Observed opportunity rate — which you do not have yet.**

So the actual procedure:

```bash
# 1. Run paper mode for 2-4 weeks. Deposit nothing.
ARB_DRY_RUN=true python arb/main.py

# 2. Then look at what it actually found.
python arb/main.py --summary
```

If, after a few weeks, `opportunities_found` is near zero — which is a
realistic outcome — then the correct deposit is **$0**, and you have learned
that for free. If it found a steady stream, `--plan` sizes against the real
numbers:

```bash
python arb/main.py --plan 1000
```

As a rough frame once paper mode justifies funding at all: under ~$500 the
per-basket dollar profit is small enough that fees and effort dominate;
$1,000–$5,000 is where a 2–4% edge on a few concurrent baskets becomes real
money. Both are meaningless until your ledger supports them. **Never fund this
before paper mode shows edges that survive fees.**

---

## What it detects

**`dutch_book`** — one mutually exclusive, exhaustive outcome set on a single
venue. Buy every outcome; exactly one settles at $1. This is the only structure
the system trades unattended, because the guarantee comes from the exchange's
own settlement rules and carries no resolution risk. Eligibility uses Kalshi's
`mutually_exclusive` flag and Polymarket's `negRisk` flag — never a title match.
If any outcome cannot be quoted, the event is skipped: the missing leg is
exactly the one that can win.

**`cross_venue`** — YES on one venue against NO on another. Structurally the
same basket, but only an arb if both venues resolve *identically*: same source,
same cutoff, same handling of ties, voids, and a source that stops publishing.
Matching titles prove none of that. These are detected and alerted, but only
trade from a `verified: true` entry in `pairs.json` that a human wrote.

Notably **absent**: YES+NO inside a single Kalshi market. Kalshi's book is
unified — a YES bid at 40¢ *is* a NO ask at 60¢ — so that spread is
self-consistent by construction and never crosses. `selftest.py` asserts this.

## Book semantics (the easiest thing to get wrong)

Kalshi's orderbook returns **resting bids on both sides**, not bids and asks:

```
{"orderbook": {"yes": [[price_c, size], ...], "no": [[price_c, size], ...]}}
```

A NO bid at `p` is an offer to sell YES at `100 - p`. So the ladder you can
actually lift is the **opposite** side, mirrored:

```
YES asks = [(100 - p, size) for p, size in book["no"]]
NO  asks = [(100 - p, size) for p, size in book["yes"]]
```

Reading `book["yes"]` as a YES ask ladder inverts the market and manufactures
arbitrage that is not there. `test_kalshi_book_mirroring` pins this down.

Polymarket returns real asks per token, in decimal dollars. Prices are rounded
**up** to the cent and sizes **down** to whole contracts — both against us, so
sub-cent ticks can shave a real edge but can never invent a fake one.

## Sizing

Cost is computed by walking the actual ladder, never off the best ask. Cost is
convex in size and payout is linear, so profit is concave; the detector sweeps
feasible sizes and keeps the maximum. A basket showing 3 cheap contracts on top
of expensive depth is sized at 3, not at the full depth.

Each leg's limit price is pinned to the **worst level it touches**, so one order
sweeps the ladder without ever paying above what the opportunity was priced at.

## Configuration

All knobs are environment variables (repository variables/secrets in CI).

| Variable | Default | Meaning |
|---|---|---|
| `ARB_DRY_RUN` | `true` | Paper mode. Must be `false` to trade |
| `ARB_LIVE` | `false` | Second gate. Must be `1` to trade |
| `ARB_BANKROLL_USD` | `0` | Settled cash available |
| `ARB_MAX_STAKE_USD` | `100` | Ceiling on any single basket |
| `ARB_MAX_DEPLOYED_USD` | `500` | Ceiling on total capital locked at once |
| `ARB_MAX_CONTRACTS` | `500` | Per-leg contract ceiling |
| `ARB_MIN_PROFIT_C` | `25` | Absolute profit floor, cents |
| `ARB_MIN_ROI` | `0.01` | Minimum profit / capital-at-risk |
| `ARB_MIN_ANNUAL_ROI` | `0.15` | Minimum return per dollar per **year** |
| `ARB_MAX_EVENT_FRACTION` | `0.25` | Cap on exposure to one event |
| `ARB_MAX_VENUE_FRACTION` | `0.60` | Cap on counterparty exposure per venue |
| `ARB_MAX_HOLD_DAYS` | `180` | Reject baskets locking capital longer |
| `ARB_SAFETY_MARGIN_C` | `1` | Cents/contract shaved off every edge |
| `ARB_CROSS_VENUE` | `false` | Enable cross-venue detection |
| `ARB_POLY_TAKER_BPS` | `0` | Polymarket taker fee, basis points |
| `KALSHI_KEY_ID` / `KALSHI_PRIVATE_KEY` | — | API key id + RSA PEM |
| `KALSHI_BEARER` | — | Alternative bearer token auth |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Alerts |
| `STATE_BLOB_URL` | — | jsonblob URL for dedupe + deployed-capital state |

Live trading requires `ARB_DRY_RUN=false` **and** `ARB_LIVE=1` **and**
credentials. Any one missing keeps it on paper.

## Before going live

The order-placement path in `execute.py` has **not been smoke-tested against a
live Kalshi account** — it was written against the documented request shape, and
this repo's CI cannot reach the venue. Field names (`taker_fill_count`,
`expiration_ts` for IOC) should be confirmed against a real response before you
trust them with money. Do this first:

```bash
ARB_DRY_RUN=false ARB_LIVE=1 python arb/main.py --probe   # auth + balance only
```

Then place one deliberately tiny basket by hand and confirm the fill counts and
the unwind path behave as `selftest.py` asserts.

## Files

```
config.py      env knobs, two-gate live check
models.py      Level / Quote / Leg / Opportunity, all in integer cents
fees.py        Kalshi published fee curve, exact; Polymarket knobs
venues/        kalshi.py (book mirroring), polymarket.py (Gamma + CLOB)
detect.py      dutch book + cross venue, depth-aware, fee-inclusive
sizing.py      allocation ranked by annualised return, not ROI
portfolio.py   open positions, locked vs free capital, release schedule
risk.py        concentration caps, hold horizon, fractional Kelly
execute.py     IOC legs, level-down reconciliation, unwind
ledger.py      append-only JSONL, paper and live share a schema
scan.py        venue data -> candidates (fixture-drivable)
main.py        entry point: scan / probe / summary / plan
selftest.py    29 offline tests
pairs.json     human-verified cross-venue pairs (edit before enabling)
```
