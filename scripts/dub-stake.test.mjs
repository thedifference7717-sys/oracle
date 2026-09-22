// The Dub's staking rule, exactly as stated: 10% of the starting bankroll,
// 10% of the new balance after a win, the last stake plus 12.5% after a loss.
//
// Run: node scripts/dub-stake.test.mjs
import D from "../dub-stake.js";

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};
const dub = (date, status, price = 100) => ({ date, status, price, legs: [{}, {}] });

console.log("the example: a $100 bankroll");
{
  ok("first Dub is $10", D.chain([], 100).next === 10);
  const lost = D.chain([dub("d1", "lost")], 100);
  ok("after a loss the next is $11.25", lost.next === 11.25, String(lost.next));
  ok("and the balance is $90", lost.balance === 90);
  const won = D.chain([dub("d1", "won", 100)], 100);
  ok("a win at +100 turns $10 into $20 back: balance $110", won.balance === 110, String(won.balance));
  ok("after a win the next is 10% of $110", won.next === 11, String(won.next));
}

console.log("losses compound, a win resets");
{
  const r = D.chain([dub("d1", "lost"), dub("d2", "lost")], 100);
  ok("two losses: 10 -> 11.25 -> 12.66", r.next === 12.66, String(r.next));
  ok("balance 100 - 10 - 11.25", r.balance === 78.75, String(r.balance));
  const back = D.chain([dub("d1", "lost"), dub("d2", "won", 100)], 100);
  ok("a win on $11.25 at +100 pays $11.25", back.rows[1].pl === 11.25);
  ok("then 10% of the new balance ($101.25)", back.next === 10.13, String(back.next));
}

console.log("voids, open bets and passes");
{
  const v = D.chain([dub("d1", "lost"), dub("d2", "void")], 100);
  ok("a void keeps the stake", v.next === 11.25);
  const o = D.chain([dub("d1", "lost"), dub("d2", "open")], 100);
  ok("an open Dub rides the stake it was placed at", o.rows[1].stake === 11.25);
  ok("and moves nothing", o.balance === 90 && o.next === 11.25);
  ok("stakeFor finds today's row", D.stakeFor(o, "d2").stake === 11.25);
  const n = D.chain([{ date: "d1", status: "noplay" }, dub("d2", "lost")], 100);
  ok("a day with no Dub is skipped", n.rows.length === 1 && n.next === 11.25);
}

console.log("the price you actually got decides the payout");
{
  const r = D.chain([dub("d1", "won", -114)], 100, { priceOf: () => 120 });
  ok("your +120 on $10 pays $12", r.rows[0].pl === 12, String(r.rows[0].pl));
}


console.log("the Robin: $1 a ticket until the balance covers ten full days");
{
  // A full six-leg Robin: 15 + 20 + 15 + 6 + 1 = 57 tickets. graded pl is per unit.
  const sizes = pls => [2, 3, 4, 5, 6].map((m, i) => ({ m, tickets: [15, 20, 15, 6, 1][i], pl: pls[i] }));
  const robin = (date, pls) => ({ date, status: "settled", legs: [{}, {}], graded: { sizes: sizes(pls) } });
  const open = { date: "d9", status: "open", legs: [{}, {}], sizes: sizes([0, 0, 0, 0, 0]) };
  ok("57 tickets a full day", D.ROBIN_TICKETS === 57);
  const r0 = D.robinChain([], 300);
  ok("$1 a ticket on a $300 bankroll", r0.unit === 1 && r0.perDay === 57);
  ok("the bar is $570", r0.bar === 570);
  const up = D.robinChain([robin("d1", [10, 5, 0, 0, 0])], 300);
  ok("a day up 15 units at $1 is +$15", up.rows[0].pl === 15 && up.balance === 315, String(up.rows[0].pl));
  ok("still $1 below $570", up.unit === 1);
  const at = D.robinChain([], 570);
  ok("exactly $570 is not over it: still $1", at.unit === 1);
  const over = D.robinChain([], 571);
  ok("over $570: $1.10 a ticket", over.unit === 1.1, String(over.unit));
  ok("next bar $627", over.bar === 627, String(over.bar));
  const mid = D.robinChain([], 650);
  ok("over $627: $1.21, next bar $689.70", mid.unit === 1.21 && mid.bar === 689.7, `${mid.unit} ${mid.bar}`);
  const big = D.robinChain([], 700);
  ok("over $689.70 too: $1.33, next bar $758.67", big.unit === 1.33 && big.bar === 758.67, `${big.unit} ${big.bar}`);
  const climb = D.robinChain([robin("d1", [60, 0, 0, 0, 0])], 520);
  ok("a winning day that crosses $570 steps the next day up", climb.balance === 580 && climb.unit === 1.1, `${climb.balance} ${climb.unit}`);
  ok("the day itself was played at $1", climb.rows[0].unit === 1 && climb.rows[0].stake === 57);
  const back = D.robinChain([robin("d1", [60, 0, 0, 0, 0]), robin("d2", [-40, 0, 0, 0, 0])], 520);
  ok("a loss back under $570 does not cut the unit", back.balance === 536 && back.unit === 1.1, `${back.balance} ${back.unit}`);
  const withOpen = D.robinChain([robin("d1", [-10, 0, 0, 0, 0]), open], 300);
  ok("an open Robin rides at the unit without moving the balance", withOpen.rows[1].status === "open" && withOpen.balance === 290);
  ok("robinUnitFor finds today's row", D.robinUnitFor(withOpen, "d9").unit === 1);
  ok("a record of days up and down", back.w === 1 && back.l === 1);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
