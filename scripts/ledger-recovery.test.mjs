// Regression test for the failure that stopped the doubles record dead.
//
// On 2026-09-18 two doubles were alerted, both cashed, and data/ledger.json
// did not change. The cause: `D.seen[key]` lives in gitignored state.json and
// survives everything, while the ledger row lives in a TRACKED file that a
// failed push, a rebase, or a cancelled runner can take away. State said the
// game was decided, the ledger had no row, and the per-game loop skipped it
// forever.
//
// Run: node scripts/ledger-recovery.test.mjs
// No dependencies, no network, no fixtures on disk — it builds its own repo.

import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};

try {
  // A repo whose published ledger stops on the 17th, exactly as main did.
  cpSync(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
  // The alerter now imports every sport's model for the cross-sport ladder.
  for (const f of ["dd-model.js", "hairdwood-model.js", "gridiron-model.js", "ladder-select.js", "dub-stake.js", "fills.js"]) cpSync(join(root, f), join(dir, f));
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data/ledger.json"), JSON.stringify({
    v: 1, sport: "MLB", updated: "2026-09-18T00:11:18.105Z",
    bets: [{ id: "2026-09-17:822924", date: "2026-09-17", teams: "TB vs ATH",
             published: "2026-09-17T14:30:00Z", status: "lost" }]
  }, null, 1));
  const git = c => execSync(`git ${c}`, { cwd: dir, stdio: "pipe" });
  git("init -q ."); git("config user.email t@t"); git("config user.name t");
  git("add -A"); git("commit -qm base"); git("branch -q -M main");
  git("update-ref refs/remotes/origin/main HEAD");

  process.chdir(dir);
  process.env.TELEGRAM_BOT_TOKEN ||= "test";   // the module exits without these
  process.env.TELEGRAM_CHAT_ID ||= "test";
  const A = await import(pathToFileURL(join(dir, "scripts/parlaiy-alerts.mjs")).href);

  const leg = (id, name) => ({ id, name, slot: 3, p: 0.75, sp: "A Starter" });
  const dbl = teams => ({ teams, venue: "A Park", prob: 0.56, edge: 0.031, evPct: 0.04,
    kelly: 0.02, soft: 0.061, spotDelta: 0.071, sameTeam: false,
    a: leg(1, "A Batter"), b: leg(2, "B Batter") });

  // State as the runner actually held it the next morning.
  const D = { bets: {
    "2026-09-18:900001": { date: "2026-09-18", teams: "NYY vs MIN", gk: 900001,
                           double: dbl("NYY vs MIN"), results: { cashed: true, hits: [1, 2] } },
    "2026-09-18:900002": { date: "2026-09-18", teams: "SEA @ COL", gk: 900002,
                           double: dbl("SEA @ COL"), results: { dead: true, hits: [1, 0] } },
  } };
  A._setLedgerStateRows([]);

  console.log("recovers rows that were alerted but never committed");
  ok("ledger starts with only the 17th", A.readLedger().bets.length === 1);
  A.reconcileLedger(D, []);
  const L = JSON.parse(readFileSync(join(dir, "data/ledger.json"), "utf8"));
  ok("both missing rows are back", L.bets.length === 3, `${L.bets.length} rows`);
  const won = L.bets.find(b => b.id === "2026-09-18:900001");
  const lost = L.bets.find(b => b.id === "2026-09-18:900002");
  ok("a cashed double is graded won", won && won.status === "won", won && won.status);
  ok("a dead double is graded lost", lost && lost.status === "lost", lost && lost.status);
  ok("hit counts carry across", won && String(won.hits) === "1,2", won && String(won.hits));
  ok("the soft score that qualified it is kept", won && won.soft === 0.061);
  ok("the stake is the spot-point stake", won && won.stake === 17.75, won && String(won.stake));
  ok("a rebuilt row is marked, not passed off as published",
     won && won.recovered === true && won.published == null);
  ok("rows are held where git cannot revert them", (D.ledgerRows || []).length === 2);

  console.log("does not duplicate on the next pass");
  A.reconcileLedger(D, []);
  const L2 = JSON.parse(readFileSync(join(dir, "data/ledger.json"), "utf8"));
  ok("still three rows", L2.bets.length === 3, `${L2.bets.length} rows`);

  console.log("survives the revert that caused the loss");
  execSync("git checkout -- data/ledger.json", { cwd: dir, stdio: "pipe" });
  ok("the working tree really was reverted",
     JSON.parse(readFileSync(join(dir, "data/ledger.json"), "utf8")).bets.length === 1);
  ok("readLedger still returns all three", A.readLedger().bets.length === 3);

  console.log("a settled row always beats an open one");
  A._setLedgerStateRows([{ id: "2026-09-17:822924", date: "2026-09-17", status: "open" }]);
  const merged = A.readLedger().bets.find(b => b.id === "2026-09-17:822924");
  ok("the graded copy wins", merged.status === "lost", merged.status);
} finally {
  process.chdir(root);
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
