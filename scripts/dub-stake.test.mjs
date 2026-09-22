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


console.log("the Robin on its own bankroll");
{
  // Six legs by 2s: fifteen tickets. graded pl is per unit on every ticket.
  const robin = (date, pl) => ({ date, status: "settled", legs: [{}, {}], graded: { sizes: [{ m: 2, tickets: 15, pl }, { m: 3, tickets: 20, pl: -20 }] } });
  const open = { date: "d9", status: "open", legs: [{}, {}], sizes: [{ m: 2, tickets: 15 }] };
  ok("first Robin is $10", D.robinChain([], 100, 2).next === 10);
  const up = D.robinChain([robin("d1", 6)], 100, 2);
  ok("tickets up 6 units at $10/15 each: +$4", up.rows[0].pl === 4, String(up.rows[0].pl));
  ok("a day up is a win: next is 10% of $104", up.next === 10.4 && up.w === 1, String(up.next));
  const down = D.robinChain([robin("d1", -9)], 100, 2);
  ok("tickets down 9 units: -$6", down.rows[0].pl === -6, String(down.rows[0].pl));
  ok("a day down is a loss: next is $11.25", down.next === 11.25 && down.l === 1);
  const by3 = D.robinChain([robin("d1", 6)], 100, 3);
  ok("the size played decides it: by 3s that day lost $10", by3.rows[0].pl === -10 && by3.next === 11.25, String(by3.rows[0].pl));
  const o = D.robinChain([robin("d1", -9), open], 100, 2);
  ok("an ungraded Robin rides without moving anything", o.rows[1].status === "open" && o.balance === 94 && o.next === 11.25);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
