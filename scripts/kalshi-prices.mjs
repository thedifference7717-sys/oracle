// Are there tradeable prices in the -200/-350 band, and what do they look like?
//
// Everything the ladder has ever shown has been an ASSUMED price. The card
// says "-250 · Assumed — type what your book is actually showing" because the
// system has never read a real quote in its life. Before any of the new
// selection logic can filter on price, that has to stop being a guess.
//
// This pulls today's MLB hit markets off Kalshi, prints the raw shape of the
// first one so the field names are established rather than assumed, and then
// reports every market as an American price with its bid/ask — so we can see
// how much of the board is actually inside the band, and how wide the spread
// is when it is.
//
// Read-only. Run: node scripts/kalshi-prices.mjs [SERIES]

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = process.argv[2] || "KXMLBHIT";
const BAND = { lo: -350, hi: -200 };

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.status === 404) throw new Error("HTTP 404");      // definitive, do not retry
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1200 * (i + 1))); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      if (/404/.test(e.message)) break;
      await new Promise(s => setTimeout(s, 500 * (i + 1)));
    }
  }
  throw last;
}

// Read the quote out of whichever fields this response actually carries.
//
// The first version of this read m.yes_bid and m.yes_ask and reported "0 of
// 315 markets have a two-sided quote" — which was not a fact about Kalshi, it
// was a fact about me reading keys that do not exist. This endpoint returns
// yes_bid_dollars / yes_ask_dollars as decimal strings, and where the yes
// side is absent the no side is there instead: a no_bid of 0.97 IS a yes ask
// of 0.03. I printed the raw shape precisely so the names would not be
// guessed, and then guessed anyway.
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
function quote(m) {
  // Probabilities in 0..1, however they are spelled.
  let yb = num(m.yes_bid_dollars), ya = num(m.yes_ask_dollars);
  if (yb == null && m.yes_bid != null) yb = num(m.yes_bid) / 100;
  if (ya == null && m.yes_ask != null) ya = num(m.yes_ask) / 100;
  const nb = num(m.no_bid_dollars), na = num(m.no_ask_dollars);
  // A no quote is the yes quote inverted: buying yes at 1 - no_bid.
  if (ya == null && nb != null) ya = 1 - nb;
  if (yb == null && na != null) yb = 1 - na;
  const last = num(m.last_price_dollars);
  return { yb, ya, last };
}

// A probability as American odds. 0.73 is -270.
const probToAmerican = p => {
  if (!(p > 0 && p < 1)) return null;
  const d = 1 / p;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
};
const inBand = a => a != null && a <= BAND.hi && a >= BAND.lo;

const d = await get(`${KALSHI}/markets?series_ticker=${SERIES}&status=open&limit=1000`);
const ms = d.markets || [];
console.log(`${SERIES}: ${ms.length} open markets\n`);
if (!ms.length) { console.log("nothing open — wrong series, or no slate."); process.exit(0); }

console.log("── raw shape of one market, so field names are established not guessed ──");
console.log(JSON.stringify(ms[0], null, 1).split("\n").slice(0, 34).join("\n"));

let quoted = 0, band = 0;
const rows = [], strikes = new Map();
for (const m of ms) {
  const q = quote(m);
  const has = q.ya != null && q.ya > 0 && q.ya < 1;
  if (has) quoted++;
  // The strike is what the bet actually is. "1+ hits" is the ladder's market;
  // "3+ hits" is a lottery ticket that happens to live in the same series.
  const k = m.floor_strike != null ? String(m.floor_strike) : "?";
  strikes.set(k, (strikes.get(k) || 0) + 1);
  const am = has ? probToAmerican(q.ya) : null;      // what you PAY is the ask
  if (inBand(am)) {
    band++;
    rows.push({ title: m.no_sub_title || m.title, strike: k, am,
                bid: q.yb, ask: q.ya,
                spread: (q.ya != null && q.yb != null) ? +(q.ya - q.yb).toFixed(2) : null });
  }
}
console.log("\n── strikes on this board (which bet each market actually is) ──");
[...strikes.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) =>
  console.log(`  ${String(n).padStart(4)} markets at ${k}+`));

console.log(`\n${quoted} of ${ms.length} markets have a two-sided quote.`);
console.log(`${band} are inside ${BAND.lo}..${BAND.hi} at the ASK — i.e. actually bettable there.\n`);
if (rows.length) {
  console.log("  AMERICAN     BID/ASK  SPREAD  STRIKE  MARKET");
  rows.sort((a, b) => b.am - a.am).slice(0, 30).forEach(r =>
    console.log(`  ${String(r.am).padStart(8)}  ${String((r.bid != null ? r.bid.toFixed(2) : "–") + "/" + (r.ask != null ? r.ask.toFixed(2) : "–")).padStart(11)}  ${String(r.spread != null ? r.spread.toFixed(2) : "–").padStart(6)}  ${String(r.strike + "+").padStart(5)}  ${String(r.title).slice(0, 46)}`));
} else {
  console.log("  NOTHING is bettable in the band right now. The band assumption is wrong,");
  console.log("  or the liquidity sits elsewhere on this board.");
}
