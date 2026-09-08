// ─────────────────────────────────────────────────────────────────────────────
// GridAIron — shared football pricing engine (NFL + FBS college)
//
// One file, two consumers: the dashboard loads it as a classic script
// (window.GridModel), Node imports it as a CJS default. Same pipeline both
// ways, so the board on screen and any alerter can never drift apart.
//
// The job is narrow and specific: take a slate, produce OUR number for every
// market on it, compare that number to the price actually on offer, and rank
// what is left by how much of an advantage is really there. Nothing here tries
// to predict football for its own sake — a projection you cannot bet is not
// worth computing.
//
// WHAT THIS MODEL DOES DIFFERENTLY, AND WHY
//
//  1. RATINGS ARE OFFENSE AND DEFENSE, NOT ONE NUMBER. A single power rating
//     gives you a spread and nothing else. Splitting points scored from points
//     allowed — each adjusted for the opponent it was earned against — gives a
//     spread AND a total AND the projected team scores the prop model needs.
//     Fit is weighted ridge regression, solved by alternating sweeps.
//
//  2. MARGIN OF VICTORY IS CAPPED. A 45-point win says the same thing about a
//     team as a 24-point win and adds a pile of garbage-time noise. Margins are
//     compressed through tanh at a league-specific cap, holding the total
//     constant so the scoring model is untouched.
//
//  3. LAST SEASON IS A PRIOR, NOT A LEDGER. Prior-season games enter the same
//     fit at a reduced weight (NFL 0.32, CFB 0.22 — college turns over more
//     roster). In week 1 that prior is nearly all we have, which is exactly
//     what it is for. By week 6 it is a footnote. No hand-tuned "preseason
//     rating" table to go stale.
//
//  4. FOOTBALL MARGINS ARE NOT NORMAL, AND THAT IS WHERE THE MONEY IS. Final
//     margins pile up on 3 and 7 and avoid 1, 2 and 5. A normal curve prices
//     every half-point the same; the real distribution says the half-point from
//     -3 to -2.5 is worth roughly ten times the half-point from -8 to -7.5.
//     We build a discrete margin distribution — a normal shaped by empirical
//     key-number multipliers, re-centred so its mean is still the projection —
//     and read spreads, pushes and moneylines straight off it.
//
//  5. THE MARKET IS A PRIOR TOO. A power rating that ignores the closing line
//     is not a model, it is an opinion. Our projection is blended toward the
//     market number before anything is priced. The blend weight is a control,
//     not a constant, and the default deliberately leaves the market in charge
//     (NFL 0.35 — the NFL market is very good; CFB 0.45 — it is less good, and
//     worst on the games nobody watches).
//
//  6. EVERY EDGE IS QUOTED AGAINST A NO-VIG PRICE AND STAKED BY KELLY. An
//     edge that does not clear the hold is not an edge. Push mass is carried
//     through both the EV and the Kelly fraction, because a push is not a loss.
//
//  7. PROPS ARE BUILT FROM VOLUME, NOT FROM SEASON AVERAGES. A receiver's
//     yards-per-game tells you what he did against a schedule he will never
//     play again, in game scripts that will not repeat. We project team plays
//     from pace and the projected total, shift the pass rate by the projected
//     margin (trailing teams throw), take the player's usage share of that,
//     and only then apply his efficiency. Variance comes from the compound
//     distribution — targets are a count, yards-per-catch is a spread — so a
//     12-target night and a 3-target night correctly get different shapes.
//
//  8. NOTHING IS GRADED AGAINST ITSELF. The backtest walks a past season
//     forward one week at a time, rebuilding ratings from only what was known,
//     and grades against the actual closing line and the actual result.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GridModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const VERSION = 1;

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const WEB  = "https://site.web.api.espn.com/apis/common/v3/sports";
const CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues";

// Per-league constants. Every one of these is a real, separately-measurable
// property of the sport, not a knob to fit the board with.
const LEAGUES = {
  nfl: {
    key: "nfl", label: "NFL", path: "football/nfl", core: "nfl", groups: null,
    sigMargin: 12.20,   // set so the model reproduces the empirical spread->win
                        // -probability curve (a 3 wins 60%, a 7 wins 72%, a 14
                        // wins 88%). The raw sd of margin-minus-close is nearer
                        // 13.5, but football margins are peaked, and a bell
                        // curve that wide prices every favourite as too live.
    sigTotal: 10.40,    // sd of final total
    avgTotal: 46.0,     // measured 2025 league mean total (23.0 a side); pace and
                        // variance are scaled against it
    hfa0: 1.90,         // home-field prior, refit from results each load
    keyDamp: 1.00,      // full strength key numbers
    carry: 0.32,        // weight on prior-season games
    decay: 0.933,       // per-week recency decay (~10 week half life)
    ridge: 2.0,         // shrink toward league average, in equivalent games.
                        // Sized so that a team carrying nothing but last season
                        // keeps ~60% of its rating, which is what NFL ratings
                        // actually carry year to year.
    movCap: 21,
    weeks: 18,
    // Measured, not chosen. Sweeping the blend weight across the 2025 season
    // (see backtest) puts the margin optimum at ZERO — our rating adds nothing
    // to an NFL closing spread, and every point of weight makes the number
    // worse. It is kept at a token 0.10 so the board still shows where we
    // differ; if you want the honest number, set the weight to 0. The total is
    // the one place the model measurably helps, and only barely.
    mktW: 0.10,
    mktWTotal: 0.30,
    maxShift: 2.5,      // points the blend may ever move off the market number
    maxShiftTotal: 3.0,
    rushTDshare: 0.36,  // share of offensive TDs that come on the ground
    bulkPlayers: true   // league-wide player stat feed carries values
  },
  cfb: {
    key: "cfb", label: "CFB", path: "football/college-football", core: "college-football", groups: 80,
    sigMargin: 15.00,   // same calibration, college spread
    sigTotal: 12.90,
    avgTotal: 54.6,     // measured 2025 college mean total (27.3 a side)
    hfa0: 2.40,
    keyDamp: 0.55,      // key numbers exist in college but are flatter
    carry: 0.22,
    decay: 0.940,
    ridge: 2.6,         // college keeps less: more roster turnover, ~50%
    movCap: 28,
    weeks: 16,
    // Same sweep on college: the margin optimum is 0.20 and it beats the
    // closing line by six hundredths of a point. College is softer than the
    // NFL, but it is not soft.
    mktW: 0.20,
    // Zero, and it is not an oversight. Betting our disagreement with the
    // college total lost 7.5% over 694 games last season — the one result in
    // the whole backtest that clears two standard errors in the WRONG
    // direction. A totals model that loses money is not a totals model, so it
    // does not get to post plays. Raise the weight by hand if you want to see
    // what it thinks; the backtest panel will still tell you it was a leak.
    mktWTotal: 0.00,
    maxShift: 4.0,
    maxShiftTotal: 4.0,
    rushTDshare: 0.45,
    bulkPlayers: false  // college feed ranks players but withholds the numbers
  }
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = v => { const n = parseFloat(String(v == null ? "" : v).replace(/,/g, "")); return isFinite(n) ? n : null; };

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

function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
// Regularised lower incomplete gamma P(a,x) — series below the crossover,
// continued fraction above. Gives us a gamma CDF, which is what yardage props
// need: right-skewed, floored at zero, matched on mean and variance.
function gammaP(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 300; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 300; i++) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}
// P(X > x) for a gamma matched to (mean, variance). Falls back to a normal
// tail if the variance is degenerate.
function gammaTail(mean, variance, x) {
  if (!(mean > 0)) return x < 0 ? 1 : 0;
  if (!(variance > 0)) return x < mean ? 1 : 0;
  const theta = variance / mean, k = mean / theta;
  if (!(k > 0) || !isFinite(k)) return 1 - normCdf((x - mean) / Math.sqrt(variance));
  return 1 - gammaP(k, x / theta);
}
// The line at which a gamma-shaped market is a coin flip — our number.
function gammaMedian(mean, variance) {
  if (!(mean > 0)) return 0;
  let lo = 0, hi = mean + 6 * Math.sqrt(Math.max(variance, 1));
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (gammaTail(mean, variance, mid) > 0.5) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
// Negative binomial with mean m and dispersion k: Var = m + m^2/k. Counts in
// football (targets, catches, carries) are over-dispersed relative to Poisson
// because usage itself varies game to game.
function nbPmf(m, k, n) {
  if (!(m > 0)) return n === 0 ? 1 : 0;
  const p = k / (k + m);
  return Math.exp(logGamma(n + k) - logGamma(k) - logGamma(n + 1) + k * Math.log(p) + n * Math.log(1 - p));
}
function nbAtLeast(m, k, n) {
  if (n <= 0) return 1;
  let below = 0;
  for (let i = 0; i < n; i++) below += nbPmf(m, k, i);
  return clamp(1 - below, 0, 1);
}
function poissonAtLeast(lam, n) {
  if (n <= 0) return 1;
  let below = 0, term = Math.exp(-lam);
  for (let i = 0; i < n; i++) { below += term; term *= lam / (i + 1); }
  return clamp(1 - below, 0, 1);
}

// ── odds ────────────────────────────────────────────────────────────────────
const amToDec = a => a == null ? null : (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const amToProb = a => { const d = amToDec(a); return d ? 1 / d : null; };
const probToAm = p => {
  p = clamp(p, 1e-6, 1 - 1e-6);
  return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
};
const fmtAm = a => a == null ? "—" : (a > 0 ? "+" + Math.round(a) : String(Math.round(a)));
// Proportional de-vig. Two-way football markets are close enough to balanced
// that the fancier power/Shin methods buy almost nothing here.
function devig(a1, a2) {
  const p1 = amToProb(a1), p2 = amToProb(a2);
  if (p1 == null || p2 == null) return { p1: p1, p2: p2, hold: null };
  const s = p1 + p2;
  return { p1: p1 / s, p2: p2 / s, hold: s - 1 };
}
// EV per $1 risked, carrying push mass so a push is scored as the refund it is.
function evUnit(p, push, american) {
  const d = amToDec(american); if (!d) return null;
  const lose = clamp(1 - p - push, 0, 1);
  return p * (d - 1) - lose;
}
// Kelly on the non-push outcomes, then scaled down. Full Kelly on a model this
// uncertain is a good way to go broke being right.
function kelly(p, push, american, fraction) {
  const d = amToDec(american); if (!d) return 0;
  const live = 1 - push; if (live <= 0) return 0;
  const pw = clamp(p / live, 0, 1), b = d - 1;
  const f = (pw * b - (1 - pw)) / b;
  return Math.max(0, f) * (fraction == null ? 0.25 : fraction);
}

// ── the margin distribution ─────────────────────────────────────────────────
// Multipliers on a normal, derived by dividing published NFL final-margin
// frequencies by a normal of the same spread. 3 carries more than twice the
// mass a bell curve would give it; 1, 2 and 5 carry about half. Beyond 24 the
// empirical and normal shapes agree and the multiplier goes to 1.
const KEY_MULT = [
  0.14, 0.55, 0.51, 2.24, 1.13, 0.65, 1.18, 1.86, 0.81, 0.58,
  1.61, 0.68, 0.50, 0.89, 1.36, 0.56, 0.75, 1.34, 0.65, 0.60,
  0.98, 1.33, 0.75, 0.80, 1.20
];
const keyMult = (d, damp) => {
  const raw = d < KEY_MULT.length ? KEY_MULT[d] : 1;
  return 1 + damp * (raw - 1);
};

const PMF_LO = -80, PMF_HI = 80;

// Discrete margin distribution centred so that its MEAN equals the projection.
// Shaping a normal by key numbers pulls the mean around; bisecting on the
// centre puts it back, so the key numbers only ever change the shape and never
// quietly move our number.
function marginPmf(mu, sigma, damp) {
  const n = PMF_HI - PMF_LO + 1;
  const build = c => {
    const p = new Float64Array(n); let s = 0;
    for (let i = 0; i < n; i++) {
      const d = PMF_LO + i;
      const v = normPdf((d - c) / sigma) * keyMult(Math.abs(d), damp);
      p[i] = v; s += v;
    }
    for (let i = 0; i < n; i++) p[i] /= s;
    return p;
  };
  const meanOf = p => { let m = 0; for (let i = 0; i < n; i++) m += p[i] * (PMF_LO + i); return m; };
  let lo = mu - 7, hi = mu + 7, p = build(mu);
  if (Math.abs(meanOf(p) - mu) > 0.01) {
    for (let it = 0; it < 40; it++) {
      const c = (lo + hi) / 2; p = build(c);
      if (meanOf(p) > mu) hi = c; else lo = c;
    }
  }
  return p;
}
// The margin a moneyline is quoting, by running the spread-to-moneyline
// conversion backwards. On the games nobody watches a book will often hang a
// price and no number; without this the model would be pricing those games
// entirely against itself, which is precisely where it is least trustworthy.
function marginFromProb(p, sigma, damp) {
  p = clamp(p, 0.005, 0.995);
  let lo = -60, hi = 60;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const m = mlProbs(marginPmf(mid, sigma, damp));
    if (m.home / Math.max(1e-9, 1 - m.push) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Home side of a spread. `line` is the home number the book hangs (-3.5 means
// the home team lays 3.5). Home covers when margin + line > 0.
function spreadProbs(pmf, line) {
  let win = 0, push = 0, lose = 0;
  for (let i = 0; i < pmf.length; i++) {
    const d = PMF_LO + i, v = d + line;
    if (v > 1e-9) win += pmf[i]; else if (v < -1e-9) lose += pmf[i]; else push += pmf[i];
  }
  return { win, push, lose };
}
// Moneyline. A tie is a push at every book that hangs a two-way NFL price.
function mlProbs(pmf) {
  let home = 0, push = 0, away = 0;
  for (let i = 0; i < pmf.length; i++) {
    const d = PMF_LO + i;
    if (d > 0) home += pmf[i]; else if (d < 0) away += pmf[i]; else push += pmf[i];
  }
  return { home, push, away };
}
// Totals get a plain discrete normal. Team totals do cluster a little, but
// nothing in football totals comes close to the 3-and-7 structure of margins,
// and inventing bumps we cannot measure would be worse than not having them.
function totalProbs(mu, sigma, line) {
  let over = 0, push = 0, under = 0;
  for (let t = 0; t <= 130; t++) {
    const p = normPdf((t - mu) / sigma) / sigma;
    if (t > line + 1e-9) over += p; else if (t < line - 1e-9) under += p; else push += p;
  }
  const s = over + push + under;
  return { over: over / s, push: push / s, under: under / s };
}

// ── network ─────────────────────────────────────────────────────────────────
// Straight to the feed first; if the browser's cross-site rules get in the way,
// fall through public proxies and remember whichever one worked, because a
// full load is a few hundred calls and re-probing each time is unaffordable.
const SOURCES = [
  u => u,
  u => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  u => "https://thingproxy.freeboard.io/fetch/" + u
];
let goodSource = null;
async function getJSON(url, tries) {
  const order = goodSource != null
    ? [goodSource].concat(SOURCES.map((_, i) => i).filter(i => i !== goodSource))
    : SOURCES.map((_, i) => i);
  let lastErr;
  for (let attempt = 0; attempt < (tries || 1); attempt++) {
    for (const i of order) {
      try {
        const r = await fetch(SOURCES[i](url), { headers: { Accept: "application/json" } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        goodSource = i;
        return j;
      } catch (e) { lastErr = e; }
    }
    if (attempt + 1 < (tries || 1)) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
  }
  throw lastErr || new Error("unreachable: " + url);
}
async function pool(items, fn, size, onEach) {
  const out = new Array(items.length); let i = 0, done = 0;
  const w = async () => {
    while (i < items.length) {
      const j = i++;
      try { out[j] = await fn(items[j], j); } catch (e) { out[j] = null; }
      done++; if (onEach) onEach(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size || 6, items.length || 1) }, w));
  return out;
}

// ── loading results ─────────────────────────────────────────────────────────
// Week-indexed scoreboards, not team schedules: one call covers every game in
// the league that week, so a full season of college costs 16 calls instead of
// 136. Only finals are kept — an in-progress game has no rating information.
function parseEvent(ev, league) {
  const c = (ev.competitions || [])[0]; if (!c) return null;
  const cs = c.competitors || []; if (cs.length !== 2) return null;
  const home = cs.find(x => x.homeAway === "home"), away = cs.find(x => x.homeAway === "away");
  if (!home || !away) return null;
  const st = (c.status || {}).type || {};
  const hs = num(home.score && home.score.value != null ? home.score.value : home.score);
  const as = num(away.score && away.score.value != null ? away.score.value : away.score);
  return {
    id: ev.id,
    date: ev.date,
    league: league,
    neutral: !!c.neutralSite,
    final: st.completed === true || st.name === "STATUS_FINAL",
    home: { id: String(home.team.id), abbr: home.team.abbreviation || home.team.shortDisplayName, name: home.team.displayName, logo: home.team.logo, rank: (home.curatedRank || {}).current, conf: home.team.conferenceId, rec: ((home.records || [])[0] || {}).summary },
    away: { id: String(away.team.id), abbr: away.team.abbreviation || away.team.shortDisplayName, name: away.team.displayName, logo: away.team.logo, rank: (away.curatedRank || {}).current, conf: away.team.conferenceId, rec: ((away.records || [])[0] || {}).summary },
    hs: hs, as: as,
    venue: (c.venue || {}).fullName,
    indoor: !!((c.venue || {}).indoor),
    weather: ev.weather || null,
    odds: c.odds || null
  };
}

async function loadWeek(L, season, week, seasontype) {
  const g = L.groups ? "&groups=" + L.groups : "";
  const url = `${SITE}/${L.path}/scoreboard?limit=400${g}&dates=${season}&seasontype=${seasontype || 2}&week=${week}`;
  const d = await getJSON(url, 2);
  const evs = (d.events || []).map(e => parseEvent(e, L.key)).filter(Boolean);
  evs.forEach(e => { e.season = season; e.week = week; });
  return evs;
}

// Everything played, across the prior season and the current one to date. The
// caller hands back a flat list; the rating fit does the weighting.
async function loadHistory(L, season, throughWeek, onProgress) {
  const jobs = [];
  for (let w = 1; w <= L.weeks; w++) jobs.push({ season: season - 1, week: w });
  for (let w = 1; w <= Math.max(0, throughWeek); w++) jobs.push({ season: season, week: w });
  let done = 0;
  const res = await pool(jobs, async j => loadWeek(L, j.season, j.week), 6, () => {
    done++; if (onProgress) onProgress(done / jobs.length);
  });
  const games = [];
  res.forEach(r => { if (r) r.forEach(g => { if (g.final && g.hs != null && g.as != null) games.push(g); }); });
  return games;
}

// ── ratings ─────────────────────────────────────────────────────────────────
// score_ij = mu + off_i - def_j + hfa/2 (home) or - hfa/2 (away), fit by
// weighted alternating least squares with a ridge penalty. The ridge is
// expressed in equivalent games, so a team with 3 results is pulled hard toward
// average and a team with 30 is barely touched — which is the honest treatment
// of a 2-0 start.
function buildRatings(games, L, opts) {
  opts = opts || {};
  const ridge = opts.ridge != null ? opts.ridge : L.ridge;
  const cap = L.movCap;
  const maxSeason = opts.season != null ? opts.season : games.reduce((m, g) => Math.max(m, g.season), 0);
  const maxWeek = opts.week != null ? opts.week : games.filter(g => g.season === maxSeason).reduce((m, g) => Math.max(m, g.week), 0);

  // Who is actually in this league? A college slate is full of one-off games
  // against schools that will never appear again; pooling them into a single
  // replacement-level opponent is both more accurate and more stable than
  // giving each of them a rating off one result.
  const seen = {};
  games.forEach(g => { seen[g.home.id] = (seen[g.home.id] || 0) + 1; seen[g.away.id] = (seen[g.away.id] || 0) + 1; });
  const member = {};
  const roster = opts.members || null;
  Object.keys(seen).forEach(id => { member[id] = roster ? !!roster[id] : seen[id] >= (L.key === "cfb" ? 6 : 4); });
  const idOf = t => member[t.id] ? t.id : "FCS";

  const rows = [];
  games.forEach(g => {
    const t = g.hs + g.as;
    const m = cap * Math.tanh((g.hs - g.as) / cap);   // compress the blowout, keep the total
    const hs = (t + m) / 2, as = (t - m) / 2;
    const weeksAgo = g.season === maxSeason ? (maxWeek - g.week) : (maxWeek + (L.weeks - g.week));
    let w = Math.pow(L.decay, weeksAgo);
    if (g.season !== maxSeason) w *= L.carry;
    if (idOf(g.home) === "FCS" || idOf(g.away) === "FCS") w *= 0.4;
    rows.push({ h: idOf(g.home), a: idOf(g.away), hs, as, w, neutral: g.neutral });
  });

  const ids = {}; rows.forEach(r => { ids[r.h] = 1; ids[r.a] = 1; });
  const teamIds = Object.keys(ids);
  const off = {}, def = {}, wsum = {}, gp = {};
  teamIds.forEach(id => { off[id] = 0; def[id] = 0; wsum[id] = 0; gp[id] = 0; });
  let tw = 0, tp = 0;
  rows.forEach(r => {
    tw += 2 * r.w; tp += r.w * (r.hs + r.as);
    wsum[r.h] += r.w; wsum[r.a] += r.w; gp[r.h]++; gp[r.a]++;
  });
  const mu = tw > 0 ? tp / tw : L.avgTotal / 2;      // league mean points per team-game
  let hfa = L.hfa0;

  for (let it = 0; it < 80; it++) {
    const onum = {}, dnum = {};
    teamIds.forEach(id => { onum[id] = 0; dnum[id] = 0; });
    rows.forEach(r => {
      const hAdj = r.neutral ? 0 : hfa / 2;
      // offense: what did you score, once we credit the defense you scored on
      onum[r.h] += r.w * (r.hs - mu + def[r.a] - hAdj);
      onum[r.a] += r.w * (r.as - mu + def[r.h] + hAdj);
      // defense: what did you allow, once we discount the offense you faced
      dnum[r.a] += r.w * (mu + off[r.h] + hAdj - r.hs);
      dnum[r.h] += r.w * (mu + off[r.a] - hAdj - r.as);
    });
    teamIds.forEach(id => {
      const den = wsum[id] + ridge;
      off[id] = onum[id] / den;
      def[id] = dnum[id] / den;
    });
    // Refit home field off the residuals rather than trusting the prior.
    let rn = 0, rd = 0;
    rows.forEach(r => {
      if (r.neutral) return;
      const pred = (off[r.h] - def[r.a]) - (off[r.a] - def[r.h]);
      rn += r.w * ((r.hs - r.as) - pred); rd += r.w;
    });
    if (rd > 0) hfa = clamp(rn / rd, 0, 4.5);
  }

  const teams = {};
  teamIds.forEach(id => {
    teams[id] = { id, off: off[id], def: def[id], rating: off[id] + def[id], gp: gp[id], w: wsum[id] };
  });
  const names = {};
  games.forEach(g => { names[g.home.id] = g.home; names[g.away.id] = g.away; });
  return { teams, names, mu, hfa, member, maxSeason, maxWeek, league: L.key };
}

// A team we have never rated (new to the league, or an FCS visitor) gets the
// pooled replacement rating rather than league average — those games are not
// coin flips and pretending otherwise is how a model hands money away.
function ratingOf(R, id) {
  return R.teams[id] || R.teams.FCS || { off: -3, def: -3, rating: -6, gp: 0, w: 0 };
}

// ── projection ──────────────────────────────────────────────────────────────
function projectGame(R, L, homeId, awayId, neutral) {
  const h = ratingOf(R, homeId), a = ratingOf(R, awayId);
  const adj = neutral ? 0 : R.hfa / 2;
  const hp = R.mu + h.off - a.def + adj;
  const ap = R.mu + a.off - h.def - adj;
  const total = hp + ap;
  // Variance scales with expected scoring: a 62-point projection is a wider
  // game than a 34-point one, and a flat sigma prices both the same.
  const paceF = Math.sqrt(clamp(total / L.avgTotal, 0.6, 1.6));
  return {
    homePts: hp, awayPts: ap, margin: hp - ap, total: total,
    sigMargin: L.sigMargin * (0.55 + 0.45 * paceF),
    sigTotal: L.sigTotal * (0.45 + 0.55 * paceF),
    thin: Math.min(h.gp, a.gp) < 4
  };
}

// ── market prices ───────────────────────────────────────────────────────────
// The scoreboard feed carries one provider and no spread juice. The core feed
// carries the juice on both sides AND the opener, which is what lets us see
// which way the market has moved since it hung the number.
const isLive = p => /live/i.test(p || "");
function pickBook(items) {
  const pre = (items || []).filter(o => o && !isLive((o.provider || {}).name));
  if (!pre.length) return null;
  pre.sort((a, b) => ((a.provider || {}).priority || 99) - ((b.provider || {}).priority || 99));
  return pre[0];
}
const amOf = v => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const n = num(String(v).replace(/\+/, ""));
  return n;
};
function parseCoreOdds(o) {
  if (!o) return null;
  const H = o.homeTeamOdds || {}, A = o.awayTeamOdds || {};
  return {
    book: (o.provider || {}).name || "book",
    spreadHome: homeSpread(o),
    spreadOddsHome: amOf(H.spreadOdds) != null ? amOf(H.spreadOdds) : -110,
    spreadOddsAway: amOf(A.spreadOdds) != null ? amOf(A.spreadOdds) : -110,
    mlHome: amOf(H.moneyLine),
    mlAway: amOf(A.moneyLine),
    total: o.overUnder != null ? num(o.overUnder) : null,
    overOdds: amOf(o.overOdds) != null ? amOf(o.overOdds) : -110,
    underOdds: amOf(o.underOdds) != null ? amOf(o.underOdds) : -110,
    openSpreadHome: openSpread(o),
    openMlHome: amOf((((H.open || {}).moneyLine || {}).alternateDisplayValue) || null)
  };
}
// ESPN publishes `spread` as the favourite's number, so the sign has to be read
// off which team is actually laying the points rather than trusted as given.
function homeSpread(raw) {
  const H = raw.homeTeamOdds || {};
  const mag = Math.abs(num(raw.spread));
  if (!isFinite(mag)) return null;
  if (H.favorite === true) return -mag;
  if (H.favorite === false) return mag;
  return num(raw.spread);
}
// The number the book hung when it first put the game up, which is the only way
// to see which way the money has since pushed it.
function openSpread(raw) {
  const ps = ((raw.homeTeamOdds || {}).open || {}).pointSpread || {};
  const disp = ps.alternateDisplayValue != null ? ps.alternateDisplayValue : ps.american;
  return disp == null ? null : num(String(disp).replace("+", ""));
}
async function loadGameOdds(L, eventId) {
  const d = await getJSON(`${CORE}/${L.core}/events/${eventId}/competitions/${eventId}/odds`, 2);
  const raw = pickBook(d.items);
  return raw ? parseCoreOdds(raw) : null;
}
// Fallback when the core feed has nothing: the scoreboard's single provider.
function oddsFromScoreboard(game) {
  const raw = pickBook(game.odds); if (!raw) return null;
  const H = raw.homeTeamOdds || {}, A = raw.awayTeamOdds || {};
  const ml = raw.moneyline || {};
  const pick = side => {
    const s = ml[side] || {};
    const c = s.close || s.current || s.open || {};
    return amOf(c.odds != null ? c.odds : c.alternateDisplayValue);
  };
  const mag = Math.abs(num(raw.spread));
  return {
    book: (raw.provider || {}).name || "book",
    spreadHome: isFinite(mag) ? (H.favorite ? -mag : mag) : null,
    spreadOddsHome: -110, spreadOddsAway: -110,
    mlHome: pick("home") != null ? pick("home") : amOf(H.moneyLine),
    mlAway: pick("away") != null ? pick("away") : amOf(A.moneyLine),
    total: raw.overUnder != null ? num(raw.overUnder) : null,
    overOdds: -110, underOdds: -110,
    openSpreadHome: null, openMlHome: null
  };
}

// ── putting our number on the market's scale ────────────────────────────────
// A ridge-shrunk rating is deliberately conservative: every projection is
// pulled toward the mean. That is the right call for accuracy and the WRONG
// call for betting, because it manufactures an edge on every dog and every
// under without knowing anything. So before we price a single market, regress
// the market's numbers on ours across the whole slate and put ours on the same
// scale. What survives that is real disagreement about a specific game, which
// is the only thing worth betting.
// How much of OUR number to use. In week 1 the ratings are last season's, and
// last season did not include the quarterback who just got traded, the coach
// who just got fired, or the rookie class. The market knows all of it. So the
// model's share of the blend ramps up as the season gives it something the
// market cannot already see, and starts at roughly a third of its full weight.
function autoMktW(L, week, base) {
  const b = base != null ? base : L.mktW;
  return b * clamp((week + 1) / 6, 0.34, 1);
}
function autoMktWTotal(L, week, base) {
  const b = base != null ? base : (L.mktWTotal != null ? L.mktWTotal : L.mktW);
  return b * clamp((week + 1) / 6, 0.34, 1);
}
function calibrateSlate(pairs, n0) {
  const good = pairs.filter(p => p && isFinite(p.model) && isFinite(p.market));
  const n = good.length;
  if (n < 4) return { a: 0, b: 1, n, r: null };
  const mm = good.reduce((s, p) => s + p.model, 0) / n;
  const mk = good.reduce((s, p) => s + p.market, 0) / n;
  let cov = 0, varM = 0, varK = 0;
  good.forEach(p => { cov += (p.model - mm) * (p.market - mk); varM += Math.pow(p.model - mm, 2); varK += Math.pow(p.market - mk, 2); });
  let b = varM > 1e-9 ? cov / varM : 1;
  // Shrink the slope toward "no correction" so a light slate cannot rescale the
  // whole model on noise, and never let it invert or run away. The intercept is
  // then re-derived rather than shrunk: whatever the slope ends up being, the
  // line still has to pass through the slate's own averages, or the correction
  // quietly moves every game in the same direction — which is how you end up
  // holding thirteen overs and no unders.
  const k = n0 == null ? 6 : n0;
  b = clamp((b * n + 1 * k) / (n + k), 0.70, 1.60);
  const a = mk - b * mm;
  const r = (varM > 0 && varK > 0) ? cov / Math.sqrt(varM * varK) : null;
  return { a, b, n, r };
}
const applyCal = (cal, v) => cal ? cal.a + cal.b * v : v;

// ── pricing a game ──────────────────────────────────────────────────────────
// Blend our projection toward the market before pricing anything. The market
// line is the single best public estimate of a football game; a model that
// ignores it is claiming to know more than every bettor who moved it, and on
// most games it does not. What we are hunting is the residual.
function blendProjection(proj, odds, w, cal, L, wTotal) {
  const cm = applyCal(cal && cal.margin, proj.margin);
  const ct = applyCal(cal && cal.total, proj.total);
  const out = {
    margin: cm, total: ct,
    modelMargin: proj.margin, modelTotal: proj.total,
    calMargin: cm, calTotal: ct,
    mktMargin: null, mktTotal: null, mktFrom: null, w: 1
  };
  if (odds && odds.spreadHome != null) {
    out.mktMargin = -odds.spreadHome;
    out.mktFrom = "spread";
  } else if (odds && odds.mlHome != null && odds.mlAway != null && L) {
    const dv = devig(odds.mlHome, odds.mlAway);
    if (dv.p1 != null) {
      out.mktMargin = marginFromProb(dv.p1, proj.sigMargin, L.keyDamp);
      out.mktFrom = "moneyline";
    }
  }
  // A model that wants to move a college line thirty points is not disagreeing,
  // it is broken — a rating built on last season and two games of this one has
  // no business overruling the market by more than a field goal or so. The cap
  // leaves ordinary disagreement untouched and clips only the tail, which is
  // where every one of the absurd edges was coming from.
  const cap = (v, anchor, lim) => lim == null ? v : clamp(v, anchor - lim, anchor + lim);
  if (out.mktMargin != null) {
    out.margin = cap(w * cm + (1 - w) * out.mktMargin, out.mktMargin, L && L.maxShift);
    out.w = w;
    out.capped = L && L.maxShift != null && Math.abs(w * cm + (1 - w) * out.mktMargin - out.margin) > 0.01;
  }
  if (odds && odds.total != null) {
    const wt = wTotal != null ? wTotal : w;
    out.mktTotal = odds.total;
    out.total = cap(wt * ct + (1 - wt) * odds.total, odds.total, L && L.maxShiftTotal);
    out.wTotal = wt;
  }
  return out;
}
// Does our disagreement with the market cross a number that actually matters?
// Moving a game from -2.5 to -3.5 is worth several times what moving it from
// -8.5 to -9.5 is worth, and a play that crosses 3 or 7 in the right direction
// is a different animal from one that does not.
function keyCross(mktLine, ourLine) {
  const lo = Math.min(Math.abs(mktLine), Math.abs(ourLine)), hi = Math.max(Math.abs(mktLine), Math.abs(ourLine));
  const crossed = [3, 7, 10, 14, 6].filter(k => lo < k && hi >= k);
  return crossed;
}

function priceGame(R, L, game, odds, opts) {
  opts = opts || {};
  const w = opts.mktW != null ? opts.mktW : L.mktW;
  const kf = opts.kelly != null ? opts.kelly : 0.25;
  const proj = projectGame(R, L, game.home.id, game.away.id, game.neutral);
  const bl = blendProjection(proj, odds, w, opts.cal, L, opts.mktWTotal != null ? opts.mktWTotal : w);
  const pmf = marginPmf(bl.margin, proj.sigMargin, L.keyDamp);
  const ml = mlProbs(pmf);
  const plays = [];

  const push = (o) => { if (o) plays.push(o); };
  const mk = (market, side, label, p, pushP, american, mktP, extra) => {
    if (american == null || !isFinite(american)) return null;
    const ev = evUnit(p, pushP, american);
    const fair = probToAm(p / Math.max(1e-9, 1 - pushP));
    return Object.assign({
      gameId: game.id, league: L.key, market, side, label,
      home: game.home, away: game.away, date: game.date, neutral: game.neutral,
      venue: game.venue, indoor: game.indoor, weather: game.weather,
      book: odds ? odds.book : null,
      p, push: pushP, price: american, fair,
      mktP: mktP == null ? null : mktP,
      edge: mktP == null ? null : p / Math.max(1e-9, 1 - pushP) - mktP,
      ev, kelly: kelly(p, pushP, american, kf),
      proj: proj, blend: bl, thin: proj.thin
    }, extra || {});
  };

  // ── spread ──
  if (odds && odds.spreadHome != null) {
    const line = odds.spreadHome;
    const sp = spreadProbs(pmf, line);
    const dv = devig(odds.spreadOddsHome, odds.spreadOddsAway);
    const ourLine = -bl.margin;
    const move = odds.openSpreadHome != null ? line - odds.openSpreadHome : null;
    const extra = {
      line, ourLine, lineDiff: bl.margin - (bl.mktMargin == null ? bl.margin : bl.mktMargin),
      keys: keyCross(line, ourLine), move, hold: dv.hold
    };
    push(mk("spread", "home", `${game.home.abbr} ${fmtLine(line)}`, sp.win, sp.push, odds.spreadOddsHome, dv.p1, extra));
    push(mk("spread", "away", `${game.away.abbr} ${fmtLine(-line)}`, sp.lose, sp.push, odds.spreadOddsAway, dv.p2, extra));
  }
  // ── moneyline ──
  if (odds && odds.mlHome != null && odds.mlAway != null) {
    const dv = devig(odds.mlHome, odds.mlAway);
    const extra = { line: null, ourLine: -bl.margin, keys: [], move: null, hold: dv.hold };
    push(mk("ml", "home", `${game.home.abbr} ML`, ml.home, ml.push, odds.mlHome, dv.p1, extra));
    push(mk("ml", "away", `${game.away.abbr} ML`, ml.away, ml.push, odds.mlAway, dv.p2, extra));
  }
  // ── total ──
  if (odds && odds.total != null) {
    const tp = totalProbs(bl.total, proj.sigTotal, odds.total);
    const dv = devig(odds.overOdds, odds.underOdds);
    const extra = { line: odds.total, ourLine: bl.total, lineDiff: bl.total - odds.total, keys: [], move: null, hold: dv.hold };
    push(mk("total", "over", `Over ${odds.total}`, tp.over, tp.push, odds.overOdds, dv.p1, extra));
    push(mk("total", "under", `Under ${odds.total}`, tp.under, tp.push, odds.underOdds, dv.p2, extra));
  }
  return { proj, blend: bl, pmf, ml, plays };
}
const fmtLine = v => v == null ? "" : (v > 0 ? "+" + (Math.round(v * 2) / 2) : String(Math.round(v * 2) / 2));

// Pull a rate toward a prior by how much evidence stands behind it: n0 is the
// sample size at which the measurement and the prior count equally.
const shrink = (val, n, prior, n0) => ((val || 0) * n + prior * n0) / ((n || 0) + n0);

// ── team volume ─────────────────────────────────────────────────────────────
// Season stat lines, own splits and what the team allowed. splitId 0 is the
// team, 900 is its opponents — the defensive half falls out for free.
function statMap(leagueCats, cat) {
  const names = (leagueCats.find(c => c.name === cat.name) || {}).names || [];
  const out = {};
  names.forEach((n, i) => { const v = num((cat.totals || [])[i]); if (v != null && out[n] == null) out[n] = v; });
  return out;
}
async function loadTeamStats(L, season) {
  const d = await getJSON(`${WEB}/${L.path}/statistics/byteam?region=us&lang=en&season=${season}&seasontype=2`, 2);
  const lc = d.categories || [];
  const out = {};
  (d.teams || []).forEach(t => {
    const own = {}, opp = {};
    (t.categories || []).forEach(c => {
      const m = statMap(lc, c);
      const tgt = String(c.splitId) === "0" ? own : opp;
      Object.keys(m).forEach(k => { if (tgt[k] == null) tgt[k] = m[k]; });
    });
    const gp = own.gamesPlayed || 1;
    out[String(t.team.id)] = {
      id: String(t.team.id), abbr: t.team.abbreviation, gp,
      passAtt: own.passingAttempts || 0, sacks: own.sacks || 0, rushAtt: own.rushingAttempts || 0,
      completions: own.completions || 0, points: own.totalPoints || 0,
      passTD: own.passingTouchdowns || 0, rushTD: own.rushingTouchdowns || 0,
      passYds: own.passingYards || 0, rushYds: own.rushingYards || 0,
      dPassYds: opp.passingYards || 0, dRushYds: opp.rushingYards || 0, dPoints: opp.totalPoints || 0
    };
  });
  return out;
}

// How many snaps, and of what kind, does this team get in THIS game? Two
// forces move it: pace (a projected shootout is more plays and more scoring
// chances) and game script (a team projected to trail throws more, and the
// effect is worth several attempts a game, which is most of a prop line).
function teamVolume(L, ts, projPts, projTotal, projMargin) {
  const gp = Math.max(1, ts ? ts.gp : 1);
  const base = ts ? {
    pass: ts.passAtt / gp, sack: ts.sacks / gp, rush: ts.rushAtt / gp, comp: ts.completions / gp,
    pts: ts.points / gp, passTD: ts.passTD / gp, rushTD: ts.rushTD / gp,
    ypa: ts.passAtt ? ts.passYds / ts.passAtt : 7, ypc: ts.rushAtt ? ts.rushYds / ts.rushAtt : 4.3
  } : { pass: 33, sack: 2.3, rush: 26, comp: 21, pts: L.avgTotal / 2, passTD: 1.5, rushTD: 0.9, ypa: 7, ypc: 4.3 };

  const drops = base.pass + base.sack;
  const plays = Math.max(30, drops + base.rush);
  const passRate = clamp(drops / plays, 0.3, 0.78);
  const pace = 1 + 0.25 * (projTotal / L.avgTotal - 1);
  // ~0.45 percentage points of pass rate per point of expected margin, capped
  // so a 30-point favourite does not end up in the wildcat.
  const shift = clamp(-0.0045 * projMargin, -0.09, 0.09);
  const playsAdj = plays * clamp(pace, 0.85, 1.18);
  const dropsAdj = playsAdj * clamp(passRate + shift, 0.25, 0.82);
  const sackRate = drops > 0 ? base.sack / drops : 0.07;
  const passAtt = dropsAdj * (1 - sackRate);
  const rushAtt = playsAdj - dropsAdj;

  // Touchdown rate is measured, not assumed: a team that lives on field goals
  // should not be handed the league's red-zone conversion.
  const evid = ts ? (ts.n != null ? ts.n : ts.gp) : 0;
  const tdPerPt = base.pts > 0 ? clamp((base.passTD + base.rushTD) / base.pts, 0.06, 0.14) : 0.10;
  const td = projPts * shrink(tdPerPt, evid, 0.100, 6);
  const rushTDshare = (base.passTD + base.rushTD) > 0
    ? shrink(base.rushTD / (base.passTD + base.rushTD), evid, L.rushTDshare, 6)
    : L.rushTDshare;

  return {
    plays: playsAdj, passAtt, rushAtt, sacks: dropsAdj - passAtt,
    passRate: dropsAdj / playsAdj, basePassAtt: base.pass, baseRushAtt: base.rush,
    td, passTD: td * (1 - rushTDshare), rushTD: td * rushTDshare,
    ypa: base.ypa, ypc: base.ypc, pts: projPts
  };
}

// ── players ─────────────────────────────────────────────────────────────────

// NFL: one league-wide feed per stat family carries complete lines, so three
// sorted calls cover every player anyone hangs a prop on.
async function loadPlayersNFL(L, season, onProgress) {
  const sorts = ["passing.passingYards", "rushing.rushingYards", "receiving.receivingYards"];
  const pages = [];
  sorts.forEach(s => { pages.push({ s, p: 1 }); pages.push({ s, p: 2 }); });
  let done = 0;
  const res = await pool(pages, async j =>
    getJSON(`${WEB}/${L.path}/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&page=${j.p}&limit=100&sort=${encodeURIComponent(j.s)}%3Adesc&season=${season}&seasontype=2`, 2)
  , 4, () => { done++; if (onProgress) onProgress(done / pages.length); });

  const by = {};
  res.forEach(d => {
    if (!d) return;
    const lc = d.categories || [];
    (d.athletes || []).forEach(a => {
      const ath = a.athlete || {}; const id = String(ath.id);
      if (by[id]) return;
      const m = {};
      (a.categories || []).forEach(c => Object.assign(m, statMap(lc, c)));
      by[id] = {
        id, name: ath.displayName, short: ath.shortName,
        pos: ((ath.position || {}).abbreviation) || "",
        teamId: ath.teamId != null ? String(ath.teamId) : null,
        gp: m.gamesPlayed || 0,
        passAtt: m.passingAttempts || 0, passYds: m.passingYards || 0, passTD: m.passingTouchdowns || 0,
        rushAtt: m.rushingAttempts || 0, rushYds: m.rushingYards || 0, rushTD: m.rushingTouchdowns || 0,
        tgt: m.receivingTargets || 0, rec: m.receptions || 0, recYds: m.receivingYards || 0, recTD: m.receivingTouchdowns || 0
      };
    });
  });
  return Object.values(by).filter(p => p.gp > 0);
}

// Who is on this team NOW. Season stats carry the team a player was on when he
// earned them, so a receiver who changed clubs in March would otherwise be
// projected into his old offence all season. The current roster is the truth.
const SKILL = ["QB", "RB", "WR", "TE", "FB"];
async function loadRoster(L, teamId) {
  const d = await getJSON(`${SITE}/${L.path}/teams/${teamId}/roster`, 2);
  const out = [];
  (d.athletes || []).forEach(grp => ((grp.items || grp.athletes || (Array.isArray(grp) ? grp : [])) || []).forEach(a => {
    const pos = ((a.position || {}).abbreviation) || "";
    if (SKILL.indexOf(pos) >= 0) out.push({ id: String(a.id), name: a.displayName || a.fullName, pos, teamId: String(teamId) });
  }));
  return out;
}
async function rosterCached(L, teamId, cache) {
  const k = "roster:" + L.key + ":" + teamId;
  if (!cache[k]) cache[k] = await loadRoster(L, teamId);
  return cache[k];
}

// College: the league-wide feed ranks players but ships every value as a dash,
// so the numbers have to be pulled per athlete. That is affordable for the two
// rosters in ONE game, which is why college props load per game on demand.
const CORE_STAT = (cats, cat, name) => {
  const c = (cats || []).find(x => (x.name || "").toLowerCase() === cat);
  if (!c) return 0;
  const s = (c.stats || []).find(x => x.name === name);
  return s ? num(s.value != null ? s.value : s.displayValue) || 0 : 0;
};
async function loadPlayersCFB(L, season, teamIds, cache, onProgress) {
  const rosters = await pool(teamIds, async id => rosterCached(L, id, cache || {}), 4);
  const flat = [];
  rosters.forEach(r => { if (r) r.slice(0, 42).forEach(p => flat.push(p)); });
  let done = 0;
  const stats = await pool(flat, async p => {
    const d = await getJSON(`${CORE}/${L.core}/seasons/${season}/types/2/athletes/${p.id}/statistics`, 1);
    const cats = ((d.splits || {}).categories) || [];
    return {
      gp: CORE_STAT(cats, "general", "gamesPlayed"),
      passAtt: CORE_STAT(cats, "passing", "passingAttempts"), passYds: CORE_STAT(cats, "passing", "passingYards"), passTD: CORE_STAT(cats, "passing", "passingTouchdowns"),
      rushAtt: CORE_STAT(cats, "rushing", "rushingAttempts"), rushYds: CORE_STAT(cats, "rushing", "rushingYards"), rushTD: CORE_STAT(cats, "rushing", "rushingTouchdowns"),
      tgt: CORE_STAT(cats, "receiving", "receivingTargets"), rec: CORE_STAT(cats, "receiving", "receptions"), recYds: CORE_STAT(cats, "receiving", "receivingYards"), recTD: CORE_STAT(cats, "receiving", "receivingTouchdowns")
    };
  }, 8, () => { done++; if (onProgress) onProgress(done / Math.max(1, flat.length)); });
  const out = [];
  flat.forEach((p, i) => { const s = stats[i]; if (s && s.gp > 0) out.push(Object.assign({ short: p.name }, p, s)); });
  return out;
}

// ── prop projections ────────────────────────────────────────────────────────
// Per-game usage a player of this position would have if we knew nothing else
// about him. These are priors for the shrinkage, and they matter most for the
// case that broke the first build: a quarterback with zero career targets was
// being handed the league-average target share, because shrinking a rate with
// "number of targets" as the sample size treats "never targeted" as "no
// evidence" instead of what it is — seventeen games of very strong evidence.
// Shrinking by GAMES PLAYED fixes that: a full season of nothing stays nothing.
const ROLE = {
  QB: { tgt: 0.05, car: 3.2, att: 20.0 },
  RB: { tgt: 2.10, car: 8.5, att: 0.05 },
  FB: { tgt: 0.60, car: 1.4, att: 0.02 },
  WR: { tgt: 3.40, car: 0.30, att: 0.05 },
  TE: { tgt: 2.60, car: 0.10, att: 0.02 }
};
const roleOf = pos => ROLE[pos] || { tgt: 1.2, car: 1.2, att: 0.05 };

// Usage share of a projected volume, then efficiency — never a yards-per-game
// average, which bakes in a schedule and a game script that will not repeat.
function projectPlayer(L, pl, vol, ts) {
  const gp = Math.max(1, pl.gp);
  const teamPassAtt = ts && ts.gp ? ts.passAtt / ts.gp : vol.basePassAtt;
  const teamRushAtt = ts && ts.gp ? ts.rushAtt / ts.gp : vol.baseRushAtt;
  const role = roleOf(pl.pos);

  // College target counts are patchy; receptions over the catch rate is the
  // same measurement taken the long way round, and it is always populated.
  const rawTgt = pl.tgt > 0 ? pl.tgt / gp : (pl.rec / gp) / 0.66;
  const tgtPerG = shrink(rawTgt, gp, role.tgt, 3);
  const carPerG = shrink(pl.rushAtt / gp, gp, role.car, 3);
  const attPerG = shrink(pl.passAtt / gp, gp, role.att, 3);
  const tgtShare = tgtPerG / Math.max(1, teamPassAtt);
  const carryShare = carPerG / Math.max(1, teamRushAtt);
  const attShare = attPerG / Math.max(1, teamPassAtt);

  const catchRate = pl.tgt > 0 ? shrink(pl.rec / pl.tgt, pl.tgt, 0.645, 25) : 0.645;
  const ypr = pl.rec > 0 ? shrink(pl.recYds / pl.rec, pl.rec, 11.6, 20) : 11.6;
  const ypc = pl.rushAtt > 0 ? shrink(pl.rushYds / pl.rushAtt, pl.rushAtt, vol.ypc, 45) : vol.ypc;
  const ypa = pl.passAtt > 0 ? shrink(pl.passYds / pl.passAtt, pl.passAtt, vol.ypa, 80) : vol.ypa;

  const eTgt = tgtShare * vol.passAtt;
  const eRec = eTgt * catchRate;
  const eCar = carryShare * vol.rushAtt;
  const ePass = attShare * vol.passAtt;

  // Compound variance: a count of chances, each worth a spread of yards. This
  // is why a 3-target night and a 12-target night get different shapes instead
  // of one blanket standard deviation.
  const vTgt = eTgt + eTgt * eTgt / 6;
  const vRec = eRec + eRec * eRec / 8;
  const vCar = eCar + eCar * eCar / 12;
  const vPass = ePass + ePass * ePass / 25;

  const recYds = { mean: eRec * ypr, var: eRec * Math.pow(1.15 * ypr, 2) + vRec * ypr * ypr };
  const rushYds = { mean: eCar * ypc, var: eCar * 30 + vCar * ypc * ypc };          // ~5.5 yd sd per carry
  const passYds = { mean: ePass * ypa, var: ePass * 94 + vPass * ypa * ypa };       // ~9.7 yd sd per attempt

  // Touchdowns: half the player's own scoring share, half his share of the
  // opportunities, and both measured per game so a season total is never
  // divided by a per-game team rate. Pure TD share overfits a fluke red-zone
  // month; pure opportunity share misses the back they hand the ball to on the
  // one-yard line.
  const teamRecTDpg = ts && ts.gp ? ts.passTD / ts.gp : vol.passTD;
  const teamRushTDpg = ts && ts.gp ? ts.rushTD / ts.gp : vol.rushTD;
  const ownRecShare = teamRecTDpg > 0.05 ? clamp((pl.recTD / gp) / teamRecTDpg, 0, 1) : tgtShare;
  const ownRushShare = teamRushTDpg > 0.05 ? clamp((pl.rushTD / gp) / teamRushTDpg, 0, 1) : carryShare;
  const lamRec = vol.passTD * clamp(0.5 * shrink(ownRecShare, pl.recTD, tgtShare, 3) + 0.5 * tgtShare, 0, 0.6);
  const lamRush = vol.rushTD * clamp(0.5 * shrink(ownRushShare, pl.rushTD, carryShare, 3) + 0.5 * carryShare, 0, 0.75);

  return {
    player: pl, eTgt, eRec, eCar, ePass, catchRate, ypr, ypc, ypa,
    recYds, rushYds, passYds,
    rec: { mean: eRec, k: 8 }, car: { mean: eCar, k: 12 },
    passTD: vol.passTD * clamp(attShare / 0.9, 0, 1.05),
    anytimeTD: 1 - Math.exp(-(lamRec + lamRush)), lamRec, lamRush
  };
}

// The markets a book will actually hang on this player, each with our number
// and a tail function so any line can be priced on the spot.
function propMarkets(pr) {
  const out = [];
  const pos = (pr.player && pr.player.pos) || "";
  const isQB = pos === "QB";
  const yards = (key, label, d, min) => {
    if (!(d.mean >= (min || 12))) return;
    out.push({
      key, label, type: "yards", mean: d.mean, sd: Math.sqrt(d.var),
      ourLine: Math.round(gammaMedian(d.mean, d.var) * 2) / 2,
      step: d.mean > 120 ? 10 : (d.mean > 45 ? 5 : 2.5),
      tail: line => gammaTail(d.mean, d.var, line)
    });
  };
  if (isQB) yards("passYds", "Pass yds", pr.passYds, 90);
  yards("rushYds", "Rush yds", pr.rushYds, 15);
  if (!isQB) yards("recYds", "Rec yds", pr.recYds, 15);
  if (!isQB && pr.rec.mean >= 1.6) out.push({
    key: "rec", label: "Receptions", type: "count", mean: pr.rec.mean, sd: Math.sqrt(pr.rec.mean + pr.rec.mean * pr.rec.mean / pr.rec.k),
    ourLine: Math.max(0.5, Math.round(pr.rec.mean) - 0.5), step: 0.5,
    tail: line => nbAtLeast(pr.rec.mean, pr.rec.k, Math.floor(line) + 1)
  });
  if (pr.car.mean >= 5) out.push({
    key: "car", label: "Rush att", type: "count", mean: pr.car.mean, sd: Math.sqrt(pr.car.mean + pr.car.mean * pr.car.mean / pr.car.k),
    ourLine: Math.max(0.5, Math.round(pr.car.mean) - 0.5), step: 0.5,
    tail: line => nbAtLeast(pr.car.mean, pr.car.k, Math.floor(line) + 1)
  });
  if (isQB && pr.passTD >= 0.6) out.push({
    key: "passTD", label: "Pass TD", type: "count", mean: pr.passTD, sd: Math.sqrt(pr.passTD),
    ourLine: 1.5, step: 0.5,
    tail: line => poissonAtLeast(pr.passTD, Math.floor(line) + 1)
  });
  if (pr.anytimeTD >= 0.08) out.push({
    key: "atd", label: "Anytime TD", type: "binary", mean: pr.anytimeTD, sd: null,
    ourLine: null, step: null, tail: () => pr.anytimeTD
  });
  return out;
}

// Price one prop against a real number and a real price. `over`/`under` are
// American; leave one out and the edge is computed against the other's implied
// price with a standard hold assumed on the missing side.
function priceProp(mkt, line, over, under, kf) {
  const p = mkt.type === "binary" ? mkt.mean : clamp(mkt.tail(line), 1e-6, 1 - 1e-6);
  const dv = (over != null && under != null) ? devig(over, under) : null;
  const res = { p, fairOver: probToAm(p), fairUnder: probToAm(1 - p), line };
  if (over != null) {
    res.over = { price: over, ev: evUnit(p, 0, over), kelly: kelly(p, 0, over, kf), mktP: dv ? dv.p1 : amToProb(over), edge: p - (dv ? dv.p1 : amToProb(over)) };
  }
  if (under != null) {
    res.under = { price: under, ev: evUnit(1 - p, 0, under), kelly: kelly(1 - p, 0, under, kf), mktP: dv ? dv.p2 : amToProb(under), edge: (1 - p) - (dv ? dv.p2 : amToProb(under)) };
  }
  return res;
}

// ── the slate ───────────────────────────────────────────────────────────────
async function loadSlate(L, opts) {
  opts = opts || {};
  const g = L.groups ? "&groups=" + L.groups : "";
  const wk = opts.week ? `&dates=${opts.season}&seasontype=2&week=${opts.week}` : "";
  const d = await getJSON(`${SITE}/${L.path}/scoreboard?limit=400${g}${wk}`, 3);
  const season = (d.season || {}).year, week = (d.week || {}).number;
  const games = (d.events || []).map(e => parseEvent(e, L.key)).filter(Boolean);
  games.forEach(x => { x.season = season; x.week = week; });
  return { season, week, games };
}

// Everything the board needs for one league, in one call. Prices are pulled
// per game from the core feed because that is the only place the spread juice
// and the OPENER live, and the opener is how you see which way the money went.
async function loadLeagueBoard(leagueKey, opts, onStatus) {
  const L = LEAGUES[leagueKey];
  opts = opts || {};
  const say = (m, p) => { if (onStatus) onStatus(m, p); };

  say("Reading the slate…", 0.02);
  const slate = await loadSlate(L, opts);
  const live = slate.games.filter(g => !g.final);

  say("Loading season results…", 0.06);
  const history = await loadHistory(L, slate.season, Math.max(0, slate.week - 1), p => say("Loading season results…", 0.06 + 0.44 * p));

  say("Loading team profiles…", 0.52);
  let teamStats = null;
  try { teamStats = await loadTeamStats(L, slate.season - 1); } catch (e) { teamStats = null; }
  let curStats = null;
  if (slate.week > 3) { try { curStats = await loadTeamStats(L, slate.season); } catch (e) { curStats = null; } }

  say("Rating every team…", 0.58);
  const members = teamStats && leagueKey === "cfb" ? Object.keys(teamStats).reduce((m, k) => (m[k] = 1, m), {}) : null;
  const ratings = buildRatings(history, L, { members, season: slate.season, week: slate.week });

  say("Pulling prices…", 0.62);
  let done = 0;
  const oddsList = await pool(live, async g => {
    try { const o = await loadGameOdds(L, g.id); if (o && (o.spreadHome != null || o.mlHome != null)) return o; } catch (e) {}
    return oddsFromScoreboard(g);
  }, 8, () => { done++; say("Pulling prices…", 0.62 + 0.3 * (done / Math.max(1, live.length))); });

  const useW = opts.mktW != null ? opts.mktW : autoMktW(L, slate.week);
  const useWT = opts.mktWTotal != null ? opts.mktWTotal : autoMktWTotal(L, slate.week);

  say("Calibrating against the market…", 0.93);
  // One pass to see how our numbers relate to the market's across the whole
  // slate, a second to actually price. Anything else is comparing a shrunk
  // projection to an unshrunk line and calling the difference an edge.
  const raw = live.map((g, i) => ({ g, o: oddsList[i], p: projectGame(ratings, L, g.home.id, g.away.id, g.neutral) }));
  const cal = {
    margin: calibrateSlate(raw.filter(x => x.o && x.o.spreadHome != null).map(x => ({ model: x.p.margin, market: -x.o.spreadHome }))),
    total: calibrateSlate(raw.filter(x => x.o && x.o.total != null).map(x => ({ model: x.p.total, market: x.o.total })))
  };

  say("Pricing the board…", 0.96);
  const popts = Object.assign({}, opts, { cal, mktW: useW, mktWTotal: useWT });
  const priced = live.map((g, i) => {
    const o = oddsList[i];
    const r = priceGame(ratings, L, g, o, popts);
    return { game: g, odds: o, proj: r.proj, blend: r.blend, ml: r.ml, plays: r.plays };
  });

  // Blend last season's team profile with this season's once there is enough
  // of this season to be worth having. Prop volume comes from these.
  const stats = {};
  const keys = new Set(Object.keys(teamStats || {}).concat(Object.keys(curStats || {})));
  keys.forEach(k => {
    const a = (teamStats || {})[k], b = (curStats || {})[k];
    if (!b) { stats[k] = a; return; }
    if (!a) { stats[k] = b; return; }
    const wb = clamp(b.gp / 6, 0, 1);
    const mix = {};
    Object.keys(a).forEach(f => {
      if (typeof a[f] === "number" && typeof b[f] === "number" && f !== "gp") mix[f] = (a[f] / Math.max(1, a.gp)) * (1 - wb) + (b[f] / Math.max(1, b.gp)) * wb;
    });
    // Everything is now a per-game rate, so gp is 1 — but `n` remembers how many
    // games are actually behind it, which is what the shrinkage needs.
    mix.gp = 1; mix.n = a.gp * (1 - wb) + b.gp * wb; mix.id = a.id; mix.abbr = a.abbr;
    stats[k] = mix;
  });

  return { league: leagueKey, L, season: slate.season, week: slate.week, ratings, cal, mktW: useW, mktWTotal: useWT, games: priced, teamStats: stats, rawTeamStats: teamStats };
}

// Props for one game, on demand. NFL pulls a league-wide feed once and reuses
// it; college has to walk two rosters, which is why it is a button and not a
// default.
async function loadGameProps(board, entry, cache, onStatus) {
  const L = board.L;
  const homeId = entry.game.home.id, awayId = entry.game.away.id;
  // Four games is about where this season's usage stops being a rounding error
  // on a hot afternoon and starts being the better description of the offence.
  const statSeason = board.week > 4 ? board.season : board.season - 1;
  const key = "players:" + board.league + ":" + statSeason;
  let players;
  if (L.bulkPlayers) {
    if (!cache[key]) {
      if (onStatus) onStatus("Loading player usage…", 0.1);
      cache[key] = await loadPlayersNFL(L, statSeason, p => onStatus && onStatus("Loading player usage…", 0.1 + 0.7 * p));
    }
    players = cache[key];
    // Re-seat everyone on the roster they are on today, and drop the ones who
    // are not on either of these two teams any more.
    try {
      if (onStatus) onStatus("Checking today's rosters…", 0.85);
      const rosters = await Promise.all([homeId, awayId].map(id => rosterCached(L, id, cache)));
      const seat = {};
      rosters.forEach((r, i) => r.forEach(a => { seat[a.id] = i === 0 ? homeId : awayId; }));
      players = players.filter(p => seat[p.id]).map(p => Object.assign({}, p, { teamId: seat[p.id] }));
    } catch (e) { /* roster feed down: fall back to the team the stats came with */ }
  } else {
    const gk = key + ":" + entry.game.id;
    if (!cache[gk]) {
      if (onStatus) onStatus("Loading both rosters…", 0.1);
      cache[gk] = await loadPlayersCFB(L, statSeason, [homeId, awayId], cache, p => onStatus && onStatus("Loading player usage…", 0.1 + 0.8 * p));
    }
    players = cache[gk];
  }
  const out = [];
  [[homeId, entry.proj.homePts, entry.blend.margin], [awayId, entry.proj.awayPts, -entry.blend.margin]].forEach(([tid, pts, mgn]) => {
    const ts = board.teamStats[tid];
    const vol = teamVolume(L, ts, pts, entry.blend.total, mgn);
    players.filter(p => p.teamId === tid).forEach(pl => {
      const pr = projectPlayer(L, pl, vol, ts);
      const mkts = propMarkets(pr);
      if (mkts.length) out.push({ teamId: tid, player: pl, proj: pr, markets: mkts, vol });
    });
  });
  // Rank by how much of the offence a player is actually being handed.
  out.sort((a, b) => (b.proj.eTgt + b.proj.eCar + b.proj.ePass * 0.6) - (a.proj.eTgt + a.proj.eCar + a.proj.ePass * 0.6));
  return out;
}

// ── walk-forward backtest ───────────────────────────────────────────────────
// Ratings for week N are rebuilt from weeks 1..N-1 plus the prior season, and
// nothing else. Grading is against the closing number the book actually hung
// and the score that actually happened.
async function backtest(leagueKey, season, weekFrom, weekTo, opts, onStatus) {
  const L = LEAGUES[leagueKey];
  opts = opts || {};
  const say = (m, p) => { if (onStatus) onStatus(m, p); };
  const capGames = opts.capGames || 400;

  say("Loading results…", 0.05);
  const history = await loadHistory(L, season, L.weeks, p => say("Loading results…", 0.05 + 0.25 * p));
  const inSeason = history.filter(g => g.season === season);

  const targets = [];
  for (let w = weekFrom; w <= weekTo; w++) inSeason.filter(g => g.week === w).forEach(g => targets.push(g));
  const use = targets.slice(0, capGames);

  say("Loading closing lines…", 0.32);
  let done = 0;
  const oddsList = await pool(use, async g => {
    try { return await loadGameOdds(L, g.id); } catch (e) { return null; }
  }, 8, () => { done++; say("Loading closing lines…", 0.32 + 0.5 * (done / Math.max(1, use.length))); });

  say("Replaying the season…", 0.85);
  const members = null;
  const byWeek = {};
  const plays = [], lines = [];
  for (let w = weekFrom; w <= weekTo; w++) {
    const known = history.filter(g => g.season < season || g.week < w);
    if (known.length < 40) continue;
    byWeek[w] = buildRatings(known, L, { members, season, week: w });
  }
  // Calibrate week by week off that week's lines only — those were on the board
  // before kickoff, so using them is not hindsight.
  const calByWeek = {};
  for (let w = weekFrom; w <= weekTo; w++) {
    const R = byWeek[w]; if (!R) continue;
    const rows = [];
    use.forEach((g, i) => {
      if (g.week !== w) return;
      const o = oddsList[i]; if (!o) return;
      const p = projectGame(R, L, g.home.id, g.away.id, g.neutral);
      rows.push({ o, p });
    });
    calByWeek[w] = {
      margin: calibrateSlate(rows.filter(r => r.o.spreadHome != null).map(r => ({ model: r.p.margin, market: -r.o.spreadHome }))),
      total: calibrateSlate(rows.filter(r => r.o.total != null).map(r => ({ model: r.p.total, market: r.o.total })))
    };
  }
  use.forEach((g, i) => {
    const R = byWeek[g.week]; const o = oddsList[i];
    if (!R || !o || o.spreadHome == null) return;
    const proj = projectGame(R, L, g.home.id, g.away.id, g.neutral);
    const bl = blendProjection(proj, o, opts.mktW != null ? opts.mktW : autoMktW(L, g.week), calByWeek[g.week], L,
      opts.mktWTotal != null ? opts.mktWTotal : autoMktWTotal(L, g.week));
    const actMargin = g.hs - g.as, actTotal = g.hs + g.as;
    lines.push({
      week: g.week, model: proj.margin, cal: bl.calMargin, market: -o.spreadHome, blend: bl.margin, actual: actMargin,
      modelTotal: proj.total, calTotal: bl.calTotal, marketTotal: o.total, actualTotal: actTotal
    });
    const pmf = marginPmf(bl.margin, proj.sigMargin, L.keyDamp);
    const sp = spreadProbs(pmf, o.spreadHome);
    const dv = devig(o.spreadOddsHome, o.spreadOddsAway);
    const gradeSpread = side => {
      const v = side === "home" ? actMargin + o.spreadHome : -actMargin - o.spreadHome;
      return v > 1e-9 ? 1 : (v < -1e-9 ? 0 : 0.5);
    };
    [["home", sp.win, dv.p1, o.spreadOddsHome], ["away", sp.lose, dv.p2, o.spreadOddsAway]].forEach(([side, p, mp, price]) => {
      if (mp == null) return;
      const pn = p / Math.max(1e-9, 1 - sp.push);
      plays.push({ market: "spread", week: g.week, side, edge: pn - mp, p: pn, price, res: gradeSpread(side) });
    });
    if (o.mlHome != null && o.mlAway != null) {
      const m = mlProbs(pmf), dvm = devig(o.mlHome, o.mlAway);
      const gradeML = side => actMargin === 0 ? 0.5 : ((side === "home") === (actMargin > 0) ? 1 : 0);
      [["home", m.home, dvm.p1, o.mlHome], ["away", m.away, dvm.p2, o.mlAway]].forEach(([side, p, mp, price]) => {
        const pn = p / Math.max(1e-9, 1 - m.push);
        plays.push({ market: "ml", week: g.week, side, edge: pn - mp, p: pn, price, res: gradeML(side) });
      });
    }
    if (o.total != null) {
      const tp = totalProbs(bl.total, proj.sigTotal, o.total), dvt = devig(o.overOdds, o.underOdds);
      const gradeT = side => actTotal === o.total ? 0.5 : ((side === "over") === (actTotal > o.total) ? 1 : 0);
      [["over", tp.over, dvt.p1, o.overOdds], ["under", tp.under, dvt.p2, o.underOdds]].forEach(([side, p, mp, price]) => {
        const pn = p / Math.max(1e-9, 1 - tp.push);
        plays.push({ market: "total", week: g.week, side, edge: pn - mp, p: pn, price, res: gradeT(side) });
      });
    }
  });
  return { league: leagueKey, season, lines, plays, games: lines.length };
}

// Aggregate a backtest into the only two questions that matter: is our number
// closer to the result than the market's, and does betting the disagreement
// actually make money after the vig?
function summarise(bt, thresholds) {
  const th = thresholds || [0.01, 0.02, 0.03, 0.05];
  const mae = arr => arr.length ? arr.reduce((s, v) => s + Math.abs(v), 0) / arr.length : null;
  const L = bt.lines;
  const acc = {
    games: L.length,
    maeModel: mae(L.map(x => x.model - x.actual)),
    maeCal: mae(L.map(x => x.cal - x.actual)),
    maeMarket: mae(L.map(x => x.market - x.actual)),
    maeBlend: mae(L.map(x => x.blend - x.actual)),
    maeTotalModel: mae(L.filter(x => x.marketTotal != null).map(x => x.modelTotal - x.actualTotal)),
    maeTotalCal: mae(L.filter(x => x.marketTotal != null).map(x => x.calTotal - x.actualTotal)),
    maeTotalMarket: mae(L.filter(x => x.marketTotal != null).map(x => x.marketTotal - x.actualTotal)),
    buckets: []
  };
  ["spread", "ml", "total"].forEach(market => {
    th.forEach(t => {
      const sel = bt.plays.filter(p => p.market === market && p.edge >= t);
      if (!sel.length) return;
      let win = 0, lose = 0, push = 0, pnl = 0, pxSum = 0;
      const rets = [];
      sel.forEach(p => {
        const d = amToDec(p.price) - 1;
        pxSum += p.price;
        if (p.res === 0.5) { push++; rets.push(0); return; }
        if (p.res === 1) { win++; pnl += d; rets.push(d); } else { lose++; pnl -= 1; rets.push(-1); }
      });
      // A backtest without an error bar is a story. One season of one league is
      // a few hundred bets, and a few hundred bets at football prices has a
      // standard error of several percent — big enough to manufacture a system
      // out of nothing. So every bucket carries how far it is from zero, and
      // the board is told to ignore anything under two standard errors.
      const n = rets.length;
      const mean = rets.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(rets.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / Math.max(1, n - 1));
      const se = sd / Math.sqrt(n);
      acc.buckets.push({
        market, edge: t, n, win, lose, push, pnl,
        roi: pnl / (win + lose || 1),
        avgPrice: pxSum / n, se, t: se > 0 ? mean / se : 0,
        significant: se > 0 && Math.abs(mean / se) >= 2
      });
    });
  });
  return acc;
}

return {
  VERSION, LEAGUES, SITE, WEB, CORE,
  clamp, num, normCdf, normPdf, gammaTail, gammaMedian, nbAtLeast, poissonAtLeast,
  amToDec, amToProb, probToAm, fmtAm, fmtLine, devig, evUnit, kelly,
  marginPmf, marginFromProb, spreadProbs, mlProbs, totalProbs, keyMult, KEY_MULT,
  getJSON, pool, loadWeek, loadHistory, loadSlate, loadTeamStats,
  buildRatings, ratingOf, projectGame, blendProjection, priceGame, keyCross, calibrateSlate, applyCal, autoMktW, autoMktWTotal,
  loadGameOdds, oddsFromScoreboard, loadLeagueBoard,
  teamVolume, loadRoster, loadPlayersNFL, loadPlayersCFB, projectPlayer, propMarkets, priceProp, loadGameProps,
  backtest, summarise
};
});
