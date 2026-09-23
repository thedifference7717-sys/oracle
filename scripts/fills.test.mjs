// The shared fills: bot commands, and how they fold into the bet amounts.
//
// Run: node scripts/fills.test.mjs
import F from "../fills.js";
import M from "../dd-model.js";
import D from "../dub-stake.js";

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};

console.log("reading a command");
{
  const c = F.parse("/odds -300", 2026);
  ok("/odds -300", c.kind === "odds" && c.value === -300 && c.day === null);
  ok("/odds 9/22 -317 carries a day", F.parse("/odds 9/22 -317", 2026).day === "2026-09-22");
  ok("/paid 72.77", F.parse("/paid 72.77", 2026).value === 72.77);
  ok("/paid $72.77", F.parse("/paid $72.77", 2026).value === 72.77);
  ok("/dub +120", F.parse("/dub +120", 2026).value === 120);
  ok("/odds@PropShopBot -300 in a group", F.parse("/odds@PropShopBot -300", 2026).value === -300);
  ok("/odds 5 is not a price", !!F.parse("/odds 5", 2026).error);
  ok("plain chat is ignored", F.parse("nice hit!", 2026) === null);
  ok("other commands are ignored", F.parse("/start", 2026) === null);
  ok("/clear dub 9/22", (c => c.kind === "clear" && c.what === "dub" && c.day === "2026-09-22")(F.parse("/clear dub 9/22", 2026)));
}

console.log("recording");
{
  const f = F.empty();
  F.apply(f, { kind: "paid", value: 72.77 }, "2026-09-22");
  F.apply(f, { kind: "dub", value: 120 }, "2026-09-22");
  ok("paid is kept", f.ladder["2026-09-22"].paid === 72.77);
  F.apply(f, { kind: "odds", value: -300 }, "2026-09-22");
  ok("new odds replace an earlier payout", f.ladder["2026-09-22"].price === -300 && f.ladder["2026-09-22"].paid == null);
  F.apply(f, { kind: "clear", what: "odds" }, "2026-09-22");
  ok("clear removes it", !f.ladder["2026-09-22"]);
  ok("the dub price is read back", F.dubPrice(f, { date: "2026-09-22", price: -114 }) === 120);
  ok("no fill: the published price", F.dubPrice(f, { date: "2026-09-21", price: -114 }) === -114);
}

console.log("fills change the next bet, the same way everywhere");
{
  const bets = [
    { date: "d1", price: -250, status: "won" },
    { date: "d2", price: -250, status: "open" }
  ];
  const plain = M.ladder(bets, { account: 100 });
  const f = { ladder: { d1: { price: -300 } }, dub: {} };
  const filled = M.ladder(F.ladderRows(bets, f), { account: 100 });
  ok("at -250, $10 rides as $14", plain.stake === 14, String(plain.stake));
  ok("at -300 it rides as $13.33", filled.stake === 13.33, String(filled.stake));
  const paid = M.ladder(F.ladderRows(bets, { ladder: { d1: { price: -300, paid: 13.5 } } }), { account: 100 });
  ok("a payout beats the price", paid.stake === 13.5, String(paid.stake));
  const dubs = [{ date: "d1", status: "won", price: -114, legs: [{}, {}] }];
  const a = D.chain(dubs, 100), b = D.chain(dubs, 100, { priceOf: x => F.dubPrice({ dub: { d1: { price: 120 } } }, x) });
  ok("the Dub balance follows the parlay price you got", a.balance === 108.77 && b.balance === 112, `${a.balance} ${b.balance}`);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
