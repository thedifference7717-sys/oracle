// The ladder's arithmetic, locked down.
//
// This is the number a customer judges the product by, so it gets a test
// rather than a screenshot. Run: node scripts/ladder-math.test.mjs

import M from "../dd-model.js";
import { readFileSync } from "fs";

let failures = 0;
const ok = (name, got, want) => {
  const pass = Math.abs(got - want) < 0.005;
  if (!pass) failures++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got ${got}, want ${want}`}`);
};

console.log("the published history replays to the standing on the card");
const K = JSON.parse(readFileSync(new URL("../data/ladder.json", import.meta.url), "utf8"));
const L = M.ladder(K.bets, { account: 100 });
// 100 - 10 (cycle 1's seed) - 14 (cycle 2, every dollar of it fresh cash,
// because cycle 1's winnings were already lost on the 16th).
ok("account", L.account, 76);
ok("profit and loss", L.pl, -24);
ok("cycle", L.cycle, 3);
ok("seed", L.base, 15.63);
ok("today's stake", L.stake, 21.88);
ok("the file's stored state agrees with the replay", K.state.account, L.account);

console.log("the 9/17 rung is charged what was actually risked");
const r17 = L.rows.find(r => r.date === "2026-09-17");
ok("stake shown", r17.stake, 14);
ok("charged to the account", r17.pl, -14);
ok("and it is flagged, not silently absorbed", r17.topUp, 1.5);

console.log("a mis-sized rung scales to any bankroll");
for (const [acct, want] of [[100, 76], [500, 380], [1000, 760]]) {
  ok(`$${acct} bankroll`, M.ladder(K.bets, { account: acct }).account, want);
}

console.log("an exchange adjustment is untouched by the proportional form");
const ex = M.ladder([{ date: "d", status: "lost", price: -250, stakeActual: 18.5, topUp: 11.5 }],
                    { account: 100 }).rows[0];
ok("stake is the one actually traded", ex.stake, 18.5);
ok("loss is seed plus the new money", ex.pl, -21.5);

console.log("only the seed is at risk while a cycle rides");
const ride = M.ladder([{ date: "a", status: "won", price: -250 }], { account: 100 });
ok("account does not move mid-cycle", ride.account, 100);
ok("money in is still the seed", ride.cashIn, 10);
ok("the rest on the table is house money", ride.onTable, 4);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
