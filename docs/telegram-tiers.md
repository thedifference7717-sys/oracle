# Telegram: you, and three client tiers

| Who | Where | Gets |
|---|---|---|
| **You** | your existing chat (`TELEGRAM_CHAT_ID`) | **everything, always, first**: every pick, result, warning and command reply |
| Tier 1 | private channel `TG_TIER1` | the Ladder: pick at lock and result |
| Tier 2 | private channel `TG_TIER2` | the Ladder and the Dub |
| Tier 3 | private channel `TG_TIER3` | the Ladder, the Dub and the Robin |

Your access doesn't depend on any subscription: your chat isn't one of the
tier channels, and the bot only takes commands (`/odds`, `/paid`, `/dub`,
`/bets`, `/tiers`) from your chat. Client copies are the same messages
without the hints about those commands.

Nothing changes until a tier channel is set. A tier that isn't set is skipped.

## Setting up the channels

1. In Telegram, create three **private channels**, for example "Prop Shop · Ladder",
   "Prop Shop · Ladder + Dub" and "Prop Shop · All Access".
2. Add your bot to each one as an **admin** with permission to post messages.
   The bot messages you each channel's ID (📣 *Added to … Its ID: -100…*). This
   takes up to a minute, while the alerter is running.
3. In the repo, go to Settings → Secrets and variables → Actions →
   **Variables**, and add:
   - `TG_TIER1` = the Ladder channel's ID
   - `TG_TIER2` = the Ladder + Dub channel's ID
   - `TG_TIER3` = the all-access channel's ID
4. Once the next alerter run starts, send **`/tiers`** to the bot from your
   chat. It posts a test message to each channel and tells you which ones
   worked.

## Getting picks before clients (optional)

Set the variable `TG_CLIENT_DELAY_MIN` to hold client copies back that many
minutes after yours. For example, `5` gives you a five-minute head start. With
no value set, clients get each message right after you.

## Connecting payments later

A membership service such as Whop or LaunchPass can take the Stripe payment
and add or remove people in the matching channel. Point each plan at its tier's
channel. Your own chat stays outside all of it.

The code is in the private `prop-shop-engine` repo (`scripts/tiers.mjs`, with tests).
