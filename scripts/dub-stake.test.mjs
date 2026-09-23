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


console.log("the Robin: a ticket is the balance divided by 570");
{
  // A full six-leg Robin: 15 + 20 + 15 + 6 + 1 = 57 tickets. graded pl is per unit.
  const sizes = pls => [2, 3, 4, 5, 6].map((m, i) => ({ m, tickets: [15, 20, 15, 6, 1][i], pl: pls[i] }));
  const robin = (date, pls) => ({ date, status: "settled", legs: [{}, {}], graded: { sizes: sizes(pls) } });
  const open = { date: "d9", status: "open", legs: [{}, {}], sizes: sizes([0, 0, 0, 0, 0]) };
  ok("57 tickets a full day", D.ROBIN_TICKETS === 57);
  const at = D.robinChain([], 570);
  ok("$570 is $1 a ticket, $57 a day", at.unit === 1 && at.perDay === 57);
  ok("$694.52 is $1.22 (1.218 to the cent)", D.robinChain([], 694.52).unit === 1.22);
  ok("$300 is $0.53", D.robinChain([], 300).unit === 0.53, String(D.robinChain([], 300).unit));
  ok("no bankroll given is $570", D.robinChain([], 0).start === 570);
  const up = D.robinChain([robin("d1", [10, 5, 0, 0, 0])], 570);
  ok("a day up 15 units at $1 is +$15", up.rows[0].pl === 15 && up.balance === 585, String(up.rows[0].pl));
  ok("the next day is $585 / 570 = $1.03", up.unit === 1.03, String(up.unit));
  const two = D.robinChain([robin("d1", [60, 0, 0, 0, 0]), robin("d2", [-40, 0, 0, 0, 0])], 570);
  ok("day two is played at the new unit", two.rows[1].unit === 1.11 && two.rows[1].pl === -44.4, `${two.rows[1].unit} ${two.rows[1].pl}`);
  ok("and a losing day brings the unit down", two.balance === 585.6 && two.unit === 1.03, `${two.balance} ${two.unit}`);
  const withOpen = D.robinChain([robin("d1", [-10, 0, 0, 0, 0]), open], 570);
  ok("an open Robin rides at the unit without moving the balance", withOpen.rows[1].status === "open" && withOpen.balance === 560 && withOpen.rows[1].unit === 0.98);
  ok("robinUnitFor finds today's row", D.robinUnitFor(withOpen, "d9").unit === 0.98);
  ok("a record of days up and down", two.w === 1 && two.l === 1);
  // The record counts every ticket: 6 legs, all won -> 57-0.
  const legs = r => r.map(x => ({ result: x }));
  const perfect = { date: "d1", legs: legs(["won", "won", "won", "won", "won", "won"]), graded: { sizes: sizes([1, 1, 1, 1, 1]).map(z => Object.assign(z, { cashed: z.tickets })) } };
  ok("a perfect Robin is 57-0", JSON.stringify(D.robinTickets(perfect)) === JSON.stringify({ w: 57, l: 0, p: 0, legsW: 6, legsL: 0 }), JSON.stringify(D.robinTickets(perfect)));
  ok("the chain adds up tickets across days", D.robinChain([perfect], 570).rec.w === 57);
  // Two voids and a loss among four: by 2s the void pair is a push.
  const mixed = { date: "d2", legs: legs(["won", "lost", "void", "void"]),
    graded: { sizes: [{ m: 2, tickets: 6, cashed: 2 }, { m: 3, tickets: 4, cashed: 1 }, { m: 4, tickets: 1, cashed: 0 }] } };
  ok("an all-void ticket is a push, not a win or a loss", JSON.stringify(D.robinTickets(mixed)) === JSON.stringify({ w: 3, l: 7, p: 1, legsW: 1, legsL: 1 }), JSON.stringify(D.robinTickets(mixed)));
  ok("an open Robin is not in the record", D.robinTickets(open) === null);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
