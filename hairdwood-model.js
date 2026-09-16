// ─────────────────────────────────────────────────────────────────────────────
// HAIrdwood — NBA player-prop pricing engine
//
// One file, two consumers: the dashboard loads it as a classic script
// (window.HairdwoodModel), Node imports it as a CJS default. Same pipeline both
// ways, so the board on screen and any alerter can never drift apart — the
// same rule the baseball and football engines in this repo run under.
//
// The job: take tonight's NBA slate, project every man who will play in it
// across the four markets anyone actually bets — POINTS, REBOUNDS, ASSISTS,
// THREES MADE — turn each projection into a probability that he clears a given
// line, and then GRADE every one of those bets on a published 100-point scale
// so the board can be ranked by how likely a bet is rather than by how loud it
// looks.
//
// WHAT THIS MODEL DOES DIFFERENTLY, AND WHY
//
//  1. MINUTES ARE THE WHOLE BET. A basketball prop is a rate times a minute
//     count, and the minute count is the part that moves. Season per-minute
//     rates are stable to within a few percent; minutes swing by a third when
//     a teammate sits, and vanish entirely in a blowout. So minutes are
//     projected on their own — season baseline, recent run, who else is out,
//     and the game's own projected margin — and everything else is a rate
//     applied to them.
//
//  2. NOTHING IS A SEASON AVERAGE. A 22-point scorer's 22 came against a
//     schedule he will not play again, at his own team's pace, in games whose
//     scripts will not repeat. We rebuild the number: pace of THIS game, the
//     opponent's allowance in THIS market, his minutes tonight, his rate per
//     minute. A season average is only ever a prior here.
//
//  3. THE MARKET TOTAL IS A FEED, NOT AN OPINION. The posted total and spread
//     already carry every rest day, every late scratch and every pace mismatch
//     the public knows about. Projected team points are pulled toward
//     (total ± spread)/2, which is the single cheapest piece of real
//     information on the board.
//
//  4. THREES ARE DERIVED FROM ATTEMPTS, NOT FROM MAKES. All four markets are
//     over-dispersed relative to Poisson — usage itself varies — so all four
//     are negative binomial. Threes are built the long way round anyway: as a
//     binomial draw on a random attempt count. That compound is NOT a
//     different family (binomial thinning of a negative binomial is negative
//     binomial again, exactly — the tails agree to four decimals, which is
//     worth knowing before anyone claims otherwise). What it buys is where the
//     DISPERSION COMES FROM: the spread of a man's threes is derived from how
//     much his ATTEMPTS move, which is measurable, rather than from an assumed
//     spread on his makes, which is a guess wearing a decimal point. Two
//     shooters at the same makes then differ only where they actually should —
//     in their own logged variance, which point 5 blends in.
//
//  5. THE PLAYER'S OWN VARIANCE BEATS THE FAMILY'S. Where the game log gives
//     us enough games, the observed game-to-game spread is blended into the
//     model's, shrunk by sample size. A metronome and a 40-or-8 guy at the same
//     average are not the same bet, and no parametric family knows that.
//
//  6. OVERS ONLY, AND THAT IS DELIBERATE. An under is mostly a bet on a player
//     getting hurt, rested or blown out — the three things this model knows
//     least about — and the DNP that would make it a lock voids the ticket
//     instead of cashing it. The board publishes overs.
//
//  7. THE GRADE IS PUBLISHED, NOT A BLACK BOX. Every bet carries a 100-point
//     HAIrdwood score built from seven components and five penalties, each one
//     shown with its own points on the card. When a component's input is
//     missing the component is dropped AND its weight comes out of the
//     denominator, so a bet is never quietly rewarded for what we could not
//     measure.
//
//  8. A SAME-GAME DOUBLE IS PRICED AS CORRELATED, BECAUSE IT IS. Two legs in
//     one game share a pace, a game script and sometimes a basketball: the
//     passer's assist IS the shooter's three. P1×P2 is the wrong number and it
//     is wrong in a different direction for each pair of markets, so the joint
//     comes from a bivariate normal with a per-market-pair correlation, done
//     by quadrature rather than by a small-rho expansion that would break on
//     exactly the pairs worth betting.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HairdwoodModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const VERSION = 1;

const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const WEB  = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba";
const CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = v => { const n = parseFloat(String(v == null ? "" : v).replace(/,/g, "")); return isFinite(n) ? n : null; };
const n0 = v => { const n = num(v); return n == null ? 0 : n; };

// ── math ────────────────────────────────────────────────────────────────────
// Abramowitz & Stegun 7.1.26.
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
const normPdf = z => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

function normInv(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl; let q, r;
  p = clamp(p, 1e-12, 1 - 1e-12);
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > ph) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// Negative binomial with mean m and dispersion k: Var = m + m^2/k. Points,
// rebounds and assists all live here — a man's usage varies game to game, so
// the count he produces is wider than Poisson by a margin that is itself
// measurable.
function nbPmf(m, k, n) {
  if (!(m > 0)) return n === 0 ? 1 : 0;
  if (!(k > 0) || !isFinite(k)) k = 1e6;                 // degenerate -> Poisson
  const p = k / (k + m);
  return Math.exp(logGamma(n + k) - logGamma(k) - logGamma(n + 1) + k * Math.log(p) + n * Math.log(1 - p));
}
function nbAtLeast(m, k, n) {
  if (n <= 0) return 1;
  let below = 0;
  for (let i = 0; i < n; i++) below += nbPmf(m, k, i);
  return clamp(1 - below, 0, 1);
}
// Threes: a binomial draw on a count of attempts that is itself random. Summing
// the binomial over the attempt distribution gives the real shape, which is
// TIGHTER than Poisson at a fixed attempt count and wider once attempts move —
// neither of which a single negative binomial reproduces.
function binPmf(n, q, k) {
  if (k < 0 || k > n) return 0;
  return Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(clamp(q, 1e-9, 1 - 1e-9)) + (n - k) * Math.log(1 - clamp(q, 1e-9, 1 - 1e-9)));
}
function compoundAtLeast(attMean, attDisp, q, n) {
  if (n <= 0) return 1;
  if (!(attMean > 0) || !(q > 0)) return 0;
  const top = Math.max(6, Math.ceil(attMean + 6 * Math.sqrt(attMean + attMean * attMean / Math.max(1e-6, attDisp))));
  let below = 0, wSum = 0;
  for (let a = 0; a <= top; a++) {
    const w = nbPmf(attMean, attDisp, a);
    if (w < 1e-9 && a > attMean) break;
    wSum += w;
    for (let k = 0; k < n && k <= a; k++) below += w * binPmf(a, q, k);
  }
  if (wSum > 0) below /= wSum;                           // renormalise the truncation
  return clamp(1 - below, 0, 1);
}

// Bivariate normal, by quadrature on the standard identity
//   d/drho Phi2(h,k,rho) = phi2(h,k,rho),
// integrated from 0 to rho by Simpson. The small-rho expansion the baseball
// engine uses is accurate to a tenth of a point at rho=0.05 and useless at the
// rho=0.6 a same-player points/threes pair really carries, and those are
// exactly the pairs worth looking at — so this one is done properly.
function biNormCdf(h, k, rho) {
  if (!rho) return normCdf(h) * normCdf(k);
  rho = clamp(rho, -0.995, 0.995);
  const f = r => {
    const s = 1 - r * r;
    return Math.exp(-(h * h - 2 * r * h * k + k * k) / (2 * s)) / (2 * Math.PI * Math.sqrt(s));
  };
  // 32 panels is accurate to a part in a million up to |rho| ~ 0.7, where the
  // integrand starts to peak; the strongly correlated pairs get twice that.
  const N = Math.abs(rho) > 0.7 ? 64 : 32, step = rho / N;
  let sum = f(0) + f(rho);
  for (let i = 1; i < N; i++) sum += f(i * step) * (i % 2 ? 4 : 2);
  return clamp(normCdf(h) * normCdf(k) + (step / 3) * sum, 0, 1);
}
// P(both legs cash) for two overs whose marginal chances are p1 and p2.
function jointProb(p1, p2, rho) {
  p1 = clamp(p1, 1e-6, 1 - 1e-6); p2 = clamp(p2, 1e-6, 1 - 1e-6);
  if (!rho) return p1 * p2;
  const z1 = normInv(1 - p1), z2 = normInv(1 - p2);
  const j = 1 - normCdf(z1) - normCdf(z2) + biNormCdf(z1, z2, rho);
  return clamp(j, Math.max(0, p1 + p2 - 1), Math.min(p1, p2));
}

// Shrink a rate toward a prior. `trials` is the unit the rate is measured in —
// minutes for a per-minute rate, games for a per-game one — and k is how many
// of those it takes before the player's own number outweighs the prior.
const shrink = (succ, trials, prior, k) => (n0(succ) + prior * k) / (n0(trials) + k);

// ── odds ────────────────────────────────────────────────────────────────────
function amOdds(p) { if (!(p > 0 && p < 1)) return "—"; const d = 1 / p; return d >= 2 ? "+" + Math.round((d - 1) * 100) : "-" + Math.round(100 / (d - 1)); }
function decFromAmerican(a) { a = +a; if (!a) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
function evaluate(p, american) {
  const dec = decFromAmerican(american);
  if (!dec) return null;
  const b = dec - 1;
  const ev = p * b - (1 - p);
  const kelly = b > 0 ? (p * dec - 1) / b : 0;
  return { dec, ev, evPct: ev * 100, kelly, quarterKelly: Math.max(0, kelly / 4), breakeven: 1 / dec, edge: p - 1 / dec };
}

// ── the four markets ────────────────────────────────────────────────────────
// `cv` is the extra-Poisson spread: Var = mean + (cv*mean)^2, which is the
// negative binomial written the way it is actually measurable — a 25-point
// scorer at cv 0.225 gets a standard deviation of 7.5 points a night, which is
// what a 25-point scorer has. `stab` is how many MINUTES of evidence it takes
// before a man's own per-minute rate outweighs the positional prior; rebounds
// stabilise fastest (a 7-footer rebounds), assists slowest (role changes).
const MARKETS = [
  { key: "pts", label: "Points",      short: "PTS", cv: 0.225, stab: 220, max: 70 },
  { key: "reb", label: "Rebounds",    short: "REB", cv: 0.215, stab: 180, max: 30 },
  { key: "ast", label: "Assists",     short: "AST", cv: 0.235, stab: 300, max: 22 },
  // cvAtt is the one that matters for threes: 3-point ATTEMPTS swing about
  // 28% game to game, and the makes inherit that dispersion through the
  // binomial. cv is only the fallback for a man whose attempts we do not have.
  { key: "tpm", label: "Threes made", short: "3PM", cv: 0.30,  stab: 260, max: 14, cvAtt: 0.28 }
];
const MKT = {}; MARKETS.forEach(m => { MKT[m.key] = m; });

// ── tuning ──────────────────────────────────────────────────────────────────
// Every constant here is either measurable from the feed or a bounded
// judgement that says so in its own comment. Nothing is fitted to make the
// board look better.
const CFG = {
  // Minutes. The season number is a prior; the last ten games are the truth
  // when a role has changed, which in the NBA it constantly has.
  minRecentW: 0.45,          // weight on the L10 minute average, at full sample
  minRecentN: 5,             // logged games before that weight is paid in full
  // A blowout costs a starter the fourth quarter. Measured crudely and capped
  // hard: past a 9-point spread each further point is worth about half a
  // percent of a starter's minutes, to a ceiling of 9%.
  blowoutFrom: 9, blowoutPer: 0.005, blowoutMax: 0.09,
  // A man who is out hands his minutes to the men behind him. The share that
  // actually lands on any one rotation player is small and this is a judgement,
  // so it is capped at a fifth: 240 team minutes, redistributed by how much of
  // the rotation is missing, weighted to men who already play.
  outShare: 0.55, outMax: 0.20,
  // Playing hurt is worth fewer minutes, not a coin flip. A prop is VOIDED if
  // he does not play, so a questionable tag is a haircut on minutes plus a
  // penalty on the grade — it is not multiplied into the probability the way a
  // baseball scratch is, because a void is a refund and not a loss.
  qDoubtful: 0.70, qQuestionable: 0.93, qProbable: 0.99,
  // Pace and matchup. Both are regressed: a defence's allowed rate is half
  // schedule, and the half that is real is worth having.
  defCarry: 0.50, defClamp: 0.12,
  paceClamp: 0.10,
  // The posted total is better than our pace arithmetic at knowing tonight's
  // scoring, so projected team points lean on it — but only within a band,
  // because a stale or missing number should never rewrite a projection.
  totalW: 0.65, totalClamp: 0.12,
  // Home men play marginally more and shoot marginally better. Small, real,
  // and not worth more than this.
  homeRate: 1.012,
  // Variance: how much of the player's own observed game-to-game spread to
  // believe, against the family's. 12 logged games gets him half way.
  varStab: 12, varClamp: [0.62, 1.55],
  // A leg has to be a real bet: no 0.5-point lines, no 2% tails.
  // A leg has to be a real bet. pCeil is the publication ceiling: past about
  // 92% the fair price is -1150, the book's version of it is worse, and no
  // amount of being right about it compounds into anything.
  lineMin: 0.5, pFloor: 0.35, pCeil: 0.92,
  minMinutes: 14, minGames: 3,
  // Correlation between two legs in the same game, before the environment
  // gain. Read `sameTeam` as "these two share a basketball" and `opp` as
  // "these two share a clock".
  //
  // The signs are the ones the sport actually has, and they are not all
  // positive: two teammates chasing the same rebound take them off each other,
  // and two of them running the offence take assists off each other, while a
  // passer and a shooter on the same side are the single most correlated pair
  // on a basketball court that is not the same man twice.
  rho: {
    same: { "pts|pts": 0.02, "pts|reb": 0.03, "pts|ast": 0.15, "pts|tpm": 0.05,
            "reb|reb": -0.10, "reb|ast": 0.00, "reb|tpm": -0.02,
            "ast|ast": -0.06, "ast|tpm": 0.19, "tpm|tpm": 0.03 },
    opp:  { "pts|pts": 0.07, "pts|reb": 0.02, "pts|ast": 0.05, "pts|tpm": 0.05,
            "reb|reb": 0.05, "reb|ast": 0.01, "reb|tpm": 0.02,
            "ast|ast": 0.05, "ast|tpm": 0.04, "tpm|tpm": 0.05 },
    // The same man twice. Points and threes are nearly the same bet; points
    // and rebounds are two different ways of being on the floor for 36
    // minutes, which is most of the correlation there is.
    self: { "pts|pts": 1, "pts|reb": 0.30, "pts|ast": 0.26, "pts|tpm": 0.62,
            "reb|reb": 1, "reb|ast": 0.18, "reb|tpm": 0.04,
            "ast|ast": 1, "ast|tpm": 0.14, "tpm|tpm": 1 }
  },
  // A fast, high-total game moves everything together harder than a rock fight
  // does. Bounded to half and double the base, the same rule the baseball
  // engine uses — it may shade a number, never invent one.
  rhoEnvGain: 0.35,
  // MEASURED, and the measurement is humbling. Across 236 graded doubles in the
  // 2026 backtest the realised joint was 57.2%, while the legs inside those
  // doubles cashed 75.6% apiece — and 0.756^2 is 57.2%. The correlation this
  // table asserts did not show up at all. It is not refuted either: the standard
  // error on 236 pairs is about three points and the lift being claimed was 1.4,
  // so the honest statement is that the effect is smaller than this board can
  // yet see. The table is halved rather than deleted, and re-measured on every
  // backtest run.
  rhoScale: 0.5,
  // Over-dispersion, measured on 3,640 graded legs: the probabilities are too
  // SPREAD OUT. The model said 62.6% where 65.7% happened and said 82.3% where
  // 80.2% did — under-confident in the middle, over-confident at both ends.
  // Shrinking 15% toward the middle cuts the error in every band, most of all
  // at the top, which is exactly where this board does its betting.
  calib: { centre: 0.70, k: 0.85 },
  // And a haircut on a PAIR specifically. Choosing the best-scoring two legs in
  // a game selects for legs whose numbers are flattered — the maximum of many
  // estimates carries the optimism of all of them — and the backtest sees it:
  // after the calibration above there are still about four points between what
  // a double is priced at and what one does. The haircut is deliberately
  // smaller than the gap, because one season is one season and a correction
  // fitted tightly to it would be the same mistake wearing a lab coat.
  pairShrink: 0.95,
  // Grading. These are the published weights; they are what the card shows,
  // and they sum to a hundred so the number on the card is the number.
  // Six, not seven. There was a "cushion" component here scoring how far the
  // projection sat above the line in standard deviations — which is the same
  // number as the probability, arrived at the long way round: at a fixed
  // distribution, z and p are the same fact. Scoring both counted it twice and
  // tilted every grade toward the cheapest line on the board. The z is still
  // printed on the card, because it is worth seeing; it is no longer paid for
  // twice.
  weights: { like: 40, role: 14, matchup: 12, price: 14, form: 12, floor: 8 },
  // Where a prop is actually worth writing. Full marks anywhere up to a -350
  // fair price; from there the payout falls off a cliff while the risk does
  // not, and by -1200 the bet is a savings account with a bust attached.
  priceFull: 0.76, priceZero: 0.93
};

// League baselines, used only until the feed gives us real ones. Measured from
// recent full seasons: ~113.5 points and ~99.2 possessions a side per 48.
const LG_FALLBACK = {
  pace: 99.2, pts: 113.5, reb: 43.5, ast: 26.5, tpm: 12.8, tpa: 35.5, tpPct: 0.361, total: 227.0
};

// ── data plumbing ───────────────────────────────────────────────────────────
function etNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); }
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const compact = s => String(s).replace(/-/g, "");
// The basketball day rolls over at 6am Eastern: a west-coast game tipping at
// 10:30pm ET is still tonight's slate at 1am, and nothing tips before noon.
function slateYmd() { const d = etNow(); d.setHours(d.getHours() - 6); return ymd(d); }
// ESPN's season year is the year the FINALS are played in, so October 2026
// belongs to season 2027. Off by one here and every rate on the board is a
// season stale.
function seasonOf(day) {
  const y = +String(day).slice(0, 4), m = +String(day).slice(5, 7);
  return m >= 8 ? y + 1 : y;
}
// The ET slate day a UTC timestamp belongs to. A 10:30pm ET tip is 02:30Z the
// NEXT day, so slicing the ISO string — which is the obvious thing to do and
// the wrong thing to do — files half the league's games under tomorrow.
function etDayOf(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const d = new Date(new Date(t).toLocaleString("en-US", { timeZone: "America/New_York" }));
  d.setHours(d.getHours() - 6);
  return ymd(d);
}
const addDays = (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

// A full board is one scoreboard call, ten league-wide stat pages, a roster
// and an injury report per team, and a game log per rotation player — north of
// a hundred requests, all of them through public CORS proxies. Re-pulling the
// lot every time the page refreshes is how a board gets itself rate-limited
// into looking broken.
//
// So what changes on the hour is re-pulled and what does not is kept. The
// scoreboard and the injury reports are ALWAYS fresh, because they are the two
// things that move in the hour before tip and the two things worth refreshing
// for. Season rates, rosters and game logs cannot change until somebody plays
// a game.
const CACHE_TTL = { stats: 6 * 3600e3, roster: 12 * 3600e3, log: 2 * 3600e3 };
const _cache = new Map();
async function cached(key, ttl, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = Promise.resolve().then(fn);
  _cache.set(key, { at: Date.now(), p });
  // A failure must not be remembered for six hours, or one blocked proxy call
  // poisons the board until the tab is closed.
  p.catch(() => { const cur = _cache.get(key); if (cur && cur.p === p) _cache.delete(key); });
  return p;
}
function clearCache() { _cache.clear(); }

async function pool(items, fn, size, onTick) {
  const out = new Array(items.length); let i = 0, done = 0;
  const w = async () => { while (i < items.length) { const j = i++; try { out[j] = await fn(items[j], j); } catch (e) { out[j] = null; } done++; if (onTick) onTick(done, items.length); } };
  await Promise.all(Array.from({ length: Math.min(size || 6, items.length || 1) }, w));
  return out;
}

// The dashboard hands its own fetcher in (it owns the CORS-proxy fallback
// chain); this is only here so the module is usable from Node without one.
const DEFAULT_SOURCES = [
  u => u,
  u => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u)
];
let goodSource = null;
async function defaultGetJSON(url) {
  const order = goodSource != null
    ? [goodSource].concat(DEFAULT_SOURCES.map((_, i) => i).filter(i => i !== goodSource))
    : DEFAULT_SOURCES.map((_, i) => i);
  let err;
  for (const i of order) {
    try {
      const r = await fetch(DEFAULT_SOURCES[i](url), { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      goodSource = i;
      return j;
    } catch (e) { err = e; }
  }
  throw err || new Error("unreachable: " + url);
}

// ── the slate ───────────────────────────────────────────────────────────────
// The spread is quoted on the favourite, and which side that is has to be READ
// rather than assumed. Shared, because the same block arrives from two places:
// the scoreboard for an upcoming game, and the summary's pickcenter for one the
// scoreboard has already stripped.
function parseOdds(list) {
  const o = (list || []).find(x => x && (num(x.overUnder) != null || num(x.spread) != null));
  if (!o) return null;
  let spreadHome = null;
  const sp = num(o.spread);
  if (sp != null) {
    if (o.homeTeamOdds && o.homeTeamOdds.favorite) spreadHome = -Math.abs(sp);
    else if (o.awayTeamOdds && o.awayTeamOdds.favorite) spreadHome = Math.abs(sp);
    else spreadHome = sp;                       // already home-relative
  }
  return { total: num(o.overUnder), spreadHome,
           details: o.details || null, provider: (o.provider || {}).name || null };
}

function parseEvent(ev) {
  const c = (ev.competitions || [])[0]; if (!c) return null;
  const cs = c.competitors || []; if (cs.length !== 2) return null;
  const home = cs.find(x => x.homeAway === "home"), away = cs.find(x => x.homeAway === "away");
  if (!home || !away) return null;
  const st = (c.status || {}).type || {};
  const side = t => ({
    id: String(t.team.id), abbr: t.team.abbreviation || t.team.shortDisplayName,
    name: t.team.displayName, logo: t.team.logo,
    rec: ((t.records || []).find(r => r.type === "total") || (t.records || [])[0] || {}).summary || null
  });
  const od = parseOdds(c.odds);
  return {
    id: String(ev.id), date: ev.date,
    started: st.state === "in" || st.completed === true || st.state === "post",
    final: st.completed === true,
    statusTxt: st.shortDetail || st.description || "",
    home: side(home), away: side(away),
    venue: (c.venue || {}).fullName || null,
    total: od ? od.total : null,
    spreadHome: od ? od.spreadHome : null,
    oddsTxt: od ? od.details : null
  };
}

async function loadSlate(get, day) {
  const d = await get(`${SITE}/scoreboard?limit=60&dates=${compact(day)}`);
  const games = (d.events || []).map(parseEvent).filter(Boolean);
  // The NBA scoreboard carries its season under leagues[0], not at the top
  // level the way the football one does. Getting this wrong is a whole season
  // of stale rates, so seasonOf() stays as the backstop.
  const yr = ((((d.leagues || [])[0] || {}).season || {}).year) || ((d.season || {}).year);
  return { day, season: yr || seasonOf(day), games };
}

// Out of season — which for a September page is most of the time — the useful
// answer is not "no games", it is WHEN. One ranged scoreboard call covers the
// next six weeks, so the page can name the next slate instead of looking
// broken.
async function nextSlateDay(get, fromDay, span) {
  const a = addDays(fromDay, 1), b = addDays(fromDay, span || 45);
  try {
    const d = await get(`${SITE}/scoreboard?limit=900&dates=${compact(a)}-${compact(b)}`);
    const days = (d.events || []).map(e => etDayOf(e.date)).filter(Boolean).sort();
    return days.length ? days[0] : null;
  } catch (e) { return null; }
}

// ── team rates ──────────────────────────────────────────────────────────────
function statMap(leagueCats, cat) {
  const names = ((leagueCats || []).find(c => c.name === cat.name) || {}).names || [];
  const out = {};
  names.forEach((n, i) => { const v = num((cat.totals || [])[i]); if (v != null && out[n] == null) out[n] = v; });
  return out;
}
// Possessions, the standard estimate: a possession ends in a shot that is not
// offensively rebounded, a turnover, or a trip to the line. Pace is what turns
// "this team allows 118" into "this team allows 118 because everybody plays 104
// possessions against them", which are two completely different defences.
const possOf = m => n0(m.avgFieldGoalsAttempted) - n0(m.avgOffensiveRebounds) + n0(m.avgTurnovers) + 0.44 * n0(m.avgFreeThrowsAttempted);

async function loadTeamStats(get, season) {
  const d = await get(`${WEB}/statistics/byteam?region=us&lang=en&contentorigin=espn&season=${season}&seasontype=2`);
  const lc = d.categories || [];
  const out = {};
  (d.teams || []).forEach(t => {
    const own = {}, opp = {};
    (t.categories || []).forEach(c => {
      // MEASURED, not assumed: the NBA feed splits a team's own numbers under
      // splitId "0" and what it ALLOWED under "900" — not the "1" the football
      // feed uses. Reading for "1" put every opponent row nowhere, which left
      // all thirty defences at exactly league average and silently deleted the
      // matchup component from every grade on the board. Anything that is not
      // "0" is the opponent; a category with no split at all (the differential
      // block) is neither and is dropped.
      const sid = c.splitId == null ? null : String(c.splitId);
      if (sid == null) return;
      const tgt = sid === "0" ? own : opp;
      const m = statMap(lc, c);
      Object.keys(m).forEach(k => { if (tgt[k] == null) tgt[k] = m[k]; });
    });
    const id = String((t.team || {}).id || "");
    if (!id) return;
    const rec = {
      id, abbr: (t.team || {}).abbreviation || "", gp: n0(own.gamesPlayed) || 0,
      pts: n0(own.avgPoints), reb: n0(own.avgRebounds), ast: n0(own.avgAssists),
      tpm: n0(own.avgThreePointFieldGoalsMade), tpa: n0(own.avgThreePointFieldGoalsAttempted),
      fga: n0(own.avgFieldGoalsAttempted), fta: n0(own.avgFreeThrowsAttempted),
      poss: possOf(own),
      // What this team ALLOWS, which is the half of the matchup that decides a
      // prop. A defence with no opponent split is not a defence we know
      // anything about, and defFactor treats it as exactly league average.
      allow: Object.keys(opp).length ? {
        pts: n0(opp.avgPoints), reb: n0(opp.avgRebounds), ast: n0(opp.avgAssists),
        tpm: n0(opp.avgThreePointFieldGoalsMade), poss: possOf(opp)
      } : null
    };
    out[id] = rec;
  });
  return out;
}

// League averages from whatever came back, so the baselines are this season's
// and not a constant that went stale in July.
function leagueFrom(teams) {
  const vals = Object.values(teams || {}).filter(t => t.gp > 0 && t.pts > 0);
  if (vals.length < 10) return Object.assign({}, LG_FALLBACK, { measured: false, n: vals.length });
  const mean = f => vals.reduce((a, t) => a + f(t), 0) / vals.length;
  const pace = mean(t => t.poss) || LG_FALLBACK.pace;
  return {
    measured: true, n: vals.length,
    pace, pts: mean(t => t.pts), reb: mean(t => t.reb), ast: mean(t => t.ast),
    tpm: mean(t => t.tpm), tpa: mean(t => t.tpa),
    tpPct: mean(t => t.tpa) > 0 ? mean(t => t.tpm) / mean(t => t.tpa) : LG_FALLBACK.tpPct,
    total: 2 * mean(t => t.pts)
  };
}

// ── players ─────────────────────────────────────────────────────────────────
// Four sorted pages of the league-wide feed cover everyone anyone hangs a prop
// on: the leading scorers, rebounders, passers and shooters, plus the minutes
// list to catch the rotation men none of those four reach.
// Whatever a page is sorted by, ESPN returns every category's line for the
// hundred players on it — the sort only decides WHO is on the page. So depth
// comes from the one key that is certain to exist, and the rest are there to
// sweep up a rebounder or a passer the scoring list would have missed. A sort
// key ESPN rejects costs that page and nothing else.
const PLAYER_PAGES = [
  { s: "offensive.avgPoints", p: 1 }, { s: "offensive.avgPoints", p: 2 },
  { s: "offensive.avgPoints", p: 3 }, { s: "offensive.avgPoints", p: 4 },
  { s: "general.avgMinutes", p: 1 }, { s: "general.avgMinutes", p: 2 },
  { s: "general.avgRebounds", p: 1 }, { s: "offensive.avgAssists", p: 1 },
  { s: "offensive.avgThreePointFieldGoalsMade", p: 1 }
];
async function loadPlayers(get, season, onTick) {
  const jobs = PLAYER_PAGES.slice();
  const res = await pool(jobs, async j =>
    get(`${WEB}/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&page=${j.p}&limit=100&sort=${encodeURIComponent(j.s)}%3Adesc&season=${season}&seasontype=2`)
  , 4, onTick);
  const by = {};
  res.forEach(d => {
    if (!d) return;
    const lc = d.categories || [];
    (d.athletes || []).forEach(a => {
      const ath = a.athlete || {}; const id = String(ath.id || "");
      if (!id || by[id]) return;
      const m = {};
      (a.categories || []).forEach(c => Object.assign(m, statMap(lc, c)));
      const gp = n0(m.gamesPlayed);
      if (!gp) return;
      // ESPN publishes both totals and averages here; averages are what the
      // per-minute rates are built from, and the totals are only a fallback
      // for a feed that dropped them.
      const mpg = m.avgMinutes != null ? n0(m.avgMinutes) : (n0(m.minutes) / gp);
      by[id] = {
        id, name: ath.displayName || ath.fullName || "", short: ath.shortName || "",
        pos: ((ath.position || {}).abbreviation) || "",
        teamId: ath.teamId != null ? String(ath.teamId) : null,
        jersey: ath.jersey || null,
        gp, gs: n0(m.gamesStarted), mpg,
        pts: m.avgPoints != null ? n0(m.avgPoints) : n0(m.points) / gp,
        reb: m.avgRebounds != null ? n0(m.avgRebounds) : n0(m.rebounds) / gp,
        ast: m.avgAssists != null ? n0(m.avgAssists) : n0(m.assists) / gp,
        tpm: m.avgThreePointFieldGoalsMade != null ? n0(m.avgThreePointFieldGoalsMade) : n0(m.threePointFieldGoalsMade) / gp,
        tpa: m.avgThreePointFieldGoalsAttempted != null ? n0(m.avgThreePointFieldGoalsAttempted) : n0(m.threePointFieldGoalsAttempted) / gp,
        tpPct: m.threePointFieldGoalPct != null ? n0(m.threePointFieldGoalPct) / 100 : null,
        fga: m.avgFieldGoalsAttempted != null ? n0(m.avgFieldGoalsAttempted) : 0
      };
    });
  });
  return Object.values(by);
}

// Who is actually on this roster tonight. Season stats carry the team a man
// earned them with, so a February trade would otherwise project him into the
// team he left.
async function loadRoster(get, teamId) {
  const d = await get(`${SITE}/teams/${teamId}/roster`);
  const out = [];
  const push = a => {
    const id = String((a || {}).id || "");
    if (id) out.push({ id, name: a.displayName || a.fullName || "", pos: ((a.position || {}).abbreviation) || "", jersey: a.jersey || null });
  };
  (d.athletes || []).forEach(g => {
    if (Array.isArray(g)) g.forEach(push);
    else if (Array.isArray(g.items)) g.items.forEach(push);
    else if (Array.isArray(g.athletes)) g.athletes.forEach(push);
    else push(g);
  });
  return out;
}

// The game summary carries both teams' injury reports — the single most
// valuable pre-tip feed in basketball, because the minutes a man is not playing
// are the minutes somebody else is — AND, in pickcenter, the market's number.
//
// The second one matters more than it looks. The scoreboard drops its `odds`
// block entirely once a game is over, and carries it inconsistently before, so
// a board built on the scoreboard alone loses the posted total exactly when it
// wants it. This call is already being made for the injuries, so the total and
// the spread come back for free.
async function loadSummary(get, eventId) {
  const d = await get(`${SITE}/summary?event=${eventId}`);
  const injuries = {};
  (d.injuries || []).forEach(t => {
    const tid = String((t.team || {}).id || "");
    if (!tid) return;
    const m = injuries[tid] || (injuries[tid] = {});
    (t.injuries || []).forEach(x => {
      const aid = String(((x.athlete || {}).id) || "");
      if (aid) m[aid] = x.status || ((x.type || {}).description) || "";
    });
  });
  // pickcenter is the consensus board; `odds` is the same block in a different
  // wrapper on some games. Either will do, and neither being there is survivable
  // — the projection falls back to our own pace arithmetic and says so.
  const odds = parseOdds(d.pickcenter) || parseOdds(d.odds);
  return { injuries, odds };
}
// Kept as its own name because it reads better at the call site and because an
// alerter may well want the injuries without the rest of a summary payload.
async function loadInjuries(get, eventId) {
  return (await loadSummary(get, eventId)).injuries;
}
const INJ_PLAY = { out: 0, doubtful: 0.15, questionable: 0.70, probable: 0.94 };
function injuryWeight(status) {
  if (!status) return 1;
  const k = String(status).toLowerCase();
  if (k.indexOf("out") >= 0 || k.indexOf("suspend") >= 0 || k.indexOf("not with team") >= 0) return INJ_PLAY.out;
  if (k.indexOf("doubtful") >= 0) return INJ_PLAY.doubtful;
  if (k.indexOf("question") >= 0 || k.indexOf("day-to-day") >= 0 || k.indexOf("day to day") >= 0) return INJ_PLAY.questionable;
  if (k.indexOf("probable") >= 0 || k.indexOf("available") >= 0) return INJ_PLAY.probable;
  return 1;
}
// What a tag costs in MINUTES rather than in likelihood of playing. Playing
// through something is worth a haircut; the chance of not playing at all is
// handled on the grade, because the ticket is voided and not lost.
function minutesTag(status) {
  const w = injuryWeight(status);
  if (w === 0) return 0;
  if (w <= INJ_PLAY.doubtful) return CFG.qDoubtful;
  if (w <= INJ_PLAY.questionable) return CFG.qQuestionable;
  if (w <= INJ_PLAY.probable) return CFG.qProbable;
  return 1;
}

// ── game logs ───────────────────────────────────────────────────────────────
// The per-player log is what turns a projection into a graded bet: it carries
// the minutes a man is ACTUALLY playing now, how often he has cleared this
// exact line, his floor on a bad night, and his own variance. One call each, so
// it is only paid for the men who can actually make the board.
function parseGamelog(d) {
  if (!d) return null;
  const names = d.names || [];
  // ESPN splits a game log in two: the stat rows carry an eventId, and the
  // dates, opponents and scores live in a separate map keyed by that id. A row
  // therefore has no gameDate of its own, which is why reading one silently
  // disabled every date test in here.
  const meta = (d.events && !Array.isArray(d.events)) ? d.events : {};
  const idx = {};
  (names || []).forEach((n, i) => { idx[String(n)] = i; });
  const findIdx = re => {
    const k = Object.keys(idx).find(k => re.test(k));
    return k ? idx[k] : -1;
  };
  // MEASURED, not assumed. The NBA game log calls this column `totalRebounds`;
  // the box score calls it `REB`; nothing calls it `rebounds`, which is what
  // this looked for. There was no error — the index came back -1, every row was
  // written with 0 rebounds, and the damage surfaced two layers away as
  // rebound props hitting 99% against a predicted 70%: with the log reading
  // zero, only players light enough on minutes to be carried by the positional
  // prior produced a rebound line at all, and theirs came out at 0.5 against
  // men who actually grab five. A silent -1 is the most expensive value in this
  // file.
  const iMin = findIdx(/^minutes$/i), iPts = findIdx(/^points$/i),
        iReb = findIdx(/^(total)?rebounds$/i), iAst = findIdx(/^assists$/i),
        iTp  = findIdx(/^threePointFieldGoals(Made-threePointFieldGoalsAttempted)?$/i);
  const rows = [];
  const walk = ev => {
    const st = ev && ev.stats;
    if (!Array.isArray(st)) return;
    const pick = i => i >= 0 ? num(st[i]) : null;
    // "3-7" is makes-attempts. Both halves are wanted: the makes are the market
    // and the attempts are where its spread comes from.
    const tpPair = iTp >= 0 ? String(st[iTp] || "").split("-") : null;
    const tp = tpPair ? num(tpPair[0]) : null;
    const tpa = tpPair ? num(tpPair[1]) : null;
    const when = ev.gameDate || (meta[ev.eventId] || {}).gameDate || null;
    const min = pick(iMin);
    // A DNP is a row of dashes. It is not a zero-point game and folding it in
    // as one would libel every bench player on the board.
    if (min == null || min <= 0) { rows.push({ dnp: true, date: when }); return; }
    rows.push({ dnp: false, date: when, min,
                pts: pick(iPts) || 0, reb: pick(iReb) || 0, ast: pick(iAst) || 0,
                tpm: tp || 0, tpa: tpa == null ? null : tpa });
  };
  (d.seasonTypes || []).forEach(s => (s.categories || []).forEach(c => (c.events || []).forEach(walk)));
  if (!rows.length && Array.isArray(d.events)) Object.values(d.events).forEach(walk);
  const played = rows.filter(r => !r.dnp);
  if (!played.length) return null;
  // ESPN returns newest first. Keep that order — "last 10" means the last 10.
  return { rows, played, dnp: rows.filter(r => r.dnp).length };
}
async function loadGamelog(get, id, season) {
  const d = await get(`${WEB}/athletes/${id}/gamelog?season=${season}`);
  return parseGamelog(d);
}

// ── as of a date ────────────────────────────────────────────────────────────
// A backtest that prices a January game with a player's FULL-SEASON averages is
// not a backtest, it is the model being shown the answer. The league-wide stat
// feed has no as-of-date version, but the game log does: it carries every game
// he played, with a date on each. So a player's line is rebuilt from his own
// log, using only the games that had actually happened.
//
// What this does NOT fix is stated plainly rather than buried: the TEAM splits
// are still full-season, so pace and the opponent's allowance know a little
// about the future. Both are clamped to about a tenth either way, so the
// residual leak is small — but it is not zero, and a backtest that claims
// otherwise is selling something.
function logBefore(log, day) {
  if (!log) return null;
  const rows = log.rows.filter(r => r.date && etDayOf(r.date) < day);
  const played = rows.filter(r => !r.dnp);
  if (!played.length) return null;
  return { rows, played, dnp: rows.length - played.length };
}
// The season line he would have carried into that night's game.
function lineFrom(log) {
  const g = log && log.played ? log.played : [];
  if (!g.length) return null;
  const mean = f => g.reduce((a, r) => a + (f(r) || 0), 0) / g.length;
  const tpaRows = g.filter(r => r.tpa != null);
  const tpa = tpaRows.length ? tpaRows.reduce((a, r) => a + r.tpa, 0) / tpaRows.length : null;
  const tpm = mean(r => r.tpm);
  return {
    gp: g.length, mpg: mean(r => r.min),
    pts: mean(r => r.pts), reb: mean(r => r.reb), ast: mean(r => r.ast),
    tpm, tpa: tpa == null ? tpm / 0.36 : tpa,
    tpPct: tpa > 0 ? tpm / tpa : null
  };
}

// ── settling a bet ──────────────────────────────────────────────────────────
// What each man actually did, from the finished game's box score. This is the
// other half of a record: a board that recommends bets and never writes down
// how they went is not keeping score, and a grade that grades itself is worth
// nothing.
//
// Parsed by NAME rather than by position, the same way the game log is, because
// a box score's column order is ESPN's business and not ours.
function parseBoxScore(d) {
  const out = {};
  const teams = ((d || {}).boxscore || {}).players || [];
  teams.forEach(t => {
    (t.statistics || []).forEach(st => {
      const names = st.names || st.keys || [];
      const idx = {};
      names.forEach((n, i) => { idx[String(n).toUpperCase()] = i; });
      const at = k => idx[k] != null ? idx[k] : -1;
      const iMin = at("MIN"), iPts = at("PTS"), iReb = at("REB"), iAst = at("AST"), iTp = at("3PT");
      (st.athletes || []).forEach(a => {
        const id = String(((a.athlete || {}).id) || "");
        if (!id) return;
        const v = a.stats || [];
        const pick = i => { const n = num(i >= 0 ? v[i] : null); return n; };
        // A DNP is the case that matters most here: the prop VOIDS, it does not
        // lose, so "no line in the box score" and "a line of zeros" have to stay
        // distinguishable all the way through.
        const dnp = a.didNotPlay === true || !v.length || String(v[iMin] || "").trim() === "--";
        if (dnp) { out[id] = { dnp: true, name: (a.athlete || {}).displayName || null }; return; }
        out[id] = {
          dnp: false, name: (a.athlete || {}).displayName || null,
          min: pick(iMin), pts: pick(iPts) || 0, reb: pick(iReb) || 0, ast: pick(iAst) || 0,
          tpm: iTp >= 0 ? (num(String(v[iTp] || "").split("-")[0]) || 0) : null
        };
      });
    });
  });
  return out;
}
async function loadBoxScore(get, eventId) {
  return parseBoxScore(await get(`${SITE}/summary?event=${eventId}`));
}
// One leg against the box score. Returns null while the answer is not knowable
// yet — an unfinished game, a man missing from a box score that has not been
// filled in — because guessing at settlement is how a record stops being one.
function settle(bet, box) {
  const line = box && box[String(bet.playerId)];
  if (!line) return null;
  if (line.dnp) return { status: "void", actual: null, note: "did not play — stake returned" };
  const got = line[bet.market];
  if (got == null || !isFinite(got)) return null;
  return { status: got > bet.line ? "won" : "lost", actual: got,
           note: `${got} ${MKT[bet.market] ? MKT[bet.market].short : bet.market} against a ${bet.line} line`,
           min: line.min };
}

// ── projection ──────────────────────────────────────────────────────────────
// Per-minute priors by position. A centre is not a point guard with a different
// number of assists — they are different distributions of everything, and the
// prior is what carries a man with nine minutes of season behind him. The 3PM
// prior is derived from the attempt prior at league accuracy, so a big who
// never shoots one is not handed a shooter's prior.
const ROLE = {
  PG: { pts: 0.48, reb: 0.115, ast: 0.190, tpa: 0.170 },
  SG: { pts: 0.47, reb: 0.125, ast: 0.110, tpa: 0.190 },
  SF: { pts: 0.45, reb: 0.150, ast: 0.100, tpa: 0.170 },
  PF: { pts: 0.45, reb: 0.200, ast: 0.080, tpa: 0.140 },
  C:  { pts: 0.46, reb: 0.270, ast: 0.080, tpa: 0.070 },
  G:  { pts: 0.475, reb: 0.120, ast: 0.150, tpa: 0.180 },
  F:  { pts: 0.45, reb: 0.175, ast: 0.090, tpa: 0.155 }
};
const roleOf = pos => ROLE[String(pos || "").toUpperCase()] || { pts: 0.47, reb: 0.181, ast: 0.110, tpa: 0.148 };

// What a defence allows, per possession, against league — because "allows 118 a
// night" is a pace statement as often as it is a defensive one. Halved on the
// way in (defCarry): most of a defensive rate is the schedule that produced it.
function defFactor(oppStats, key, lg) {
  const a = oppStats && oppStats.allow;
  if (!a || !(a.poss > 0) || !(lg.pace > 0)) return 1;
  const lgRate = (lg[key] || 0) / lg.pace;
  const oppRate = (a[key] || 0) / a.poss;
  if (!(lgRate > 0) || !(oppRate > 0)) return 1;
  return clamp(1 + CFG.defCarry * (oppRate / lgRate - 1), 1 - CFG.defClamp, 1 + CFG.defClamp);
}

// The environment both teams are about to play in: how many possessions, and
// how many points each side is going to score. The possessions are ours; the
// points lean on the posted total, which knows about the rest day we do not.
function gameEnv(game, teams, lg) {
  const H = teams[game.home.id] || null, A = teams[game.away.id] || null;
  const tp = t => (t && t.poss > 0) ? t.poss : lg.pace;
  const op = t => (t && t.allow && t.allow.poss > 0) ? t.allow.poss : lg.pace;
  // Two teams' paces combine multiplicatively against league, which is the
  // standard estimate and behaves correctly when a fast team plays a slow one.
  const poss = clamp((tp(H) * tp(A)) / lg.pace, lg.pace * 0.86, lg.pace * 1.16);
  const mdl = t => (t && t.pts > 0 && t.poss > 0) ? (t.pts / t.poss) * poss : lg.pts;
  let homePts = mdl(H), awayPts = mdl(A), src = "model";
  if (game.total > 0) {
    const sp = game.spreadHome != null ? game.spreadHome : 0;
    const mH = game.total / 2 - sp / 2, mA = game.total / 2 + sp / 2;
    homePts = (1 - CFG.totalW) * homePts + CFG.totalW * mH;
    awayPts = (1 - CFG.totalW) * awayPts + CFG.totalW * mA;
    src = game.spreadHome != null ? "total+spread" : "total";
  }
  const paceF = t => {
    const own = tp(t);
    return clamp(poss / own, 1 - CFG.paceClamp, 1 + CFG.paceClamp);
  };
  const scoreF = (t, pts) => {
    if (!t || !(t.pts > 0)) return clamp(pts / lg.pts, 1 - CFG.totalClamp, 1 + CFG.totalClamp);
    return clamp(pts / t.pts, 1 - CFG.totalClamp, 1 + CFG.totalClamp);
  };
  return {
    poss, src, homePts, awayPts, total: homePts + awayPts,
    spreadHome: game.spreadHome,
    home: { stats: H, opp: A, pts: homePts, pace: paceF(H), score: scoreF(H, homePts) },
    away: { stats: A, opp: H, pts: awayPts, pace: paceF(A), score: scoreF(A, awayPts) },
    paceVsLg: poss / lg.pace,
    fast: poss > lg.pace * 1.02, hasTotal: game.total > 0
  };
}

// Minutes, which is the bet. Season average is the prior, the last ten games
// are the evidence, an injured team-mate is a raise and a 14-point spread is a
// pay cut.
function projectMinutes(pl, log, side, env, out) {
  const seasonMin = pl.mpg || 0;
  const recent = log && log.played.length ? log.played.slice(0, 10) : null;
  const recentMin = recent && recent.length ? recent.reduce((a, r) => a + r.min, 0) / recent.length : null;
  // The season average is the prior and the recent run is the evidence — but
  // three games is not evidence, so the recency weight is only paid in full
  // once there are minRecentN of them. A man six games into a new role should
  // be projected into the new role, not into the average of two of them.
  const base = seasonMin;
  const w = recent ? CFG.minRecentW * clamp(recent.length / CFG.minRecentN, 0, 1) : 0;
  let m = recentMin != null ? (1 - w) * base + w * recentMin : base;
  // Minutes freed by the men who are out. Capped, because the fifth starter
  // does not absorb a whole rotation.
  const bump = clamp(CFG.outShare * (out.minutes / 240), 0, CFG.outMax);
  m *= (1 + bump);
  // A blowout takes the fourth quarter off a starter and hands it to men who
  // are not on this board.
  const sp = env.spreadHome;
  const margin = sp == null ? 0 : Math.abs(sp);
  const starter = m >= 26;
  const blow = starter ? clamp((margin - CFG.blowoutFrom) * CFG.blowoutPer, 0, CFG.blowoutMax) : 0;
  m *= (1 - blow);
  // Playing hurt is a haircut, not a coin flip.
  const tag = minutesTag(out.status);
  m *= tag;
  return {
    minutes: clamp(m, 0, 42), base, recentMin, recentW: w, bump, blowout: blow, tag,
    // How steady those minutes have been. A rotation man swinging between 12
    // and 31 is a different bet from one who plays 28 every night, whatever
    // their averages say.
    sd: recent && recent.length >= 4 ? Math.sqrt(recent.reduce((a, r) => a + (r.min - recentMin) * (r.min - recentMin), 0) / (recent.length - 1)) : null,
    starter
  };
}

// The per-minute rates, shrunk to the positional prior by minutes played, then
// put back through tonight's environment.
function projectPlayer(pl, log, side, env, lg, out) {
  const mins = projectMinutes(pl, log, side, env, out);
  const role = roleOf(pl.pos);
  const totMin = Math.max(0, (pl.mpg || 0) * (pl.gp || 0));
  const rate = (key, perGame, prior) => shrink((perGame || 0) * (pl.gp || 0), totMin, prior, MKT[key] ? MKT[key].stab : 240);
  const rPts = rate("pts", pl.pts, role.pts);
  const rReb = rate("reb", pl.reb, role.reb);
  const rAst = rate("ast", pl.ast, role.ast);
  const rTpa = rate("tpm", pl.tpa, role.tpa);
  // 3P% is a rate on attempts, not on minutes: shrink it by attempts, which is
  // the only sample size that means anything for a shooting percentage. 250
  // attempts is roughly where a shooter's own number starts to beat league.
  const tpaTot = (pl.tpa || 0) * (pl.gp || 0);
  const tpPct = clamp(shrink((pl.tpPct != null ? pl.tpPct : lg.tpPct) * tpaTot, tpaTot, lg.tpPct, 250), 0.20, 0.50);

  const side_ = side === "home" ? env.home : env.away;
  const opp = side_.opp;
  // When the posted total is in, half the defensive adjustment for the scoring
  // markets is already inside it — the book did not arrive at a 219 total by
  // ignoring who is defending. Applying both in full is the same edge counted
  // twice, and double-counting is how a model talks itself into a bet.
  const dmp = env.hasTotal ? 0.5 : 1;
  const dmix = (key, d) => 1 + (defFactor(opp, key, lg) - 1) * d;
  const homeF = side === "home" ? CFG.homeRate : 1;

  const mPts = rPts * mins.minutes * side_.score * dmix("pts", dmp) * out.usage * homeF;
  const mReb = rReb * mins.minutes * side_.pace * dmix("reb", 1);
  const mAst = rAst * mins.minutes * Math.pow(side_.score, 0.8) * dmix("ast", dmp) * out.usage;
  const mTpa = rTpa * mins.minutes * side_.pace * dmix("tpm", dmp) * homeF;
  const mTpm = mTpa * tpPct;

  return {
    mins, rates: { pts: rPts, reb: rReb, ast: rAst, tpa: rTpa, tpPct },
    proj: { pts: mPts, reb: mReb, ast: mAst, tpm: mTpm },
    tpa: mTpa,
    factors: {
      pace: side_.pace, score: side_.score,
      def: { pts: defFactor(opp, "pts", lg), reb: defFactor(opp, "reb", lg), ast: defFactor(opp, "ast", lg), tpm: defFactor(opp, "tpm", lg) },
      usage: out.usage, bump: mins.bump, blowout: mins.blowout, defDamp: dmp
    }
  };
}

// ── from a projection to a probability ──────────────────────────────────────
// The family's standard deviation, then the player's own, blended by how many
// games we have actually watched him play. A parametric family cannot know that
// one 16-point scorer goes 16, 15, 17 and another goes 4, 31, 12; the log can.
function spread(key, mean, log, extra) {
  const cv = MKT[key].cv;
  // The family's own spread. For threes the dispersion is derived from the
  // ATTEMPTS: att*q(1-q) + q^2*Var(att) reduces EXACTLY to mean + (cvAtt*mean)^2,
  // so at a fixed attempt dispersion two men averaging 2.2 makes have the same
  // spread whether that came off eleven attempts or four. That is worth saying
  // plainly rather than pretending otherwise — what separates those two shooters
  // on this board is not the family, it is the blended term below: their own
  // observed game-to-game spread, which is measured and does differ.
  const c = (key === "tpm" && extra && extra.tpa > 0) ? MKT.tpm.cvAtt : cv;
  let sd = Math.sqrt(Math.max(1e-9, mean + (c * mean) * (c * mean)));
  const familySd = sd;
  let obs = null, ratio = 1;
  const rows = log && log.played.length >= 5 ? log.played.slice(0, 20) : null;
  if (rows && mean > 0) {
    const vals = rows.map(r => r[key] || 0);
    const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (mu > 0.5) {
      const v = vals.reduce((a, b) => a + (b - mu) * (b - mu), 0) / Math.max(1, vals.length - 1);
      // Scale the observed spread to OUR mean before comparing: he is projected
      // for different minutes tonight than he averaged, and a raw sd from a
      // different mean is not a comparable number.
      obs = Math.sqrt(Math.max(1e-9, v)) * Math.sqrt(mean / mu);
      const w = vals.length / (vals.length + CFG.varStab);
      const blended = (1 - w) * sd + w * obs;
      ratio = clamp(blended / sd, CFG.varClamp[0], CFG.varClamp[1]);
      sd = sd * ratio;
    }
  }
  return { sd, familySd, obs, ratio, n: rows ? rows.length : 0 };
}

// P(he goes OVER this line). A prop line is always a half number, so "over
// 24.5" is "25 or more" — the tail is taken at the integer above, and the
// distribution used is the one that market actually has.
function overProb(key, mean, sp, line, extra) {
  if (!(mean > 0)) return 0;
  const need = Math.floor(line) + 1;
  if (key === "tpm") {
    // Summed over the attempt distribution rather than assumed: the arithmetic
    // comes out at a negative binomial either way, but this is where the
    // dispersion is actually derived from, and it stays right if the attempt
    // model is ever given a shape of its own.
    const att = Math.max(0.2, (extra && extra.tpa) || mean / 0.36);
    const q = clamp(mean / att, 0.05, 0.75);
    const cvA = MKT.tpm.cvAtt * (sp && sp.ratio ? sp.ratio : 1);
    const k = 1 / Math.max(1e-4, cvA * cvA);
    return clamp(compoundAtLeast(att, k, q, need), 0, 1);
  }
  // Negative binomial matched on (mean, blended variance).
  const varr = sp.sd * sp.sd;
  const k = varr > mean ? (mean * mean) / (varr - mean) : 1e6;   // variance at or below Poisson -> Poisson
  return clamp(nbAtLeast(mean, k, need), 0, 1);
}

// Every alternate line a book would hang on this market, with our probability
// on each. Books quote a ladder on all four of these, so the question is never
// "is 24.5 a good bet" — it is which rung of his own ladder is the bet.
//
// WHICH rung is not decided here, and deliberately not by "the highest one that
// clears the target", which is what this used to do. That rule is degenerate on
// a low-mean count: a man projected for 2.2 threes clears 70% at 0.5 and not at
// 1.5, so the whole board collapses onto o0.5 legs at a fair price of -900 —
// the likeliest bets available and among the worst, and nine of them in a row
// at the top of a board is not a board. The caller scores every rung and keeps
// the best, which is the same question the grade already answers.
function ladderLines(key, mean, sp, extra) {
  const out = [];
  const top = Math.max(1, Math.ceil(mean * 2 + 6));
  for (let L = 0.5; L <= Math.min(MKT[key].max, top); L += 1) {
    const p = overProb(key, mean, sp, L, extra);
    out.push({ line: L, p });
    if (p < 0.12) break;
  }
  return { rungs: out };
}

// ── the HAIrdwood score ──────────────────────────────────────────────────────
// A hundred points, published in full, because a ranking nobody can check is
// just a number in a large font. Seven things earn points and five take them
// away, and every one appears on the card with its own line and its own reason.
//
// The rule that keeps it honest: WHEN AN INPUT IS MISSING, ITS COMPONENT IS
// DROPPED AND ITS WEIGHT COMES OUT OF THE DENOMINATOR. A man with no game log
// is not quietly credited with good form, and he is not silently punished for
// it either — he is scored out of the 74 points we can actually measure, and
// the card says so.
const GRADES = [
  { at: 88, g: "A+", note: "as close to a lock as this sport offers" },
  { at: 80, g: "A",  note: "the bet you make if you make one" },
  { at: 72, g: "B+", note: "strong — a clear edge in the likely column" },
  { at: 64, g: "B",  note: "solid, with something you can name against it" },
  { at: 55, g: "C+", note: "playable, not a headline" },
  { at: 45, g: "C",  note: "a coin flip wearing a suit" },
  { at: 0,  g: "D",  note: "listed so you can see why it is not a bet" }
];
const gradeOf = s => GRADES.find(g => s >= g.at) || GRADES[GRADES.length - 1];

const frac = (v, full) => clamp(v / full, 0, 1);

// The measured correction, applied to every probability this model publishes.
// Kept as one function so the board, the alerter and the backtest cannot end up
// running three different versions of the same apology.
function calibrate(p) {
  const C = CFG.calib;
  return clamp(C.centre + C.k * (p - C.centre), 0.02, 0.98);
}

function scoreLeg(leg) {
  const W = CFG.weights, parts = [];
  let earned = 0, available = 0;
  const add = (key, label, pts, max, note) => {
    parts.push({ key, label, pts: +pts.toFixed(1), max, note });
    earned += pts; available += max;
  };
  const skip = (key, label, note) => parts.push({ key, label, pts: null, max: 0, note, missing: true });

  // 1. LIKELIHOOD. The model's own probability, stretched across the band a
  //    prop bet actually lives in: a 50% leg earns nothing here and a 90% one
  //    earns all of it.
  const z = leg.sd > 0 ? (leg.mean - leg.line) / leg.sd : 0;
  add("like", "Likelihood", W.like * frac(leg.p - 0.50, 0.40), W.like,
      `${Math.round(leg.p * 100)}% to clear ${leg.line} — projected ${leg.mean.toFixed(1)}, ${z >= 0 ? "+" : ""}${z.toFixed(2)} sd over it`);

  // 2. ROLE. Minutes, and how reliable they have been. Thirty-four steady
  //    minutes is most of a prop; twenty-two that swing by eight is a trap.
  const m = leg.mins;
  let roleF = 0.55 * frac(m.minutes - 16, 18);
  if (m.sd != null) roleF += 0.45 * (1 - frac(m.sd - 2.5, 7.5));
  else roleF += 0.45 * (leg.gs / Math.max(1, leg.gp) >= 0.7 ? 0.7 : 0.35);
  add("role", "Role & minutes", W.role * clamp(roleF, 0, 1), W.role,
      `${m.minutes.toFixed(1)} projected min${m.sd != null ? ` · L10 swing ±${m.sd.toFixed(1)}` : ""}${m.bump > 0.005 ? ` · +${Math.round(m.bump * 100)}% from absences` : ""}`);

  // 3. MATCHUP. The opponent's allowance in this market and the pace of the
  //    game, both of which are already inside the projection — this is the
  //    part of the grade that says WHY the projection is where it is.
  if (leg.factors && leg.factors.def) {
    const d = leg.factors.def[leg.market] || 1, pace = leg.factors.pace || 1;
    const mf = clamp(0.5 + 2.2 * (d - 1) + 1.6 * (pace - 1), 0, 1);
    add("matchup", "Matchup & pace", W.matchup * mf, W.matchup,
        `${d >= 1 ? "+" : ""}${((d - 1) * 100).toFixed(1)}% vs this defence · ${pace >= 1 ? "+" : ""}${((pace - 1) * 100).toFixed(1)}% pace`);
  } else skip("matchup", "Matchup & pace", "no team splits in the feed");

  // 4. PRICE. The likeliest bet on any board is the cheapest line on it, and
  //    it is usually not the best bet on it: a ladder of 92% legs at -1150
  //    turns $10 into $10.87 a day and still busts one cycle in four. So the
  //    grade carries what the bet is worth as well as how likely it is, and a
  //    leg that has climbed to a real line beats one that stayed on 0.5.
  add("price", "Price & payout", W.price * (1 - frac(leg.p - CFG.priceFull, CFG.priceZero - CFG.priceFull)), W.price,
      `fair ${amOdds(leg.p)}${leg.p > CFG.priceFull ? " — short, and it compounds slowly" : ""}`);

  // 5. FORM. How often he has actually cleared this exact line lately. The
  //    most persuasive number on the card and the easiest to over-read, so it
  //    is only worth nine points and only counts with five games behind it.
  if (leg.form && leg.form.n >= 5) {
    add("form", "Recent form", W.form * frac(leg.form.rate - 0.35, 0.50), W.form,
        `${leg.form.hits}/${leg.form.n} over ${leg.line} in his last ${leg.form.n}`);
  } else skip("form", "Recent form", leg.form ? `only ${leg.form.n} games logged` : "no game log");

  // 6. FLOOR. What happens on his worst night. A bet whose bad games still
  //    clear the line is a different animal from one that needs a good one.
  if (leg.form && leg.form.n >= 5) {
    const f = leg.form.p25;
    add("floor", "Floor", W.floor * clamp(0.25 + 0.75 * frac(f - leg.line, Math.max(1, leg.line * 0.25)), 0, 1), W.floor,
        `bottom-quartile night is ${f.toFixed(1)}`);
  } else skip("floor", "Floor", "no game log");

  // ── what comes off ────────────────────────────────────────────────────────
  const pen = [];
  const take = (label, pts, note) => { if (pts > 0) { pen.push({ label, pts: +pts.toFixed(1), note }); earned -= pts; } };
  const tag = String(leg.status || "").toLowerCase();
  if (tag) {
    if (tag.indexOf("doubtful") >= 0) take("Doubtful", 16, "the ticket voids if he sits, and he is barely playing if he does not");
    else if (tag.indexOf("question") >= 0 || tag.indexOf("day") >= 0) take("Questionable", 9, "minutes already cut for it; the void risk is the rest");
    else if (tag.indexOf("probable") >= 0 || tag.indexOf("available") >= 0) take("Probable", 2, "on the report, expected to play");
  }
  if (leg.factors && leg.factors.blowout > 0) take("Blowout risk", 8 * frac(leg.factors.blowout, CFG.blowoutMax),
      `${Math.abs(leg.spreadHome || 0)}-point spread — the fourth quarter may not be his`);
  if (leg.b2b) take("Back-to-back", 4, "played last night");
  if (leg.gp < 8) take("Thin sample", 6 * (1 - frac(leg.gp, 8)), `${leg.gp} games of evidence`);
  if (leg.spreadRatio > 1.25) take("Volatile", 4 * clamp((leg.spreadRatio - 1.25) / 0.3, 0, 1),
      "his own game-to-game swing is wider than the market's shape");

  const score = available > 0 ? clamp(100 * earned / available, 0, 100) : 0;
  const g = gradeOf(score);
  return { score: +score.toFixed(1), grade: g.g, note: g.note, parts, penalties: pen,
           earned: +earned.toFixed(1), available };
}

// The same schema for a two-leg double. The likelihood band moves — a double at
// 60% is a good double — and the correlation between the legs is worth points
// of its own, because it is the only part of a same-game parlay that the naive
// price is definitely getting wrong.
function scorePair(a, b, joint, naive) {
  const parts = [];
  let earned = 0, available = 0;
  const add = (key, label, pts, max, note) => { parts.push({ key, label, pts: +pts.toFixed(1), max, note }); earned += pts; available += max; };
  const fracOf = (leg, key) => {
    const p = leg.score.parts.find(x => x.key === key);
    return (p && p.pts != null && p.max > 0) ? p.pts / p.max : null;
  };
  const avg = key => {
    const x = fracOf(a, key), y = fracOf(b, key);
    if (x == null && y == null) return null;
    return ((x == null ? y : x) + (y == null ? x : y)) / 2;
  };
  // The band a double actually lives in, AFTER the measured corrections. This
  // used to run 33% to 78%, which was calibrated against joints the model no
  // longer publishes: shrinking the legs and shading the pair moved a typical
  // double from the high sixties into the high fifties, and the old band scored
  // every one of them so low that three doubles cleared the bar in a whole
  // season where 236 had before. The scale has to measure the bets that exist,
  // not the ones the model used to claim.
  add("like", "Both legs land", 40 * frac(joint - 0.42, 0.26), 40, `${Math.round(joint * 100)}% for the pair`);
  const ro = avg("role"), mp = avg("price");
  add("legs", "Leg quality", 18 * clamp(0.6 * (ro == null ? 0.4 : ro) + 0.4 * (mp == null ? 0.4 : mp), 0, 1), 18,
      `${a.score.grade} + ${b.score.grade} on their own`);
  // Same rule as a single: a double of two near-certainties pays nothing, and
  // a double is the one bet people reach for precisely because it should pay.
  add("price", "Price & payout", 10 * (1 - frac(joint - 0.55, 0.20)), 10, `fair ${amOdds(joint)} for the pair`);
  const lift = joint - naive;
  add("corr", "Correlation", 10 * frac(lift, 0.045), 10,
      lift >= 0 ? `+${(lift * 100).toFixed(1)}pts over pricing them apart` : `${(lift * 100).toFixed(1)}pts — these two fight each other`);
  const mu = avg("matchup");
  if (mu != null) add("matchup", "Game environment", 10 * mu, 10, "pace and both defences");
  const fo = avg("form");
  if (fo != null) add("form", "Recent form", 7 * fo, 7, "how often each has cleared it lately");
  const fl = avg("floor");
  if (fl != null) add("floor", "Floors", 5 * fl, 5, "both legs on a bad night");
  // A pair inherits its legs' penalties: the injury tag and the blowout are
  // properties of the night, and putting two of them on one ticket does not
  // make either go away.
  const pen = [];
  [a, b].forEach(l => (l.score.penalties || []).forEach(p => {
    pen.push({ label: `${l.pl.name}: ${p.label}`, pts: +(p.pts / 2).toFixed(1), note: p.note });
    earned -= p.pts / 2;
  }));
  const score = available > 0 ? clamp(100 * earned / available, 0, 100) : 0;
  const g = gradeOf(score);
  return { score: +score.toFixed(1), grade: g.g, note: g.note, parts, penalties: pen, available };
}

// ── correlation between two legs ────────────────────────────────────────────
function rhoFor(a, b, env) {
  const k = [a.market, b.market].sort().join("|");
  const tbl = a.pl.id === b.pl.id ? CFG.rho.self
            : a.teamId === b.teamId ? CFG.rho.same
            : CFG.rho.opp;
  let base = tbl[k];
  if (base == null) base = a.pl.id === b.pl.id ? 0.2 : (a.teamId === b.teamId ? 0.02 : 0.04);
  if (a.pl.id === b.pl.id && a.market === b.market) return 0.999;
  // A fast, high-scoring game moves everything in it together harder than a
  // rock fight does. Bounded to half and double, so it can shade a number and
  // never invent one.
  const env_ = env ? (env.paceVsLg - 1) : 0;
  const g = 1 + CFG.rhoEnvGain * (env_ / 0.05);
  const scaled = base * CFG.rhoScale;
  return scaled >= 0 ? clamp(scaled * g, scaled * 0.5, scaled * 2) : clamp(scaled * g, scaled * 2, scaled * 0.5);
}

// The best pair in one game. Every combination is enumerated rather than
// assuming the two likeliest legs make the best double: once correlation is
// priced, a passer and his own shooter routinely beat two higher singles from
// opposite sides of the floor.
function bestDouble(legs, env, opts) {
  opts = opts || {};
  let pool = (legs || []).slice().sort((x, y) => y.score.score - x.score.score).slice(0, opts.depth || 20);
  if (pool.length < 2) return null;
  const out = [];
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const a = pool[i], b = pool[j];
    const samePlayer = a.pl.id === b.pl.id;
    if (samePlayer && !opts.allowSame) continue;
    if (opts.onlyTeam && a.teamId !== b.teamId) continue;
    const rho = rhoFor(a, b, env);
    const naive = a.p * b.p;
    const prob = clamp(jointProb(a.p, b.p, rho) * CFG.pairShrink, 1e-4, 1 - 1e-4);
    const sc = scorePair(a, b, prob, naive);
    out.push({ a, b, rho, prob, naive, lift: prob - naive, score: sc, samePlayer, sameTeam: a.teamId === b.teamId });
  }
  out.sort((x, y) => y.score.score - x.score.score || y.prob - x.prob);
  return out.length ? { best: out[0], all: out.slice(0, 12) } : null;
}

// ── the compounding ladder ──────────────────────────────────────────────────
// One bet a day: the single highest-graded prop on the whole slate, whichever
// of the four markets it happens to be in. Win and the entire return rides the
// next day; five wins closes the cycle and the money comes off the table. A
// miss ends the cycle there and the next one starts 25% bigger.
//
// The arithmetic that matters, stated where it cannot be skipped: only the
// cycle's SEED is ever our money. Everything after day one is the book's, so a
// miss on day four costs exactly what a miss on day one costs. That is the
// single feature separating this from a martingale. What it does NOT do is
// make the thing likely — five legs at 75% is 23.7%, so three cycles in four
// end in a bust, and the escalation compounds. Both numbers are computed live
// and shown on the card, because a ladder sold without them is a martingale in
// a good suit.
const LADDER = {
  account: 100,    // starting bankroll
  seed: 10,        // day-1 stake of the first cycle
  basePct: 0.10,   // after a completed cycle, the next seed is 10% of the account
  rungs: 5,        // wins needed to close a cycle
  missGain: 0.25   // a busted cycle restarts this much bigger
};
const round2 = v => Math.round(v * 100) / 100;

// Replay the settled history and return where the ladder stands right now.
// `history` is chronological: { date, price (American), stake, status:
// "won"|"lost"|"void"|"open", pick }. A VOID is the basketball-specific case
// the baseball ladder never had to think about: the man did not play, the book
// refunded the stake, and the rung is simply re-run tomorrow — no money moved,
// no cycle ended.
function ladder(history, cfg) {
  const C = Object.assign({}, LADDER, cfg || {});
  let account = C.account, base = C.seed, stake = C.seed, rung = 1, cycle = 1;
  let peak = account, maxDD = 0, staked = 0, cycles = { done: 0, busted: 0 }, voids = 0;
  const rows = [];
  for (const b of history || []) {
    const dec = decFromAmerican(b.price) || 1;
    const at = b.stake != null ? +b.stake : stake;
    const row = { date: b.date, cycle, rung, stake: at, price: b.price, pick: b.pick || null,
                  market: b.market || null, line: b.line != null ? b.line : null,
                  p: b.p != null ? b.p : null, status: b.status, pl: 0, closed: null };
    if (b.status === "won") {
      const ret = round2(at * dec);
      row.ret = ret;
      if (rung >= C.rungs) {
        row.pl = round2(ret - base); row.closed = "complete";
        account = round2(account + row.pl); staked += base; cycles.done++;
        cycle++; rung = 1; base = round2(Math.max(0, account) * C.basePct); stake = base;
      } else { rung++; stake = ret; }
    } else if (b.status === "lost") {
      row.pl = -base; row.closed = "busted";
      account = round2(account - base); staked += base; cycles.busted++;
      cycle++; rung = 1; base = round2(base * (1 + C.missGain)); stake = base;
    } else if (b.status === "void" || b.status === "push") {
      row.closed = "void"; voids++;                      // stake back, same rung tomorrow
      rows.push(row); continue;
    } else { rows.push(row); continue; }                 // open — the state freezes here
    peak = Math.max(peak, account);
    maxDD = Math.max(maxDD, peak - account);
    rows.push(row);
  }
  const open = (history || []).some(b => b.status === "open");
  return { cfg: C, rows, account, base, stake: round2(stake), rung, cycle, open, voids,
           atRisk: base, onTable: round2(stake - base),
           staked: round2(staked), pl: round2(account - C.account), peak, maxDD: round2(maxDD),
           cycles, canFund: stake <= account + 1e-9 };
}

function ladderRisk(p, american, state) {
  const C = (state && state.cfg) || LADDER;
  const dec = decFromAmerican(american);
  if (!dec || !(p > 0 && p < 1)) return null;
  const base = (state && state.base) || C.seed;
  const account = (state && state.account) || C.account;
  const cycleWin = Math.pow(p, C.rungs);
  const fullReturn = base * Math.pow(dec, C.rungs);
  const cycleProfit = fullReturn - base;
  const cycleEv = cycleWin * cycleProfit - (1 - cycleWin) * base;
  const legEv = p * (dec - 1) - (1 - p);
  let bal = account, b = base, n = 0;
  while (b <= bal && n < 40) { bal -= b; b = b * (1 + C.missGain); n++; }
  return { dec, cycleWin, fullReturn, cycleProfit, cycleEv, legEv,
           bustsSurvived: n, pBust: Math.pow(1 - cycleWin, n + 1),
           rungStakes: Array.from({ length: C.rungs }, (_, i) => round2(base * Math.pow(dec, i))) };
}

// ── the board ───────────────────────────────────────────────────────────────
// One entry point. Everything above is pure enough to test on its own; this is
// the part that talks to the feed, and it is written to degrade rather than
// fail — a missing team split costs the matchup component, a missing game log
// costs form and floor, and the board says which.
async function buildBoard(o) {
  o = o || {};
  const get = o.getJSON || defaultGetJSON;
  const say = o.onStatus || function () {};
  const prog = o.onProgress || function () {};
  // A FLOOR, not a target: publish nothing less likely than this. It used to be
  // the thing being solved for (0.70, "climb to it"), which on a low-mean count
  // filtered out every rung except the cheapest and left the value selection
  // below with one candidate and nothing to choose. The grade picks the rung
  // now; this only says how far down the board is willing to look.
  const target = o.target != null ? o.target : 0.60;
  const day = o.day || slateYmd();
  const degraded = [];
  const soft = (label, p) => p.catch(() => { degraded.push(label); return null; });

  say("Tonight's slate…"); prog(5);
  const slate = await loadSlate(get, day);
  const live = slate.games.filter(g => o.includeFinal ? true : !g.final);
  if (!live.length) {
    // Out of season the useful answer is when, not nothing.
    say("No NBA games today — looking for the next slate…"); prog(30);
    const next = await nextSlateDay(get, day, o.lookahead || 45);
    prog(0);
    return { date: day, season: slate.season, empty: true, nextDay: next, games: [], legs: [], slates: [], degraded };
  }

  const season = slate.season || seasonOf(day);
  say("League rates, team splits…"); prog(15);
  let [players, teams] = await Promise.all([
    soft("player stats", cached(`players:${season}`, CACHE_TTL.stats, () => loadPlayers(get, season, (d, n) => prog(15 + 20 * d / n)))),
    soft("team splits", cached(`teams:${season}`, CACHE_TTL.stats, () => loadTeamStats(get, season)))
  ]);
  // Opening night, and every October: this season's feed is empty because
  // nothing has been played. Last season's rates are a far better prior than
  // no rates at all, as long as the board SAYS that is what it is showing.
  let priorSeason = false;
  if (!players || players.length < 40) {
    say("No stats for this season yet — falling back to last season…"); prog(22);
    const back = await Promise.all([
      soft("player stats", cached(`players:${season - 1}`, CACHE_TTL.stats, () => loadPlayers(get, season - 1))),
      soft("team splits", cached(`teams:${season - 1}`, CACHE_TTL.stats, () => loadTeamStats(get, season - 1)))
    ]);
    if (back[0] && back[0].length >= 40) { players = back[0]; teams = back[1] || teams; priorSeason = true; }
  }
  players = players || [];
  teams = teams || {};
  const lg = leagueFrom(teams);

  const byTeam = {};
  players.forEach(p => { if (p.teamId) (byTeam[p.teamId] = byTeam[p.teamId] || []).push(p); });
  Object.keys(byTeam).forEach(t => byTeam[t].sort((a, b) => b.mpg - a.mpg));

  // Rosters, so a man traded in February is projected into the team he plays
  // for tonight rather than the one his season line was earned with. Skipped
  // when pricing a past date: today's roster is not who was on it then, and a
  // filter that is wrong is worse than no filter.
  const teamIds = [...new Set(live.flatMap(g => [g.home.id, g.away.id]))];
  // Declared out here on purpose: the candidate filter below reads it, and
  // tucking it inside the branch is exactly how this went out with `roster is
  // not defined` and took the whole board down. An empty map means "no roster
  // filter", which is what skipping it should mean.
  const roster = {};
  if (o.rosters !== false) {
    say("Rosters…"); prog(38);
    const rosterList = await pool(teamIds, async t => {
      try { return { t, r: await cached(`roster:${t}`, CACHE_TTL.roster, () => loadRoster(get, t)) }; } catch (e) { return null; }
    }, 6);
    rosterList.forEach(x => { if (x && x.r && x.r.length) roster[x.t] = new Set(x.r.map(p => p.id)); });
    if (Object.keys(roster).length < teamIds.length) degraded.push("some rosters");
  }

  say("Injury reports and the market's number…"); prog(48);
  const sumList = await pool(live, async g => ({ g, s: await loadSummary(get, g.id) }), 4);
  const injByTeam = {};
  let priced = 0;
  sumList.forEach(x => {
    if (!x || !x.s) return;
    Object.keys(x.s.injuries).forEach(t => { injByTeam[t] = Object.assign(injByTeam[t] || {}, x.s.injuries[t]); });
    // Whatever the scoreboard gave stands; this only fills the gap, which on a
    // finished game — and on plenty of upcoming ones — is the whole thing.
    const od = x.s.odds;
    if (od) {
      if (!(x.g.total > 0) && od.total > 0) { x.g.total = od.total; x.g.oddsTxt = x.g.oddsTxt || od.details; }
      if (x.g.spreadHome == null && od.spreadHome != null) { x.g.spreadHome = od.spreadHome; x.g.oddsTxt = x.g.oddsTxt || od.details; }
    }
    if (x.g.total > 0) priced++;
  });
  if (!Object.keys(injByTeam).length) degraded.push("injury report");
  if (!priced) degraded.push("posted totals");

  // Who is missing, and what they were doing. This is the number that moves a
  // prop line in the last hour before tip, so it is computed per team once and
  // carried into every projection on that side.
  const absence = {};
  teamIds.forEach(t => {
    const list = byTeam[t] || [], inj = injByTeam[t] || {};
    let minutes = 0, pts = 0, ast = 0, names = [];
    const teamPts = list.reduce((a, p) => a + (p.pts || 0), 0) || 1;
    list.forEach(p => {
      const w = injuryWeight(inj[p.id]);
      if (w >= 1 || (p.mpg || 0) < 8) return;
      const gone = 1 - w;
      minutes += (p.mpg || 0) * gone; pts += (p.pts || 0) * gone; ast += (p.ast || 0) * gone;
      if (gone > 0.5) names.push(p.name + (w === 0 ? "" : " (" + (inj[p.id] || "") + ")"));
    });
    absence[t] = {
      minutes, pts, ast, names,
      // The ball the missing men are not using has to be used by somebody.
      // Capped at +12%, because a role is not infinitely elastic.
      usage: clamp(1 + 0.35 * (pts / teamPts), 1, 1.12)
    };
  });

  // Candidates: rotation men only, and only for the teams playing tonight.
  const perTeam = o.perTeam || 8;
  const cand = [];
  live.forEach(g => {
    const env = gameEnv(g, teams, lg);
    [["home", g.home, g.away], ["away", g.away, g.home]].forEach(([side, team, opp]) => {
      const inj = injByTeam[team.id] || {};
      const rs = roster[team.id];
      (byTeam[team.id] || [])
        // Priced as of a past date, the season-long minutes are the wrong sieve
        // — a man who started in November and lost his place by March would be
        // filtered out of a November board by what happened afterwards. The bar
        // is dropped here and applied again below against the as-of line, which
        // is the number that was actually knowable.
        .filter(p => (p.mpg || 0) >= (o.asOf ? 8 : CFG.minMinutes) && (p.gp || 0) >= CFG.minGames)
        .filter(p => !rs || rs.has(p.id))
        .filter(p => injuryWeight(inj[p.id]) > 0)
        .slice(0, perTeam)
        .forEach(p => cand.push({ p, g, env, side, team, opp, status: inj[p.id] || null }));
    });
  });
  if (!cand.length) return { date: day, season, games: [], legs: [], slates: [], empty: false, note: "no rotation players resolved", degraded, lg, priorSeason };

  // Game logs, for the men who can actually make the board. Capped: this is one
  // call per player and a twelve-game slate would otherwise be two hundred.
  const logs = {};
  if (o.gamelogs !== false) {
    const order = cand.slice().sort((a, b) => (b.p.mpg || 0) - (a.p.mpg || 0)).slice(0, o.maxLogs || 90);
    say(`Game logs for ${order.length} rotation players…`); prog(55);
    await pool(order, async c => {
      try {
        const sn = priorSeason ? season - 1 : season;
        const l = await cached(`log:${c.p.id}:${sn}`, CACHE_TTL.log, () => loadGamelog(get, c.p.id, sn));
        if (l) logs[c.p.id] = l;
      } catch (e) {}
    }, 8, (d, n) => prog(55 + 30 * d / n));
    if (!Object.keys(logs).length) degraded.push("game logs");
  }

  // Yesterday, in Eastern time — a back-to-back is a real penalty and the only
  // way to see one is the log.
  const yest = addDays(day, -1);
  const playedOn = (log, d) => !!(log && log.played.some(r => r.date && etDayOf(r.date) === d));

  say("Pricing every prop…"); prog(88);
  const legs = [];
  cand.forEach(c => {
    let log = logs[c.p.id] || null;
    // Everything downstream — minutes, form, floor, the variance blend, the
    // back-to-back — reads the log, so cutting it here is what makes the whole
    // projection as-of rather than just the averages.
    if (o.asOf) {
      log = logBefore(log, o.asOf);
      const line = lineFrom(log);
      if (!line || line.gp < CFG.minGames || line.mpg < CFG.minMinutes) return;
      c = Object.assign({}, c, { p: Object.assign({}, c.p, line) });
    }
    const out = Object.assign({}, absence[c.team.id] || { minutes: 0, pts: 0, usage: 1, names: [] }, { status: c.status });
    const pr = projectPlayer(c.p, log, c.side, c.env, lg, out);
    if (!(pr.mins.minutes >= 10)) return;
    MARKETS.forEach(mk => {
      const mean = pr.proj[mk.key];
      if (!(mean > 0.8)) return;                          // not a market anyone hangs a line on
      const sp = spread(mk.key, mean, log, { tpa: pr.tpa });
      const lad = ladderLines(mk.key, mean, sp, { tpa: pr.tpa });
      // Every rung carries the measured correction from here on, so the grade,
      // the line choice, the fair price and the ladder all read the same number.
      lad.rungs.forEach(r => { r.raw = r.p; r.p = calibrate(r.p); });
      // Every rung this man could be bet at, graded, best one kept. `target` is
      // a FLOOR now rather than the thing being solved for — publish nothing
      // less likely than you asked for — and pCeil drops the tails no book
      // would take anyway. The grade decides the rest, which is the point of
      // having a grade: it already knows that a 70% line at a real number beats
      // an 88% line at a price that cannot compound.
      const cands = lad.rungs.filter(r => r.line >= CFG.lineMin && r.p >= Math.max(CFG.pFloor, target) && r.p <= CFG.pCeil);
      if (!cands.length) return;
      // How often he has actually done it, and what the bad nights look like.
      // Recomputed per rung, because "9 of his last 10" is a claim about ONE
      // line and means nothing carried across to another.
      const last = log && log.played.length ? log.played.slice(0, 10) : null;
      const vals = last ? last.map(r => r[mk.key] || 0) : null;
      const sorted = vals ? vals.slice().sort((x, y) => x - y) : null;
      const formAt = line => vals ? {
        n: vals.length, hits: vals.filter(v => v > line).length,
        rate: vals.filter(v => v > line).length / vals.length,
        p25: sorted[Math.floor(Math.max(0, sorted.length - 1) * 0.25)] || 0,
        avg: vals.reduce((a, b) => a + b, 0) / vals.length, vals
      } : null;

      const build = r => {
        const leg = {
          pl: c.p, gameId: c.g.id, game: c.g, teamId: c.team.id, teamAbbr: c.team.abbr,
          oppAbbr: c.opp.abbr, side: c.side, isHome: c.side === "home",
          market: mk.key, marketLabel: mk.label, marketShort: mk.short,
          line: r.line, p: r.p, mean, sd: sp.sd, spreadRatio: sp.ratio, sdObs: sp.obs,
          rungs: lad.rungs, mins: pr.mins, factors: pr.factors, rates: pr.rates,
          status: c.status, gp: c.p.gp, gs: c.p.gs, seasonAvg: c.p[mk.key],
          b2b: playedOn(log, yest), hasLog: !!log, form: formAt(r.line),
          spreadHome: c.g.spreadHome, total: c.g.total, env: c.env
        };
        leg.pRaw = r.raw != null ? r.raw : r.p;   // before the measured correction
        leg.score = scoreLeg(leg);
        return leg;
      };
      // Two different questions, each answered by the right number. WHICH rung
      // to publish is a value question — the grade weighted by what the bet
      // actually returns — because the likeliest rung on a man's ladder is
      // always his cheapest one, and a board of nine o0.5 threes at -900 is
      // not a board. HOW GOOD the published rung is stays the grade, which is
      // what the ranking asked for.
      const val = l => l.score.score * Math.sqrt(Math.max(1e-9, 1 / l.p - 1));
      const leg = cands.map(build).sort((a, b) => val(b) - val(a) || b.score.score - a.score.score)[0];
      const p = leg.p;
      leg.fair = amOdds(p);
      // Profit per unit at the fair price. The board's default order is the
      // grade — the question asked was which bet is likeliest — but "likeliest"
      // and "best" are not the same question, and this is what the second one
      // is sorted on: the grade weighted by what the bet actually returns.
      leg.payout = 1 / p - 1;
      leg.value = +(leg.score.score * Math.sqrt(leg.payout)).toFixed(1);
      legs.push(leg);
    });
  });

  legs.sort((a, b) => b.score.score - a.score.score || b.p - a.p);

  // Per game: the legs in it, and the best double it offers.
  const slates = live.map(g => {
    const mine = legs.filter(l => l.gameId === g.id);
    const env = mine.length ? mine[0].env : gameEnv(g, teams, lg);
    const d = bestDouble(mine, env, { allowSame: !!o.allowSame, onlyTeam: !!o.onlyTeam, depth: o.depth || 20 });
    return { game: g, env, legs: mine, double: d ? d.best : null, doubles: d ? d.all : [] };
  }).filter(s => s.legs.length);
  slates.sort((a, b) => ((b.double && b.double.score.score) || 0) - ((a.double && a.double.score.score) || 0));

  prog(100);
  return {
    date: day, season, priorSeason, empty: false, degraded, lg, teams,
    games: live, legs, slates, target,
    counts: { games: live.length, players: cand.length, legs: legs.length, logs: Object.keys(logs).length }
  };
}

// When the pick becomes real: one hour before the first tip on the slate. The
// same rule the baseball ladder runs on, and for the same reason — an NBA
// board re-ranks itself every time an inactive list drops, and a pick that
// quietly swaps itself is not a pick.
function lockInfo(games) {
  const ts = (games || []).map(g => Date.parse(g.date)).filter(t => !isNaN(t));
  if (!ts.length) return null;
  const first = Math.min.apply(null, ts);
  return { lockAt: first - 3600000, first, open: Date.now() >= first - 3600000 };
}

return {
  VERSION, SITE, WEB, CORE, CFG, MARKETS, MKT, LADDER, GRADES, ROLE, LG_FALLBACK,
  // math
  clamp, num, normCdf, normPdf, normInv, nbPmf, nbAtLeast, compoundAtLeast, biNormCdf, jointProb, shrink,
  // odds
  amOdds, decFromAmerican, evaluate,
  // pipeline
  slateYmd, seasonOf, addDays, ymd, etNow, lockInfo,
  logBefore, lineFrom,
  parseEvent, parseOdds, loadSlate, nextSlateDay, loadTeamStats, loadPlayers, loadRoster,
  loadSummary, loadInjuries,
  loadGamelog, parseGamelog, leagueFrom, injuryWeight, minutesTag,
  gameEnv, defFactor, projectMinutes, projectPlayer, spread, overProb, ladderLines, etDayOf,
  scoreLeg, scorePair, gradeOf, rhoFor, bestDouble, calibrate,
  parseBoxScore, loadBoxScore, settle,
  ladder, ladderRisk, buildBoard, clearCache
};
});
