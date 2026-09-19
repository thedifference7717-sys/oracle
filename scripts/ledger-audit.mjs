// Does the published record contain every double that was actually bet?
//
// data/ledger.json is written when a pick is alerted. data/model-log.json is
// written once a day at settlement, by different code, and carries the
// all-time won-lost record plus a count of graded legs. Two files, two paths,
// one underlying truth — so diffing consecutive model-log commits gives an
// independent count of how many doubles settled on each day, and the ledger
// has to match it.
//
// This is the check that would have caught three days of missing rows on the
// first morning instead of the fourth. It is the reason the recovery job runs
// on a schedule rather than only when someone thinks to look.
//
// Needs full git history (fetch-depth: 0). Run: node scripts/ledger-audit.mjs

import { execSync } from "child_process";
import { readFileSync } from "fs";

const sh = c => execSync(c, { encoding: "utf8", maxBuffer: 32 << 20 });

// One snapshot per commit that touched the calibration log, oldest first.
const snaps = [];
for (const sha of sh("git log --format=%H --reverse -- data/model-log.json").trim().split("\n").filter(Boolean)) {
  try {
    const d = JSON.parse(sh(`git show ${sha}:data/model-log.json`));
    if (!d || !d.through || !d.record) continue;
    const prev = snaps[snaps.length - 1];
    // Several commits can carry the same slate day; the last one wins.
    if (prev && prev.through === d.through) snaps[snaps.length - 1] = { through: d.through, w: d.record.w, l: d.record.l, n: d.global?.n ?? 0 };
    else snaps.push({ through: d.through, w: d.record.w, l: d.record.l, n: d.global?.n ?? 0 });
  } catch (e) { /* a snapshot that will not parse tells us nothing */ }
}

// Per-day settled counts, from the movement between consecutive snapshots.
const expected = new Map();
for (let i = 1; i < snaps.length; i++) {
  const a = snaps[i - 1], b = snaps[i];
  const dw = b.w - a.w, dl = b.l - a.l, dn = b.n - a.n;
  if (dw < 0 || dl < 0) continue;                 // a reset, not a day's play
  if (dw + dl === 0) continue;                    // nothing settled
  expected.set(b.through, { w: dw, l: dl, legs: dn });
}

// Shortfalls that are known, explained and unrecoverable. Subtracted before
// judging, so the audit does not cry wolf every hour over a gap nobody can
// close — but printed either way, because a gap that stops being mentioned
// stops being a gap and starts being a cover-up.
let gaps = new Map();
try {
  const G = JSON.parse(readFileSync("data/ledger-gaps.json", "utf8"));
  for (const g of G.gaps || []) gaps.set(g.date, g);
} catch (e) { /* no known gaps is the normal case */ }

const L = JSON.parse(readFileSync("data/ledger.json", "utf8"));
const rows = Array.isArray(L.bets) ? L.bets : [];
const era = rows.map(b => b.date).filter(Boolean).sort()[0];   // ledger starts here
if (!era) { console.log("Ledger is empty — nothing to audit against."); process.exit(0); }

const actual = new Map();
for (const b of rows) {
  const a = actual.get(b.date) || { w: 0, l: 0, open: 0 };
  if (b.status === "won") a.w++; else if (b.status === "lost") a.l++; else a.open++;
  actual.set(b.date, a);
}

console.log(`Auditing data/ledger.json against data/model-log.json from ${era}.\n`);
console.log("  DAY         CALIBRATION SAYS   LEDGER HAS        ");
let short = 0, days = 0;
for (const [day, e] of [...expected.entries()].sort()) {
  if (day < era) continue;                        // predates the ledger, legitimately absent
  days++;
  const a = actual.get(day) || { w: 0, l: 0, open: 0 };
  const g = gaps.get(day) || { w: 0, l: 0 };
  const want = e.w + e.l, have = a.w + a.l + g.w + g.l;
  const agree = want === have && e.w === a.w + g.w && e.l === a.l + g.l;
  if (!agree) short++;
  console.log(`  ${agree ? (g.w || g.l ? "ok* " : "ok  ") : "SHORT"} ${day}  ${String(e.w) + "W " + e.l + "L"}`.padEnd(34) +
    `${a.w}W ${a.l}L${a.open ? ` (+${a.open} open)` : ""}` +
    (g.w || g.l ? `  + ${g.w}W ${g.l}L known gap` : "") +
    (agree ? "" : `   <-- ${want - have} bet(s) missing from the record`));
}

// Days the ledger has but the calibration log never saw. Not necessarily an
// error: today's bets are in the ledger long before the day settles.
for (const [day, a] of [...actual.entries()].sort()) {
  if (expected.has(day) || day < era) continue;
  console.log(`  note ${day}  not yet settled`.padEnd(34) + `${a.w}W ${a.l}L${a.open ? ` (+${a.open} open)` : ""}`);
}

if (!days) { console.log("\nNo settled days to compare yet."); process.exit(0); }
if (gaps.size) {
  console.log("\n  * days with a known, documented gap (data/ledger-gaps.json):");
  for (const [d, g] of [...gaps.entries()].sort())
    console.log(`      ${d}  ${g.w}W ${g.l}L  ${g.recoverable ? "recoverable" : "not recoverable"} — ${g.reason}`);
}
console.log(short
  ? `\nINCOMPLETE — ${short} of ${days} settled day(s) are missing bets from the published record.`
  : `\nComplete — all ${days} settled day(s) reconcile against the calibration log.`);
process.exit(short ? 2 : 0);
