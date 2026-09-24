// Run: node arb/arb.test.mjs
import { generateKeyPairSync, createVerify, constants } from "node:crypto";
import { kalshiFee, polyFee, planArb, annualised } from "./lib/math.mjs";
import { normaliseBook, signHeaders } from "./lib/kalshi.mjs";
import { orient, kalshiYesWords, matchMarkets, matchGames } from "./lib/match.mjs";
let f = 0;
const ok = (n, c, d) => { if (c) console.log("  ok   " + n); else { f++; console.log("  FAIL " + n + (d ? " — " + d : "")); } };

console.log("fees");
ok("Kalshi 100 @ 0.50 = $1.75", kalshiFee(100, 0.5) === 1.75);
ok("Kalshi rounds up to the cent", kalshiFee(1, 0.5) === 0.02);
ok("Poly 100 @ 0.50, rate 0.07 = $1.75", Math.abs(polyFee(100, 0.5, 0.07) - 1.75) < 1e-9);
ok("Poly 30c == 70c", polyFee(100, 0.3, 0.07) === polyFee(100, 0.7, 0.07));
ok("Poly no fee when rate 0", polyFee(100, 0.5, 0) === 0);

console.log("Kalshi book: bids on one side are asks on the other");
const b = normaliseBook({ orderbook_fp: { no_dollars: [["0.34", "1620"], ["0.36", "607"]], yes_dollars: [["0.62", "1218"]] } });
ok("NO bid 0.36 is a YES ask 0.64", b.yesAsks.some(([p, s]) => p === 0.64 && s === 607));
ok("YES bid 0.62 is a NO ask 0.38", b.noAsks[0][0] === 0.38);
const legacy = normaliseBook({ orderbook: { yes: [[62, 10]], no: [[36, 5]] } });
ok("legacy cents shape", legacy.yesAsks[0][0] === 0.64 && legacy.noAsks[0][0] === 0.38);

console.log("sizing walks both books and stops when the edge goes");
const free = () => 0;
const plan = planArb(
  { asks: [[0.40, 50], [0.45, 100]], fee: free },
  { asks: [[0.50, 30], [0.54, 100]], fee: free },
  { minEdge: 0.02 });
// 30 @ .40+.50=.90, 20 @ .40+.54=.94, then .45+.54=.99 < 2c edge → stop
ok("takes 50 contracts", plan.contracts === 50, JSON.stringify(plan));
ok("profit = 30×.10 + 20×.06 = 4.20", Math.abs(plan.profit - 4.2) < 1e-9);
ok("limit prices are the worst levels taken", plan.limitA === 0.40 && plan.limitB === 0.54);
ok("respects maxContracts", planArb({ asks: [[0.4, 500]], fee: free }, { asks: [[0.5, 500]], fee: free }, { maxContracts: 7 }).contracts === 7);
ok("no arb when asks sum ≥ 1", planArb({ asks: [[0.52, 99]], fee: free }, { asks: [[0.49, 99]], fee: free }) === null);
const kF = (n, p) => kalshiFee(n, p), pF = (n, p) => polyFee(n, p, 0.03);
const thin = planArb({ asks: [[0.48, 100]], fee: kF }, { asks: [[0.49, 100]], fee: pF }, { minEdge: 0 });
ok("3c gross at 50/50 is only ~0.5c after fees", thin && Math.abs(thin.edgePerContract - 0.005) < 1e-4, JSON.stringify(thin));
ok("…so a 1c minimum edge rejects it", planArb({ asks: [[0.48, 100]], fee: kF }, { asks: [[0.49, 100]], fee: pF }, { minEdge: 0.01 }) === null);
ok("fractional depth never gives a fractional contract", planArb({ asks: [[0.4, 2.7]], fee: free }, { asks: [[0.5, 9]], fee: free }).contracts === 2);
ok("annualised: 1% over ~36.5 days ≈ 10.5%", Math.abs(annualised(0.01, Date.now() + 36.5 * 86400000) - 0.1046) < 0.002);

console.log("matching and orientation");
const ev = { title: "ATL Falcons vs NO Saints" };
const m = { ticker: "KXNFLGAME-26OCT05ATLNO-NO", yes_sub_title: "New Orleans", market_type: "binary", yes_ask_dollars: "0.64", no_ask_dollars: "0.38", expected_expiration_time: "2026-10-06T03:15:00Z" };
ok("ticker suffix NO pulls in 'saints'", kalshiYesWords(ev, m).has("saints"));
const pm = { slug: "nfl-atl-no-2026-10-05", question: "Falcons vs. Saints", outcomes: '["Falcons","Saints"]', endDate: "2026-10-06T00:00:00Z", bestAsk: "0.35", bestBid: "0.34", events: [{ title: "Falcons vs. Saints" }] };
ok("Saints is outcome 1", orient(ev, m, pm) === 1);
ok("Yes/No market maps Yes to Kalshi YES", orient(ev, m, { outcomes: '["Yes","No"]' }) === 0);
ok("can't tell → null, never a guess", orient({ title: "X" }, { ticker: "A-B", yes_sub_title: "Over" }, { outcomes: '["Up","Down"]' }) === null);
const c = matchMarkets([{ ...ev, markets: [m] }], [pm], { minScore: 0.2 });
ok("finds the pair", c.length === 1 && c[0].pair.polyOutcomeSameAsKalshiYes === "Saints", JSON.stringify(c[0]?.pair));
// Kalshi YES Saints .64 + Poly Falcons .35 = .99 → 1c ; Kalshi NO .38 + Poly Saints (1-.34=.66) = 1.04
ok("gross edge 1c on the right route", c[0].grossEdge === 0.01 && /Kalshi YES/.test(c[0].route), c[0].route);
ok("candidates are never pre-verified", c[0].pair.verified === false);
ok("dates too far apart don't match", matchMarkets([{ ...ev, markets: [m] }], [{ ...pm, endDate: "2026-12-01T00:00:00Z" }], { minScore: 0.2 }).length === 0);

console.log("games match on team codes, not names");
const gev = { title: "Atlanta vs Green Bay", sub_title: "ATL vs GB (Sep 24)", series_ticker: "KXNFLGAME" };
const gm = { ticker: "KXNFLGAME-26SEP24ATLGB-GB", yes_sub_title: "Green Bay", yes_ask_dollars: "0.70", no_ask_dollars: "0.31", occurrence_datetime: "2026-09-25T00:15:00Z" };
const gpm = { slug: "nfl-atl-gb-2026-09-25", question: "Falcons vs. Packers", outcomes: '["Falcons","Packers"]', bestAsk: "0.27", bestBid: "0.26" };
const gc = matchGames([{ ...gev, markets: [gm] }], [gpm, { ...gpm, slug: "nfl-atl-gb-2026-09-25-total-42pt5", outcomes: '["Over","Under"]' }]);
ok("one match, the winner market only", gc.length === 1 && gc[0].poly.slug === "nfl-atl-gb-2026-09-25");
ok("Kalshi GB YES == Poly Packers", gc[0].pair.polyOutcomeSameAsKalshiYes === "Packers");
// YES GB .70 + Falcons .27 = .97 → 3c
ok("edge on YES GB + Falcons", gc[0].grossEdge === 0.03 && /Falcons/.test(gc[0].route), gc[0].route);
ok("other week's game doesn't match", matchGames([{ ...gev, markets: [gm] }], [{ ...gpm, slug: "nfl-atl-gb-2026-12-20" }]).length === 0);

console.log("Kalshi request signing");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const h = signHeaders("post", "/trade-api/v2/portfolio/orders?x=1", { id: "kid", pem }, "1700000000000");
const v = createVerify("RSA-SHA256"); v.update("1700000000000POST/trade-api/v2/portfolio/orders");
ok("RSA-PSS signature over ts+METHOD+path (no query)", v.verify({ key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, h["KALSHI-ACCESS-SIGNATURE"], "base64"));
ok("headers carry key id and timestamp", h["KALSHI-ACCESS-KEY"] === "kid" && h["KALSHI-ACCESS-TIMESTAMP"] === "1700000000000");

console.log(f ? `\n${f} FAILED` : "\nall passed");
process.exit(f ? 1 : 0);
