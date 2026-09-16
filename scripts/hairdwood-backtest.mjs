#!/usr/bin/env node
// HAIrdwood — grade the grade.
//
//   node scripts/hairdwood-backtest.mjs [season] [slates] [stride]
//   node scripts/hairdwood-backtest.mjs 2026 16 9      the default
//
// THE QUESTION. The board hands every bet a number out of a hundred and sorts
// the world by it. That number is a claim, and until it is checked against what
// actually happened it is only a well-argued opinion. So: walk a finished
// season, price each slate the way the dashboard would have priced it THAT
// MORNING, publish every leg, and settle all of them off the real box scores.
// Then ask the only question that matters — does an A actually cash more often
// than a B?
//
// WHAT IS AND IS NOT LEAK-FREE, stated up front because a backtest that flatters
// itself is worse than none:
//
//   · PLAYER lines are rebuilt from each man's own game log using only games
//     that had already been played. Minutes, form, floor, the variance blend and
//     the back-to-back all read that same truncated log, so the whole projection
//     is as-of and not just the averages.
//   · TEAM splits are full-season. ESPN has no as-of version and rebuilding
//     thirty teams from box scores was not worth the complexity, so pace and the
//     opponent's allowance know a little about the future. Both are clamped to
//     about a tenth either way, which bounds the damage without hiding it.
//   · ROSTERS are skipped: today's roster is not who was on it in January, and
//     a filter that is wrong is worse than no filter.
//   · INJURY reports on a finished game come back empty, so the backtest runs
//     BLIND to who was out. That is a handicap, not a leak — the live board
//     will know more than this one did.
//
// The ladder is replayed too, on the same rule the live job uses: the top-graded
// leg each slate, taken only if it clears the bar.
import { writeFileSync, mkdirSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require("../hairdwood-model.js");

const SEASON = +(process.argv[2] || 2026);
const SLATES = +(process.argv[3] || 16);
const STRIDE = +(process.argv[4] || 9);
const BAR = +(process.env.HAIRDWOOD_BAR || 65);
const HOLD = 0.03;                    // what a book shades off our fair number
const OUT = "data/hairdwood-backtest.json";

const say = m => process.stderr.write(m + "\n");
let calls = 0, retries = 0;
const nap = ms => new Promise(r => setTimeout(r, ms));
// A season walk is a few thousand requests at a stranger's server. One refused
// connection two hours in should cost a retry, not the run.
async function get(url) {
  let last;
  for (let a = 0; a < 4; a++) {
    if (a) { retries++; await nap(400 * Math.pow(3, a - 1)); }
    try {
      calls++;
      const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "hairdwood-backtest" } });
      if (r.status === 404) throw Object.assign(new Error("HTTP 404"), { fatal: true });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { last = e; if (e.fatal) break; }
  }
  throw last;
}

// Mid-November to early April: the season's shoulders are left out on purpose.
// October has no log to rebuild anyone from, and the last fortnight is rest
// days and tanking, which is a different sport wearing the same jerseys.
function dates() {
  const out = [];
  let d = `${SEASON - 1}-11-15`;
  for (let i = 0; i < SLATES; i++) { out.push(d); d = M.addDays(d, STRIDE); }
  return out.filter(x => x < `${SEASON}-04-06`);
}

const legs = [], ladderRows = [], doubles = [];
const boxCache = new Map();
async function boxFor(eventId) {
  if (!boxCache.has(eventId)) {
    try { boxCache.set(eventId, await M.loadBoxScore(get, eventId)); }
    catch (e) { boxCache.set(eventId, null); }
  }
  return boxCache.get(eventId);
}

for (const day of dates()) {
  let board;
  try {
    board = await M.buildBoard({ getJSON: get, day, asOf: day, includeFinal: true,
                                 rosters: false, maxLogs: 220, onStatus: () => {} });
  } catch (e) { say(`${day}: ${e.message}`); continue; }
  if (board.empty || !board.legs.length) { say(`${day}: no board`); continue; }
  boxCache.clear();                   // one slate's box scores at a time

  let settled = 0, hit = 0;
  for (const l of board.legs) {
    const box = await boxFor(l.gameId);
    if (!box) continue;
    const res = M.settle({ playerId: String(l.pl.id), market: l.market, line: l.line }, box);
    if (!res) continue;
    settled++;
    if (res.status === "won") hit++;
    legs.push({ day, player: l.pl.name, market: l.market, line: l.line,
                p: +l.p.toFixed(4), score: l.score.score, grade: l.score.grade,
                proj: +l.mean.toFixed(2), min: +l.mins.minutes.toFixed(1),
                hasLog: l.hasLog, status: res.status, actual: res.actual });
  }

  // The ladder's own rule, replayed: the top-graded leg, taken only if it
  // clears the bar, at a price a book would plausibly have offered.
  const top = board.legs[0];
  if (top) {
    const box = await boxFor(top.gameId);
    const res = box ? M.settle({ playerId: String(top.pl.id), market: top.market, line: top.line }, box) : null;
    if (top.score.score < BAR) {
      ladderRows.push({ date: day, status: "passed", score: top.score.score, pick: top.pl.name });
    } else if (res) {
      ladderRows.push({ date: day, pick: top.pl.name, market: top.market, line: top.line,
                        p: +top.p.toFixed(4), score: top.score.score, grade: top.score.grade,
                        price: +M.amOdds(Math.min(0.97, top.p + HOLD)), status: res.status, actual: res.actual });
    }
  }

  for (const s of board.slates) {
    const d = s.double; if (!d) continue;
    const box = await boxFor(s.game.id); if (!box) continue;
    const a = M.settle({ playerId: String(d.a.pl.id), market: d.a.market, line: d.a.line }, box);
    const b = M.settle({ playerId: String(d.b.pl.id), market: d.b.market, line: d.b.line }, box);
    if (!a || !b) continue;
    const status = (a.status === "void" || b.status === "void") ? "void"
                 : (a.status === "won" && b.status === "won") ? "won" : "lost";
    doubles.push({ day, game: `${s.game.away.abbr}@${s.game.home.abbr}`,
                   joint: +d.prob.toFixed(4), naive: +d.naive.toFixed(4), rho: +d.rho.toFixed(3),
                   score: d.score.score, grade: d.score.grade, status });
  }
  say(`${day}: ${settled} legs settled, ${(100 * hit / Math.max(1, settled)).toFixed(1)}% cashed`);
}

// ── what it all says ────────────────────────────────────────────────────────
const graded = legs.filter(l => l.status !== "void");
const rate = rows => rows.length ? rows.filter(r => r.status === "won").length / rows.length : null;
const mean = (rows, f) => rows.length ? rows.reduce((a, r) => a + f(r), 0) / rows.length : null;
const round = (v, n) => v == null ? null : +v.toFixed(n == null ? 3 : n);

function bucketBy(rows, key, order) {
  const by = {};
  rows.forEach(r => { (by[key(r)] = by[key(r)] || []).push(r); });
  const keys = order || Object.keys(by).sort();
  return keys.filter(k => by[k]).map(k => ({
    key: k, n: by[k].length,
    predicted: round(mean(by[k], r => r.p)),
    actual: round(rate(by[k])),
    edge: round(rate(by[k]) - mean(by[k], r => r.p))
  }));
}

// Does the grade rank-order the outcome? That is the whole claim.
const byGrade = bucketBy(graded, r => r.grade, ["A+", "A", "B+", "B", "C+", "C", "D"]);
const byMarket = bucketBy(graded, r => r.market, ["pts", "reb", "ast", "tpm"]);
const byBand = bucketBy(graded, r => {
  const b = Math.floor(r.p * 20) / 20;           // 5-point probability bands
  return `${(b * 100).toFixed(0)}-${((b + 0.05) * 100).toFixed(0)}%`;
});
const brier = graded.length ? mean(graded, r => Math.pow((r.status === "won" ? 1 : 0) - r.p, 2)) : null;

// Monotonic? Spearman between the grade and whether it cashed is the honest
// one-number version, but with seven buckets the eye does better: each grade
// bucket's hit rate against the one below it.
const mono = (() => {
  const vals = byGrade.filter(g => g.n >= 20).map(g => g.actual);
  let ok = 0, tot = 0;
  for (let i = 1; i < vals.length; i++) { tot++; if (vals[i - 1] >= vals[i]) ok++; }
  return tot ? { pairs: tot, inOrder: ok } : null;
})();

const ladderPlayed = ladderRows.filter(r => r.status !== "passed");
const st = M.ladder(ladderPlayed.map(r => ({ date: r.date, price: r.price, status: r.status, pick: r.pick,
                                             market: r.market, line: r.line, p: r.p })));
const dbl = doubles.filter(d => d.status !== "void");

const report = {
  at: new Date().toISOString(), season: SEASON, slates: dates().length, stride: STRIDE,
  leakage: "player lines rebuilt as-of from game logs; team splits full-season (clamped ±10-12%); injuries unavailable on finished games, so the backtest runs blind to them",
  legs: { n: legs.length, graded: graded.length, void: legs.length - graded.length,
          predicted: round(mean(graded, r => r.p)), actual: round(rate(graded)),
          edge: round(rate(graded) - mean(graded, r => r.p)), brier: round(brier, 4) },
  byGrade, byMarket, byBand, monotonic: mono,
  ladder: { days: ladderRows.length, played: ladderPlayed.length,
            passed: ladderRows.filter(r => r.status === "passed").length,
            won: ladderPlayed.filter(r => r.status === "won").length,
            lost: ladderPlayed.filter(r => r.status === "lost").length,
            void: ladderPlayed.filter(r => r.status === "void").length,
            account: st.account, pl: st.pl, cycles: st.cycles, maxDD: st.maxDD,
            rows: ladderRows },
  doubles: { n: dbl.length, predicted: round(mean(dbl, d => d.joint)), actual: round(rate(dbl)),
             naive: round(mean(dbl, d => d.naive)),
             edge: round(rate(dbl) - mean(dbl, d => d.joint)) },
  fetches: calls, retries
};
mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

say("\n── every published leg ─────────────────────────────────");
say(`${report.legs.graded} graded (${report.legs.void} void) · predicted ${(report.legs.predicted * 100).toFixed(1)}% · actual ${(report.legs.actual * 100).toFixed(1)}% · Brier ${report.legs.brier}`);
say("\n── by grade ────────────────────────────────────────────");
byGrade.forEach(g => say(`  ${g.key.padEnd(2)} n=${String(g.n).padStart(4)}  predicted ${(g.predicted * 100).toFixed(1)}%  actual ${(g.actual * 100).toFixed(1)}%  ${g.edge >= 0 ? "+" : ""}${(g.edge * 100).toFixed(1)}`));
if (mono) say(`  order held in ${mono.inOrder} of ${mono.pairs} adjacent pairs`);
say("\n── by market ───────────────────────────────────────────");
byMarket.forEach(g => say(`  ${g.key.toUpperCase()} n=${String(g.n).padStart(4)}  predicted ${(g.predicted * 100).toFixed(1)}%  actual ${(g.actual * 100).toFixed(1)}%  ${g.edge >= 0 ? "+" : ""}${(g.edge * 100).toFixed(1)}`));
say("\n── calibration ─────────────────────────────────────────");
byBand.forEach(g => { if (g.n >= 15) say(`  ${g.key.padEnd(8)} n=${String(g.n).padStart(4)}  said ${(g.predicted * 100).toFixed(1)}%  did ${(g.actual * 100).toFixed(1)}%`); });
say("\n── the ladder ──────────────────────────────────────────");
say(`  ${report.ladder.played} rungs (${report.ladder.passed} days passed): ${report.ladder.won}W ${report.ladder.lost}L ${report.ladder.void}V`);
say(`  account $${st.account.toFixed(2)} from $100 · ${st.cycles.done} complete, ${st.cycles.busted} bust · max drawdown $${st.maxDD.toFixed(2)}`);
say("\n── same-game doubles ───────────────────────────────────");
if (dbl.length) say(`  n=${dbl.length} · predicted ${(report.doubles.predicted * 100).toFixed(1)}% · actual ${(report.doubles.actual * 100).toFixed(1)}% · pricing them apart would have said ${(report.doubles.naive * 100).toFixed(1)}%`);
say(`\n${calls} fetches → ${OUT}`);
