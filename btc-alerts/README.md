# BTC 4h Fib + 15m MSS — Telegram alerts

A scheduled checker that watches BTC and sends **staged** Telegram alerts for a
two-step trend-continuation setup:

- **Step 1 — 4h 50% Fib.** Find the most recent confirmed 4h swing leg (pivot
  based). When price pulls back into the 50% retracement zone of that leg, the
  setup *arms* and you get a Step 1 alert.
- **Step 2 — 15m confirmation.** While armed, watch the 15m chart. When a
  **market-structure shift** (latest 15m close breaks the most recent 15m swing
  high for longs / swing low for shorts) lines up with **3 consecutive candles**
  in the trade direction, you get the Step 2 "setup confirmed" alert.

Works **both directions**: a 4h up-leg gives long setups, a down-leg gives shorts.

> ⚠️ This is an alerting aid, not financial advice or an auto-trader. It never
> places orders. Always confirm on your own chart and follow your prop-firm rules.

## How it runs

`.github/workflows/btc-alerts.yml` runs `btc-alerts/main.py` every ~5 minutes on
GitHub Actions. State (which alerts have fired for the current setup) is kept in
a keyless [jsonblob](https://jsonblob.com) blob so each alert fires once.

OHLC comes from **Kraken** (native 4h + 15m intervals, reachable from CI),
falling back to **Binance**.

## Setup

1. **Create a Telegram bot.** Message [@BotFather](https://t.me/BotFather) →
   `/newbot` → copy the **bot token**.
2. **Get your chat id.** Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[].message.chat.id`
   (or message [@userinfobot](https://t.me/userinfobot)).
3. **Add repository secrets** (Settings → Secrets and variables → Actions):
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `STATE_BLOB_URL` *(optional)* — a jsonblob URL to use for state. If omitted,
     the workflow auto-creates one on first run and commits it to
     `btc-alerts/.state-url`.
4. **Activate the schedule.** Scheduled workflows only run on the **default
   branch**, so merge this to `main`. Until then, test it from any branch via
   **Actions → BTC 4h Fib + 15m MSS alerts → Run workflow**.

## Tuning (optional repository variables / env)

| Variable | Default | Meaning |
|---|---|---|
| `PIVOT_STRENGTH_4H` | `3` | Candles each side required for a 4h swing pivot |
| `FIB_ZONE_BAND` | `0.03` | 50% zone half-width as a fraction of the leg (≈47–53%) |
| `PIVOT_STRENGTH_15M` | `2` | Candles each side required for a 15m swing pivot |
| `CONSECUTIVE_CANDLES` | `3` | Consecutive confirming 15m candles required |
| `BTC_KRAKEN_PAIR` | `XBTUSD` | Kraken pair |
| `BTC_BINANCE_SYMBOL` | `BTCUSDT` | Binance fallback symbol |

## Run locally

```bash
pip install -r btc-alerts/requirements.txt
# Without TELEGRAM_* set, alerts print to stdout (dry run):
python btc-alerts/main.py
```
