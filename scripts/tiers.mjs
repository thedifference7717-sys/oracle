// Client channels by tier — who gets which message.
//
// The owner's chat (TELEGRAM_CHAT_ID) gets everything the alerter sends,
// always, and always first: commands, warnings, the lot. Paying clients get
// their tier's picks and results in private Telegram channels:
//
//   TG_TIER1  the Ladder
//   TG_TIER2  the Ladder and the Dub
//   TG_TIER3  the Ladder, the Dub and the Robin
//
// A channel that is not configured is simply skipped, so this is a no-op
// until the first one is set. TG_CLIENT_DELAY_MIN holds client copies back
// that many minutes after the owner's (default 0: straight after).

export const PRODUCT_TIERS = { ladder: [1, 2, 3], dub: [2, 3], robin: [3] };

export function tierConfig(env) {
  const ch = [1, 2, 3].map(i => String(env[`TG_TIER${i}`] || "").trim());
  return {
    channels: ch,                                           // index 0 = tier 1
    delayMs: Math.max(0, +(env.TG_CLIENT_DELAY_MIN || 0) || 0) * 60000,
    any: ch.some(Boolean)
  };
}

// The channels one product's message goes to — each at most once, even if
// two tiers share a channel.
export function routes(cfg, product) {
  return [...new Set((PRODUCT_TIERS[product] || []).map(t => cfg.channels[t - 1]).filter(Boolean))];
}

// The client copy: the owner's hints about bot commands are dropped, because
// the bot only takes commands from the owner's chat.
export const forClients = text => String(text)
  .replace(/\n?<i>Got a different price\?[^<]*<\/i>/g, "")
  .replace(/\n{3,}/g, "\n\n");

// The outbox, held in state so a delayed or failed send survives the pass (and
// the runner). Each entry is one message to one channel.
export function enqueue(q, chats, text, at) {
  for (const chat of chats) q.push({ chat, text, at, tries: 0 });
  return q;
}
// Send what is due; keep what is not, and what failed (for a day, 30 tries).
export async function flush(q, send, now = Date.now(), log = () => {}) {
  const keep = [];
  for (const m of q) {
    if (m.at > now) { keep.push(m); continue; }
    try { await send(m.chat, m.text); }
    catch (e) {
      m.tries = (m.tries || 0) + 1;
      if (m.tries < 30 && now - m.at < 86400000) keep.push(m);
      log(`telegram: client send to ${m.chat} failed (${e.message})${m.tries < 30 ? " — will retry" : " — dropped"}`);
    }
  }
  q.splice(0, q.length, ...keep);
  return q;
}
