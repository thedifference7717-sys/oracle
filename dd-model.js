// ─────────────────────────────────────────────────────────────────────────────
// DAIly Double — shared hit-probability engine (BUILD 3)
//
// One file, two consumers: the browser dashboard loads it as a classic script
// (window.DDModel) and scripts/parlaiy-alerts.mjs imports it as a CJS default.
// Keeping the whole pipeline here means the board on screen and the board in
// Telegram can never drift apart.
//
// What changed from BUILD 2, and why:
//
//  1. LOG5, NOT A LINEAR BLEND. `0.6*batterAVG + 0.4*pitcherBAA` is not a
//     matchup — it drags everyone toward the middle and breaks at the tails.
//     Log5 (Bill James' odds-ratio) is the correct combination of a batter
//     rate, a pitcher rate and the league rate.
//
//  2. K RATE AND CONTACT ARE MODELLED SEPARATELY. A hit needs the batter to
//     not strike out AND to find grass. Those two skills have wildly different
//     reliability: strikeout rate is real after ~60 AB, hit-on-contact needs
//     ~800 balls in play, and a pitcher barely controls it at all. Splitting
//     them lets us trust the trustworthy half. Raw BAA — which BUILD 2 gave a
//     40% weight — is mostly noise and defense.
//
//  3. EVERY INPUT IS SHRUNK toward league average by its own stabilisation
//     point. No more treating a .450 fortnight on 20 AB as a .450 hitter.
//
//  4. AT-BATS ARE MODELLED, NOT ASSUMED. The single biggest miss in BUILD 2.
//     Expected team plate appearances come from an OBP-driven inning model;
//     a hitter's share falls out of his lineup slot. A leadoff man gets ~4.65
//     PA, the 9-hole ~3.78 — that is a ~7-point swing in hit probability, far
//     larger than any park factor. Walks are then subtracted per-hitter, so a
//     high-OBP grinder correctly gets fewer swings at a hit.
//
//  5. THE BULLPEN EXISTS. A batter faces the starter maybe 2-3 times of 4.
//     We compute P(starter still in) for each plate appearance from his
//     batters-faced-per-start, apply a third-time-through bonus, and hand the
//     rest of the plate appearances to the opponent's actual relief corps.
//
//  6. PAIRS ARE CORRELATED. Two hitters in one game are not independent
//     events, so P1 x P2 is the wrong number. A Gaussian copula lifts it. For
//     teammates (shared pitcher, shared innings) the lift is real money: the
//     true price of a same-game double is better than the naive product, and
//     books that grade legs independently are handing that edge over.
//
//  7. SCRATCH RISK IS PRICED. If the lineup is not posted, a "regular" is not
//     a certainty — and a scratch is a guaranteed loss, not a coin flip.
//
//  8. THE HARD FILTERS ARE GONE. The .270 / 200-AB / tough-SP gates were doing
//     the ranking's job badly. With a real model the probability sorts itself,
//     and the board is free to move day to day.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DDModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const VERSION = 3;
const API = "https://statsapi.mlb.com/api/v1";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── math ────────────────────────────────────────────────────────────────────
// Abramowitz & Stegun 7.1.26 — plenty accurate for a probability model.
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
const normPdf = z => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
// Acklam's inverse normal CDF.
function normInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -6 : 6;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > ph) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
const logit = p => Math.log(clamp(p, 1e-6, 1 - 1e-6) / (1 - clamp(p, 1e-6, 1 - 1e-6)));
const expit = z => 1 / (1 + Math.exp(-z));

// Odds-ratio ("log5") combination of a batter rate, a pitcher rate and the
// league rate. This is the right way to answer "what happens when THIS hitter
// meets THIS pitcher", and it degrades gracefully at the tails.
function log5(bat, pit, lg) {
  if (!(lg > 0 && lg < 1)) return bat;
  const b = clamp(bat, 1e-4, 1 - 1e-4), p = clamp(pit, 1e-4, 1 - 1e-4), l = clamp(lg, 1e-4, 1 - 1e-4);
  const num = (b * p) / l, den = num + ((1 - b) * (1 - p)) / (1 - l);
  return den > 0 ? clamp(num / den, 1e-4, 1 - 1e-4) : bat;
}
// Empirical-Bayes shrink: pull an observed rate toward the league mean with a
// prior worth `k` trials. k IS the statistic's stabilisation point.
const shrink = (succ, trials, lg, k) => (succ + lg * k) / ((trials || 0) + k);

// Stabilisation points (in trials), from the standard reliability work.
const K = {
  batK:      70,    // strikeout rate settles fast
  batHR:     350,   // the long ball on contact — a real, separable skill
  batBabip:  550,   // where everything else lands, slower still
  batBB:     110,
  pitK:      90,
  pitHR:     450,   // pitchers DO own the long ball
  pitBabip:  1400,  // ...and almost nothing about the rest — regress to league
  pitBB:     150,
  pitOBP:    350,   // on-base allowed, for the run-environment model
  teamOBP:   900,
  teamDef:   1600,
  spBF:      8,     // starts, for batters-faced-per-start
  relief:    400,
  teamBat:   400    // team-aggregate rates, for the spot score
};

// ── ballpark ────────────────────────────────────────────────────────────────
// HITS factors (100 = neutral). These move balls in play, not strikeouts, so
// they are applied to the contact term only.
const PARK = {"Coors Field":112,"Fenway Park":107,"Great American Ball Park":102,"Globe Life Field":101,"Chase Field":103,"Wrigley Field":101,"Yankee Stadium":101,"Citizens Bank Park":101,"Oriole Park at Camden Yards":100,"Rogers Centre":101,"American Family Field":100,"Truist Park":100,"Kauffman Stadium":103,"Daikin Park":100,"Minute Maid Park":100,"Nationals Park":100,"Dodger Stadium":99,"Angel Stadium":100,"Busch Stadium":99,"Target Field":99,"Progressive Field":99,"Rate Field":100,"PNC Park":100,"Comerica Park":101,"Citi Field":98,"Petco Park":97,"loanDepot park":98,"T-Mobile Park":96,"Oracle Park":98,"Sutter Health Park":101,"George M. Steinbrenner Field":100};
// HOME RUN factors are a different table entirely — Fenway suppresses homers
// while inflating hits, Oracle Park is death to both, Great American inflates
// homers far more than singles.
const PARK_HR = {"Coors Field":112,"Great American Ball Park":113,"Yankee Stadium":110,"Citizens Bank Park":108,"Globe Life Field":104,"Oriole Park at Camden Yards":101,"Fenway Park":99,"Dodger Stadium":103,"Wrigley Field":101,"Truist Park":102,"Chase Field":103,"Daikin Park":101,"Minute Maid Park":101,"Rogers Centre":103,"American Family Field":105,"Nationals Park":101,"Citi Field":96,"Petco Park":96,"Oracle Park":90,"T-Mobile Park":93,"loanDepot park":95,"Comerica Park":94,"Kauffman Stadium":95,"Angel Stadium":102,"Busch Stadium":96,"PNC Park":94,"Target Field":99,"Progressive Field":98,"Rate Field":103,"Sutter Health Park":100,"George M. Steinbrenner Field":102};
function lookup(tbl, n) {
  if (!n) return 100;
  if (tbl[n] != null) return tbl[n];
  const k = Object.keys(tbl).find(k => n.includes(k) || k.includes(n));
  return k ? tbl[k] : 100;
}
const park = n => lookup(PARK, n);
const parkHr = n => lookup(PARK_HR, n);

// ── tuning constants ────────────────────────────────────────────────────────
const CFG = {
  // League platoon splits. Individual platoon skill needs 1000+ PA to separate
  // from the league gap, so applying the league delta to everyone is not a
  // shortcut — it is the better estimate for all but a handful of hitters.
  platoon: { advK: 0.93, advC: 1.025, advHr: 1.09, disK: 1.08, disC: 0.975, disHr: 0.92, switchDamp: 0.6 },
  // Third time through the order. Multiplier on the starter's hit rate only.
  tto: [0.96, 1.00, 1.06, 1.10],
  teamPaSd: 4.2,          // sd of a team's plate appearances in a game
  spBfSd: 5.5,            // sd of a starter's batters faced
  spBfMean: 23.5,         // league mean batters faced per start
  homePaAdj: 0.985,       // home side skips the 9th when it leads
  awayPaAdj: 1.010,
  parkContactDamp: 0.80,  // how much of the hits index reaches balls in play
  parkHrDamp: 0.90,       // ... of the homer index reaches the long ball
  parkPaDamp: 0.35,       // ... and of the hits index reaches the run environment
  scratchPosted: 0.985,   // posted in the lineup, but late scratches happen
  scratchMax: 0.95,       // ceiling when the lineup is NOT posted yet
  rhoTeammate: 0.09,      // same lineup: shared pitcher, park, weather, innings
  rhoOpponent: 0.03,      // opposite dugouts: shared park, weather, umpire only
  // Correlation is not a constant. Teammates hitting a soft spot rise and fall
  // together harder than teammates facing an ace: a bad starter's blow-up
  // inning hands several of them an extra turn at once, and the chance he is
  // chased early is itself a shared event. Scaled off the spot score, +/-10
  // points of environment moves rho by this much, bounded either side.
  rhoEnvGain: 0.60,
  recencyWeight: 1.0,     // last-30-day counts get this much EXTRA weight
  calPlayerK: 50,         // shrinkage on a player's own logged residual
  calGlobalK: 400,
  calMaxShift: 0.5        // cap any calibration nudge at ±0.5 logit
};

// League fallbacks, only used if the aggregate feeds come back thin.
const LG_FALLBACK = { avg: 0.244, kPerAb: 0.253, contact: 0.327, hrPerContact: 0.044, babip: 0.292, bbPerPa: 0.083, obp: 0.313, abPerPa: 0.884 };

// ── probability a hitter records at least one hit ────────────────────────────
//
// Walks through the game one plate appearance at a time. Each PA k carries:
//   q_k = P(he even gets a k-th PA)         — from the team's inning model
//   w_k = P(the starter is still out there) — from batters-faced-per-start
// and its own hit probability against whichever arm he is likely to see.
//
// Returns the full trace so the UI can show WHY, not just a number.
function hitProbability(bat, opp, ctx) {
  const lg = ctx.lg;

  // Expected plate appearances for this lineup slot. A team's k-th time
  // through means team PA number slot + 9(k-1), so the chance he bats a k-th
  // time is just P(the team gets that many PA).
  const mu = ctx.teamPaMu, sd = CFG.teamPaSd;
  const paChance = k => 1 - normCdf((bat.slot + 9 * (k - 1) - 0.5 - mu) / sd);
  // Same idea for the starter: he is still pitching if he has not yet faced
  // that many batters.
  const spChance = k => 1 - normCdf((bat.slot + 9 * (k - 1) - 0.5 - opp.spBf) / CFG.spBfSd);

  // Three ways to reach: don't strike out, then either clear the fence or find
  // grass. Splitting the last two matters for judging a BAD PITCHER. A pitcher
  // owns his home-run rate and has almost no say over where the other balls
  // land, so lumping them together (as a single hits-allowed number does)
  // buries the half that is real under the half that is noise.
  const hitRate = (pit, ttoMult, plt) => {
    let kr = log5(bat.kRate, pit.kRate, lg.kPerAb);
    let hr = log5(bat.hrRate, pit.hrRate, lg.hrPerContact);
    let bip = log5(bat.babip, pit.babip, lg.babip);
    // Platoon. The gap is widest on the long ball. Switch hitters always get
    // the good side, but a damped version of it.
    const damp = bat.hand === "S" ? CFG.platoon.switchDamp : 1;
    if (plt === "adv") {
      kr *= 1 - (1 - CFG.platoon.advK) * damp;
      hr *= 1 + (CFG.platoon.advHr - 1) * damp;
      bip *= 1 + (CFG.platoon.advC - 1) * damp;
    } else if (plt === "dis") {
      kr *= 1 + (CFG.platoon.disK - 1) * damp;
      hr *= 1 - (1 - CFG.platoon.disHr) * damp;
      bip *= 1 - (1 - CFG.platoon.disC) * damp;
    }
    hr *= ctx.parkHr;                       // homer parks, not hits parks
    bip *= ctx.parkContact * opp.defence;   // nobody has ever fielded a homer
    hr *= ttoMult; bip *= ttoMult;          // familiarity, third time around
    hr = clamp(hr, 0.004, 0.16); bip = clamp(bip, 0.15, 0.50);
    return clamp((1 - clamp(kr, 0.02, 0.60)) * (hr + (1 - hr) * bip), 0.05, 0.55);
  };

  let noHit = 1, ePa = 0, eAb = 0, eHit = 0;
  const trace = [];
  for (let k = 1; k <= 6; k++) {
    const q = paChance(k);
    if (q < 0.005) break;
    const w = clamp(spChance(k), 0, 1);
    const tto = CFG.tto[Math.min(k, CFG.tto.length) - 1];
    const pSp = hitRate(opp.sp, tto, opp.plt);
    const pPen = hitRate(opp.pen, 1, null);   // a mixed pen has no platoon edge
    const perAb = w * pSp + (1 - w) * pPen;
    const perPa = perAb * bat.abPerPa;   // a walk is not a hit
    noHit *= 1 - q * perPa;
    ePa += q; eAb += q * bat.abPerPa; eHit += q * perPa;
    trace.push({ pa: k, q: +q.toFixed(3), vsSp: +w.toFixed(3), p: +perPa.toFixed(4) });
  }
  const raw = 1 - noHit;
  return { p: clamp(raw * bat.startProb, 0.01, 0.98), pIfStarts: raw, ePa, eAb, eHit, trace };
}

// ── correlated pair probability ─────────────────────────────────────────────
// Gaussian copula. For the small correlations in play here a second-order
// expansion of the bivariate normal is accurate to well under a tenth of a
// point, and needs no numerical integration.
//
// This is the piece that makes a same-game double worth playing: the naive
// product understates a teammate pair by roughly 2 points of probability, so
// anything priced off independent legs is priced too long.
function jointProb(p1, p2, rho) {
  if (!rho) return p1 * p2;
  const z1 = normInv(p1), z2 = normInv(p2), d = normPdf(z1) * normPdf(z2);
  return clamp(p1 * p2 + rho * d * (1 + (rho * z1 * z2) / 2), Math.max(0, p1 + p2 - 1), Math.min(p1, p2));
}
// Correlation scales with how soft the spot is. Two teammates hitting a
// batting-practice arm rise and fall together harder than two facing an ace:
// the blow-up inning that hands one an extra turn hands the other one too, and
// "he gets chased in the third" is a single shared event for the whole lineup.
// The gain is a judgement call, not a measured coefficient — it is bounded to
// half and double the base so it can shade a number without inventing one.
function rhoFor(a, b) {
  const base = a.teamId === b.teamId ? CFG.rhoTeammate : CFG.rhoOpponent;
  const d = ((a.spotDelta || 0) + (b.spotDelta || 0)) / 2;
  return clamp(base * (1 + CFG.rhoEnvGain * (d / 0.10)), base * 0.5, base * 2);
}

// ── round robin over independent legs ───────────────────────────────────────
// A round robin takes n legs and bets every m-sized combination of them. When
// the legs sit in DIFFERENT games they share no pitcher, park or innings, so
// unlike a same-game double they are near enough independent — which makes the
// whole thing exactly solvable rather than something to simulate.
//
// The elementary symmetric polynomial e_m of the leg probabilities IS the
// expected number of winning m-leg tickets: every m-subset contributes the
// product of its legs, which is precisely that ticket's chance of cashing.
// Computing it by expanding prod(1 + p_i*x) costs n*m instead of enumerating
// C(n,m) tickets.
function esp(ps) {
  let e = [1];
  for (const p of ps) {
    const next = new Array(e.length + 1).fill(0);
    for (let k = 0; k < e.length; k++) { next[k] += e[k]; next[k + 1] += e[k] * p; }
    e = next;
  }
  return e;                       // e[m] = expected winning m-leg tickets
}

// How many of the n legs actually land, as a full distribution. Same DP shape,
// but carrying "exactly k hits" rather than subset products (Poisson-binomial:
// the legs have different probabilities, so this is not a binomial).
function hitCountDist(ps) {
  let d = [1];
  for (const p of ps) {
    const next = new Array(d.length + 1).fill(0);
    for (let k = 0; k < d.length; k++) { next[k] += d[k] * (1 - p); next[k + 1] += d[k] * p; }
    d = next;
  }
  return d;                       // d[k] = P(exactly k of the legs hit)
}

const nCr = (n, m) => { let r = 1; for (let i = 0; i < m; i++) r = r * (n - i) / (i + 1); return Math.round(r); };

// Price a round robin at an assumed per-leg price. Every m-leg ticket pays the
// leg's decimal odds compounded m times, so expected return is that payout
// times e_m, against C(n,m) tickets staked.
function roundRobin(ps, legAmerican, sizes) {
  const n = ps.length, e = esp(ps), dist = hitCountDist(ps);
  const decLeg = decFromAmerican(legAmerican);
  const rows = (sizes || [2, 3, 4]).filter(m => m >= 2 && m <= n).map(m => {
    const tickets = nCr(n, m), expWin = e[m] || 0;
    const payout = decLeg ? Math.pow(decLeg, m) : null;          // decimal, per unit staked
    const ev = payout != null ? (payout * expWin) / tickets - 1 : null;
    // The per-leg price at which this round robin breaks even.
    const beDec = expWin > 0 ? Math.pow(tickets / expWin, 1 / m) : null;
    return { m, tickets, expWin, hitRate: expWin / tickets, payout, ev,
             breakevenLeg: beDec ? (beDec >= 2 ? "+" + Math.round((beDec - 1) * 100) : "-" + Math.round(100 / (beDec - 1))) : "—" };
  });
  return { n, dist, atLeast: dist.map((_, k) => dist.slice(k).reduce((a, b) => a + b, 0)),
           expHits: ps.reduce((a, b) => a + b, 0), allHit: ps.reduce((a, b) => a * b, 1), rows };
}

// ── prices, EV, staking ─────────────────────────────────────────────────────
function amOdds(p) { if (!(p > 0 && p < 1)) return "—"; const d = 1 / p; return d >= 2 ? "+" + Math.round((d - 1) * 100) : "-" + Math.round(100 / (d - 1)); }
function decFromAmerican(a) { a = +a; if (!a) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
// EV per unit staked, plus Kelly. Quarter-Kelly is the number to actually bet:
// full Kelly on a model this uncertain is a good way to go broke while right.
function evaluate(p, american) {
  const dec = decFromAmerican(american);
  if (!dec) return null;
  const b = dec - 1;
  const ev = p * b - (1 - p);
  const kelly = b > 0 ? (p * dec - 1) / b : 0;
  return { dec, ev, evPct: ev * 100, kelly, quarterKelly: Math.max(0, kelly / 4), breakeven: 1 / dec, edge: p - 1 / dec };
}

// ── calibration: the payoff of it being the same faces every day ────────────
// Because the eligible pool barely turns over, a per-player residual is worth
// having. `log` accumulates, per player, how many spots he has been graded in,
// how many he cashed, and what we predicted. The correction is shrunk hard —
// 50 games of prior — so one hot week cannot hijack the model, but a hitter
// who genuinely beats his projection all season eventually gets credit.
function calibrate(p, playerId, cal) {
  if (!cal) return p;
  let z = logit(p);
  if (cal.global && cal.global.n > 0) {
    const g = cal.global, mean = g.sump / g.n;
    const obs = (g.hits + mean * CFG.calGlobalK) / (g.n + CFG.calGlobalK);
    z += clamp(logit(obs) - logit(mean), -CFG.calMaxShift, CFG.calMaxShift);
  }
  const rec = cal.legs && cal.legs[playerId];
  if (rec && rec.n >= 8) {
    const mean = rec.sump / rec.n;
    const obs = (rec.hits + mean * CFG.calPlayerK) / (rec.n + CFG.calPlayerK);
    z += clamp(logit(obs) - logit(mean), -CFG.calMaxShift, CFG.calMaxShift);
  }
  return clamp(expit(z), 0.01, 0.98);
}
// Fold one graded leg back into the log. Called by the alerter at settlement.
function record(cal, playerId, predicted, gotHit) {
  cal = cal || {};
  cal.legs = cal.legs || {}; cal.global = cal.global || { n: 0, hits: 0, sump: 0 };
  const r = cal.legs[playerId] = cal.legs[playerId] || { n: 0, hits: 0, sump: 0 };
  r.n++; r.sump += predicted; if (gotHit) r.hits++;
  cal.global.n++; cal.global.sump += predicted; if (gotHit) cal.global.hits++;
  cal.v = VERSION; cal.updated = new Date().toISOString();
  return cal;
}

// ── data plumbing ───────────────────────────────────────────────────────────
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
function etNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); }
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// The baseball day rolls over at 6am Eastern, not local midnight.
function slateYmd() { const d = etNow(); d.setHours(d.getHours() - 6); return ymd(d); }
const platoon = (bat, pit) => (!bat || !pit) ? null : (bat === "S" ? "adv" : (bat !== pit ? "adv" : "dis"));

async function pool(items, fn, size, onTick) {
  const out = new Array(items.length); let i = 0, done = 0;
  const w = async () => { while (i < items.length) { const j = i++; try { out[j] = await fn(items[j]); } catch (e) { out[j] = null; } done++; onTick && onTick(done, items.length); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length || 1) }, w));
  return out;
}

// ── the board ───────────────────────────────────────────────────────────────
async function buildBoard(o) {
  const getJSON = o.getJSON, day = o.day || slateYmd(), cal = o.cal || null;
  const say = o.onStatus || function () {}, prog = o.onProgress || function () {};
  const season = +day.slice(0, 4);
  const rEnd = etNow(); rEnd.setDate(rEnd.getDate() - 1);
  const rStart = etNow(); rStart.setDate(rStart.getDate() - 30);

  say("Schedule + posted lineups…"); prog(6);
  const sched = o.schedule || await getJSON(`${API}/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team,venue,lineups`);
  const games = (sched && sched.dates && sched.dates[0] ? sched.dates[0].games : []).filter(g => !/postpon|suspend|cancel/i.test((g.status && g.status.detailedState) || ""));
  if (!games.length) return { date: day, games: [], candidates: [], pairs: [], note: "no games" };

  say("League hitting, pitching and last-30 form…"); prog(20);
  // Only the season hitting feed is load-bearing. The other two are large
  // payloads travelling through public CORS proxies, and putting all three in
  // one Promise.all means a single hiccup takes down the whole board — a page
  // that shows nothing is worse than one that shows slightly coarser numbers.
  // Every consumer of these already falls back to league average when the data
  // is absent, so let them fail softly and tell the user which did.
  const degraded = [];
  const soft = (label, p) => p.catch(() => { degraded.push(label); return null; });
  const [seasonH, recentH, seasonP] = await Promise.all([
    getJSON(`${API}/stats?stats=season&group=hitting&season=${season}&sportId=1&limit=3000&gameType=R&playerPool=All`),
    soft("recent form", getJSON(`${API}/stats?stats=byDateRange&group=hitting&startDate=${ymd(rStart)}&endDate=${ymd(rEnd)}&sportId=1&limit=3000&gameType=R&playerPool=All`)),
    soft("pitching", getJSON(`${API}/stats?stats=season&group=pitching&season=${season}&sportId=1&limit=2500&gameType=R&playerPool=All`))
  ]);
  const splitsOf = d => (d && d.stats && d.stats[0] && d.stats[0].splits) || [];

  // League baselines, measured rather than assumed.
  const L = { h: 0, hr: 0, ab: 0, k: 0, bb: 0, hbp: 0, sf: 0, pa: 0 };
  const hit = {}, gp = [];
  splitsOf(seasonH).forEach(s => {
    const id = s.player && s.player.id, st = s.stat || {}; if (id == null) return;
    const r = { ab: num(st.atBats), h: num(st.hits), hr: num(st.homeRuns), k: num(st.strikeOuts), bb: num(st.baseOnBalls), hbp: num(st.hitByPitch), sf: num(st.sacFlies), pa: num(st.plateAppearances), g: num(st.gamesPlayed), teamId: s.team && s.team.id };
    hit[id] = r;
    L.h += r.h; L.hr += r.hr; L.ab += r.ab; L.k += r.k; L.bb += r.bb; L.hbp += r.hbp; L.sf += r.sf; L.pa += r.pa;
    if (r.ab >= 200) gp.push(r.g);
  });
  splitsOf(recentH).forEach(s => {
    const id = s.player && s.player.id, st = s.stat || {}; if (id == null || !hit[id]) return;
    hit[id].rAb = num(st.atBats); hit[id].rH = num(st.hits); hit[id].rHr = num(st.homeRuns); hit[id].rK = num(st.strikeOuts); hit[id].rBb = num(st.baseOnBalls);
  });
  const lg = L.ab > 1000 ? {
    avg: L.h / L.ab, kPerAb: L.k / L.ab, contact: L.h / Math.max(1, L.ab - L.k),
    hrPerContact: L.hr / Math.max(1, L.ab - L.k),
    babip: (L.h - L.hr) / Math.max(1, L.ab - L.k - L.hr),
    bbPerPa: (L.bb + L.hbp) / Math.max(1, L.pa), abPerPa: L.ab / Math.max(1, L.pa),
    obp: (L.h + L.bb + L.hbp) / Math.max(1, L.pa)
  } : LG_FALLBACK;
  if (!(lg.hrPerContact > 0)) { lg.hrPerContact = LG_FALLBACK.hrPerContact; lg.babip = LG_FALLBACK.babip; }

  // How deep into the season are we? Used to judge whether a hitter without a
  // posted lineup is really an everyday player.
  gp.sort((a, b) => a - b);
  const teamGames = Math.max(1, gp.length ? gp[Math.floor(gp.length * 0.9)] : 60);

  // Pitchers: individual starters, plus each club's relief corps aggregated.
  const pit = {}, relief = {}, LP = { h: 0, hr: 0, ab: 0, k: 0, bb: 0, hbp: 0, pa: 0 }, teamStaff = {};
  splitsOf(seasonP).forEach(s => {
    const id = s.player && s.player.id, st = s.stat || {}; if (id == null) return;
    const tid = s.team && s.team.id;
    const r = { ab: num(st.atBats), h: num(st.hits), hr: num(st.homeRuns), k: num(st.strikeOuts), bb: num(st.baseOnBalls), hbp: num(st.hitByPitch), bf: num(st.battersFaced), gs: num(st.gamesStarted), g: num(st.gamesPlayed) };
    pit[id] = r;
    LP.h += r.h; LP.hr += r.hr; LP.ab += r.ab; LP.k += r.k; LP.bb += r.bb; LP.hbp += r.hbp; LP.pa += (r.bf || r.ab);
    if (tid != null) {
      const T = teamStaff[tid] = teamStaff[tid] || { h: 0, hr: 0, ab: 0, k: 0, bb: 0, hbp: 0, pa: 0 };
      T.h += r.h; T.hr += r.hr; T.ab += r.ab; T.k += r.k; T.bb += r.bb; T.hbp += r.hbp; T.pa += (r.bf || r.ab);
      if (!r.gs) { // pure reliever
        const R = relief[tid] = relief[tid] || { h: 0, hr: 0, ab: 0, k: 0, bb: 0, hbp: 0, pa: 0 };
        R.h += r.h; R.hr += r.hr; R.ab += r.ab; R.k += r.k; R.bb += r.bb; R.hbp += r.hbp; R.pa += (r.bf || r.ab);
      }
    }
  });
  const lgPitK = LP.ab > 1000 ? LP.k / LP.ab : lg.kPerAb;
  const lgPitHr = LP.ab > 1000 ? LP.hr / Math.max(1, LP.ab - LP.k) : lg.hrPerContact;
  const lgPitBabip = LP.ab > 1000 ? (LP.h - LP.hr) / Math.max(1, LP.ab - LP.k - LP.hr) : lg.babip;
  const lgStaffObp = LP.pa > 1000 ? (LP.h + LP.bb + LP.hbp) / LP.pa : lg.obp;
  // Rate an arm the way the model sees him, so "bad pitcher" is a measured
  // thing and not a hunch. Relievers and starters both go through here.
  // Guard every field individually rather than trusting the object. A club with
  // no relief rows yields {gs:0} with every stat undefined — truthy, so an
  // `r ? r.k : 0` test passes it straight through and NaN reaches the board.
  const fld = (r, k) => (r && isFinite(+r[k])) ? +r[k] : 0;
  const arm = r => {
    const ab = fld(r, "ab"), h = fld(r, "h"), hr = fld(r, "hr"), k = fld(r, "k"),
          bb = fld(r, "bb"), hbp = fld(r, "hbp"), bf = fld(r, "bf") || ab;
    const rel = !!r && !fld(r, "gs");                     // reliever priors are looser
    return {
      kRate:  shrink(k,      ab,                             lgPitK,     rel ? K.relief : K.pitK),
      hrRate: shrink(hr,     Math.max(0, ab - k),            lgPitHr,    rel ? K.relief : K.pitHR),
      babip:  shrink(h - hr, Math.max(0, ab - k - hr),       lgPitBabip, rel ? K.relief * 2 : K.pitBabip),
      obp:    shrink(h + bb + hbp, bf,                       lgStaffObp, K.pitOBP)
    };
  };

  // Team offence and the opposing staff's on-base allowed drive the inning
  // model that produces expected plate appearances.
  const teamOff = {};
  Object.keys(hit).forEach(id => {
    const r = hit[id]; if (r.teamId == null) return;
    const T = teamOff[r.teamId] = teamOff[r.teamId] || { h: 0, hr: 0, ab: 0, k: 0, bb: 0, hbp: 0, sf: 0, pa: 0 };
    T.h += r.h; T.hr += r.hr; T.ab += r.ab; T.k += r.k; T.bb += r.bb; T.hbp += r.hbp; T.sf += r.sf; T.pa += r.pa;
  });
  const obpOff = tid => { const T = teamOff[tid]; return shrink(T ? T.h + T.bb + T.hbp : 0, T ? T.pa : 0, lg.obp, K.teamOBP); };
  const obpDef = tid => { const T = teamStaff[tid]; return shrink(T ? T.h + T.bb + T.hbp : 0, T ? T.pa : 0, lgStaffObp, K.teamOBP); };
  // A team's average hitter, as the model sees him — the "good hitting team"
  // half of the thesis, measured rather than asserted.
  const teamBatter = tid => {
    const T = teamOff[tid] || { h: 0, hr: 0, ab: 0, k: 0, bb: 0, hbp: 0, sf: 0, pa: 0 };
    return {
      slot: 5, hand: "R", startProb: 1,
      kRate:  shrink(T.k, T.ab, lg.kPerAb, K.teamBat),
      hrRate: shrink(T.hr, Math.max(0, T.ab - T.k), lg.hrPerContact, K.teamBat),
      babip:  shrink(T.h - T.hr, Math.max(0, T.ab - T.k - T.hr), lg.babip, K.teamBat),
      abPerPa: 1 - shrink(T.bb + T.hbp + T.sf, T.pa, 1 - lg.abPerPa, K.teamBat)
    };
  };
  // Club-level hit suppression behind the arm. The starter is inside this
  // aggregate too, so it overlaps his own contact term slightly — but his is
  // regressed almost all the way to league (pitchers barely control balls in
  // play) and this is capped at +/-6%, so the overlap is small by construction.
  const defence = tid => {
    const T = teamStaff[tid]; if (!T || T.ab < 500) return 1;
    return clamp(shrink(T.h - T.hr, T.ab - T.k - T.hr, lgPitBabip, K.teamDef) / lgPitBabip, 0.94, 1.06);
  };

  // Rosters only for clubs that have not posted a lineup yet.
  const G = games.map(g => {
    const lu = g.lineups || {};
    const ord = arr => (Array.isArray(arr) && arr.length >= 9) ? arr : null;
    return {
      pk: g.gamePk, venue: g.venue && g.venue.name,
      pf: park(g.venue && g.venue.name), pfHr: parkHr(g.venue && g.venue.name),
      startTime: g.gameDate,
      home: { id: g.teams.home.team.id, name: g.teams.home.team.abbreviation || g.teams.home.team.name, sp: g.teams.away.probablePitcher, order: ord(lu.homePlayers), isHome: true },
      away: { id: g.teams.away.team.id, name: g.teams.away.team.abbreviation || g.teams.away.team.name, sp: g.teams.home.probablePitcher, order: ord(lu.awayPlayers), isHome: false }
    };
  });
  const needRoster = [...new Set(G.flatMap(g => [g.home, g.away]).filter(t => !t.order).map(t => t.id))];
  const rosters = {};
  if (needRoster.length) {
    say("Rosters for clubs without a posted lineup…"); prog(45);
    await pool(needRoster, async tid => {
      const d = await getJSON(`${API}/teams/${tid}/roster?rosterType=active`);
      rosters[tid] = ((d && d.roster) || []).filter(p => !p.position || p.position.type !== "Pitcher")
        .map(p => ({ id: p.person.id, name: p.person.fullName, pos: p.position && p.position.abbreviation }));
    }, 6);
  }

  // Assemble candidates.
  const raw = [];
  G.forEach(g => {
    [[g.home, g.away], [g.away, g.home]].forEach(([team, opp]) => {
      const posted = !!team.order;
      const people = posted
        ? team.order.slice(0, 9).map((p, i) => ({ id: p.id, name: p.fullName, pos: p.primaryPosition && p.primaryPosition.abbreviation, slot: i + 1 }))
        : (rosters[team.id] || []).map(p => ({ id: p.id, name: p.name, pos: p.pos, slot: null }));
      people.forEach(pl => {
        const s = hit[pl.id]; if (!s) return;
        if (!posted && s.ab < 60) return;                 // no signal, and probably not playing
        if (posted && s.ab < 10 && !s.rAb) return;
        // Where does he hit when we do not know? Fall back to his own season
        // plate appearances per game, inverted through the slot curve.
        let slot = pl.slot;
        let startProb;
        if (posted) { startProb = CFG.scratchPosted; if (!slot) slot = 5; }
        else {
          // Infer his slot from his own plate appearances per game, inverting
          // the same slot curve the PA model uses (PA ~= 4.77 - 0.11*slot),
          // then shrink 40% toward the middle: PA/G is measured over games he
          // appeared in, so pinch-hit cameos drag it down and one bad estimate
          // should not drop a leadoff man to the 9-hole.
          const paPerG = s.g > 0 ? s.pa / s.g : 0;
          const slotRaw = (4.77 - paPerG) / 0.11;
          slot = clamp(Math.round(5 + 0.6 * (slotRaw - 5)), 1, 9);
          startProb = clamp((s.g / teamGames) * CFG.scratchMax, 0.15, CFG.scratchMax);
          if (startProb < 0.55) return;                   // part-timer, not worth a leg
        }
        raw.push({ id: pl.id, name: pl.name, pos: pl.pos, slot, posted, startProb,
          teamId: team.id, teamName: team.name, oppId: opp.id, oppName: opp.name, isHome: team.isHome,
          sp: team.sp, gk: g.pk, pf: g.pf, pfHr: g.pfHr, venue: g.venue, s });
      });
    });
  });
  if (!raw.length) return { date: day, games: G, candidates: [], pairs: [], note: "no candidates" };

  say("Handedness…"); prog(70);
  const spIds = [...new Set(raw.map(c => c.sp && c.sp.id).filter(Boolean))];
  const ids = [...new Set([...raw.map(c => c.id), ...spIds])];
  const hand = {};
  for (let i = 0; i < ids.length; i += 40) {
    try {
      const d = await getJSON(`${API}/people?personIds=${ids.slice(i, i + 40).join(",")}`);
      ((d && d.people) || []).forEach(p => hand[p.id] = { bat: p.batSide && p.batSide.code, pit: p.pitchHand && p.pitchHand.code });
    } catch (e) { /* handedness is a nicety, not a requirement */ }
  }

  // ── Game-side context, computed once per lineup rather than once per hitter.
  // This is what makes a SPOT SCORE possible: hold the batter constant and let
  // the opposing arm, the bullpen behind him, the defence and the park vary.
  say("Scoring…"); prog(85);

  // League-neutral reference: an average hitter, average arm, average pen,
  // neutral park. Everything below is quoted as points against this.
  const lgBat = { slot: 5, hand: "R", startProb: 1, kRate: lg.kPerAb, hrRate: lg.hrPerContact, babip: lg.babip, abPerPa: lg.abPerPa };
  const lgArm = { kRate: lgPitK, hrRate: lgPitHr, babip: lgPitBabip, obp: lgStaffObp };
  const neutralCtx = { lg, parkContact: 1, parkHr: 1, teamPaMu: clamp(27 / (1 - lg.obp) * 0.955, 32, 45) };
  const neutralOpp = { sp: lgArm, pen: lgArm, spBf: CFG.spBfMean, defence: 1, plt: null };
  const BASELINE = hitProbability(lgBat, neutralOpp, neutralCtx).p;

  const sides = {};
  G.forEach(g => {
    [[g.home, g.away], [g.away, g.home]].forEach(([team, opp]) => {
      const spId = team.sp && team.sp.id, sp = spId != null ? pit[spId] : null;
      const spRates = arm(sp);
      const pen = arm(Object.assign({ gs: 0 }, relief[opp.id] || {}));
      // How long the starter goes decides how much of the night is his. A bad
      // one gets chased, which hands the lineup a third and fourth look at a
      // bullpen — usually the softer target of the two.
      const spBf = clamp(sp && sp.gs > 0 ? (sp.bf + CFG.spBfMean * K.spBF) / (sp.gs + K.spBF) : CFG.spBfMean, 10, 28);
      const spShare = clamp(spBf / 38, 0.2, 0.9);

      // Run environment. BUILD 3.0 used the opponent's whole-staff on-base
      // allowed here; that washes out the one arm we actually know is starting.
      // Weight the starter's own on-base allowed by the share of the game he is
      // expected to work, and give the rest to the pen. A starter who walks the
      // park buys this lineup extra turns, which is most of the edge in a soft
      // spot.
      const obpDefBlend = spShare * spRates.obp + (1 - spShare) * pen.obp;
      const obpExp = log5(obpOff(team.id), obpDefBlend, lg.obp);
      const paMu = clamp(27 / (1 - obpExp) * 0.955
        * (1 + (g.pf - 100) / 100 * CFG.parkPaDamp)
        * (team.isHome ? CFG.homePaAdj : CFG.awayPaAdj), 32, 45);

      const ctx = { lg, parkContact: 1 + (g.pf - 100) / 100 * CFG.parkContactDamp,
                    parkHr: 1 + (g.pfHr - 100) / 100 * CFG.parkHrDamp, teamPaMu: paMu };
      const oppCtx = { sp: spRates, pen, spBf, defence: defence(opp.id), plt: null };

      // Three readings of the same spot:
      //   soft    — how bad the PITCHING and park are, offence held at league
      //   offIdx  — how good the OFFENCE is, opposition held at league
      //   spot    — the two together: what a typical hitter in THIS lineup does
      //             against THIS arm in THIS park. The thesis in one number.
      const tb = teamBatter(team.id);
      const soft = hitProbability(lgBat, oppCtx, ctx).p - BASELINE;
      const offIdx = hitProbability(Object.assign({}, tb), neutralOpp, neutralCtx).p - BASELINE;
      const spot = hitProbability(Object.assign({}, tb), oppCtx, ctx).p;

      sides[`${g.pk}:${team.id}`] = {
        ctx, opp: oppCtx, spBf, spShare, paMu, sp, spRates, pen,
        soft, offIdx, spot, spotDelta: spot - BASELINE,
        spName: team.sp && team.sp.fullName || null,
        spHand: spId != null && hand[spId] ? hand[spId].pit : null
      };
    });
  });

  raw.forEach(c => {
    const side = sides[`${c.gk}:${c.teamId}`];
    const s = c.s;
    // Recency: last 30 days counted twice, then shrunk. A 20-AB heater moves
    // the needle a little; it does not redefine the hitter.
    const w = CFG.recencyWeight;
    const ab = s.ab + w * (s.rAb || 0), h = s.h + w * (s.rH || 0),
          hr = s.hr + w * (s.rHr || 0), k = s.k + w * (s.rK || 0);
    const bat = {
      slot: c.slot, hand: hand[c.id] && hand[c.id].bat,
      kRate: shrink(k, ab, lg.kPerAb, K.batK),
      hrRate: shrink(hr, Math.max(1, ab - k), lg.hrPerContact, K.batHR),
      babip: shrink(h - hr, Math.max(1, ab - k - hr), lg.babip, K.batBabip),
      abPerPa: 1 - shrink(s.bb + s.hbp + s.sf, s.pa, 1 - lg.abPerPa, K.batBB),
      startProb: c.startProb
    };
    const plt = platoon(bat.hand, side.spHand);
    const opp = Object.assign({}, side.opp, { plt });
    const r = hitProbability(bat, opp, side.ctx);

    c.pRaw = r.p;
    c.p = calibrate(r.p, c.id, cal);
    c.pIfStarts = r.pIfStarts; c.ePa = r.ePa; c.eAb = r.eAb; c.trace = r.trace;
    c.plt = plt; c.spBf = side.spBf; c.teamPaMu = side.paMu;
    // Carry the spot readings onto every leg so the board can be sorted by
    // them, not just by who the hitter is.
    c.soft = side.soft; c.offIdx = side.offIdx; c.spot = side.spot; c.spotDelta = side.spotDelta;
    c.avg = s.ab > 0 ? s.h / s.ab : 0;
    c.rAvg = s.rAb > 0 ? s.rH / s.rAb : null;
    c.projAvg = (bat.hrRate + (1 - bat.hrRate) * bat.babip) * (1 - bat.kRate);
    c.spName = side.spName;
    c.spBaa = side.sp && side.sp.ab > 0 ? side.sp.h / side.sp.ab : null;
    c.spK = side.sp && side.sp.ab > 0 ? side.sp.k / side.sp.ab : null;
    c.spHr9 = side.sp && side.sp.bf > 0 ? side.sp.hr / side.sp.bf * 38 : null;  // homers per ~9 innings faced
    c.rec = cal && cal.legs && cal.legs[c.id] ? cal.legs[c.id] : null;
    delete c.s;                       // raw counting stats, not needed downstream
  });

  // Pairs. Enumerate every combination inside a game rather than assuming the
  // two highest singles make the best double — once correlation is priced in,
  // a teammate pair often beats a higher-probability cross-team pair.
  const price = o.american != null ? o.american : 100;
  const byGame = {};
  raw.forEach(c => (byGame[c.gk] = byGame[c.gk] || []).push(c));
  const pairs = [];
  Object.keys(byGame).forEach(gk => {
    const list = byGame[gk].sort((a, b) => b.p - a.p).slice(0, 10);
    let best = null;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const rho = rhoFor(a, b);
      const prob = jointProb(a.p, b.p, rho);
      const ev = evaluate(prob, price);
      const cand = { a, b, rho, prob, naive: a.p * b.p, lift: prob - a.p * b.p, ev,
        sameTeam: a.teamId === b.teamId, gk: +gk, venue: a.venue, pf: a.pf, pfHr: a.pfHr,
        // A same-team pair inherits that side's spot; a cross-team pair sits
        // between the two, which is one more reason to prefer teammates.
        soft: (a.soft + b.soft) / 2, offIdx: (a.offIdx + b.offIdx) / 2,
        spot: (a.spot + b.spot) / 2, spotDelta: (a.spotDelta + b.spotDelta) / 2,
        teams: `${a.teamName} vs ${a.oppName}`, bothPosted: a.posted && b.posted };
      if (!best || cand.prob > best.prob) best = cand;
    }
    if (best) pairs.push(best);
  });
  // Rank by edge over the price on offer, not by raw probability. The single
  // most likely double is usually also the most heavily bet and worst priced.
  pairs.sort((x, y) => (y.ev ? y.ev.edge : y.prob) - (x.ev ? x.ev.edge : x.prob) || y.prob - x.prob);

  // Every lineup on the slate, ranked by how soft its spot is. This is the
  // board for "target the bad arm", as opposed to "target the good hitter".
  const spots = Object.keys(sides).map(key => {
    const [gk, tid] = key.split(":");
    const side = sides[key];
    const mine = raw.filter(c => c.gk === +gk && c.teamId === +tid);
    if (!mine.length) return null;
    const g = G.find(x => x.pk === +gk);
    const me = g && (g.home.id === +tid ? g.home : g.away);
    const them = g && (g.home.id === +tid ? g.away : g.home);
    return {
      gk: +gk, teamId: +tid, team: me ? me.name : String(tid), opp: them ? them.name : "",
      isHome: me ? me.isHome : false, venue: g && g.venue, pf: g && g.pf, pfHr: g && g.pfHr,
      spName: side.spName, spBf: side.spBf, spShare: side.spShare, paMu: side.paMu,
      spK: side.spRates.kRate, spHr: side.spRates.hrRate, spObp: side.spRates.obp,
      penK: side.pen.kRate, penObp: side.pen.obp,
      soft: side.soft, offIdx: side.offIdx, spot: side.spot, spotDelta: side.spotDelta,
      posted: mine.some(c => c.posted), n: mine.length,
      best: mine.slice().sort((x, y) => y.p - x.p).slice(0, 3).map(c => ({ id: c.id, name: c.name, slot: c.slot, p: c.p }))
    };
  }).filter(Boolean).sort((a, b) => b.spotDelta - a.spotDelta);

  prog(100);
  return { date: day, v: VERSION, lg, teamGames, baseline: BASELINE, games: G,
    candidates: raw.sort((a, b) => b.p - a.p), pairs, spots, price, degraded };
}

return { VERSION, API, CFG, K, PARK, park, clamp, erf, normCdf, normPdf, normInv, logit, expit,
  log5, shrink, hitProbability, jointProb, rhoFor, amOdds, decFromAmerican, evaluate,
  esp, hitCountDist, nCr, roundRobin,
  calibrate, record, etNow, ymd, slateYmd, platoon, pool, buildBoard };
});
