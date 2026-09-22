// The cross-sport selector, and specifically the thing it exists to prevent:
// an untested model talking its way onto the ladder.
//
// Run: node scripts/ladder-select.test.mjs

import S from "../ladder-select.js";

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};

// MLB has a record. NBA has none. Exactly today's situation.
const RECORDS = {
  MLB: { n: 144, predicted: 0.743, actual: 0.736 },
  NBA: { n: 0 },
  NFL: { n: 0 }
};

const mlb = { sport: "MLB", player: "A Hitter",  market: "hit", p: 0.78, price: -300 };
const nba = { sport: "NBA", player: "A Scorer",  market: "pts", p: 0.86, price: -300 };

console.log("an unproven model cannot outrank a proven one on its own say-so");
{
  const r = S.select([mlb, nba], RECORDS);
  ok("NBA claims the higher raw probability", nba.p > mlb.p);
  ok("but MLB is picked", r.pick.sport === "MLB", r.pick.sport);
  const n = r.all.find(x => x.sport === "NBA");
  ok("NBA's number is pulled to the market", Math.abs(n.pAdj - n.implied) < 1e-9,
     `pAdj ${n.pAdj.toFixed(3)} vs implied ${n.implied.toFixed(3)}`);
  ok("NBA gets zero trust at zero legs", n.trust === 0);
}

console.log("but it can still win when the PRICE says it is likeliest");
{
  const shortNba = Object.assign({}, nba, { price: -340 });
  const r = S.select([mlb, shortNba], RECORDS);
  ok("shorter-priced NBA wins", r.pick.sport === "NBA", r.pick.sport);
}

console.log("a model that runs hot is marked down by exactly how hot");
{
  const hot = { MLB: { n: 144, predicted: 0.80, actual: 0.70 } };
  const a = S.adjusted({ sport: "MLB", p: 0.78, price: -300 }, hot.MLB);
  ok("bias is actual minus predicted", Math.abs(a.bias - (-0.10)) < 1e-9, String(a.bias));
  ok("its own number drops by that much", Math.abs(a.own - 0.68) < 1e-9, String(a.own));
}

console.log("the price band is enforced");
{
  ok("-275 is in",  S.inBand(-275));
  ok("-350 is in",  S.inBand(-350));
  ok("-200 is in",  S.inBand(-200));
  ok("-400 is out", !S.inBand(-400));
  ok("-150 is out", !S.inBand(-150));
  ok("+120 is out", !S.inBand(120));
  const r = S.select([{ sport: "MLB", p: 0.95, price: -900 }, mlb], RECORDS);
  ok("a -900 lock is not eligible however likely", r.pick.price === -300, String(r.pick.price));
}

console.log("an unpriced candidate is treated as typical, not as good");
{
  const a = S.adjusted({ sport: "NBA", p: 0.93 }, RECORDS.NBA);
  ok("it falls back to the band's middle", Math.abs(a.p - S.NO_PRICE_PRIOR) < 1e-9, String(a.p));
  ok("and is flagged unpriced", a.priced === false);
}

console.log("trust is earned gradually, not switched on");
{
  ok("0 legs  -> 0.00", Math.abs(S.trust(0) - 0) < 1e-9);
  ok("200 legs -> 0.50", Math.abs(S.trust(200) - 0.5) < 1e-9);
  ok("600 legs -> 0.75", Math.abs(S.trust(600) - 0.75) < 1e-9);
}

console.log("nothing eligible is a real answer, not a crash");
{
  const r = S.select([{ sport: "MLB", p: 0.9, price: -900 }], RECORDS);
  ok("pick is null", r.pick === null);
  ok("and the rejected candidate is still reported", r.all.length === 1);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
