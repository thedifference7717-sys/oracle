// Grade a ladder rung the live alerter missed.
//
// A rung that was announced but whose row never reached the repo leaves a hole
// in the ledger, and a hole makes the cycle count ambiguous — which is exactly
// how "is today cycle 2 or cycle 3?" becomes unanswerable. Grading is the
// system's job, so the system reconstructs and grades it rather than asking.
//
// Usage: node scripts/ladder-backfill.mjs <YYYY-MM-DD> "<Player Name>" [stake] [price]
//
// The player is resolved by name against that date's boxscores, so no id has
// to be known in advance. It refuses to write anything it cannot verify: an
// unresolvable name, an ambiguous one, or a game that never reached a final.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

const API = "https://statsapi.mlb.com/api/v1";
const LADDER = "data/ladder.json";
const [, , day, wanted, stakeArg, priceArg] = process.argv;
if (!day || !wanted) { console.error('usage: <YYYY-MM-DD> "<Player Name>" [stake] [price]'); process.exit(1); }

const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").trim();
const j = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`); return r.json(); };

const sched = await j(`${API}/schedule?sportId=1&date=${day}`);
const games = (sched?.dates?.[0]?.games || []);
if (!games.length) { console.error(`No games on ${day}.`); process.exit(1); }

const found = [];
for (const g of games) {
  let bx; try { bx = await j(`${API}/game/${g.gamePk}/boxscore`); } catch (e) { continue; }
  for (const side of ["home", "away"]) {
    for (const pp of Object.values(bx?.teams?.[side]?.players || {})) {
      const nm = pp?.person?.fullName;
      if (!nm || norm(nm) !== norm(wanted)) continue;
      const bat = pp?.stats?.batting || {};
      found.push({
        gamePk: g.gamePk, id: pp.person.id, name: nm,
        hits: bat.hits == null ? null : +bat.hits,
        ab: bat.atBats == null ? null : +bat.atBats,
        state: g.status?.abstractGameState, detail: g.status?.detailedState,
        teams: `${g.teams.away.team.abbreviation || g.teams.away.team.name} @ ${g.teams.home.team.abbreviation || g.teams.home.team.name}`
      });
    }
  }
}

if (!found.length) { console.error(`No batter named "${wanted}" appears in any ${day} boxscore.`); process.exit(2); }
if (found.length > 1) {
  console.error(`"${wanted}" is ambiguous on ${day} — ${found.length} matches:`);
  found.forEach(f => console.error(`  id ${f.id}  ${f.name}  ${f.teams}  ${f.hits}-for-${f.ab}`));
  process.exit(3);
}

const f = found[0];
const final = f.state === "Final" && !/postpon|suspend|cancel/i.test(f.detail || "");
if (!final && !(f.hits >= 1)) { console.error(`${f.name}'s game is ${f.detail} and he has no hit — nothing to grade yet.`); process.exit(4); }

const status = f.hits >= 1 ? "won" : "lost";
console.log(`${day}  ${f.name} (id ${f.id})  ${f.teams}  ${f.hits}-for-${f.ab}  ->  ${status.toUpperCase()}`);

let L = { v: 1, sport: "MLB", bets: [] };
try { if (existsSync(LADDER)) L = JSON.parse(readFileSync(LADDER, "utf8")); } catch (e) {}
if (L.bets.some(b => b.date === day)) { console.log(`A row for ${day} already exists — leaving it alone.`); process.exit(0); }

L.bets.push({
  id: `${day}:ladder`, date: day, sport: "MLB",
  pick: f.name, playerId: f.id, gk: f.gamePk, teams: f.teams,
  stake: stakeArg ? +stakeArg : null, price: priceArg ? +priceArg : null,
  hits: f.hits, status, settled: new Date().toISOString(),
  backfilled: true,
  note: "Announced on Telegram but its row never reached the repo; graded afterwards from the official boxscore."
});
L.bets.sort((a, b) => String(a.date).localeCompare(String(b.date)));
L.updated = new Date().toISOString();
mkdirSync("data", { recursive: true });
writeFileSync(LADDER, JSON.stringify(L, null, 1) + "\n");
console.log(`wrote ${LADDER}`);
