#!/usr/bin/env node
// GridAIron — grade the board's own picks, and publish the record.
//
//   node scripts/gridiron-log.mjs                 grade the last finished week
//   node scripts/gridiron-log.mjs 2026 1          grade a particular week
//   node scripts/gridiron-log.mjs 2026 1 <snap>   ...against a given price snapshot
//
// This is the football twin of scripts/parlaiy-alerts.mjs, and it works the
// same way for the same reason: THE BOARD IS NOT COMPUTED HERE. Every double
// comes out of gridiron-model.js, the identical file the dashboard runs, so
// the record can only ever be a record of what the dashboard actually showed.
//
// Why it exists at all: until now nothing wrote down what the board
// recommended. The dashboard's MY BETS panel holds what you personally pressed
// LOG on and nothing else, so a week could go by with the board picking
// fourteen doubles and leaving no trace of how they did. A tipster who does
// not keep score is not a tipster.
//
// The ratings for week N are built from weeks 1..N-1 only, and the player
// usage from the prior season until week 4, so grading a past week does not
// leak that week's results into the picks it is grading.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import M from "../gridiron-model.js";

const OUT = "data/gridiron-log.json";
const [, , argSeason, argWeek, argSnap] = process.argv;

// Prices: a snapshot taken before kickoff. Grading against prices that moved
// after the games would be marking our own homework.
function loadSnapshot(ref) {
  if (ref && existsSync(ref)) return JSON.parse(readFileSync(ref, "utf8"));
  if (ref && /^[0-9a-f]{7,40}$/.test(ref)) {
    return JSON.parse(execSync(`git show ${ref}:data/kalshi-football.json`, { encoding: "utf8", maxBuffer: 64e6 }));
  }
  return JSON.parse(readFileSync("data/kalshi-football.json", "utf8"));
}

const L = M.LEAGUES.nfl;
const say = m => process.stderr.write(m + "\n");

const board = await M.loadLeagueBoard("nfl",
  Object.assign({ includeFinal: true },
    argSeason && argWeek ? { season: +argSeason, week: +argWeek } : {}), () => {});
say(`board: season ${board.season} week ${board.week}, ${board.games.length} games`);

const snap = loadSnapshot(argSnap);
say(`prices: snapshot taken ${snap.at}`);
const kal = M.kalshiFromSnapshot(snap, "nfl");
if (kal) M.matchKalshi(board, kal);
const kprops = M.kalshiPropsFromSnapshot(snap, "nfl");
if (!kprops) { say("no player prices in that snapshot — nothing to grade"); process.exit(0); }

// ── build the board exactly as the dashboard does ───────────────────────────
const cache = {};
const pending = [];
for (const entry of board.games) {
  let list;
  try { list = await M.loadGameProps(board, entry, cache, () => {}, {}); } catch (e) { continue; }
  const home = list.filter(p => p.teamId === entry.game.home.id);
  const away = list.filter(p => p.teamId === entry.game.away.id);
  if (!home.length && !away.length) continue;
  const seed = String(entry.game.id).split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  const sim = M.simulateGame([home, away], { n: 10000, seed });
  sim.byPlayer = {}; sim.manOf = {};
  sim.men.forEach(man => {
    sim.manOf[man.pl.player.id] = man;
    const by = {}; M.simMarkets(man).forEach(mk => by[mk.key] = mk);
    sim.byPlayer[man.pl.player.id] = by;
  });
  pending.push({ entry, list, sim });
}
// The slate calibration is fitted across every quoted rung before a single
// double is priced, same as the dashboard.
const pairs = [];
pending.forEach(({ entry, list, sim }) => list.forEach(pl => pl.markets.forEach(mkt => {
  const sm = (sim.byPlayer[pl.player.id] || {})[mkt.key];
  if (!sm || sm.type === "binary" || mkt.ourLine == null) return;
  const rung = M.kalshiRung(kprops, entry, pl.player.name, mkt.key, mkt.ourLine);
  if (rung && rung.mid != null) pairs.push({ p: sm.tail(rung.strike), market: rung.mid });
})));
const probCal = M.calibrateProbs(pairs);
say(`calibrated on ${pairs.length} quoted rungs`);

const BAR = process.env.GI_BAR != null ? +process.env.GI_BAR : 0.02;
const picks = [];
for (const { entry, list, sim } of pending) {
  const legs = M.propLegs(entry, list, sim, { kprops, probCal });
  const best = M.bestDouble(legs, {});
  if (!best || !M.doubleQualifies(best, { bar: BAR })) continue;
  picks.push({ entry, d: best });
}
say(`${picks.length} of ${board.games.length} games produced a qualifying double at a +${(BAR*100).toFixed(1)}pt bar`);

// ── grade them ──────────────────────────────────────────────────────────────
const legOf = l => ({ player: l.player, propKey: l.key, side: l.side, line: l.line, p: l.p, market: l.market });
const graded = [];
for (const { entry, d } of picks) {
  let players = null;
  try { players = await M.loadPlayerStats(L, entry.game.id); } catch (e) {}
  const bet = { market: "double", legs: [legOf(d.a), legOf(d.c)] };
  const res = players ? { final: true, hs: 1, as: 0, players } : null;
  const r = res ? M.gradeBet(bet, res) : null;
  const legResult = l => res ? M.gradeLeg(l, res) : null;
  graded.push({
    game: entry.game.away.abbr + " @ " + entry.game.home.abbr, gameId: entry.game.id,
    date: entry.game.date,
    legs: [d.a, d.c].map(l => ({
      ...legOf(l),
      got: players && players[Object.keys(players).find(k => players[k].name === l.player)]
        ? players[Object.keys(players).find(k => players[k].name === l.player)][l.key] : null,
      result: legResult(legOf(l))
    })),
    price: d.price, prob: d.prob,
    edge: M.defensibleEdge(d), totalEdge: d.edge,
    result: r
  });
}

const done = graded.filter(g => g.result != null);
const w = done.filter(g => g.result === 1).length;
const l = done.filter(g => g.result === 0).length;
const push = done.filter(g => g.result === 0.5).length;
// Profit at a flat unit, which is the only stake this can honestly assume —
// the dashboard's dollars-per-point is a setting, not a fact about the pick.
const units = done.reduce((a, g) => a + (g.result === 0.5 ? 0 : g.result === 1 ? (M.amToDec(g.price) - 1) : -1), 0);
const expected = done.reduce((a, g) => a + g.prob, 0);

const log = {
  v: M.VERSION, updated: new Date().toISOString(),
  season: board.season, week: board.week,
  pricedFrom: snap.at, bar: BAR,
  record: { w, l, push, n: done.length, open: graded.length - done.length },
  units: +units.toFixed(3), expectedWins: +expected.toFixed(2),
  picks: graded
};
mkdirSync("data", { recursive: true });
let all = { weeks: {} };
if (existsSync(OUT)) { try { all = JSON.parse(readFileSync(OUT, "utf8")); } catch (e) {} }
all.weeks = all.weeks || {};
all.weeks[board.season + "-" + board.week] = log;
all.v = M.VERSION; all.updated = log.updated;
// Everything graded so far, across weeks.
const every = Object.values(all.weeks).flatMap(x => x.picks || []).filter(p => p.result != null);
all.record = {
  w: every.filter(p => p.result === 1).length,
  l: every.filter(p => p.result === 0).length,
  push: every.filter(p => p.result === 0.5).length,
  n: every.length,
  units: +every.reduce((a, p) => a + (p.result === 0.5 ? 0 : p.result === 1 ? (M.amToDec(p.price) - 1) : -1), 0).toFixed(3),
  expectedWins: +every.reduce((a, p) => a + p.prob, 0).toFixed(2)
};
writeFileSync(OUT, JSON.stringify(all, null, 1));

console.log(`\nWEEK ${board.week}, ${board.season}   priced from the ${snap.at} snapshot`);
console.log(`  ${graded.length} doubles posted, ${done.length} graded\n`);
console.log("  game        the double                                              result");
graded.forEach(g => {
  const mark = g.result == null ? "open" : g.result === 1 ? "WON" : g.result === 0.5 ? "push" : "lost";
  console.log("  " + g.game.padEnd(12) +
    g.legs.map(x => x.player.split(" ").slice(-1)[0] + " " + x.side.toLowerCase() + " " + x.line +
      (x.got == null ? "" : " (" + x.got + ")")).join(" + ").slice(0, 54).padEnd(56) + mark);
});
console.log(`\n  record ${w}-${l}${push ? "-" + push : ""}   ${units >= 0 ? "+" : ""}${units.toFixed(2)} units at flat stakes`);
console.log(`  expected ${expected.toFixed(1)} wins from ${done.length} bets; got ${w}`);
console.log(`\nwrote ${OUT}`);
