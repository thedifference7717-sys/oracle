#!/usr/bin/env node
// Two jobs, no trading in either:
//
//   node arb/scan.mjs discover [--series KXNFLGAME] [--top 40]
//     Pull every open market on both venues, pair up the ones that look like
//     the same question, and write arb/candidates.json with a rough
//     top-of-book edge. Copy the ones you've checked into arb/pairs.json.
//
//   node arb/scan.mjs pairs [--pairs arb/pairs.json] [--min-edge 0.01]
//     Price each pair in pairs.json against live orderbooks, after both
//     venues' fees, sized to real depth.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as K from "./lib/kalshi.mjs";
import * as P from "./lib/polymarket.mjs";
import { matchMarkets, matchGames } from "./lib/match.mjs";
import { loadPairs, evaluate } from "./lib/pairs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export function args(argv = process.argv.slice(2)) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2), v = argv[i + 1];
      if (v == null || v.startsWith("--")) a[k] = true; else { a[k] = v; i++; }
    } else a._.push(argv[i]);
  }
  return a;
}

async function discover(a) {
  console.log("fetching Kalshi events…");
  const ke = await K.openEvents({ series: a.series, maxPages: +(a["kalshi-pages"] || 50) });
  console.log(`  ${ke.length} events, ${ke.reduce((s, e) => s + (e.markets || []).length, 0)} markets`);
  console.log("fetching Polymarket markets…");
  const pm = await P.openMarkets({ maxPages: +(a["poly-pages"] || 400) });
  console.log(`  ${pm.length} markets`);
  const games = matchGames(ke, pm);
  const seen = new Set(games.map(x => x.kalshi.ticker + "|" + x.poly.slug));
  const c = [...games, ...matchMarkets(ke, pm, { minScore: +(a["min-score"] || 0.35), maxDays: +(a["max-days"] || 3) })
    .filter(x => !seen.has(x.kalshi.ticker + "|" + x.poly.slug))]
    .sort((x, y) => (y.grossEdge ?? -9) - (x.grossEdge ?? -9) || y.score - x.score);
  const out = a.out || join(HERE, "candidates.json");
  writeFileSync(out, JSON.stringify(c, null, 2));
  console.log(`\n${c.length} candidate pairs → ${out}\n`);
  for (const x of c.slice(0, +(a.top || 25))) {
    const e = x.grossEdge == null ? "  side?" : (x.grossEdge * 100).toFixed(1).padStart(6) + "c";
    console.log(`${e}  [${x.score}]  ${x.kalshi.ticker}  ⇄  ${x.poly.slug}${x.poly.restricted ? " (restricted)" : ""}`);
    if (x.route) console.log(`         ${x.route}`);
  }
  console.log("\nEdges above are pre-fee, top-of-book, from cached list data. They are leads, not trades.");
}

async function pairs(a) {
  const list = loadPairs(a.pairs || join(HERE, "pairs.json"));
  for (const pair of list) {
    try {
      const r = await evaluate(pair, { minEdge: +(a["min-edge"] ?? 0.01), maxContracts: +(a["max-contracts"] || 1000) });
      const tag = pair.verified ? "" : " [UNVERIFIED — bot will not trade]";
      console.log(`\n${pair.name || pair.kalshi}${tag}`);
      console.log(r.best ? "  ✔ " + r.best.describe + (r.best.apy != null ? `, ~${(r.best.apy * 100).toFixed(0)}% annualised to ${r.closes}` : "")
                         : "  — no arb after fees right now");
    } catch (e) {
      console.log(`\n${pair.name || pair.kalshi}\n  ✖ ${e.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args();
  const cmd = a._[0] || "pairs";
  (cmd === "discover" ? discover(a) : pairs(a)).catch(e => { console.error(e); process.exit(1); });
}
