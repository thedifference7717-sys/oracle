// Kalshi quote parsing and matching, against the response shape Kalshi really
// returns (taken from the 2026-09-22 probe), so none of it rests on guesses.
// Run: node scripts/kalshi-quotes.test.mjs
import { quoteOf, probToAmerican, normName, indexHitMarkets, lookup } from "./kalshi-quotes.mjs";
let f = 0;
const ok = (n, c, d) => { if (c) console.log("  ok   " + n); else { f++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };

const mk = (name, strike, o = {}) => Object.assign({
  ticker: "KXMLBHIT-X-" + name, event_ticker: "KXMLBHIT-26SEP22",
  floor_strike: strike, no_sub_title: `${name}: ${strike + 0.5}+`,
  occurrence_datetime: "2026-09-22T23:05:00Z"
}, o);

console.log("reads the fields Kalshi actually sends");
ok("yes_*_dollars strings", quoteOf({ yes_bid_dollars: "0.7000", yes_ask_dollars: "0.7100" }).ask === 0.71);
ok("no side inverts to yes", quoteOf({ no_bid_dollars: "0.2900", no_ask_dollars: "0.3000" }).ask === 0.71);
ok("legacy cents still read", quoteOf({ yes_bid: 70, yes_ask: 71 }).ask === 0.71);

console.log("prices as American odds");
ok("0.71 -> -245", probToAmerican(0.71) === -245);
ok("0.67 -> -203", probToAmerican(0.67) === -203);
ok("0.73 -> -270", probToAmerican(0.73) === -270);

console.log("names match across sources");
ok("accents", normName("Luis García Jr.") === normName("Luis Garcia"));
ok("initials", normName("J.P. Crawford") === normName("JP Crawford"));
ok("acuña", normName("Ronald Acuña Jr.") === normName("Ronald Acuna"));

console.log("only the 1+ strike is the ladder's bet");
const idx = indexHitMarkets([
  mk("Mookie Betts", 0.5, { yes_bid_dollars: "0.66", yes_ask_dollars: "0.67" }),
  mk("Mookie Betts", 1.5, { yes_bid_dollars: "0.20", yes_ask_dollars: "0.22" }),
  mk("Jorge Mateo", 2.5, { no_bid_dollars: "0.97", no_ask_dollars: "1.00" }),
  mk("No Quote", 0.5, {})
]);
ok("Betts 1+ found at -203", lookup(idx, "Mookie Betts").american === -203);
ok("his 2+ market is ignored", idx.get(normName("Mookie Betts")).length === 1);
ok("a 3+ lottery ticket is not indexed", !idx.has(normName("Jorge Mateo")));
ok("a market with no price is not indexed", !idx.has(normName("No Quote")));
ok("unknown player is null, not a crash", lookup(idx, "Nobody") === null);

console.log("doubleheaders take the right game");
const dh = indexHitMarkets([
  mk("Two Games", 0.5, { yes_ask_dollars: "0.70", occurrence_datetime: "2026-09-22T17:05:00Z" }),
  mk("Two Games", 0.5, { yes_ask_dollars: "0.66", occurrence_datetime: "2026-09-22T23:05:00Z" })
]);
ok("nightcap quote for the nightcap", lookup(dh, "Two Games", "2026-09-22T23:10:00Z").ask === 0.66);
ok("opener quote for the opener", lookup(dh, "Two Games", "2026-09-22T17:10:00Z").ask === 0.70);

console.log(f ? `\n${f} check(s) failed.` : "\nAll checks passed.");
process.exit(f ? 1 : 0);
