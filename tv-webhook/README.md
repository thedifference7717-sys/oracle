# LuxAlgo SMC → Telegram relay

Forwards **LuxAlgo Smart Money Concepts** alerts from TradingView to your
Telegram bot. It relays alerts only — **it never places a trade**, so it's safe
for a prop-firm account that prohibits bots.

```
LuxAlgo SMC on TradingView  →  alert fires  →  webhook (POST)
   →  this Cloudflare Worker  →  Telegram message to your phone
```

Why a Worker: TradingView can POST to a webhook but can't message Telegram
directly, and a webhook needs an always-on listener (our 5-minute GitHub
Actions cron can only *poll*, it can't *receive*). A free Cloudflare Worker is
the simplest always-on bridge.

> Requires a **paid TradingView plan** (webhook alerts aren't on the free tier)
> and the LuxAlgo SMC indicator on your chart.

## 1. Deploy the Worker (no command line)

1. Sign in at **dash.cloudflare.com** (free account) → **Workers & Pages** →
   **Create application** → **Create Worker** → give it a name → **Deploy**.
2. Click **Edit code**, delete the sample, paste the contents of
   [`worker.js`](./worker.js), then **Deploy**.
3. Open the Worker's **Settings → Variables and Secrets** and add three
   **encrypted** secrets:
   - `TELEGRAM_BOT_TOKEN` — token from **@BotFather**
   - `TELEGRAM_CHAT_ID` — the number from **@userinfobot**
   - `WEBHOOK_SECRET` — any random string you invent (e.g. `s3cr3t-8842`)
4. Copy your Worker URL: `https://<name>.<subdomain>.workers.dev`

<details><summary>Prefer the CLI?</summary>

```bash
npm i -g wrangler
cd tv-webhook
wrangler deploy
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put WEBHOOK_SECRET
```
</details>

## 2. Test it

```bash
curl -X POST "https://<name>.workers.dev/?key=YOUR_WEBHOOK_SECRET" -d "relay test ✅"
```
A "📡 LuxAlgo SMC — relay test ✅" message should land in Telegram. A `401`
means the `?key=` doesn't match `WEBHOOK_SECRET`.

## 3. Point LuxAlgo's alerts at it

1. Add **LuxAlgo Smart Money Concepts** to your TradingView chart.
2. Create an alert (the clock icon, or right-click the chart → *Add alert*).
3. **Condition** → pick the LuxAlgo SMC signal you want (e.g. *Bullish BOS*,
   *Bearish CHoCH*, *Order Block*, *Liquidity*) — or **Any alert() function call**
   to forward every SMC signal.
4. **Notifications** tab → enable **Webhook URL** and paste:
   ```
   https://<name>.workers.dev/?key=YOUR_WEBHOOK_SECRET
   ```
5. **Message** box → what gets sent to Telegram. Placeholders are filled by
   TradingView, e.g.:
   ```
   {{ticker}} · {{interval}} · price {{close}} — SMC alert
   ```
6. **Create**. From now on, each LuxAlgo SMC alert is relayed to your phone.

## Security

The `?key=` secret stops strangers from spamming your Telegram through the
public Worker URL. Keep the URL+key private. To rotate, change `WEBHOOK_SECRET`
in the Worker and update the URL in your TradingView alerts.

## How this relates to the other alerter

`btc-alerts/` (the GitHub Actions cron) is a **separate, self-contained**
alerter that computes the 4h 50% Fib + 15m SMC structure itself and pings you on
its own schedule. This Worker instead relays **LuxAlgo's own** signals. You can
run either or both — both just send Telegram messages, neither places a trade.
