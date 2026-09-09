// Kalshi → GridAIron snapshot.
//
// Kalshi serves its public market data without cross-origin headers, so a page
// on GitHub Pages cannot read it directly, and the public CORS proxies are all
// either gone, key-walled, or rate-limited by Kalshi itself. Deploying the
// Worker in kalshi-proxy/ solves it properly and gives live prices.
//
// This is the path for people who would rather not deploy anything: a workflow
// runs it on a schedule and commits the result, so the board reads the exchange
// from its own origin with no setup at all. The cost is honest and stated on
// the page — the prices are as old as the last run, so they are good for
// FINDING a candidate and not for trading on blind. Check the live number
// before you send an order.
//

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = {
  nfl: { ml: "KXNFLGAME", spread: "KXNFLSPREAD", total: "KXNFLTOTAL" },
  cfb: { ml: "KXNCAAFGAME", spread: "KXNCAAFSPREAD", total: "KXNCAAFTOTAL" }
};
// Player ladders. Only the NFL has them; college props are not listed. Trimmed
// the same way as the game ladders, they cost about 15KB gzipped, which is
// nothing — and without them the ranked props board has no price to rank
// against and simply sits there empty, which is exactly what it did.
const PROP_SERIES = {
  nfl: { passYds: "KXNFLPASSYDS", recYds: "KXNFLRECYDS", rec: "KXNFLREC", passTD: "KXNFLPASSTDS" }
};
const PROP_MAX_RUNGS = 8;
const DAYS = 8;                       // anything kicking off later is not this week's problem
// A ladder has rungs nobody will ever trade — a contract at three cents is
// there for completeness, not for business. Keeping only what is near the
// money holds the file to something that can be committed on a schedule
// without the repository growing a megabyte an hour, and loses nothing: best
// execution compares against the book's posted number, which is by definition
// near the money.
const NEAR = [0.05, 0.95];            // keep rungs whose midpoint is in here
const MAX_RUNGS = 10;                 // per game, per market, closest to even first
const OUT = "data/kalshi-football.json";

const num = v => (v === null || v === undefined || v === "") ? null : (isFinite(parseFloat(v)) ? parseFloat(v) : null);
const round = (v, d) => v == null ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

async function get(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { last = e; await new Promise(s => setTimeout(s, 700 * (i + 1))); }
  }
  throw last || new Error("unreachable " + url);
}

async function series(ticker) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 4; page++) {
    const d = await get(`${KALSHI}/markets?series_ticker=${ticker}&status=open&limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    (d.markets || []).forEach(m => out.push(m));
    cursor = d.cursor || "";
    if (!cursor || !(d.markets || []).length) break;
  }
  return out;
}

// Only what the board actually prices with, rounded to the cent it trades in.
const trim = m => ({
  t: m.ticker,
  l: m.yes_sub_title || m.title || m.ticker,
  s: num(m.floor_strike),
  b: round(num(m.yes_bid_dollars), 2),
  a: round(num(m.yes_ask_dollars), 2),
  bs: Math.round(num(m.yes_bid_size_fp) || 0),
  as: Math.round(num(m.yes_ask_size_fp) || 0),
  oi: Math.round(num(m.open_interest_fp) || 0)
});

const cutoff = Date.now() + DAYS * 86400e3;

const snap = { at: new Date().toISOString(), days: DAYS, leagues: {} };
let total = 0;

for (const [league, S] of Object.entries(SERIES)) {
  const events = {};
  for (const [kind, ticker] of Object.entries(S)) {
    let list = [];
    try { list = await series(ticker); }
    catch (e) { console.log(`  ${ticker}: ${e.message}`); continue; }
    let kept = 0;
    list.forEach(m => {
      const close = Date.parse(m.close_time || "");
      if (isFinite(close) && close > cutoff) return;
      const key = String(m.event_ticker || "").replace(/^KX\w+?-/, "");
      if (!key) return;
      const t = trim(m);
      if (kind !== "ml") {
        const mid = (t.b == null || t.a == null) ? null : (t.b + t.a) / 2;
        if (mid == null || mid < NEAR[0] || mid > NEAR[1]) return;
      }
      const ev = events[key] || (events[key] = { ml: [], spread: [], total: [] });
      ev[kind].push(t);
      kept++;
    });
    console.log(`  ${ticker}: ${kept} of ${list.length} within ${DAYS} days and near the money`);
    total += kept;
  }
  // Trim each ladder to the rungs closest to a coin flip.
  Object.values(events).forEach(ev => ["spread", "total"].forEach(kind => {
    if (ev[kind].length > MAX_RUNGS) {
      ev[kind] = ev[kind]
        .map(m => ({ m, d: Math.abs(((m.b || 0) + (m.a || 0)) / 2 - 0.5) }))
        .sort((x, y) => x.d - y.d).slice(0, MAX_RUNGS).map(x => x.m);
    }
  }));
  // A game with no moneyline cannot be matched to the board, so it is dead weight.
  Object.keys(events).forEach(k => { if (events[k].ml.length < 2) delete events[k]; });
  let after = 0; Object.values(events).forEach(e => after += e.ml.length + e.spread.length + e.total.length);
  console.log(`${league}: kept ${after} contracts after trimming ladders`);

  // Player ladders, keyed by game and then by player.
  const props = {};
  const PS = PROP_SERIES[league] || {};
  for (const [kind, ticker] of Object.entries(PS)) {
    let list = [];
    try { list = await series(ticker); }
    catch (e) { console.log(`  ${ticker}: ${e.message}`); continue; }
    let kept = 0;
    list.forEach(m => {
      const close = Date.parse(m.close_time || "");
      if (isFinite(close) && close > cutoff) return;
      const t = trim(m);
      const mid = (t.b == null || t.a == null) ? null : (t.b + t.a) / 2;
      if (t.s == null || mid == null || mid < NEAR[0] || mid > NEAR[1]) return;
      const key = String(m.event_ticker || "").replace(/^KX\w+?-/, "");
      const who = String(m.title || "").split(":")[0].trim();
      if (!key || !who) return;
      const ev = props[key] || (props[key] = {});
      const pl = ev[who] || (ev[who] = {});
      (pl[kind] || (pl[kind] = [])).push({ t: t.t, s: t.s, b: t.b, a: t.a, bs: t.bs, as: t.as, oi: t.oi });
      kept++;
    });
    console.log(`  ${ticker}: ${kept} player rungs near the money`);
    total += kept;
  }
  let props_after = 0;
  Object.values(props).forEach(ev => Object.values(ev).forEach(pl => Object.keys(pl).forEach(k => {
    if (pl[k].length > PROP_MAX_RUNGS) {
      pl[k] = pl[k].map(m => ({ m, d: Math.abs(((m.b || 0) + (m.a || 0)) / 2 - 0.5) }))
        .sort((x, y) => x.d - y.d).slice(0, PROP_MAX_RUNGS).map(x => x.m);
    }
    props_after += pl[k].length;
  })));
  if (props_after) console.log(`${league}: kept ${props_after} player rungs`);
  snap.leagues[league] = { events, props };
  console.log(`${league}: ${Object.keys(events).length} games`);
}

if (!total) {
  console.log("nothing came back — leaving the existing snapshot alone");
  process.exit(0);
}

const { writeFileSync, mkdirSync } = await import("fs");
mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify(snap));
console.log(`wrote ${OUT} — ${total} contracts, ${(JSON.stringify(snap).length / 1024).toFixed(0)} KB`);
