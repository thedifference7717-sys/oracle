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
//
// One pass, deliberately. The first version listed every series and then made
// a second call PER SERIES to count its open markets, which is hundreds of
// sequential round trips behind a retrying client — it ran for six minutes
// without finishing. Open markets are the thing worth knowing, so ask for
// those directly and group them by series afterwards: the same answer, in a
// number of calls that depends on how many markets are live rather than on
// how many series Kalshi has ever created.

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

// Sports we have a model for. Anything else is not useful to the ladder yet.
const SPORTS = {
  NBA: /NBA|BASKETBALL/i,
  MLB: /MLB|BASEBALL/i,
  NFL: /NFL|FOOTBALL/i
};

// Every market currently open, in pages. This is the expensive call, so it is
// the only one we make.
const markets = [];
let cursor = "";
for (let page = 0; page < 60; page++) {
  const d = await get(`${KALSHI}/markets?status=open&limit=1000${cursor ? "&cursor=" + cursor : ""}`);
  const batch = d.markets || [];
  markets.push(...batch);
  cursor = d.cursor || "";
  process.stdout.write(`\rfetched ${markets.length} open markets…`);
  if (!cursor || !batch.length) break;
}
console.log(`\rKalshi has ${markets.length} open markets right now.\n`);

// Group by series. The API gives series_ticker on most markets; where it does
// not, the series is the ticker up to the first dash.
const bySeries = new Map();
for (const m of markets) {
  const key = m.series_ticker || String(m.ticker || "").split("-")[0];
  if (!key) continue;
  const e = bySeries.get(key) || { n: 0, sample: m.title || m.subtitle || "", yes: [] };
  e.n++;
  if (e.yes.length < 3 && m.yes_bid != null && m.yes_ask != null) {
    e.yes.push(`${m.yes_bid}/${m.yes_ask}c`);
  }
  bySeries.set(key, e);
}

for (const [sport, re] of Object.entries(SPORTS)) {
  const rows = [...bySeries.entries()]
    .filter(([k, v]) => re.test(k) || re.test(v.sample))
    .sort((a, b) => b[1].n - a[1].n);
  console.log(`=== ${sport} — ${rows.length} series with live markets ===`);
  if (!rows.length) console.log("  (nothing open — out of season, or the name does not match)");
  for (const [k, v] of rows.slice(0, 25)) {
    console.log(`  ${String(v.n).padStart(4)} open  ${k.padEnd(26)} ${v.yes.join(" ").padEnd(22)} ${String(v.sample).slice(0, 60)}`);
  }
  console.log();
}
