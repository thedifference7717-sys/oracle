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

// Kalshi quotes in cents of probability. A 73c ask is a 73% implied chance,
// which is -270 in American terms.
const centsToAmerican = c => {
  const p = c / 100;
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
const rows = [];
for (const m of ms) {
  const bid = m.yes_bid, ask = m.yes_ask, last = m.last_price;
  const has = bid != null && ask != null && (bid > 0 || ask > 0);
  if (has) quoted++;
  // What you would actually PAY is the ask.
  const am = has && ask > 0 ? centsToAmerican(ask) : null;
  if (inBand(am)) { band++; rows.push({ t: m.ticker, title: m.title, bid, ask, last, am, spread: (ask != null && bid != null) ? ask - bid : null }); }
}

console.log(`\n${quoted} of ${ms.length} markets have a two-sided quote.`);
console.log(`${band} are inside ${BAND.lo}..${BAND.hi} at the ASK — i.e. actually bettable there.\n`);
if (rows.length) {
  console.log("  AMERICAN  BID/ASK  SPREAD  MARKET");
  rows.sort((a, b) => b.am - a.am).slice(0, 30).forEach(r =>
    console.log(`  ${String(r.am).padStart(8)}  ${String(r.bid + "/" + r.ask + "c").padStart(8)}  ${String(r.spread + "c").padStart(6)}  ${String(r.title).slice(0, 56)}`));
} else {
  console.log("  NOTHING is bettable in the band right now. The band assumption is wrong,");
  console.log("  or the liquidity sits elsewhere on this board.");
}
