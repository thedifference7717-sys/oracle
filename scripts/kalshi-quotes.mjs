// Live Kalshi prices for "to record a hit", by player.
//
// Until now every price the ladder showed was assumed — "-250 · Assumed" on
// the card, and every rung compounded on it. The real board says otherwise:
// on 2026-09-22 the 1+ hit asks ran 67c to 73c, i.e. -203 to -270, with 1-5c
// spreads. Assuming -250 overstated most rungs.
//
// Three things about Kalshi's response that bit an earlier probe and are
// handled here on purpose:
//   - Quotes come as *_dollars decimal strings (yes_ask_dollars "0.71"), not
//     cents. Where the yes side is missing, the no side is the same quote
//     inverted: no_bid 0.29 IS a yes ask of 0.71.
//   - One series holds every strike. floor_strike 0.5 is "1+ hits", the
//     ladder's bet; 1.5/2.5/3.5 are different, far longer bets that happen to
//     share the ticker prefix.
//   - The player's name lives in the sub-title ("Mookie Betts: 1+"), and
//     names differ in accents and suffixes across Kalshi and MLB StatsAPI.

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

export function quoteOf(m) {
  let yb = num(m.yes_bid_dollars), ya = num(m.yes_ask_dollars);
  if (yb == null && m.yes_bid != null) yb = num(m.yes_bid) / 100;
  if (ya == null && m.yes_ask != null) ya = num(m.yes_ask) / 100;
  const nb = num(m.no_bid_dollars), na = num(m.no_ask_dollars);
  if (ya == null && nb != null) ya = +(1 - nb).toFixed(4);
  if (yb == null && na != null) yb = +(1 - na).toFixed(4);
  return { bid: yb, ask: ya };
}

export function probToAmerican(p) {
  if (!(p > 0 && p < 1)) return null;
  const d = 1 / p;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}

// "Luis García Jr." and "Luis Garcia" are the same man; "J.P. Crawford" and
// "JP Crawford" too. Accents, punctuation and generational suffixes go.
export function normName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ").trim();
}

export function playerOf(m) {
  const t = m.yes_sub_title || m.no_sub_title || m.subtitle || m.title || "";
  return String(t).split(":")[0].trim();
}

// Build name -> [quote,...] from a raw market list. Only the 1+ strike, only
// markets with a real two-sided price.
export function indexHitMarkets(markets) {
  const idx = new Map();
  for (const m of markets || []) {
    if (+m.floor_strike !== 0.5) continue;
    const q = quoteOf(m);
    if (!(q.ask > 0 && q.ask < 1)) continue;
    const player = playerOf(m);
    const key = normName(player);
    if (!key) continue;
    const row = {
      player, ticker: m.ticker, event: m.event_ticker,
      bid: q.bid, ask: q.ask, american: probToAmerican(q.ask),
      spread: q.bid != null ? +(q.ask - q.bid).toFixed(2) : null,
      at: m.occurrence_datetime || m.expected_expiration_time || null
    };
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(row);
  }
  return idx;
}

// The quote for this candidate. A doubleheader gives a man two markets; take
// the one closest to his game's first pitch.
export function lookup(idx, name, gameTime) {
  const list = idx.get(normName(name));
  if (!list || !list.length) return null;
  if (list.length === 1 || !gameTime) return list[0];
  const t = Date.parse(gameTime);
  return list.slice().sort((a, b) =>
    Math.abs(Date.parse(a.at) - t) - Math.abs(Date.parse(b.at) - t))[0];
}

export async function fetchHitQuotes({ series = "KXMLBHIT", fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${KALSHI}/markets?series_ticker=${series}&status=open&limit=1000`,
                            { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("Kalshi HTTP " + r.status);
  const d = await r.json();
  return indexHitMarkets(d.markets || []);
}
