/**
 * TradingView (LuxAlgo Smart Money Concepts) → Telegram relay.
 *
 * TradingView can POST an alert to a webhook but can't message Telegram
 * directly. This Cloudflare Worker is the always-on bridge: it receives the
 * alert, checks a shared secret, and forwards the message to your bot chat.
 *
 * It places NO trades — it only relays alerts. Prop-firm safe.
 *
 * Secrets to set in the Worker (Settings → Variables and Secrets):
 *   TELEGRAM_BOT_TOKEN   token from @BotFather
 *   TELEGRAM_CHAT_ID     your chat id (number from @userinfobot)
 *   WEBHOOK_SECRET       any random string you invent; put it in the URL as ?key=
 */
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response(
        "LuxAlgo SMC → Telegram relay is live. Point a TradingView webhook here (POST).",
        { status: 200 }
      );
    }

    const url = new URL(request.url);
    const raw = (await request.text()) || "";

    // TradingView may send JSON or plain text — handle both.
    let payload = {};
    try { payload = JSON.parse(raw); } catch { payload = {}; }

    // Shared-secret check: ?key= in the URL, or a "secret" field in JSON.
    const provided = url.searchParams.get("key") || payload.secret || "";
    if (!env.WEBHOOK_SECRET || provided !== env.WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return new Response("server not configured (missing TELEGRAM_* secrets)", { status: 500 });
    }

    // Message to relay: JSON text/message field, else the raw body.
    let text = (payload.text || payload.message || raw || "").toString().trim();
    if (!text) text = "TradingView alert (empty message body).";
    // Telegram hard-limits messages to 4096 chars.
    if (text.length > 3900) text = text.slice(0, 3900) + "…";

    const tg = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `📡 <b>LuxAlgo SMC</b>\n${escapeHtml(text)}`,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );

    if (!tg.ok) {
      return new Response("telegram error: " + (await tg.text()), { status: 502 });
    }
    return new Response("ok", { status: 200 });
  },
};

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
