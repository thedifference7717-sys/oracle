// One-shot recovery for doubles that were alerted but never reached the ledger.
//
// The alerter now reconciles on every pass, but that only helps while its
// gitignored state.json still holds the bet — and that state lives in the
// Actions cache, not in the repo, so it cannot be repaired from a checkout.
// This runs the same reconciliation from a job of its own: restore the cache,
// read what the runner actually recorded, and write the missing rows into
// data/ledger.json.
//
// It reuses the alerter's own reconcileLedger rather than reimplementing it,
// so there is exactly one definition of what a recovered row looks like.

import { readFileSync, existsSync } from "fs";

process.env.TELEGRAM_BOT_TOKEN ||= "unused-by-this-script";
process.env.TELEGRAM_CHAT_ID ||= "unused-by-this-script";

const A = await import("./parlaiy-alerts.mjs");

const STATE = "state.json";
if (!existsSync(STATE)) {
  console.log("No state.json restored — nothing to recover from.");
  process.exit(0);
}
let blob = {};
try { blob = A.readState() || {}; }                       // decrypted with PICKS_KEY if it is encrypted
catch (e) { console.log("state.json unreadable:", e.message); process.exit(1); }

const D = (blob.dd = blob.dd || {});
D.bets = D.bets || {};
A._setLedgerStateRows(Array.isArray(D.ledgerRows) ? D.ledgerRows : []);

console.log(`state.json holds ${Object.keys(D.bets).length} bet(s):`);
for (const [k, b] of Object.entries(D.bets)) {
  const d = b.double || {};
  const r = b.results || {};
  console.log(`  ${k}  ${b.teams}  ${r.cashed ? "CASHED" : r.dead ? "DEAD" : "open"}` +
    `  legs=${d.a ? d.a.name : "?"} + ${d.b ? d.b.name : "?"}` +
    `  soft=${d.soft != null ? (d.soft * 100).toFixed(1) : "?"}` +
    `  spot=${d.spotDelta != null ? (d.spotDelta * 100).toFixed(1) : "?"}`);
}

const before = A.readLedger().bets;
console.log(`\nledger before: ${before.length} row(s), latest ${before.length ? before[before.length - 1].date : "—"}`);

A.reconcileLedger(D, []);

const after = A.readLedger().bets;
console.log(`ledger after : ${after.length} row(s)`);
for (const b of after) {
  console.log(`  ${b.date}  ${b.teams}  ${b.status}` +
    `  stake=${b.stake != null ? b.stake : "—"}  price=${b.price != null ? b.price : "—"}` +
    `  soft=${b.soft != null ? (b.soft * 100).toFixed(1) : "—"}${b.recovered ? "  [RECOVERED]" : ""}`);
}
console.log(`\n${after.length - before.length} row(s) added.`);
