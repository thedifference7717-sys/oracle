// The cross-sport ladder's pure parts: how a Kalshi prop is read, how the one
// bet is chosen, and who gets benched.
//
// Run: node scripts/ladder-sports.test.mjs
import * as S from "./ladder-sports.mjs";

let failures = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
};
const BAND = { lo: -350, hi: -200 };

console.log("reading a prop contract");
{
  ok("24.5 points reads as 25+", S.needText("NBA", "pts", 24.5) === "25+ points");
  ok("249.5 passing yards reads as 250+", S.needText("NFL", "passYds", 249.5) === "250+ passing yards");
  ok("a hit reads as a hit", S.needText("MLB", "hit", 0.5) === "to record a hit");
  ok("name from a title with a colon", S.propPlayer({ title: "Jordan Love: 250+ passing yards" }) === "Jordan Love");
  ok("name from a sub-title when the title has none",
     S.propPlayer({ title: "Points scored", yes_sub_title: "Jalen Brunson: 25+" }) === "Jalen Brunson");
  ok("a half-point strike is taken as given", S.strikeOf({ floor_strike: 24.5 }) === 24.5);
  ok("a whole-number 'or more' strike is moved to the half point",
     S.strikeOf({ floor_strike: 25, strike_type: "greater_or_equal" }) === 24.5);
  const idx = S.indexProps([
    { ticker: "A", title: "Luka Dončić: 30+ points", floor_strike: 29.5, yes_bid_dollars: "0.70", yes_ask_dollars: "0.72",
      occurrence_datetime: "2026-10-22T23:30:00Z" },
    { ticker: "B", title: "Luka Dončić: 30+ points", floor_strike: 29.5, yes_ask_dollars: "0.70",
      occurrence_datetime: "2026-10-25T23:30:00Z" },
    { ticker: "C", title: "Nobody: 5+", floor_strike: 4.5 }                       // no quote: dropped
  ]);
  ok("accents do not split a player", idx.has("luka doncic"));
  ok("a contract with no quote is dropped", !idx.has("nobody"));
  const q = S.quotesFor(idx, "Luka Doncic", "2026-10-22T23:30:00Z");
  ok("his next game's contract is not tonight's", q.length === 1 && q[0].ticker === "A", q.map(x => x.ticker).join(","));
  ok("the ask becomes an American price", q[0].american === -257, String(q[0].american));
}

const RECORDS = { MLB: { n: 144, predicted: 0.743, actual: 0.736 }, NBA: { n: 0 }, NFL: { n: 0 } };

console.log("one bet across three sports");
{
  const c = [
    { sport: "MLB", player: "Hitter",  playerId: 1, p: 0.78, price: -300 },
    { sport: "NBA", player: "Scorer",  playerId: 2, p: 0.80, price: -330 },
    { sport: "NFL", player: "Catcher", playerId: 3, p: 0.72, price: -250 }
  ];
  const r = S.choose(c, RECORDS, { band: BAND });
  ok("the likeliest after each sport's record is picked", r.pick && r.pick.sport === "NBA", r.pick && r.pick.sport);
  ok("every eligible prop is ranked", r.ranked.length === 3, String(r.ranked.length));
  ok("ranked best first", r.ranked[0].pAdj >= r.ranked[1].pAdj && r.ranked[1].pAdj >= r.ranked[2].pAdj);
}

console.log("an untested sport cannot win on its model's say-so");
{
  const c = [
    { sport: "MLB", player: "Hitter", playerId: 1, p: 0.79, price: -300 },
    { sport: "NBA", player: "Hype",   playerId: 2, p: 0.95, price: -250 }
  ];
  const r = S.choose(c, RECORDS, { band: BAND });
  ok("MLB beats a 95% claim priced at -250", r.pick.sport === "MLB", r.pick.sport);
}

console.log("the model has to agree with the price");
{
  const c = [
    { sport: "NFL", player: "Favourite", playerId: 9, p: 0.70, price: -340 },   // market 77%, model 70%
    { sport: "MLB", player: "Hitter",    playerId: 1, p: 0.76, price: -290 }
  ];
  const r = S.choose(c, RECORDS, { band: BAND });
  ok("a prop the model rates below its price is set aside", r.doubted.some(x => x.player === "Favourite"));
  ok("and the next one is taken", r.pick.player === "Hitter", r.pick.player);
  const none = S.choose([c[0]], RECORDS, { band: BAND });
  ok("nothing left is no pick, not a crash", none.pick === null);
}

console.log("the price band still holds");
{
  const r = S.choose([{ sport: "NBA", player: "Lock", playerId: 5, p: 0.97, price: -900 }], RECORDS, { band: BAND });
  ok("-900 is not eligible", r.pick === null && r.rejected.length === 1);
}

console.log("two days running, then a day off — in any sport");
{
  const bets = [
    { date: "2026-10-20", sport: "NBA", playerId: "7", pick: "Big", status: "won" },
    { date: "2026-10-21", sport: "NBA", playerId: "7", pick: "Big", status: "won" }
  ];
  const b = S.benched(bets, 2);
  ok("he is benched", b.has("NBA:7"));
  ok("an MLB player with the same id is not", !b.has("MLB:7"));
  const c = [
    { sport: "NBA", player: "Big",    playerId: "7", p: 0.80, price: -340 },
    { sport: "MLB", player: "Hitter", playerId: 1,   p: 0.76, price: -290 }
  ];
  const r = S.choose(c, RECORDS, { band: BAND, blocked: b });
  ok("the benched man is passed over", r.pick.player === "Hitter" && r.benched[0].player === "Big");
  const mixed = S.benched([bets[0], { date: "2026-10-21", sport: "MLB", playerId: 7, status: "won" }], 2);
  ok("the same id in two sports is two people", mixed.size === 0);
}

console.log("each sport's record");
{
  const rec = S.sportRecords([
    { sport: "NFL", status: "won", p: 0.75 }, { sport: "NFL", status: "lost", p: 0.75 },
    { status: "won", p: 0.7 }, { sport: "NBA", status: "open", p: 0.8 }
  ], { global: { n: 144, hits: 106, sump: 107 } });
  ok("NFL counts its settled rungs", rec.NFL.n === 2 && rec.NFL.actual === 0.5);
  ok("an open rung is not a record", rec.NBA.n === 0);
  ok("MLB uses the larger calibration sample", rec.MLB.n === 144);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
