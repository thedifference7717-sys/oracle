// The ladder's arithmetic, locked down.
//
// This is the number a customer judges the product by, so it gets a test
// rather than a screenshot. Run: node scripts/ladder-math.test.mjs

import M from "../dd-model.js";
import { readFileSync } from "fs";

let failures = 0;
const okTol = (name, got, want, tol) => {
  const pass = Math.abs(got - want) <= tol;
  if (!pass) failures++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  got ${got}, want ${want}`}`);
};
const ok = (name, got, want) => okTol(name, got, want, 0.005);

// Invariants, not snapshots.
//
// The first version of this file asserted the live standing — account 76,
// cycle 3, "today's stake" 21.88 — which is a photograph of one afternoon, not
// a rule. Three rungs later the ladder had moved on and the test failed while
// the code was perfectly correct. A test that has to be edited every time the
// product does its job is worse than no test: it trains you to ignore it.
// So assert what must hold on every possible history instead.
console.log("the replay agrees with what the alerter published");
const K = JSON.parse(readFileSync(new URL("../data/ladder.json", import.meta.url), "utf8"));
const L = M.ladder(K.bets, { account: 100 });
ok("stored state matches a fresh replay", K.state.account, L.account);
ok("stored seed matches", K.state.base, L.base);
ok("stored next stake matches", K.state.stake, L.stake);
ok("profit and loss is account minus the starting bankroll", L.pl, L.account - 100);

console.log("the account only moves when a cycle ends");
{
  let acct = 100, moves = 0, ends = 0;
  for (const r of L.rows) {
    if (r.closed) ends++;
    if (Math.abs((r.pl || 0)) > 0.005) moves++;
  }
  // Every row that changed the account is a row that closed a cycle, and no
  // other row did. This is why the headline can sit still for days.
  const movedWithoutEnding = L.rows.filter(r => Math.abs(r.pl || 0) > 0.005 && !r.closed).length;
  ok("no row changes the account without ending a cycle", movedWithoutEnding, 0);
  ok("cycles ended equals busts plus completions", ends, L.cycles.busted + L.cycles.done);
}

console.log("a winning rung rolls its whole return onto the next one");
{
  const rows = L.rows;
  let checked = 0, wrong = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.status !== "won" || a.closed) continue;   // mid-cycle win only
    checked++;
    if (Math.abs(b.stake - a.ret) > 0.02) wrong++;
  }
  ok("every mid-cycle win is followed by a stake equal to its return", wrong, 0);
  ok("and there was at least one to check", checked > 0 ? 1 : 0, 1);
}

console.log("the 9/17 rung is charged what was actually risked");
const r17 = L.rows.find(r => r.date === "2026-09-17");
ok("stake shown", r17.stake, 14);
ok("charged to the account", r17.pl, -14);
ok("and it is flagged, not silently absorbed", r17.topUp, 1.5);

console.log("the whole ladder scales linearly with the bankroll");
// Stated as a ratio so it keeps holding as the history grows: doubling the
// account doubles every figure, including the 9/17 correction.
// Exactly linear is too strong a claim for the seed: every cycle's escalation
// is rounded to the cent, so a bigger bankroll rounds at a bigger scale and
// the two drift by up to a cent per escalation. 10 -> 12.50 -> 15.63 at $100;
// 50 -> 62.50 -> 78.13 at $500, against 15.63 x 5 = 78.15. That is the money
// being real, not an error — so allow a cent per cycle and no more.
for (const k of [5, 10]) {
  const scaled = M.ladder(K.bets, { account: 100 * k });
  const cycles = scaled.cycles.busted + scaled.cycles.done + 1;
  ok(`x${k} bankroll gives x${k} account`, scaled.account, L.account * k);
  okTol(`x${k} bankroll gives x${k} seed (to the rounding)`, scaled.base, L.base * k, 0.01 * k * cycles);
}

console.log("a rung with no recorded price does not compound at even money");
{
  // decFromAmerican(null) is null, and `null || 1` is EVEN MONEY — so a
  // winning rung whose price never reached the file returned exactly its
  // stake and the ladder silently stopped growing. It also rendered as the
  // literal string "null" wherever the price was shown.
  const unpriced = M.ladder([{ date: "d1", status: "won", price: null, pick: "X" }], { account: 100 });
  // Compare against the CURRENT default, not a number typed here — the base
  // price is a setting and moved from -250 to -275 the first time it changed.
  const priced   = M.ladder([{ date: "d1", status: "won", price: M.LADDER.price, pick: "X" }], { account: 100 });
  ok("it returns what the assumed price pays", unpriced.rows[0].ret, priced.rows[0].ret);
  ok("it rolls the same stake forward", unpriced.stake, priced.stake);
  ok("the price shown is a number, never null", unpriced.rows[0].price, M.LADDER.price);
  ok("and the row says the price was assumed", unpriced.rows[0].assumedPrice ? 1 : 0, 1);
  ok("a recorded price is not flagged", priced.rows[0].assumedPrice ? 1 : 0, 0);
}

console.log("a recorded payout beats the price");
{
  // Odds move every day and every book, and a bettor knows what came back more
  // reliably than the American number behind it. A rounded price is also lossy:
  // -191 turns $36.33 into $55.35, three cents adrift, and the ladder compounds
  // that into every rung after it. So the payout is taken as given.
  const r = M.ladder([{ date: "d1", status: "won", price: -300,
                        stakeActual: 36.33, returnActual: 55.32, pick: "X" }], { account: 363.3 });
  ok("the return is exactly what was recorded", r.rows[0].ret, 55.32);
  ok("the next rung rides that number", r.stake, 55.32);
  ok("the price is back-solved from it", r.rows[0].price, -191);
  ok("and the row says so", r.rows[0].retActual ? 1 : 0, 1);
  // A payout of zero or nonsense must not be mistaken for a real one.
  const junk = M.ladder([{ date: "d1", status: "won", price: -275, returnActual: 0, pick: "X" }], { account: 100 });
  ok("a zero payout falls back to the price", junk.rows[0].ret, M.ladder([{ date: "d1", status: "won", price: -275, pick: "X" }], { account: 100 }).rows[0].ret);
}

console.log("the base price is the documented assumption");
ok("LADDER.price", M.LADDER.price, -275);

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
