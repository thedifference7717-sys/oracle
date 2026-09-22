// What player-prop markets does Kalshi actually list, and for which sports?
//
// The ladder is moving to "best single player prop in any sport, priced -200
// to -350". That needs a price feed across sports, and the only one already
// wired here is Kalshi — which is free, public, and the book the picks are
// actually traded on, so its prices are the right ones by definition.
//
// kalshi-snapshot.mjs already pulls NFL props, but it hardcodes series tickers
// (KXNFLPASSYDS and friends) that somebody had to look up. This finds the rest
// rather than guessing: list every series, keep the ones that look like a
// player prop for a sport we model, and print them with a live market count so
// it is obvious which are real and which are dormant out of season.
//
// Read-only. Writes nothing, commits nothing. Run: node scripts/kalshi-discover.mjs

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

async function get(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { last = e; await new Promise(s => setTimeout(s, 600 * (i + 1))); }
  }
  throw last;
}

// Sports we already have a model for. Anything else is not useful yet.
const SPORTS = {
  NBA: /\bNBA\b|BASKETBALL/i,
  MLB: /\bMLB\b|BASEBALL/i,
  NFL: /\bNFL\b|FOOTBALL/i
};

const series = [];
let cursor = "";
for (let page = 0; page < 40; page++) {
  const d = await get(`${KALSHI}/series?limit=200${cursor ? "&cursor=" + cursor : ""}`);
  const batch = d.series || d.series_list || [];
  series.push(...batch);
  cursor = d.cursor || "";
  if (!cursor || !batch.length) break;
}
console.log(`Kalshi lists ${series.length} series in total.\n`);

for (const [sport, re] of Object.entries(SPORTS)) {
  const mine = series.filter(s =>
    re.test(`${s.ticker || ""} ${s.title || ""} ${s.category || ""}`));
  console.log(`=== ${sport} — ${mine.length} series ===`);
  const rows = [];
  for (const s of mine) {
    let open = 0;
    try {
      const m = await get(`${KALSHI}/markets?series_ticker=${encodeURIComponent(s.ticker)}&status=open&limit=200`);
      open = (m.markets || []).length;
    } catch (e) { open = -1; }
    rows.push({ ticker: s.ticker, open, title: (s.title || "").slice(0, 64) });
  }
  // Live ones first: an empty series is out of season, not useless.
  rows.sort((a, b) => b.open - a.open);
  for (const r of rows) {
    console.log(`  ${String(r.open).padStart(4)} open  ${String(r.ticker).padEnd(24)} ${r.title}`);
  }
  console.log();
}
