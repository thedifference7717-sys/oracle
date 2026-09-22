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

console.log("a man listed out is not a probability, he is a veto");
{
  const hurt = { sport: "NBA", player: "Sidelined", market: "pts", p: 0.95, price: -340, status: "Out" };
  const r = S.select([hurt, mlb], RECORDS);
  ok("he is not picked", r.pick.sport === "MLB", r.pick && r.pick.sport);
  ok("and the reason is named", r.rejected.some(x => x.reason.includes("out")), JSON.stringify(r.rejected));
}

console.log("questionable does not veto, it costs trust");
{
  const q  = { sport: "MLB", player: "Q", market: "hit", p: 0.90, price: -300, status: "Questionable" };
  const ok_ = { sport: "MLB", player: "Fit", market: "hit", p: 0.90, price: -300 };
  const a = S.select([q], RECORDS).all[0], b = S.select([ok_], RECORDS).all[0];
  ok("the questionable man is trusted less", a.trust < b.trust, `${a.trust.toFixed(3)} vs ${b.trust.toFixed(3)}`);
  ok("so his number sits closer to the market", Math.abs(a.pAdj - a.implied) < Math.abs(b.pAdj - b.implied));
  ok("but he is still eligible", S.select([q], RECORDS).pick !== null);
}

console.log("form and matchup break ties, they do not rescore p");
{
  const cold = { sport: "MLB", player: "Cold", market: "hit", p: 0.78, price: -300, formEdge: -0.20, oppWeakness: -0.15 };
  const hotp = { sport: "MLB", player: "Hot",  market: "hit", p: 0.775, price: -300, formEdge:  0.20, oppWeakness:  0.15 };
  const r = S.select([cold, hotp], RECORDS);
  ok("the in-form man wins a near-tie", r.pick.player === "Hot", r.pick.player);
  const c = r.all.find(x => x.player === "Cold"), h = r.all.find(x => x.player === "Hot");
  ok("even though his raw p is lower", hotp.p < cold.p);
  ok("and p itself was not altered by form", Math.abs(h.pOwn - (0.775 + h.bias)) < 1e-9);
}

console.log("a real gap in probability still beats context");
{
  const cold = { sport: "MLB", player: "Cold", market: "hit", p: 0.84, price: -300, formEdge: -0.3, oppWeakness: -0.3 };
  const hotp = { sport: "MLB", player: "Hot",  market: "hit", p: 0.74, price: -300, formEdge:  0.3, oppWeakness:  0.3 };
  ok("10 points of probability is not a tie", S.select([cold, hotp], RECORDS).pick.player === "Cold");
}

console.log("thin evidence is not treated as form");
{
  const rookie = { sport: "MLB", player: "Debut", market: "hit", p: 0.88, price: -300, recentGames: 1 };
  const r = S.select([rookie, mlb], RECORDS);
  ok("one recent game is vetoed", r.pick.player !== "Debut", r.pick && r.pick.player);
  ok("named as such", r.rejected.some(x => x.reason.includes("thinRecent")));
}

console.log("every pick can be argued with");
{
  const c = { sport: "MLB", player: "A", market: "hit", p: 0.78, price: -300,
              formEdge: 0.12, oppWeakness: 0.08, recentGames: 14, status: "Active" };
  const w = S.select([c], RECORDS).pick.why.join(" | ");
  ok("it says how he has been going", /in form/.test(w), w);
  ok("it says how the matchup looks", /matchup/.test(w));
  ok("it says how much recent evidence there is", /recent games/.test(w));
  ok("it compares model to market", /market .*model/.test(w));
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
