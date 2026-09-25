// Check every revealed pick against the record — no key needed.
//
//   node scripts/verify-seals.mjs            (in a full clone: git clone, not --depth)
//
// For each Ladder row and each Dub and Robin leg that was sealed:
//   1. the revealed fields must reproduce the fingerprint (sha256), and
//   2. that fingerprint must appear, sealed, in a commit made before the
//      pick's game started.
// Together those say the pick published now is the pick that was committed
// then, and that nobody could have read it off the repo in between.
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { checkReveal } from "./seal.mjs";

// The first commit in which this fingerprint sat inside a SEAL — a revealed
// row carries the same hash, so merely finding the string is not enough.
const sealedIn = (J, hash) => (J.bets || []).some(b => (b.sealed && b.sealed.hash === hash) || (b.legs || []).some(l => l.sealed && l.sealed.hash === hash));
const firstCommit = (hash, file) => {
  let log = "";
  try { log = execSync(`git log --reverse --format="%H %cI" -S ${hash} -- ${file}`, { encoding: "utf8" }).trim(); } catch (e) { return null; }
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, at] = line.split(" ");
    try { if (sealedIn(JSON.parse(execSync(`git show ${sha}:${file}`, { encoding: "utf8", maxBuffer: 1 << 28 })), hash)) return Date.parse(at); } catch (e) {}
  }
  return null;
};

let checked = 0, bad = 0, pending = 0;
const report = (label, item, file) => {
  if (item.sealed) { pending++; return; }
  if (!item.revealed) return;
  checked++;
  const okHash = checkReveal(item);
  const at = firstCommit(item.revealed.hash, file);
  const start = Date.parse(item.start || "");
  const okTime = at != null && !isNaN(start) && at < start;
  if (!okHash || !okTime) bad++;
  console.log(`${okHash && okTime ? "ok  " : "FAIL"} ${label}: ${item.pick || item.player}` +
    (okHash ? "" : " — fields do not reproduce the fingerprint") +
    (at == null ? " — never committed sealed (or a shallow clone)"
      : ` — sealed ${new Date(at).toISOString()}, game ${isNaN(start) ? "?" : new Date(start).toISOString()}${okTime ? "" : " — NOT before the game"}`));
};

for (const [file, kind] of [["data/ladder.json", "ladder"], ["data/dub.json", "dub"], ["data/robin.json", "robin"]]) {
  let J; try { J = JSON.parse(readFileSync(file, "utf8")); } catch (e) { continue; }
  for (const b of J.bets || []) {
    if (b.seal !== 1) continue;
    if (kind === "ladder") report(`${b.date} ladder`, b, file);
    else (b.legs || []).forEach((l, i) => report(`${b.date} ${kind} leg ${i + 1}`, l, file));
  }
}
console.log(`\n${checked} revealed pick(s) checked, ${bad} failed, ${pending} still sealed.`);
process.exit(bad ? 1 : 0);
