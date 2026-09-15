// Recover the record for the window between the new model's first slate and
// the day the per-bet ledger started, from the repository's own history.
//
// data/model-log.json has been committed most nights since the model went in.
// Each commit carries a cumulative counter and the date it runs `through`, and
// GitHub timestamps the commit. Differencing the last snapshot taken BEFORE
// the era began against the latest one therefore yields the era's record —
// and because both endpoints are public commits, anyone can rerun this and get
// the same answer. That is weaker evidence than the per-bet ledger (individual
// bets cannot be listed, because they were never written down that way) but it
// is much stronger than a number simply asserted, and it is all that exists
// for this window.
//
// The arithmetic is checked, not trusted: doubles x 2 must equal graded legs.
// If it does not, the counters are measuring different things and the script
// refuses to emit rather than publish a figure it cannot stand behind.
import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";

const ERA_START = process.argv[2] || "2026-09-10";
const LOG = "data/model-log.json";
const OUT = "data/era-open.json";

const sh = c => execSync(c, { encoding: "utf8" }).trim();
const snapshots = sh(`git log --format=%H --all -- ${LOG}`).split("\n").filter(Boolean)
  .map(sha => {
    let d; try { d = JSON.parse(sh(`git show ${sha}:${LOG}`)); } catch (e) { return null; }
    const r = d.record || {}, g = d.global || {};
    if (r.w == null || g.n == null) return null;
    return { sha: sha.slice(0, 7), committed: sh(`git show -s --format=%cI ${sha}`),
             through: d.through, w: r.w, l: r.l, legs: g.n, hits: g.hits, sump: g.sump };
  }).filter(Boolean)
  .sort((a, b) => (a.through || "").localeCompare(b.through || ""));

if (snapshots.length < 2) { console.error("Not enough model-log snapshots to difference."); process.exit(1); }

// The baseline is the newest snapshot whose data stops BEFORE the era starts.
const prior = [...snapshots].reverse().find(s => s.through && s.through < ERA_START);
const latest = snapshots[snapshots.length - 1];
if (!prior) { console.error(`No snapshot predates ${ERA_START}; nothing to subtract.`); process.exit(1); }

const d = {
  w: latest.w - prior.w, l: latest.l - prior.l,
  legs: latest.legs - prior.legs, hits: latest.hits - prior.hits,
  predicted: +(latest.sump - prior.sump).toFixed(2)
};
d.bets = d.w + d.l;

const ok = d.bets * 2 === d.legs && d.w >= 0 && d.l >= 0 && d.hits >= 0 && d.legs > 0;
if (!ok) {
  console.error(`Refusing to emit: ${d.bets} doubles x 2 = ${d.bets * 2} but ${d.legs} legs graded.`);
  console.error("The two counters disagree, so the difference does not describe one set of bets.");
  process.exit(1);
}

mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify({
  v: 1, sport: "MLB", eraStart: ERA_START,
  generated: new Date().toISOString(),
  method: "difference of two dated data/model-log.json commits; rerun with scripts/derive-era-record.mjs",
  from: prior, to: latest, derived: d
}, null, 1) + "\n");

console.log(`${ERA_START} -> ${latest.through}: ${d.w}-${d.l} (${d.bets} doubles)`);
console.log(`  legs ${d.hits}/${d.legs} = ${(d.hits / d.legs * 100).toFixed(1)}% actual vs ${(d.predicted / d.legs * 100).toFixed(1)}% predicted`);
console.log(`  baseline ${prior.sha} (through ${prior.through}) -> ${latest.sha} (through ${latest.through})`);
console.log(`  wrote ${OUT}`);
