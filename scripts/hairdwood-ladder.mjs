#!/usr/bin/env node
// HAIrdwood — publish the ladder's rung, then settle it.
//
//   node scripts/hairdwood-ladder.mjs          settle what is settleable, then lock today
//   node scripts/hairdwood-ladder.mjs lock     only publish today's rung
//   node scripts/hairdwood-ladder.mjs grade    only settle the open ones
//
// THE BOARD IS NOT COMPUTED HERE. The rung comes out of hairdwood-model.js —
// the identical file the dashboard runs — so the record can only ever be a
// record of what the dashboard actually showed. That is the whole point: a
// tipster who does not keep score is not a tipster, and a score kept in a
// different program from the picks is not a score.
//
// The two halves run on the same schedule and are both idempotent, so the job
// can fire hourly and fix itself. Locking twice in a day is a no-op; grading a
// game that is not final yet leaves the row open for the next pass.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require("../hairdwood-model.js");

const OUT = "data/hairdwood-ladder.json";
const MODE = (process.argv[2] || "both").toLowerCase();
// The grade a rung has to carry to be worth the ladder's money. The board's
// own default bar; a day where nothing clears it is a day the ladder sits out,
// and sitting out is recorded rather than silently skipped.
const BAR = +(process.env.HAIRDWOOD_BAR || 65);
// What a book is likely to actually offer, against our fair number. Three
// points of hold is a normal prop market. It is an ASSUMPTION and the row says
// so — the dashboard's odds box overrides it, and every rung above recompounds
// off what you really got.
const HOLD = 0.03;

const say = m => process.stderr.write(m + "\n");
let calls = 0;
async function get(url) {
  calls++;
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "hairdwood-ladder" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

function load() {
  if (!existsSync(OUT)) return { v: 1, bets: [], skipped: [] };
  const j = JSON.parse(readFileSync(OUT, "utf8"));
  j.bets = Array.isArray(j.bets) ? j.bets : [];
  j.skipped = Array.isArray(j.skipped) ? j.skipped : [];
  return j;
}
function save(j) {
  j.bets.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  j.updated = new Date().toISOString();
  mkdirSync("data", { recursive: true });
  writeFileSync(OUT, JSON.stringify(j, null, 2) + "\n");
}

// ── settle ──────────────────────────────────────────────────────────────────
// Every open rung whose box score has landed. A game that is not final yet, or
// a man with no line in a box score that has not been filled in, stays open —
// settling on a guess would make the record worth less than no record.
async function grade(j) {
  const open = j.bets.filter(b => b.status === "open" && b.eventId && b.playerId);
  if (!open.length) { say("nothing open to settle"); return 0; }
  let n = 0;
  for (const b of open) {
    let box;
    try { box = await M.loadBoxScore(get, b.eventId); }
    catch (e) { say(`${b.date} ${b.pick}: box score unavailable (${e.message}) — left open`); continue; }
    const res = M.settle(b, box);
    if (!res) { say(`${b.date} ${b.pick}: no box-score line yet — left open`); continue; }
    b.status = res.status;
    b.actual = res.actual;
    b.playedMin = res.min == null ? null : res.min;
    b.settled = new Date().toISOString();
    b.result = res.note;
    n++;
    say(`${b.date} ${b.pick} ${b.market} o${b.line} -> ${res.status.toUpperCase()} (${res.note})`);
  }
  return n;
}

// ── lock ────────────────────────────────────────────────────────────────────
// The rung is placed an hour before the first tip, from the board as it stands
// at that instant. Not before: an NBA board re-ranks itself every time an
// inactive list drops, and those land in that last hour. A pick that quietly
// swaps itself is not a pick, and a pick published after tip-off is not a bet.
async function lock(j) {
  const day = M.slateYmd();
  if (j.bets.some(b => b.date === day)) { say(`${day}: already locked`); return 0; }
  if ((j.skipped || []).some(s => s.date === day)) { say(`${day}: already recorded as a pass`); return 0; }

  const board = await M.buildBoard({ getJSON: get, day, onStatus: m => say("  · " + m) });
  if (board.empty || !board.legs.length) {
    say(`${day}: no slate${board.nextDay ? ` — next is ${board.nextDay}` : ""}`);
    return 0;
  }
  const lk = M.lockInfo(board.games);
  if (lk && Date.now() < lk.lockAt) {
    say(`${day}: too early — locks at ${new Date(lk.lockAt).toISOString()}, first tip ${new Date(lk.first).toISOString()}`);
    return 0;
  }
  // Every game that has already tipped is off the table: the board is for
  // betting, and a leg you could not have got down is not a record of anything.
  const live = board.legs.filter(l => !l.game.started);
  const pool = live.length ? live : board.legs;
  const pick = pool.slice().sort((a, b) => b.score.score - a.score.score || b.p - a.p)[0];

  if (pick.score.score < BAR) {
    // A pass is part of the record. Writing it down is what stops a bad night
    // from being quietly deleted from the history.
    j.skipped.push({
      date: day, reason: `nothing cleared the ${BAR} bar`,
      best: { pick: pick.pl.name, market: pick.market, line: pick.line,
              score: pick.score.score, grade: pick.score.grade, p: +pick.p.toFixed(4) },
      at: new Date().toISOString()
    });
    say(`${day}: PASS — best was ${pick.pl.name} ${pick.marketShort} o${pick.line} at ${pick.score.score} (bar ${BAR})`);
    return 1;
  }

  const row = {
    date: day,
    pick: pick.pl.name,
    playerId: String(pick.pl.id),
    eventId: String(pick.gameId),
    market: pick.market,
    line: pick.line,
    p: +pick.p.toFixed(4),
    score: pick.score.score,
    grade: pick.score.grade,
    // Assumed, and flagged: nobody here knows what your book was showing. The
    // dashboard's odds box overrides it and recompounds every rung above.
    price: +M.amOdds(Math.min(0.97, pick.p + HOLD)),
    priceAssumed: true,
    status: "open",
    teams: `${pick.teamAbbr} ${pick.isHome ? "vs" : "@"} ${pick.oppAbbr}`,
    projected: +pick.mean.toFixed(2),
    minutes: +pick.mins.minutes.toFixed(1),
    injuryTag: pick.status || null,
    published: new Date().toISOString(),
    firstTip: lk ? new Date(lk.first).toISOString() : null,
    // What the board looked like behind it, so a rung can be argued with later.
    runnersUp: pool.slice(1, 4).map(l => ({ pick: l.pl.name, market: l.market, line: l.line, score: l.score.score }))
  };
  j.bets.push(row);
  say(`${day}: LOCKED ${row.pick} ${row.market} o${row.line} — grade ${row.score} ${row.grade}, ${Math.round(row.p * 100)}% at an assumed ${row.price}`);
  return 1;
}

// ── run ─────────────────────────────────────────────────────────────────────
const j = load();
let moved = 0;
if (MODE === "grade" || MODE === "both") moved += await grade(j);
if (MODE === "lock" || MODE === "both") moved += await lock(j);
if (moved) save(j);
const st = M.ladder(j.bets);
say(`\nladder: cycle ${st.cycle}, day ${st.rung} of ${st.cfg.rungs}, account $${st.account.toFixed(2)}, ` +
    `${st.cycles.done} complete / ${st.cycles.busted} bust / ${st.voids} void · ${calls} fetches`);
if (!moved) say("nothing changed");
