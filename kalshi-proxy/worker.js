/**
 * Kalshi → GridAIron read-only CORS bridge.
 *
 * Kalshi's public market data is open to anyone, but it is served without the
 * cross-origin headers a browser insists on, so a page on GitHub Pages cannot
 * read it directly. This Worker is the ten-line bridge: it forwards a GET to
 * Kalshi's public endpoints and hands the answer back with the headers the
 * browser wants.
 *
 * It is deliberately incapable of trading. It forwards nothing but GET, it
 * carries no Kalshi credentials of any kind, and it refuses any path outside
 * the public market-data endpoints — so the worst it can do is tell you what
 * something is trading at. Nothing to leak, nothing to lose.
 *
 * Deploy:  wrangler deploy
 * Then paste the Worker URL into GridAIron's EXCHANGE PROXY field.
 */
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

// Public market data only. No portfolio, no orders, no balance — those need
// credentials this Worker does not have and must never be given.
const ALLOWED = [
  /^\/markets\/?$/,
  /^\/markets\/[A-Za-z0-9._-]+\/?$/,
  /^\/markets\/[A-Za-z0-9._-]+\/orderbook\/?$/,
  /^\/events\/?$/,
  /^\/events\/[A-Za-z0-9._-]+\/?$/,
  /^\/series\/?$/,
  /^\/series\/[A-Za-z0-9._-]+\/?$/
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") {
      return new Response("This bridge forwards GET requests for Kalshi public market data. Nothing else.",
        { status: 405, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/") {
      return new Response("Kalshi read-only bridge for GridAIron. Try /markets?series_ticker=KXNFLGAME&status=open&limit=5",
        { status: 200, headers: cors });
    }
    if (!ALLOWED.some(re => re.test(path))) {
      return new Response(JSON.stringify({ error: "path not allowed by this bridge" }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const target = KALSHI + path + (url.search || "");
    try {
      const r = await fetch(target, { headers: { Accept: "application/json" }, cf: { cacheTtl: 20, cacheEverything: true } });
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: { ...cors, "Content-Type": r.headers.get("content-type") || "application/json", "Cache-Control": "public, max-age=20" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "upstream unreachable", detail: String(e) }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    }
  }
};
