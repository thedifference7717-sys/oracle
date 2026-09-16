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

const MARKET_KEYS = M.MARKETS.map(m => m.key);
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
    seasonYearTopLevel: (sb.season || {}).year || null,
    seasonYearUnderLeagues: ((((sb.leagues || [])[0] || {}).season || {}).year) || null,
    competitionKeys: keys(comp),
    oddsKeys: keys((comp && (comp.odds || [])[0]) || {}),
    oddsSample: (comp && (comp.odds || [])[0]) || null,
    competitorKeys: keys((comp && (comp.competitors || [])[0]) || {}),
    statusType: comp && comp.status ? comp.status.type : null
  };
  check("scoreboard returns a slate", (sb.events || []).length > 0, `${(sb.events || []).length} events`);
  // Read the way the model reads it, or the check is testing a different
  // program. The NBA feed keeps its season under leagues[0]; looking for it at
  // the top level is what this check caught the first time it ran.
  const slate = await M.loadSlate(get, DAY);
  check("loadSlate resolves the season", slate.season === season,
        `loadSlate says ${slate.season}, seasonOf() says ${season}, ` +
        `top-level=${(sb.season || {}).year}, leagues[0]=${((((sb.leagues || [])[0] || {}).season || {}).year)}`);
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
      injurySample: (raw.injuries || [])[0] ? { teamKeys: keys(raw.injuries[0].team), entry: (raw.injuries[0].injuries || [])[0] } : null,
      pickcenterKeys: keys((raw.pickcenter || [])[0] || {}),
      pickcenterSample: (raw.pickcenter || [])[0] || null,
      boxscoreKeys: keys(raw.boxscore || {}),
      boxTeamKeys: keys(((raw.boxscore || {}).players || [])[0] || {}),
      boxStatNames: ((((raw.boxscore || {}).players || [])[0] || {}).statistics || [])[0]
        ? { names: raw.boxscore.players[0].statistics[0].names, keys: raw.boxscore.players[0].statistics[0].keys,
            athleteSample: (raw.boxscore.players[0].statistics[0].athletes || [])[0] } : null };
    const sum = await M.loadSummary(get, games[0].id);
    const n = Object.values(sum.injuries).reduce((a, m) => a + keys(m).length, 0);
    // A finished game's report is often emptied out, so absence here is not a
    // failure — it is only meaningful on a live slate.
    check("injury report parsed", n > 0 ? true : "warn",
          n > 0 ? `${n} entries` : "none on this (finished) game — re-run on a live slate to confirm");
    // The scoreboard drops its odds block once a game is over, so this is where
    // the posted total has to come from. 65% of every projected team score
    // rides on it.
    check("summary carries the market's number", !!(sum.odds && sum.odds.total > 0),
          sum.odds ? `total ${sum.odds.total}, spreadHome ${sum.odds.spreadHome} (${sum.odds.provider || "?"}: ${sum.odds.details})` : "no pickcenter and no odds block");

    // ── settlement, which is what makes the record a record ────────────────
    const box = M.parseBoxScore(raw);
    const lines = Object.values(box);
    const played = lines.filter(l => !l.dnp);
    report.shapes.boxParsed = { players: lines.length, played: played.length, dnp: lines.length - played.length,
                                sample: played[0] || null };
    check("box score parsed", played.length >= 14, `${played.length} played, ${lines.length - played.length} DNP`);
    check("box score carries all four markets",
          some(played, l => l.min > 0) >= 14 && some(played, l => l.pts >= 0) >= 14 &&
          some(played, l => l.reb >= 0) >= 14 && some(played, l => l.ast >= 0) >= 14 &&
          some(played, l => l.tpm != null) >= 14,
          played[0] ? `${played[0].name}: ${played[0].min} min, ${played[0].pts} pts, ${played[0].reb} reb, ${played[0].ast} ast, ${played[0].tpm} 3pm` : "");
    // Settle a bet either side of what actually happened: one has to win and
    // the other has to lose, or the grader is not reading the same number the
    // box score is printing. Guarded, because an empty box score is already
    // reported above and should not take the rest of the probe down with it.
    const who = played.slice().sort((a, b) => b.pts - a.pts)[0];
    if (!who) { check("settlement grades a real line", false, "no box-score lines to settle against"); }
    else {
    const id = keys(box).find(k => box[k] === who);
    const lo = M.settle({ playerId: id, market: "pts", line: who.pts - 1.5 }, box);
    const hi = M.settle({ playerId: id, market: "pts", line: who.pts + 1.5 }, box);
    check("settlement grades a real line", !!(lo && hi && lo.status === "won" && hi.status === "lost"),
          `${who.name} scored ${who.pts}: o${who.pts - 1.5} -> ${lo && lo.status}, o${who.pts + 1.5} -> ${hi && hi.status}`);
    }
    const sat = lines.find(l => l.dnp);
    if (sat) {
      const sid = keys(box).find(k => box[k] === sat);
      const v = M.settle({ playerId: sid, market: "pts", line: 9.5 }, box);
      check("a DNP voids rather than loses", !!(v && v.status === "void"), `${sat.name} -> ${v && v.status}`);
    } else report.notes.push("no DNP in this box score — the void path was not exercised");
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
      // Every column, tested for being PRESENT rather than merely parseable.
      // `rebounds` shipped as a column name that does not exist in this feed;
      // it returned zero for every game of every player and nothing complained
      // until a backtest four layers downstream came back absurd.
      check("game log carries rebounds", some(log.played, r => r.reb > 0) >= log.played.length * 0.5,
            `${some(log.played, r => r.reb > 0)}/${log.played.length} games with a rebound — a rotation player who never rebounds is a parse failure, not a player`);
      check("game log carries assists", some(log.played, r => r.ast > 0) >= log.played.length * 0.5,
            `${some(log.played, r => r.ast > 0)}/${log.played.length} games with an assist`);
      check("game log carries three-point attempts", some(log.played, r => r.tpa != null) >= log.played.length * 0.8,
            "the 3PM spread is derived from attempts, so a missing column silently changes the distribution");
      // The decisive one for the backtest: the line rebuilt from a full game
      // log has to agree with the season line the league feed publishes. If
      // those two ever disagree, the as-of path is measuring something else.
      const rebuilt = M.lineFrom(log);
      const gaps = ["mpg", "pts", "reb", "ast", "tpm"].map(k => {
        const a = rebuilt[k], b = star[k];
        return { k, rebuilt: +a.toFixed(2), feed: +(b || 0).toFixed(2),
                 off: b > 0.5 ? Math.abs(a / b - 1) : (a < 0.5 ? 0 : 1) };
      });
      report.shapes.asOfRebuild = gaps;
      const worst = gaps.slice().sort((x, y) => y.off - x.off)[0];
      check("a line rebuilt from the log matches the season feed",
            gaps.every(g => g.off < 0.15),
            gaps.map(g => `${g.k} ${g.rebuilt} vs ${g.feed}`).join(", ") + ` — worst off by ${(worst.off * 100).toFixed(0)}%`);
    }
      // The back-to-back penalty and the recency window both need these.
      check("game log carries dates", some(log.played, r => r.date) >= log.played.length * 0.9,
            log.played[0] ? `newest ${log.played[0].date} -> ET day ${M.etDayOf(log.played[0].date)}` : "");
  } catch (e) { check("gamelog reachable and parsed", false, e.message); }
}

// ── 2. substance: the whole board, on a real slate ──────────────────────────
say("\nbuilding the board the dashboard would build…\n");
try {
  // No maxLogs override: probe what the page actually does, or the check on
  // log coverage below is measuring the probe's own cap.
  const board = await M.buildBoard({ getJSON: get, day: DAY, includeFinal: true, onStatus: m => say("  · " + m) });
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
  // The regression this board already had once: the line picker took the
  // highest rung clearing a hit-rate target, which on a low-mean count is
  // always the cheapest rung, and the whole top of the board came out as
  // "over 0.5 threes" at a fair price of -900. Bettable lines are not a
  // nice-to-have here, they are the product.
  const atFloor = some(board.legs, l => l.line === 0.5);
  check("lines are not all minimums", atFloor < board.legs.length * 0.5,
        `${atFloor}/${board.legs.length} legs sit on the 0.5 line`);
  const ps = board.legs.map(l => l.p).sort((a, b) => a - b);
  const medP = ps[Math.floor(ps.length / 2)] || 1;
  check("published prices are bettable", medP < 0.85,
        `median leg ${(medP * 100).toFixed(0)}% (fair ${M.amOdds(medP)})`);
  const shortest = ps[ps.length - 1];
  check("nothing unbettable is published", shortest <= M.CFG.pCeil + 1e-9,
        `shortest leg ${(shortest * 100).toFixed(0)}% (fair ${M.amOdds(shortest)}), ceiling ${(M.CFG.pCeil * 100).toFixed(0)}%`);
  // ── is the DISTRIBUTION the right shape? ─────────────────────────────────
  // The backtest has rebounds cashing 73.2% against a predicted 69.5% while the
  // projected mean is right, which means the fault is in the shape rather than
  // the level. The game logs already downloaded above are the direct evidence:
  // for each man, take his own per-game numbers, feed his own mean back into
  // our distribution, and compare what the model says about a line to how often
  // he actually cleared it. Any market whose model probability sits below its
  // own empirical frequency has the wrong shape, and this says by how much and
  // at which lines.
  // Its own sample, fetched here: `logs` inside buildBoard is the model's
  // private working set and not something this script can reach into. Forty
  // rotation players is enough to measure a distribution and cheap enough to
  // pay for on every run.
  const shapeLogs = {};
  {
    const pool = (players || []).filter(pl => (pl.mpg || 0) >= 20 && (pl.gp || 0) >= 20).slice(0, 40);
    for (const pl of pool) {
      try { const l = await M.loadGamelog(get, pl.id, season); if (l) shapeLogs[pl.id] = l; } catch (e) {}
    }
  }
  const shape = {};
  Object.keys(shapeLogs).forEach(id => {
    const L = shapeLogs[id];
    if (!L || L.played.length < 15) return;
    MARKET_KEYS.forEach(k => {
      const v = L.played.map(r => r[k]).filter(x => x != null);
      if (v.length < 15) return;
      const mu = v.reduce((a, b) => a + b, 0) / v.length;
      if (!(mu > 1)) return;
      const varr = v.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (v.length - 1);
      const sh = shape[k] = shape[k] || { n: 0, cvSum: 0, byOffset: {} };
      sh.n++;
      // The dispersion his own log implies, in the same parameterisation the
      // model uses: Var = mean + (cv*mean)^2.
      sh.cvSum += Math.sqrt(Math.max(0, varr - mu)) / mu;
      // The Fano factor: variance over mean. Below 1 means the count is
      // steadier than Poisson, which no negative binomial can represent and
      // which is the whole reason rebounds were mispriced.
      sh.vmrSum = (sh.vmrSum || 0) + varr / mu;
      sh.meanSum = (sh.meanSum || 0) + mu;
      sh.varSum = (sh.varSum || 0) + varr;
      // The pairs themselves, for the fit below. A single cv assumes the excess
      // spread grows in PROPORTION to the mean, and that is an assumption, not
      // a measurement: fit it at a 15-point scorer and extrapolate to a 25-point
      // one and you hand him a standard deviation of 11 where the real one is
      // nearer 9. So the exponent gets measured too.
      (sh.pairs = sh.pairs || []).push([mu, varr]);
      const sp = M.spread(k, mu, L, { tpa: mu / 0.36 });
      // Lines at and below the mean, which is where the board writes them.
      [-2.5, -1.5, -0.5].forEach(off => {
        const line = Math.max(0.5, Math.round(mu + off) + 0.5);
        const model = M.overProb(k, mu, sp, line, { tpa: mu / 0.36 });
        const emp = v.filter(x => x > line).length / v.length;
        const b = sh.byOffset[off] = sh.byOffset[off] || { n: 0, model: 0, emp: 0 };
        b.n++; b.model += model; b.emp += emp;
      });
    });
  });
  report.distributionShape = {};
  MARKET_KEYS.forEach(k => {
    const sh = shape[k]; if (!sh || !sh.n) return;
    const offs = {};
    Object.keys(sh.byOffset).forEach(o => {
      const b = sh.byOffset[o];
      offs[o] = { n: b.n, model: +(b.model / b.n).toFixed(4), empirical: +(b.emp / b.n).toFixed(4),
                  gap: +((b.emp - b.model) / b.n * b.n).toFixed(4) };
      offs[o].gap = +(offs[o].empirical - offs[o].model).toFixed(4);
    });
    // Excess spread against the mean, on log-log axes: sd_excess = K * mean^P.
    // P = 1 is the constant-cv assumption the model ships with; anything below
    // it means the spread grows more slowly than the mean, which is what
    // scoring actually does.
    const fit = (() => {
      const pts = (sh.pairs || []).map(([mu, v]) => [Math.log(mu), Math.log(Math.sqrt(Math.max(1e-6, v - mu)))])
                                  .filter(([x, y]) => isFinite(x) && isFinite(y));
      if (pts.length < 12) return null;
      const n = pts.length;
      const mx = pts.reduce((a, q) => a + q[0], 0) / n, my = pts.reduce((a, q) => a + q[1], 0) / n;
      let num = 0, den = 0;
      pts.forEach(([x, y]) => { num += (x - mx) * (y - my); den += (x - mx) * (x - mx); });
      if (!(den > 0)) return null;
      const P = num / den, K = Math.exp(my - P * mx);
      // What that fit says the spread is at three real sizes, against what the
      // model's constant-cv form says.
      const at = m => ({ mean: m, fitted: +Math.sqrt(m + Math.pow(K * Math.pow(m, P), 2)).toFixed(2),
                         model: +M.spread(k, m, null, { tpa: m / 0.36 }).sd.toFixed(2) });
      return { n, K: +K.toFixed(4), P: +P.toFixed(3), at: [at(5), at(15), at(25)] };
    })();
    const impliedCv = +(sh.cvSum / sh.n).toFixed(3);
    const impliedVmr = +(sh.vmrSum / sh.n).toFixed(3);
    report.distributionShape[k] = { players: sh.n, impliedCv, modelCv: M.MKT[k].cv,
      impliedVmr, modelVmr: M.MKT[k].vmr != null ? M.MKT[k].vmr : 1,
      meanOfMeans: +(sh.meanSum / sh.n).toFixed(2), meanOfVars: +(sh.varSum / sh.n).toFixed(2),
      spreadFit: fit, byOffset: offs };
    const worst = Object.values(offs).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
    check(`${k.toUpperCase()} distribution matches the logs`, Math.abs(worst.gap) < 0.03 ? true : "warn",
          `implied vmr ${impliedVmr} (model ${M.MKT[k].vmr != null ? M.MKT[k].vmr : 1}), implied cv ${impliedCv} (model ${M.MKT[k].cv}) · ` +
          Object.keys(offs).map(o => `${o}: model ${(offs[o].model * 100).toFixed(1)}% vs real ${(offs[o].empirical * 100).toFixed(1)}%`).join(" · "));
  });

  // ── where does a player's own rate stop needing a prior? ─────────────────
  // `stab` is the minutes of evidence at which a man's own per-minute rate
  // outweighs his positional prior. The four in this model were chosen, not
  // measured, and the backtest says every market projects low by an amount that
  // tracks what those constants cost an above-average player — which is every
  // player the board writes a prop on, because that is why he has one.
  //
  // So measure it the way a stabilisation point is defined: split each man's
  // season in half, predict the second half from the first half shrunk toward
  // the prior, and find the k that minimises the error. Too small a k overfits
  // a hot fortnight; too large a k is the bias being hunted here. The answer is
  // whichever number predicts best, and it is allowed to disagree with me.
  const stab = {};
  MARKET_KEYS.forEach(k => {
    const grid = [20, 40, 60, 90, 120, 160, 200, 260, 320, 420, 560];
    const err = grid.map(() => 0);
    let used = 0;
    Object.keys(shapeLogs).forEach(id => {
      const L = shapeLogs[id];
      if (!L || L.played.length < 24) return;
      const pl = (players || []).find(x => x.id === id);
      if (!pl) return;
      const half = Math.floor(L.played.length / 2);
      // The log is newest-first, so the OLDER half is the predictor.
      const older = L.played.slice(half), newer = L.played.slice(0, half);
      const minA = older.reduce((a, r) => a + r.min, 0), minB = newer.reduce((a, r) => a + r.min, 0);
      if (!(minA > 120 && minB > 120)) return;
      const totA = older.reduce((a, r) => a + (r[k] || 0), 0);
      const rateB = newer.reduce((a, r) => a + (r[k] || 0), 0) / minB;
      const role = M.ROLE[String(pl.pos || "").toUpperCase()] || {};
      const prior = k === "tpm" ? (role.tpa || 0.148) * 0.36 : (role[k] != null ? role[k] : 0.15);
      used++;
      grid.forEach((g, i) => {
        const pred = (totA + prior * g) / (minA + g);
        err[i] += (pred - rateB) * (pred - rateB) * minB;   // weight by exposure
      });
    });
    if (used < 10) return;
    let best = 0;
    err.forEach((e, i) => { if (e < err[best]) best = i; });
    stab[k] = { players: used, bestStab: grid[best], modelStab: M.MKT[k].stab,
                curve: grid.map((g, i) => [g, +(err[i] / used).toFixed(6)]) };
  });
  report.stabilisation = stab;
  MARKET_KEYS.forEach(k => {
    const q = stab[k]; if (!q) return;
    check(`${k.toUpperCase()} stabilisation constant`, Math.abs(q.bestStab - q.modelStab) <= q.modelStab * 0.6 ? true : "warn",
          `split-half says ${q.bestStab} minutes, model uses ${q.modelStab} (${q.players} players)`);
  });

  // ── how much should the recent window count for MINUTES? ────────────────
  // The backtest has minutes short by 2.4% and cleared every adjustment of
  // blame: the blowout haircut is worth half a percent and the injury tag six
  // tenths. The shortfall is in the source — season-to-date says 27.6 minutes,
  // the last ten say 28.5, and these men played 29.2. Minutes trend upward
  // through a season and the blend does not lean far enough forward to catch
  // it.
  //
  // `minRecentW` is how far it leans, and it was chosen rather than measured.
  // Same split-half as the rate constants: predict the back half of a season's
  // minutes from the front half, blending the front half's overall average with
  // its own last ten, and keep whichever weight predicts best. Zero is pure
  // season average, one is pure recent form.
  {
    const grid = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0];
    const err = grid.map(() => 0);
    let used = 0;
    Object.keys(shapeLogs).forEach(id => {
      const L = shapeLogs[id];
      if (!L || L.played.length < 24) return;
      const half = Math.floor(L.played.length / 2);
      const older = L.played.slice(half), newer = L.played.slice(0, half);
      if (older.length < 12 || newer.length < 12) return;
      const seasonAvg = older.reduce((a, r) => a + r.min, 0) / older.length;
      const last10 = older.slice(0, 10).reduce((a, r) => a + r.min, 0) / Math.min(10, older.length);
      const actual = newer.reduce((a, r) => a + r.min, 0) / newer.length;
      used++;
      grid.forEach((w, i) => {
        const pred = (1 - w) * seasonAvg + w * last10;
        err[i] += (pred - actual) * (pred - actual);
      });
    });
    if (used >= 10) {
      let best = 0;
      err.forEach((e, i) => { if (e < err[best]) best = i; });
      // The bias each weight leaves behind matters as much as the error: a
      // weight can predict well on average and still sit low every time.
      report.minutesWeight = { players: used, bestW: grid[best], modelW: M.CFG.minRecentW,
                               curve: grid.map((w, i) => [w, +(Math.sqrt(err[i] / used)).toFixed(3)]) };
      check("minutes recency weight", Math.abs(grid[best] - M.CFG.minRecentW) <= 0.2 ? true : "warn",
            `split-half says ${grid[best]}, model uses ${M.CFG.minRecentW} (${used} players, rmse ` +
            report.minutesWeight.curve.map(([w, e]) => `${w}:${e}`).join(" ") + ")");
    }
  }

  // ── does the projection track what happens? ──────────────────────────────
  // The backtest found rebounds hitting 99.1% against a predicted 70.0%, on a
  // quarter as many legs as the other markets. A hit rate that far above its
  // own prediction is not a model being careful, it is a model measuring
  // something other than what it settles against. So the projection is
  // compared to the box score, market by market, on this slate: if the
  // projection is low the bias shows here, and if the settlement is reading
  // the wrong column that shows here too.
  const boxes = {};
  for (const g of board.games) {
    try { boxes[g.id] = await M.loadBoxScore(get, g.id); } catch (e) { boxes[g.id] = null; }
  }
  const perMkt = {};
  board.legs.forEach(l => {
    const bx = boxes[l.gameId]; if (!bx) return;
    const line = bx[String(l.pl.id)];
    if (!line || line.dnp) return;
    const got = line[l.market];
    if (got == null) return;
    const m = perMkt[l.market] = perMkt[l.market] || { n: 0, proj: 0, actual: 0, line: 0, won: 0, p: 0, samples: [] };
    m.n++; m.proj += l.mean; m.actual += got; m.line += l.line; m.p += l.p;
    if (got > l.line) m.won++;
    if (m.samples.length < 4) m.samples.push(`${l.pl.name} ${l.marketShort} o${l.line}: projected ${l.mean.toFixed(1)}, got ${got}`);
  });
  report.perMarket = {};
  Object.keys(perMkt).forEach(k => {
    const m = perMkt[k];
    report.perMarket[k] = { n: m.n, meanProjected: +(m.proj / m.n).toFixed(2), meanActual: +(m.actual / m.n).toFixed(2),
                            meanLine: +(m.line / m.n).toFixed(2), predicted: +(m.p / m.n).toFixed(3),
                            hit: +(m.won / m.n).toFixed(3), samples: m.samples };
  });
  Object.keys(perMkt).forEach(k => {
    const r = report.perMarket[k];
    const bias = r.meanProjected / Math.max(0.01, r.meanActual) - 1;
    // A projection more than a fifth away from the mean outcome is not noise on
    // a hundred-plus legs; it is the wrong number.
    check(`${k.toUpperCase()} projections track the box score`, Math.abs(bias) < 0.20 ? true : "warn",
          `projected ${r.meanProjected} vs actual ${r.meanActual} (${bias >= 0 ? "+" : ""}${(bias * 100).toFixed(0)}%), lines average ${r.meanLine}, said ${(r.predicted * 100).toFixed(0)}% hit ${(r.hit * 100).toFixed(0)}% on ${r.n}`);
  });
  // The other half of the same question: how many legs each market even gets.
  // Rebounds produced a quarter of what points did in the backtest, which is
  // itself evidence that something upstream is starving them.
  const counts = {}; board.legs.forEach(l => { counts[l.market] = (counts[l.market] || 0) + 1; });
  const least = Math.min.apply(null, MARKET_KEYS.map(k => counts[k] || 0));
  const most = Math.max.apply(null, MARKET_KEYS.map(k => counts[k] || 0));
  check("no market is starved of legs", least >= most * 0.4 ? true : "warn",
        JSON.stringify(counts));

  check("game logs reached the legs", some(board.legs, l => l.hasLog) > board.legs.length * 0.5,
        `${some(board.legs, l => l.hasLog)}/${board.legs.length} legs carry a log`);
  const withTotal2 = some(board.games, g => g.total > 0);
  check("the board ends up with posted totals", withTotal2 >= board.games.length * 0.8,
        `${withTotal2}/${board.games.length} games priced after the summary fill-in`);
  check("defences differ from each other", (() => {
    const f = board.legs.map(l => l.factors.def.pts).filter(v => v != null);
    return new Set(f.map(v => v.toFixed(3))).size > 3;
  })(), "if every defence reads 1.000 the opponent split is not being parsed");
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
