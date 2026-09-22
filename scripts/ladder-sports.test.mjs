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


console.log("the Dub: best pair, two games, never the ladder's bet");
{
  const pool = [
    { sport: "MLB", player: "Ladder Man", playerId: 1, eventId: "g1", p: 0.8, pAdj: 0.78, price: -340 },
    { sport: "MLB", player: "Same Game",  playerId: 2, eventId: "g2", p: 0.78, pAdj: 0.76, price: -320 },
    { sport: "MLB", player: "Teammate",   playerId: 3, eventId: "g2", p: 0.77, pAdj: 0.75, price: -300 },
    { sport: "NFL", player: "Receiver",   playerId: 9, eventId: "n1", p: 0.74, pAdj: 0.72, price: -260 }
  ];
  const d = S.pickDub(pool, { sport: "MLB", playerId: 1, pick: "Ladder Man" });
  ok("the ladder's man is left out", d && !d.legs.some(l => l.player === "Ladder Man"));
  ok("the two legs come from different games", d.legs[0].eventId !== d.legs[1].eventId);
  ok("it pairs the best leg with the best from another game", d.legs.map(l => l.player).join("+") === "Same Game+Receiver", d.legs.map(l => l.player).join("+"));
  ok("joint chance is the product", Math.abs(d.prob - 0.76 * 0.72) < 1e-4, String(d.prob));
  const dd = (1 + 100 / 320) * (1 + 100 / 260);
  ok("parlay price multiplies the legs", d.price === -Math.round(100 / (dd - 1)), String(d.price));
  ok("with no ladder pick the top leg is used", S.pickDub(pool, null).legs[0].player === "Ladder Man");
  ok("one game only is no Dub", S.pickDub(pool.slice(1, 3), null) === null);
}

console.log("the Robin: six likeliest, one per game where possible");
{
  const pool = Array.from({ length: 9 }, (_, i) => ({ sport: "MLB", player: "P" + i, playerId: i, eventId: "g" + Math.floor(i / 2),
    p: 0.8 - i * 0.01, pAdj: 0.78 - i * 0.01, price: -300 + i * 10 }));
  const r = S.pickRobin(pool, 6);
  ok("six legs", r.legs.length === 6, String(r.legs.length));
  ok("five games give five, then it fills", new Set(r.legs.slice(0, 5).map(l => l.eventId)).size === 5);
  ok("sizes 2 through 6", r.sizes.map(z => z.m).join(",") === "2,3,4,5,6");
  ok("by 2s is fifteen tickets", r.sizes[0].tickets === 15);
  ok("by 6s is one ticket", r.sizes[4].tickets === 1);
}

console.log("grading");
{
  const L = rs => ({ legs: rs.map((x, i) => ({ result: x, price: -300, player: "L" + i })) });
  ok("both won is won", S.gradeDub(L(["won", "won"])) === "won");
  ok("one lost is lost, even with the other open", S.gradeDub(L(["lost", null])) === "lost");
  ok("one open is still open", S.gradeDub(L(["won", null])) === null);
  ok("a void leg drops out", S.gradeDub(L(["won", "void"])) === "won");
  const g = S.gradeRobin(L(["won", "won", "won", "lost"]));
  ok("robin counts hits", g.hit === 3 && g.of === 4);
  ok("by 2s: three of six tickets cash", g.sizes[0].cashed === 3 && g.sizes[0].tickets === 6);
  ok("by 4s: the lost leg kills the only ticket", g.sizes[2].cashed === 0);
  ok("a robin with an open leg is not graded", S.gradeRobin(L(["won", null, "won"])) === null);
}


console.log("the Dub and Robin pool keeps out what the model doubts");
{
  const c = [
    { sport: "MLB", player: "Doubtful Starter", playerId: 1, eventId: "a", p: 0.46, price: -245 },
    { sport: "MLB", player: "Close Call",       playerId: 2, eventId: "b", p: 0.69, price: -245 },
    { sport: "MLB", player: "Agreed",           playerId: 3, eventId: "c", p: 0.74, price: -245 }
  ];
  const r = S.choose(c, RECORDS, { band: BAND });
  ok("a 46% model number at a 71% price is out", !r.pool.some(x => x.player === "Doubtful Starter"));
  ok("within three points is in", r.pool.some(x => x.player === "Close Call"));
  ok("agreement is in", r.pool.some(x => x.player === "Agreed"));
}


console.log("a one-sided quote is not a market");
{
  const board = { candidates: [
    { name: "No Bid", id: 1, p: 0.75, gk: 9, teamName: "A", oppName: "B", isHome: true, slot: 2, posted: true },
    { name: "Wide",   id: 2, p: 0.75, gk: 9, teamName: "A", oppName: "B", isHome: true, slot: 3, posted: true },
    { name: "Real",   id: 3, p: 0.75, gk: 9, teamName: "A", oppName: "B", isHome: true, slot: 4, posted: true } ] };
  const q = { "No Bid": { bid: 0, ask: 0.7, spread: 0.7 }, "Wide": { bid: 0.55, ask: 0.72, spread: 0.17 }, "Real": { bid: 0.71, ask: 0.72, spread: 0.01 } };
  const r = S.mlbCandidates(board, [{ gamePk: 9, gameDate: "2026-09-22T23:00:00Z" }],
    c => Object.assign({ american: -250, source: "kalshi" }, q[c.name]));
  ok("only the two-sided, tight quote survives", r.candidates.map(c => c.player).join() === "Real", r.candidates.map(c => c.player).join());
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
