// ladder-math.js (what the public pages load) must be the model's own ladder
// arithmetic, not an approximation of it. Two checks: the source of every
// shared function is identical, and both replay the real ledger identically.
// Skips where dd-model.js is absent (the public repo, after the split).
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let failures = 0;
const ok = (name, cond, detail) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || detail == null ? "" : " — " + detail}`); if (!cond) failures++; };

if (!existsSync(new URL("../dd-model.js", import.meta.url))) {
  console.log("dd-model.js not here — nothing to compare against. Skipped.");
  process.exit(0);
}
const M = require("../dd-model.js"), L = require("../ladder-math.js");

console.log("the same code");
for (const f of ["amOdds", "americanFromDec", "decFromAmerican", "ladder", "ladderRisk", "ladderBlocked", "etNow", "slateYmd"]) {
  ok(`${f} is identical`, typeof L[f] === "function" && String(L[f]) === String(M[f]));
}
ok("the ladder's settings are identical", JSON.stringify(L.LADDER) === JSON.stringify(M.LADDER));
ok("so is the MLB feed address", L.API === M.API);

console.log("the same answers on the real ledger");
const K = JSON.parse(readFileSync(new URL("../data/ladder.json", import.meta.url), "utf8"));
for (const cfg of [{}, { account: 100 }, { account: 2500, price: -300 }]) {
  const a = M.ladder(K.bets, cfg), b = L.ladder(K.bets, cfg);
  ok(`replay with ${JSON.stringify(cfg)}`, JSON.stringify(a) === JSON.stringify(b));
  ok(`risk with ${JSON.stringify(cfg)}`, JSON.stringify(M.ladderRisk(0.72, -250, a)) === JSON.stringify(L.ladderRisk(0.72, -250, b)));
}
ok("benched players agree", [...M.ladderBlocked(K.bets)].join() === [...L.ladderBlocked(K.bets)].join());

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
