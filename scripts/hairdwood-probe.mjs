#!/usr/bin/env node
// HAIrdwood — check the engine against the real ESPN feed.
//
//   node scripts/hairdwood-probe.mjs                 a default past slate
//   node scripts/hairdwood-probe.mjs 2026-01-15      a particular one
//
// WHY THIS EXISTS. hairdwood-model.js was written in a sandbox that blocks
// *.espn.com at the network policy, so every field name in it is INFERRED from
// the patterns gridiron-model.js already uses in production rather than
// observed. Inferred field names fail silently: `avgMinutes` spelt wrong does
// not throw, it returns zero minutes for every player in the league, and the
// board that comes out the other end looks plausible and is worthless.
//
// A GitHub Actions runner can reach ESPN. So this runs there, against a REAL
// past slate with real box scores, and answers the only question that matters
// before opening night: does the pipeline this repo actually ships produce a
// board from the feed as it actually is?
//
// It works in two passes:
//
//   1. SHAPE. Fetch each endpoint raw and write down what came back — the
//      category names, the stat-name arrays, the split ids, whether a game log
//      carries its dates on the rows or in a map beside them. This is the
//      reference the model was missing when it was written.
//
//   2. SUBSTANCE. Run the model's own loaders and then buildBoard() over that
//      slate, and check the numbers are numbers. A parse that half-works is
//      the dangerous case: players present but every minute zero, teams
//      present but every opponent split missing. Each of those is a named
//      check with a threshold, and a failure exits non-zero so the workflow
//      goes red rather than committing a green-looking report.
//
// The report is written to data/hairdwood-probe.json and committed, so the
// findings can be read back and the model corrected against them.
import { writeFileSync, mkdirSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require("../hairdwood-model.js");

const DAY = process.argv[2] || "2026-01-15";   // a mid-season Thursday, many games
const OUT = "data/hairdwood-probe.json";
const say = m => process.stderr.write(m + "\n");

// Straight to ESPN: the CORS-proxy chain in the model is for the browser, and
// on a runner it only adds a way to fail.
let calls = 0, bytes = 0;
async function get(url) {
  calls++;
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "hairdwood-probe" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const t = await r.text();
  bytes += t.length;
  return JSON.parse(t);
}

const report = { at: new Date().toISOString(), day: DAY, checks: [], shapes: {}, notes: [] };
let failed = 0;
function check(name, ok, detail) {
  const state = ok === true ? "PASS" : ok === "warn" ? "WARN" : "FAIL";
  if (state === "FAIL") failed++;
  report.checks.push({ name, state, detail });
  say(`${state.padEnd(4)} ${name}${detail ? " — " + detail : ""}`);
}
const keys = o => o && typeof o === "object" ? Object.keys(o) : [];
const some = (arr, f) => (arr || []).filter(f).length;

// ── 1. shape ────────────────────────────────────────────────────────────────
const SITE = M.SITE, WEB = M.WEB;
const season = M.seasonOf(DAY);
say(`\nprobing ${DAY} (ESPN season ${season})\n`);

let sb = null;
try {
  sb = await get(`${SITE}/scoreboard?limit=60&dates=${DAY.replace(/-/g, "")}`);
  const ev = (sb.events || [])[0];
  const comp = ev && (ev.competitions || [])[0];
  report.shapes.scoreboard = {
    topKeys: keys(sb), events: (sb.events || []).length,
    seasonYear: (sb.season || {}).year,
    competitionKeys: keys(comp),
    oddsKeys: keys((comp && (comp.odds || [])[0]) || {}),
    oddsSample: (comp && (comp.odds || [])[0]) || null,
    competitorKeys: keys((comp && (comp.competitors || [])[0]) || {}),
    statusType: comp && comp.status ? comp.status.type : null
  };
  check("scoreboard returns a slate", (sb.events || []).length > 0, `${(sb.events || []).length} events`);
  check("scoreboard season year matches seasonOf()", (sb.season || {}).year === season,
        `feed says ${(sb.season || {}).year}, we computed ${season}`);
} catch (e) { check("scoreboard reachable", false, e.message); }

// parseEvent is the model's own reader: if it disagrees with the feed, the
// board never sees a game at all.
let games = [];
if (sb) {
  games = (sb.events || []).map(M.parseEvent).filter(Boolean);
  check("parseEvent reads every event", games.length === (sb.events || []).length,
        `${games.length} of ${(sb.events || []).length}`);
  check("teams carry abbreviations", some(games, g => g.home.abbr && g.away.abbr) === games.length,
        games.length ? `${games[0].away.abbr} @ ${games[0].home.abbr}` : "");
  const withTotal = some(games, g => g.total > 0);
  const withSpread = some(games, g => g.spreadHome != null);
  // The posted total carries 65% of the projected team score. If it is absent
  // the model falls back to its own pace arithmetic — it still works, it is
  // just poorer — so this is a warning and not a failure.
  check("games carry a posted total", withTotal > games.length * 0.5 ? true : "warn",
        `${withTotal}/${games.length} have a total, ${withSpread} have a spread`);
  const sp = games.find(g => g.spreadHome != null);
  if (sp) report.notes.push(`spread sign check: ${sp.away.abbr} @ ${sp.home.abbr} details="${sp.oddsTxt}" -> spreadHome=${sp.spreadHome}`);
}

// ── team splits ─────────────────────────────────────────────────────────────
let teams = null;
try {
  const raw = await get(`${WEB}/statistics/byteam?region=us&lang=en&contentorigin=espn&season=${season}&seasontype=2`);
  report.shapes.byteam = {
    topKeys: keys(raw),
    categories: (raw.categories || []).map(c => ({ name: c.name, names: c.names })),
    teamCount: (raw.teams || []).length,
    teamCategorySample: ((raw.teams || [])[0] || {}).categories
      ? raw.teams[0].categories.map(c => ({ name: c.name, splitId: c.splitId, totals: (c.totals || []).slice(0, 6) }))
      : null
  };
  teams = await M.loadTeamStats(get, season);
  const list = Object.values(teams);
  check("byteam returns the league", list.length >= 28, `${list.length} teams`);
  check("team scoring parsed", some(list, t => t.pts > 90) >= 28,
        `${some(list, t => t.pts > 90)} teams over 90 ppg · sample ${(list[0] || {}).abbr} ${(list[0] || {}).pts}`);
  check("possessions parsed", some(list, t => t.poss > 85 && t.poss < 115) >= 28,
        `sample pace ${((list[0] || {}).poss || 0).toFixed(1)}`);
  // The opponent split IS the matchup component. Without it every defence on
  // the board is exactly league average and 10 points of the grade vanish.
  check("opponent splits present", some(list, t => t.allow && t.allow.pts > 90) >= 28,
        `${some(list, t => t.allow)} teams carry an opponent split`);
  const lg = M.leagueFrom(teams);
  report.shapes.league = lg;
  check("league baselines measured", lg.measured === true,
        `pace ${lg.pace.toFixed(1)} · ${lg.pts.toFixed(1)} ppg · ${lg.tpm.toFixed(1)} 3pm · 3P% ${(lg.tpPct * 100).toFixed(1)}`);
} catch (e) { check("byteam reachable and parsed", false, e.message); }

// ── players ─────────────────────────────────────────────────────────────────
let players = null;
try {
  const raw = await get(`${WEB}/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&page=1&limit=100&sort=offensive.avgPoints%3Adesc&season=${season}&seasontype=2`);
  report.shapes.byathlete = {
    topKeys: keys(raw),
    categories: (raw.categories || []).map(c => ({ name: c.name, names: c.names })),
    athleteCount: (raw.athletes || []).length,
    athleteKeys: keys((raw.athletes || [])[0] || {}),
    athleteSample: (raw.athletes || [])[0] ? {
      athlete: keys(raw.athletes[0].athlete || {}),
      categories: (raw.athletes[0].categories || []).map(c => ({ name: c.name, totals: (c.totals || []).slice(0, 8) }))
    } : null
  };
  // Every sort key the model asks for, tested on its own: one ESPN rejects
  // costs a whole page of players and the model would never say so.
  const sorts = {};
  for (const s of ["offensive.avgPoints", "general.avgMinutes", "general.avgRebounds",
                   "offensive.avgAssists", "offensive.avgThreePointFieldGoalsMade"]) {
    try {
      const d = await get(`${WEB}/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&page=1&limit=5&sort=${encodeURIComponent(s)}%3Adesc&season=${season}&seasontype=2`);
      sorts[s] = { ok: true, n: (d.athletes || []).length, top: ((d.athletes || [])[0] || {}).athlete?.displayName || null };
    } catch (e) { sorts[s] = { ok: false, error: e.message }; }
  }
  report.shapes.sortKeys = sorts;
  const bad = Object.keys(sorts).filter(k => !sorts[k].ok);
  check("every sort key is accepted", bad.length === 0 ? true : (bad.length < 5 ? "warn" : false),
        bad.length ? `rejected: ${bad.join(", ")}` : "all five");

  players = await M.loadPlayers(get, season);
  check("byathlete returns a player pool", players.length >= 200, `${players.length} players`);
  // Each of these is a silent-zero trap: a wrong key returns zero, not an error.
  const withMin = some(players, p => p.mpg > 5);
  check("minutes parsed", withMin >= players.length * 0.7,
        `${withMin}/${players.length} over 5 mpg · top ${(players.slice().sort((a, b) => b.mpg - a.mpg)[0] || {}).name} ${(players.slice().sort((a, b) => b.mpg - a.mpg)[0] || {}).mpg}`);
  check("points parsed", some(players, p => p.pts > 10) >= 80, `${some(players, p => p.pts > 10)} over 10 ppg`);
  check("rebounds parsed", some(players, p => p.reb > 5) >= 40, `${some(players, p => p.reb > 5)} over 5 rpg`);
  check("assists parsed", some(players, p => p.ast > 4) >= 25, `${some(players, p => p.ast > 4)} over 4 apg`);
  check("threes parsed", some(players, p => p.tpm > 1.5) >= 60, `${some(players, p => p.tpm > 1.5)} over 1.5 3pm`);
  check("3P% parsed", some(players, p => p.tpPct > 0.25 && p.tpPct < 0.55) >= 60,
        `sample ${(players.find(p => p.tpPct) || {}).tpPct}`);
  check("attempts parsed (threes need them)", some(players, p => p.tpa > 2) >= 60,
        `${some(players, p => p.tpa > 2)} over 2 3pa`);
  check("positions parsed", some(players, p => p.pos) >= players.length * 0.8,
        `${[...new Set(players.map(p => p.pos))].filter(Boolean).slice(0, 8).join(", ")}`);
  check("team ids parsed", some(players, p => p.teamId) >= players.length * 0.8, "");
} catch (e) { check("byathlete reachable and parsed", false, e.message); }

// ── roster, injuries, game log ──────────────────────────────────────────────
if (games.length) {
  const tid = games[0].home.id;
  try {
    const raw = await get(`${SITE}/teams/${tid}/roster`);
    report.shapes.roster = { topKeys: keys(raw), groupKeys: keys((raw.athletes || [])[0] || {}) };
    const r = await M.loadRoster(get, tid);
    check("roster parsed", r.length >= 10, `${r.length} players on ${games[0].home.abbr}`);
  } catch (e) { check("roster reachable and parsed", false, e.message); }

  try {
    const raw = await get(`${SITE}/summary?event=${games[0].id}`);
    report.shapes.summary = { topKeys: keys(raw), hasInjuries: Array.isArray(raw.injuries),
      injurySample: (raw.injuries || [])[0] ? { teamKeys: keys(raw.injuries[0].team), entry: (raw.injuries[0].injuries || [])[0] } : null };
    const inj = await M.loadInjuries(get, games[0].id);
    const n = Object.values(inj).reduce((a, m) => a + keys(m).length, 0);
    // A finished game's report is often emptied out, so absence here is not a
    // failure — it is only meaningful on a live slate.
    check("injury report parsed", n > 0 ? true : "warn",
          n > 0 ? `${n} entries` : "none on this (finished) game — re-run on a live slate to confirm");
  } catch (e) { check("summary reachable and parsed", false, e.message); }
}

if (players && players.length) {
  const star = players.slice().sort((a, b) => b.mpg - a.mpg)[0];
  try {
    const raw = await get(`${WEB}/athletes/${star.id}/gamelog?season=${season}`);
    report.shapes.gamelog = {
      topKeys: keys(raw), names: raw.names || null, labels: raw.labels || null,
      seasonTypeKeys: keys((raw.seasonTypes || [])[0] || {}),
      eventsIsMap: !!(raw.events && !Array.isArray(raw.events)),
      eventSample: raw.events && !Array.isArray(raw.events) ? (Object.values(raw.events)[0] || null) : null,
      statRowSample: (((raw.seasonTypes || [])[0] || {}).categories || [])[0]
        ? ((raw.seasonTypes[0].categories[0].events || [])[0] || null) : null
    };
    const log = M.parseGamelog(raw);
    check("game log parsed", !!(log && log.played.length >= 5),
          log ? `${log.played.length} games played, ${log.dnp} DNP — ${star.name}` : "nothing parsed");
    if (log) {
      check("game log carries minutes", some(log.played, r => r.min > 5) >= log.played.length * 0.8, "");
      check("game log carries points", some(log.played, r => r.pts > 0) >= log.played.length * 0.7, "");
      check("game log carries threes", some(log.played, r => r.tpm >= 0) === log.played.length, "");
      // The back-to-back penalty and the recency window both need these.
      check("game log carries dates", some(log.played, r => r.date) >= log.played.length * 0.9,
            log.played[0] ? `newest ${log.played[0].date} -> ET day ${M.etDayOf(log.played[0].date)}` : "");
    }
  } catch (e) { check("gamelog reachable and parsed", false, e.message); }
}

// ── 2. substance: the whole board, on a real slate ──────────────────────────
say("\nbuilding the board the dashboard would build…\n");
try {
  const board = await M.buildBoard({ getJSON: get, day: DAY, includeFinal: true, maxLogs: 40, onStatus: m => say("  · " + m) });
  report.board = {
    date: board.date, season: board.season, priorSeason: board.priorSeason,
    degraded: board.degraded, counts: board.counts,
    top: (board.legs || []).slice(0, 12).map(l => ({
      grade: l.score.grade, score: l.score.score, player: l.pl.name, pos: l.pl.pos,
      team: l.teamAbbr, opp: l.oppAbbr, market: l.market, line: l.line,
      p: +l.p.toFixed(3), proj: +l.mean.toFixed(1), min: +l.mins.minutes.toFixed(1),
      seasonAvg: l.seasonAvg, form: l.form ? `${l.form.hits}/${l.form.n}` : null
    })),
    doubles: (board.slates || []).slice(0, 5).map(s => s.double && ({
      game: `${s.game.away.abbr}@${s.game.home.abbr}`, grade: s.double.score.grade,
      score: s.double.score.score, joint: +s.double.prob.toFixed(3), rho: +s.double.rho.toFixed(3),
      legs: [`${s.double.a.pl.name} ${s.double.a.marketShort} o${s.double.a.line}`,
             `${s.double.b.pl.name} ${s.double.b.marketShort} o${s.double.b.line}`]
    })).filter(Boolean)
  };
  check("board builds", !board.empty && board.legs.length > 0, `${board.counts.legs} graded props from ${board.counts.games} games`);
  check("board is not degraded", (board.degraded || []).length === 0 ? true : "warn",
        (board.degraded || []).join(", ") || "every feed answered");
  check("projections are sane", some(board.legs, l => l.mean > 0 && l.mean < 60) === board.legs.length, "");
  check("minutes are sane", some(board.legs, l => l.mins.minutes >= 10 && l.mins.minutes <= 42) === board.legs.length, "");
  // A board that is all one market means three of the four are not parsing.
  const byMkt = {};
  board.legs.forEach(l => { byMkt[l.market] = (byMkt[l.market] || 0) + 1; });
  report.board.byMarket = byMkt;
  check("all four markets priced", keys(byMkt).length === 4, JSON.stringify(byMkt));
  check("game logs reached the legs", some(board.legs, l => l.hasLog) > board.legs.length * 0.3,
        `${some(board.legs, l => l.hasLog)}/${board.legs.length} legs carry a log`);
  // The projection has to beat the season average it was built from, or the
  // whole pipeline is an expensive way to reprint a season average.
  const moved = board.legs.filter(l => l.seasonAvg > 0).map(l => Math.abs(l.mean / l.seasonAvg - 1));
  const med = moved.sort((a, b) => a - b)[Math.floor(moved.length / 2)] || 0;
  check("projections move off the season average", med > 0.01 && med < 0.5,
        `median move ${(med * 100).toFixed(1)}%`);
} catch (e) {
  check("board builds", false, e.message);
  report.board = { error: e.message, stack: String(e.stack || "").split("\n").slice(0, 6) };
}

report.fetches = calls;
report.bytes = bytes;
report.failed = failed;
report.verdict = failed === 0 ? "the engine reads the live feed correctly" : `${failed} check(s) failed — the model needs correcting`;
mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
say(`\n${report.verdict}`);
say(`${calls} fetches, ${(bytes / 1e6).toFixed(1)} MB → ${OUT}`);
process.exit(failed === 0 ? 0 : 1);
