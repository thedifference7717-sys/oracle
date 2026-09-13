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
    // Measured two ways that agree: the mean absolute error of the closing
    // total across the 2025 backtest implies 13.05, and fitting a distribution
    // to Kalshi's live total ladder — a real-money, near-vig-free market that
    // quotes every half point — implies 12.78. The 10.4 this started with was
    // far too narrow, and a too-narrow total is not a harmless approximation:
    // it manufactures a fake edge on every deep in-the-money rung and on both
    // sides of every posted total.
    sigTotal: 12.90,
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
  // Everyone outside the league shares one pooled rating, so "Alabama State"
  // and "North Dakota State" are the same number to this model. That is fine
  // for rating the FBS team that played them and useless for pricing the game
  // itself, so a game with a pooled side gets flagged and the market keeps it.
  const pooled = !R.teams[homeId] || !R.teams[awayId];
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
    thin: Math.min(h.gp, a.gp) < 4,
    pooled: pooled
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
  // A book that posts NO spread is not posting a pick-em, and the difference is
  // not academic: Math.abs(null) is 0 in this language, so an absent number used
  // to arrive as a coin flip. On Alabama State at Troy — no spread posted, the
  // moneyline -1650/+950 — that made the model believe the market had an FCS
  // visitor even with a Sun Belt team, and it put nearly nine percent of a
  // bankroll on the dog at +950. Absent has to mean absent.
  const raw$ = num(raw.spread);
  if (raw$ == null) return null;
  const mag = Math.abs(raw$);
  if (H.favorite === true) return -mag;
  if (H.favorite === false) return mag;
  return raw$;
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
  // WHICH SLOPE, AND WHY IT MATTERS MORE THAN IT LOOKS.
  //
  // The obvious fit is least squares: cov/var, the slope that best PREDICTS the
  // market from our number. It is also a trap. A best predictor is deliberately
  // shrunk toward the average — that is what makes it best — so our calibrated
  // number comes out systematically closer to zero than the market's. Subtract
  // one from the other and the difference points at the underdog every single
  // time, in every game, forever. The board fills up with dogs and unders and
  // it looks like an insight instead of arithmetic.
  //
  // It is not free to be wrong about this: across the 2025 backtest, plays on
  // the dog carried negative skill in three of four splits (college moneyline
  // dogs worst, -8.95% over 619 bets) while plays on the favourite were mildly
  // positive. A systematic tilt is a guaranteed leak.
  //
  // So we scale to match the market's SPREAD rather than to predict its level:
  // sd(market)/sd(model), which puts our numbers on the same footing as theirs
  // and leaves the disagreement symmetric. It amplifies our noise by 1/r, which
  // is a real cost — but noise is not a leak, and the blend that follows damps
  // it. Being unbiased and noisy beats being tidy and always on the dog.
  const olsB = varM > 1e-9 ? cov / varM : 1;
  const rmaB = (varM > 1e-9 && varK > 1e-9) ? Math.sign(cov || 1) * Math.sqrt(varK / varM) : 1;
  // Shrink toward "no correction" so a light slate cannot rescale the model on
  // noise, and never let it invert or run away. The intercept is then re-derived
  // rather than shrunk: whatever the slope ends up being, the line still has to
  // pass through the slate's own averages, or the correction quietly moves every
  // game the same way — which is how you end up holding thirteen overs and no
  // unders.
  // A scale is a steadier thing to estimate than a level, so it needs less
  // protection than the old slope did — too much and the compression it was
  // meant to cure creeps straight back in.
  const k = n0 == null ? 3 : n0;
  const b = clamp((rmaB * n + 1 * k) / (n + k), 0.70, 2.50);
  const a = mk - b * mm;
  const r = (varM > 0 && varK > 0) ? cov / Math.sqrt(varM * varK) : null;

  // A SINGLE SCALE IS NOT ENOUGH, and the college board proved it. Measured
  // against the market by size of line, our numbers came out 1.46x too extreme
  // on games inside a touchdown and barely HALF the market's on games outside
  // thirty — we said 19 where the book said 39. No straight line fixes both
  // ends, and the one we had was splitting the difference: slightly too big on
  // close games, wildly too small on mismatches, which quietly put every large
  // underdog on the board and nothing else.
  //
  // The compression is structural rather than accidental: blowouts are capped
  // through tanh before the fit ever sees them, and the ridge pulls the extreme
  // teams hardest, so the very games with the biggest lines are the ones our
  // ratings understate most.
  //
  // So the mapping is monotone rather than linear. Our games are ranked, the
  // market's are ranked, and ours is placed at the market's number for its own
  // rank. Ordering is what the model actually claims to know; scale is the
  // market's to set. What survives is disagreement about which team is better,
  // which is the only thing worth betting.
  const qs = good.slice().sort((x, y) => x.model - y.model).map(x => x.model);
  const qk = good.map(x => x.market).sort((x, y) => x - y);
  return { a, b, n, r, olsB, rmaB, qs, qk };
}
// Where v sits among our own numbers, read off at the market's number for that
// place. Falls back to the straight line when a slate is too small to rank.
function applyCal(cal, v) {
  if (!cal) return v;
  const lin = cal.a + cal.b * v;
  const qs = cal.qs, qk = cal.qk;
  if (!qs || qs.length < 10) return lin;
  const n = qs.length;
  let i = 0; while (i < n && qs[i] < v) i++;
  let mapped;
  if (i === 0) {
    // Below everything we have: shift by the offset at the bottom of the range.
    mapped = qk[0] + (v - qs[0]);
  } else if (i >= n) {
    mapped = qk[n - 1] + (v - qs[n - 1]);
  } else {
    const span = qs[i] - qs[i - 1];
    const t = span > 1e-9 ? (v - qs[i - 1]) / span : 0;
    mapped = qk[i - 1] + t * (qk[i] - qk[i - 1]);
  }
  // Half a step toward the straight line, so one odd slate cannot bend the
  // mapping into a shape the next slate will not recognise.
  return 0.75 * mapped + 0.25 * lin;
}

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
  // A posted spread is only worth anchoring to if the book's own moneyline
  // agrees with it. When the two disagree by more than about ten points of
  // probability, one of them is stale or malformed, and the moneyline is the
  // one with real money behind it.
  let spreadOk = odds && odds.spreadHome != null;
  if (spreadOk && L && odds.mlHome != null && odds.mlAway != null) {
    const dv = devig(odds.mlHome, odds.mlAway);
    if (dv.p1 != null) {
      const fromSpread = mlProbs(marginPmf(-odds.spreadHome, proj.sigMargin, L.keyDamp));
      const pSpread = fromSpread.home / Math.max(1e-9, 1 - fromSpread.push);
      if (Math.abs(pSpread - dv.p1) > 0.10) { spreadOk = false; out.spreadRejected = true; }
    }
  }
  if (spreadOk) {
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
  // No opinion worth having on a game where one side is a pooled average.
  const wUse = proj.pooled ? 0 : w;
  // And with the weight at zero, the ONLY thing that could still generate a
  // play is our spread-to-moneyline conversion disagreeing with the book's own
  // moneyline. Measured across a live slate that conversion sits within about
  // 1.8 points of the book at every spread size, with no bias on these games in
  // particular — so a four-point disagreement is not an insight, it is the
  // noise in our own conversion. Betting it on a game where we cannot even rate
  // one of the teams is indefensible. The game still shows in the table; it
  // just does not get to ask for money.
  const mute = proj.pooled;
  const bl = blendProjection(proj, odds, wUse, opts.cal, L,
    proj.pooled ? 0 : (opts.mktWTotal != null ? opts.mktWTotal : w));
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
      muted: mute, kellyRaw: kelly(p, pushP, american, kf),
      home: game.home, away: game.away, date: game.date, neutral: game.neutral,
      venue: game.venue, indoor: game.indoor, weather: game.weather,
      book: odds ? odds.book : null,
      p, push: pushP, price: american, fair,
      mktP: mktP == null ? null : mktP,
      edge: mktP == null ? null : p / Math.max(1e-9, 1 - pushP) - mktP,
      ev, kelly: mute ? 0 : kelly(p, pushP, american, kf),
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
      // What this team's OPPONENTS did against it — the defence, which the feed
      // has been handing over all along and which nothing was reading.
      dPassAtt: opp.passingAttempts || 0, dCompletions: opp.completions || 0,
      dPassYds: opp.passingYards || 0, dPassTD: opp.passingTouchdowns || 0,
      dRushAtt: opp.rushingAttempts || 0, dRushYds: opp.rushingYards || 0,
      dRushTD: opp.rushingTouchdowns || 0, dSacks: opp.sacks || 0,
      dPoints: opp.totalPoints || 0
    };
  });
  return out;
}

// How many snaps, and of what kind, does this team get in THIS game? Two
// forces move it: pace (a projected shootout is more plays and more scoring
// chances) and game script (a team projected to trail throws more, and the
// effect is worth several attempts a game, which is most of a prop line).
function teamVolume(L, ts, projPts, projTotal, projMargin, def, wx, uf) {
  const gp = Math.max(1, ts ? ts.gp : 1);
  const base = ts ? {
    pass: ts.passAtt / gp, sack: ts.sacks / gp, rush: ts.rushAtt / gp, comp: ts.completions / gp,
    pts: ts.points / gp, passTD: ts.passTD / gp, rushTD: ts.rushTD / gp,
    ypa: ts.passAtt ? ts.passYds / ts.passAtt : 7, ypc: ts.rushAtt ? ts.rushYds / ts.rushAtt : 4.3
  } : { pass: 33, sack: 2.3, rush: 26, comp: 21, pts: L.avgTotal / 2, passTD: 1.5, rushTD: 0.9, ypa: 7, ypc: 4.3 };

  const drops = base.pass + base.sack;
  const plays = Math.max(30, drops + base.rush);
  const passRate = clamp(drops / plays, 0.3, 0.78);
  // Pace is our own, the defence's willingness to allow snaps, and the weather.
  const dPace = def ? defFactor((def.passAttPG + def.rushAttPG), LEAGUE.passAttPG + LEAGUE.rushAttPG, def.n, 0.10) : 1;
  const pace = (1 + 0.25 * (projTotal / L.avgTotal - 1)) * dPace;
  // ~0.45 percentage points of pass rate per point of expected margin, capped
  // so a 30-point favourite does not end up in the wildcat.
  const shift = clamp(-0.0045 * projMargin, -0.09, 0.09);
  const playsAdj = plays * clamp(pace, 0.82, 1.20);
  const wxPass = wx ? wx.pass : 1;
  const unitPass = uf ? uf.passRate : 1;
  const dropsAdj = playsAdj * clamp((passRate + shift) * wxPass * unitPass, 0.25, 0.82);
  const sackRate = clamp((drops > 0 ? base.sack / drops : 0.07) * (uf ? uf.sack : 1), 0.01, 0.20);
  const passAtt = dropsAdj * (1 - sackRate);
  const rushAtt = playsAdj - dropsAdj;

  // Touchdown rate is measured, not assumed: a team that lives on field goals
  // should not be handed the league's red-zone conversion.
  const evid = ts ? (ts.n != null ? ts.n : ts.gp) : 0;
  const tdPerPt = base.pts > 0 ? clamp((base.passTD + base.rushTD) / base.pts, 0.06, 0.14) : 0.10;
  const td = projPts * shrink(tdPerPt, evid, 0.100, 6);   // projPts already carries the matchup
  const rushTDshare = (base.passTD + base.rushTD) > 0
    ? shrink(base.rushTD / (base.passTD + base.rushTD), evid, L.rushTDshare, 6)
    : L.rushTDshare;

  return {
    plays: playsAdj, passAtt, rushAtt, sacks: dropsAdj - passAtt,
    passRate: dropsAdj / playsAdj, basePassAtt: base.pass, baseRushAtt: base.rush,
    td, passTD: td * (1 - rushTDshare), rushTD: td * rushTDshare,
    // Efficiency the offence brings, already moved for who it is facing and
    // what the weather is doing.
    ypa: base.ypa * (def ? defFactor(def.ypa, LEAGUE.ypa, def.n) : 1) * (wx ? wx.ypa : 1) * (uf ? uf.ypa : 1),
    ypc: base.ypc * (def ? defFactor(def.ypc, LEAGUE.ypc, def.n) : 1) * (uf ? uf.ypc : 1),
    defCatch: def ? def.catch : LEAGUE.catch,
    defN: def ? def.n : 0,
    tdFactor: def ? defFactor(def.ptsPG, LEAGUE.ptsPG, def.n, 0.20) : 1,
    pts: projPts, wx: wx || null, units: uf || null
  };
}

// ── the other side of the ball ──────────────────────────────────────────────
// Until now a projection knew how much of his offence a player gets and
// nothing whatsoever about who he is playing. A slot receiver drew the same
// number against the best secondary in the league as against the worst, which
// is not a model of anything.
//
// The fix is the same one the baseball board uses: a rate is the player's own
// rate, moved by the opponent's rate, relative to the league. For a
// probability that is log5 — the odds-ratio — and for a per-attempt yardage it
// is the multiplicative form of the same idea. Both are shrunk by how much of
// the defence we have actually seen, because a run defence after two games is
// mostly the two offences it happened to draw.
const LEAGUE = { ypa: 7.0, ypc: 4.3, catch: 0.645, passAttPG: 32.1, rushAttPG: 26.8, ptsPG: 23.0, sackRate: 0.068 };

const DEF_CARRY = 0.15;                 // a prior-season game, in this-season games
function defenceProfile(ts) {
  if (!ts) return null;
  // Trust grows on its own as this season accumulates, which is the behaviour
  // we want: nearly deaf to the matchup in September, listening by November.
  const gp = ts.nCur != null
    ? Math.max(0.5, ts.nCur + DEF_CARRY * (ts.nPrior || 0))
    : Math.max(1, ts.n != null ? ts.n : ts.gp);
  const perG = v => (v || 0) / Math.max(1, ts.gp);
  const passAtt = perG(ts.dPassAtt), rushAtt = perG(ts.dRushAtt);
  return {
    n: gp,
    ypa: ts.dPassAtt ? ts.dPassYds / ts.dPassAtt : LEAGUE.ypa,
    ypc: ts.dRushAtt ? ts.dRushYds / ts.dRushAtt : LEAGUE.ypc,
    catch: ts.dPassAtt ? clamp(ts.dCompletions / ts.dPassAtt, 0.4, 0.8) : LEAGUE.catch,
    passAttPG: passAtt || LEAGUE.passAttPG,
    rushAttPG: rushAtt || LEAGUE.rushAttPG,
    ptsPG: perG(ts.dPoints) || LEAGUE.ptsPG,
    passTDPG: perG(ts.dPassTD), rushTDPG: perG(ts.dRushTD)
  };
}
// How much to move a rate for this defence: 1.0 is neutral. Shrunk toward
// neutral by the games behind it, and capped, because no defence is worth a
// forty percent swing on a receiving line.
function defFactor(allowed, league, n, cap) {
  if (!(league > 0) || !(allowed > 0)) return 1;
  const raw = allowed / league;
  const w = clamp((n || 0) / ((n || 0) + 6), 0, 1);      // six games to half-trust it
  const lim = cap == null ? 0.18 : cap;
  return clamp(1 + w * (raw - 1), 1 - lim, 1 + lim);
}
// Log5 for genuine probabilities: the player's rate, the defence's rate, and
// the league's, combined as odds rather than averaged.
function log5(p, d, lg) {
  if (!(lg > 0) || !(lg < 1)) return p;
  const o = (x) => clamp(x, 1e-4, 1 - 1e-4) / (1 - clamp(x, 1e-4, 1 - 1e-4));
  const odds = o(p) * o(d) / o(lg);
  return odds / (1 + odds);
}

// Weather, with a caveat that matters more than the adjustment. The feed gives
// a temperature and a phrase; it does NOT give wind, and wind is the only
// weather that seriously moves a passing line. So this is a small, honest
// nudge for cold and wet and nothing more — it should not be mistaken for a
// weather model.
function weatherFactor(game) {
  const out = { pass: 1, ypa: 1, total: 1, note: null };
  if (!game || game.indoor) return out;
  const w = game.weather || {};
  const t = num(w.temperature);
  const cond = String(w.displayValue || "").toLowerCase();
  const wet = /rain|shower|snow|storm|sleet|drizzle|flurr/.test(cond);
  if (t != null && t <= 32) {
    out.ypa *= 0.97; out.total *= 0.97;
    out.note = "cold (" + t + "°F)";
  }
  if (wet) {
    out.pass *= 0.97; out.ypa *= 0.96; out.total *= 0.96;
    out.note = (out.note ? out.note + ", " : "") + cond;
  }
  return out;
}

// Injuries. A player who is out should not be projected at all, and the snaps
// he is not taking have to go somewhere — usually to the man behind him, which
// is the single biggest thing that moves a prop line in the last hour before
// kickoff.
const INJ_PLAY = { out: 0, doubtful: 0.12, questionable: 0.72, probable: 0.95 };
function injuryWeight(status) {
  if (!status) return 1;
  const k = String(status).toLowerCase();
  if (k.indexOf("out") >= 0 || k.indexOf("injured reserve") >= 0 || k.indexOf("suspend") >= 0) return INJ_PLAY.out;
  if (k.indexOf("doubtful") >= 0) return INJ_PLAY.doubtful;
  if (k.indexOf("question") >= 0) return INJ_PLAY.questionable;
  if (k.indexOf("probable") >= 0) return INJ_PLAY.probable;
  return 1;
}
// WHICH injuries, not how many. A backup corner being out is worth nothing; the
// starting corner being out is worth a percent or two on the other team's
// passing game, and the two are indistinguishable in a list of names. The depth
// chart settles it — rank 1 at a position is the starter.
const UNIT_OF = {
  lt: "oline", lg: "oline", c: "oline", rg: "oline", rt: "oline",
  lcb: "secondary", rcb: "secondary", ss: "secondary", fs: "secondary", nb: "secondary",
  lde: "front7", rde: "front7", nt: "front7", dt: "front7", ldt: "front7", rdt: "front7",
  wlb: "front7", slb: "front7", lilb: "front7", rilb: "front7", mlb: "front7", lolb: "front7", rolb: "front7",
  qb: "qb", rb: "skill", wr: "skill", te: "skill", fb: "skill"
};
async function loadDepthChart(L, teamId, season) {
  const d = await getJSON(`${CORE}/${L.core}/seasons/${season}/teams/${teamId}/depthcharts`, 2);
  const out = {};
  (d.items || []).forEach(grp => {
    const pos = grp.positions || {};
    Object.keys(pos).forEach(key => {
      const unit = UNIT_OF[key];
      if (!unit) return;
      (pos[key].athletes || []).forEach(a => {
        const ref = ((a.athlete || {})["$ref"]) || "";
        const id = ref.split("/athletes/")[1];
        if (!id) return;
        const aid = id.split("?")[0];
        // Keep the best rank a player holds anywhere on the chart.
        const rank = a.rank != null ? a.rank : 99;
        if (!out[aid] || rank < out[aid].rank) out[aid] = { rank, key, unit };
      });
    });
  });
  return out;
}
// How much of each unit is missing, counted in starters. A doubtful starter is
// most of a starter gone; a questionable one is a fraction.
//
// The MAGNITUDES BELOW ARE JUDGEMENT, not measurement, and they are capped
// accordingly. The defensive rates elsewhere in this model come from what a
// defence has actually allowed; these do not, because the feed will never tell
// us how a line played without its left tackle. They are deliberately small —
// the direction is confident, the size is not.
function unitsOut(injByTeam, depth) {
  const out = { oline: 0, secondary: 0, front7: 0, qb: 0 };
  if (!injByTeam || !depth) return out;
  Object.keys(injByTeam).forEach(aid => {
    const d = depth[aid];
    if (!d || d.rank !== 1) return;                 // only starters count
    const missing = 1 - injuryWeight(injByTeam[aid]);
    if (missing <= 0) return;
    if (out[d.unit] != null) out[d.unit] += missing;
  });
  Object.keys(out).forEach(k => { out[k] = clamp(out[k], 0, 3); });
  return out;
}
// What a missing starter is worth. Own line first, then what the opponent is
// missing — a depleted secondary is why a quarterback throws more than his
// season rate says he will, which is the whole point of doing this by unit.
// `strength` dials the whole thing. It defaults to ZERO, and the reason is
// written down rather than buried: swept against the exchange's own ladders the
// effect is monotonically harmful — 7.09pp of error with it off, 7.10 at a
// quarter strength, 7.14 at full, 7.20 at double. Not noise either: paired on
// 2,222 identical rungs it is t = -3.6 against us.
//
// The idea is sound and I still believe the mechanism is real. The likeliest
// explanation is that a liquid market has already priced a public injury report
// before we get to it, so an adjustment laid on top of our own projection
// pushes past what the market has already done — and the magnitudes here were
// my judgement rather than anything measured, which I said when I wrote them.
//
// So it ships visible and inert: the board shows you which units are missing,
// and does not move the number unless you ask it to.
function unitFactors(own, opp, strength) {
  const k = strength == null ? 0 : strength;
  const sc = v => (v || 0) * k;
  const o = { oline: sc((own || {}).oline) };
  const d = { secondary: sc((opp || {}).secondary), front7: sc((opp || {}).front7) };
  return {
    ypc: (1 - 0.035 * o.oline) * (1 + 0.025 * d.front7),
    ypa: (1 - 0.015 * o.oline) * (1 + 0.030 * d.secondary) * (1 + 0.010 * d.front7),
    sack: 1 + 0.12 * o.oline,
    // Coaches throw at a hurt secondary and run at a hurt front. Both show up
    // as play-calling before they show up as efficiency.
    passRate: 1 + 0.015 * d.secondary - 0.012 * d.front7 - 0.010 * o.oline,
    strength: k,
    note: [
      (own || {}).oline >= 0.5 ? (own.oline).toFixed(1) + " OL out" : null,
      (opp || {}).secondary >= 0.5 ? "opp " + (opp.secondary).toFixed(1) + " DB out" : null,
      (opp || {}).front7 >= 0.5 ? "opp " + (opp.front7).toFixed(1) + " front-7 out" : null
    ].filter(Boolean).join(", ") || null
  };
}

// The game summary carries both teams' reports. It is a heavy payload, so it
// is fetched once per game and cached.
async function loadInjuries(L, eventId) {
  const d = await getJSON(`${SITE}/${L.path}/summary?event=${eventId}`, 2);
  const out = {};
  (d.injuries || []).forEach(t => {
    const tid = String((t.team || {}).id || "");
    if (!tid) return;
    const m = out[tid] || (out[tid] = {});
    (t.injuries || []).forEach(x => {
      const aid = String(((x.athlete || {}).id) || "");
      if (aid) m[aid] = x.status || (x.type || {}).description || "";
    });
  });
  return out;
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

// How over-dispersed each count is relative to Poisson (Var = m + m^2/k, so a
// bigger k is closer to Poisson), and a scale on each yardage variance.
//
// These are FITTED, not chosen. Kalshi quotes a ladder of strikes on passing
// yards, receiving yards and receptions for every player in every game, and a
// ladder is a cumulative distribution: it says what the market thinks the whole
// shape is, not just the middle. Fitting our own shape to ~2,000 live rungs is
// the only outside check on a prop model that exists short of a season of
// results — and it said our first pass was 11-17% too wide on every one of
// them, which pushed our median well under the market's and would have had the
// board recommending unders all day.
//
// Receptions came back essentially Poisson once the game is fixed: conditional
// on a projection, the extra dispersion I assumed was not there.
let DISP = { tgt: 6, rec: 20, car: 18, att: 25 };
let VAR = { recYds: 0.85, rushYds: 0.80, passYds: 0.70 };
// Exposed so the shape can be refitted against a live ladder rather than
// staying frozen at whatever last season implied.
function setPropShape(d, v) {
  if (d) DISP = Object.assign({}, DISP, d);
  if (v) VAR = Object.assign({}, VAR, v);
  return { DISP: DISP, VAR: VAR };
}
const propShape = () => ({ DISP: Object.assign({}, DISP), VAR: Object.assign({}, VAR) });

// Usage share of a projected volume, then efficiency — never a yards-per-game
// average, which bakes in a schedule and a game script that will not repeat.
function projectPlayer(L, pl, vol, ts, scale) {
  const gp = Math.max(1, pl.gp);
  const teamPassAtt = ts && ts.gp ? ts.passAtt / ts.gp : vol.basePassAtt;
  const teamRushAtt = ts && ts.gp ? ts.rushAtt / ts.gp : vol.baseRushAtt;
  const role = roleOf(pl.pos);

  // College target counts are patchy; receptions over the catch rate is the
  // same measurement taken the long way round, and it is always populated.
  const rawTgt = pl.tgt > 0 ? pl.tgt / gp : (pl.rec / gp) / 0.66;
  const tgtPerG = shrink(rawTgt, gp, role.tgt, 3);
  const carPerG = shrink(pl.rushAtt / gp, gp, role.car, 3);
  // A quarterback's prior is not "the average rostered quarterback" — that
  // number is a blend of starters and clipboard holders, and shrinking a
  // seventeen-game starter toward it quietly costs him two or three attempts a
  // game. Measured against the exchange's own passing ladders that was worth
  // about seventeen yards of projection, every week, on every starter. The
  // prior that belongs here is what THIS offence throws.
  const qbPrior = pl.pos === "QB" ? Math.max(role.att, 0.92 * teamPassAtt) : role.att;
  const attPerG = shrink(pl.passAtt / gp, gp, qbPrior, 3);
  const tgtShare = tgtPerG / Math.max(1, teamPassAtt);
  const carryShare = carPerG / Math.max(1, teamRushAtt);
  const attShare = attPerG / Math.max(1, teamPassAtt);

  // Catch rate is a probability, so the defence enters through log5 rather than
  // as a multiplier — the odds-ratio, the same combination the baseball board
  // uses for a hitter against a pitcher.
  const ownCatch = pl.tgt > 0 ? shrink(pl.rec / pl.tgt, pl.tgt, LEAGUE.catch, 25) : LEAGUE.catch;
  const catchRate = clamp(log5(ownCatch, vol.defCatch != null ? vol.defCatch : LEAGUE.catch, LEAGUE.catch), 0.35, 0.92);
  // Yardage rates are per-attempt, so the matchup is multiplicative. vol.ypa
  // and vol.ypc already carry the defence and the weather.
  const yprBase = pl.rec > 0 ? shrink(pl.recYds / pl.rec, pl.rec, 11.6, 20) : 11.6;
  const ypr = yprBase * (vol.ypa / LEAGUE.ypa);
  const ypc = pl.rushAtt > 0 ? shrink(pl.rushYds / pl.rushAtt, pl.rushAtt, vol.ypc, 45) : vol.ypc;
  const ypa = pl.passAtt > 0 ? shrink(pl.passYds / pl.passAtt, pl.passAtt, vol.ypa, 80) : vol.ypa;

  const sc = scale || {};
  const eTgt = tgtShare * vol.passAtt * (sc.eTgt != null ? sc.eTgt : 1);
  const eRec = eTgt * catchRate;
  const eCar = carryShare * vol.rushAtt * (sc.eCar != null ? sc.eCar : 1);
  const ePass = attShare * vol.passAtt * (sc.ePass != null ? sc.ePass : 1);

  // Compound variance: a count of chances, each worth a spread of yards. This
  // is why a 3-target night and a 12-target night get different shapes instead
  // of one blanket standard deviation.
  const vTgt = eTgt + eTgt * eTgt / DISP.tgt;
  const vRec = eRec + eRec * eRec / DISP.rec;
  const vCar = eCar + eCar * eCar / DISP.car;
  const vPass = ePass + ePass * ePass / DISP.att;

  const recYds = { mean: eRec * ypr, var: VAR.recYds * (eRec * Math.pow(1.15 * ypr, 2) + vRec * ypr * ypr) };
  const rushYds = { mean: eCar * ypc, var: VAR.rushYds * (eCar * 30 + vCar * ypc * ypc) };   // ~5.5 yd sd per carry
  const passYds = { mean: ePass * ypa, var: VAR.passYds * (ePass * 94 + vPass * ypa * ypa) };// ~9.7 yd sd per attempt

  // Touchdowns: half the player's own scoring share, half his share of the
  // opportunities, and both measured per game so a season total is never
  // divided by a per-game team rate. Pure TD share overfits a fluke red-zone
  // month; pure opportunity share misses the back they hand the ball to on the
  // one-yard line.
  const teamRecTDpg = ts && ts.gp ? ts.passTD / ts.gp : vol.passTD;
  const teamRushTDpg = ts && ts.gp ? ts.rushTD / ts.gp : vol.rushTD;
  const ownRecShare = teamRecTDpg > 0.05 ? clamp((pl.recTD / gp) / teamRecTDpg, 0, 1) : tgtShare;
  const ownRushShare = teamRushTDpg > 0.05 ? clamp((pl.rushTD / gp) / teamRushTDpg, 0, 1) : carryShare;
  const tdF = vol.tdFactor != null ? vol.tdFactor : 1;
  const lamRec = vol.passTD * tdF * clamp(0.5 * shrink(ownRecShare, pl.recTD, tgtShare, 3) + 0.5 * tgtShare, 0, 0.6);
  const lamRush = vol.rushTD * tdF * clamp(0.5 * shrink(ownRushShare, pl.rushTD, carryShare, 3) + 0.5 * carryShare, 0, 0.75);

  return {
    player: pl, eTgt, eRec, eCar, ePass, catchRate, ypr, ypc, ypa,
    recYds, rushYds, passYds,
    rec: { mean: eRec, k: DISP.rec }, car: { mean: eCar, k: DISP.car },
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

// ── simulating the game ─────────────────────────────────────────────────────
// Everything above prices one leg at a time. A parlay is not one leg at a
// time. Legs in the same game move together, and multiplying their
// probabilities is the most expensive mistake available in this market.
//
// So the board simulates the afternoon instead. One pass draws a whole game —
// the script, each side's volume, how the targets and carries fell, how each
// man did with them — and every leg reads its answer off the same draw. Three
// things fall out of that which per-leg pricing cannot give you:
//
//   1. A RANGE. The middle half of ten thousand simulated afternoons is what
//      "he'll get about this much" actually means, and it is wider than
//      anyone's intuition.
//   2. PARLAYS PRICED PROPERLY, at any number of legs, with no correlation
//      matrix to invert and no copula to fray in the tails.
//   3. SAME-PLAYER LEGS THAT AGREE. Two catches cannot make ninety yards. A
//      copula will cheerfully say they can; a simulation that draws the
//      catches first cannot.
//
// Every constant here is fitted on the 2023 season and scored on 2024, in
// scripts/nfl-prop-shape.mjs. The fitted shapes reproduce the real
// distribution of player games to within a chi-square of about 30 on 19
// degrees of freedom, out of sample, against 120-320 for what this replaced.

// Deterministic: the same slate has to produce the same board twice, or every
// refresh moves the numbers under the user.
function rng(seed) {
  let a = (seed >>> 0) || 0x2F6E2B1;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalDraw(r) {
  let u = r(); if (u <= 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * r());
}
function normInv(p) {
  p = clamp(p, 1e-9, 1 - 1e-9);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  let q, r;
  if (p < 0.02425) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 0.97575) { q = Math.sqrt(-2 * Math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
function poisDraw(lam, r) {
  if (!(lam > 0)) return 0;
  if (lam < 25) {
    const L = Math.exp(-lam);
    let k = 0, p = 1;
    do { k++; p *= r(); } while (p > L);
    return k - 1;
  }
  const n = Math.round(lam + Math.sqrt(lam) * normalDraw(r));
  return n > 0 ? n : 0;
}
function binomDraw(n, p, r) {
  if (!(n > 0) || !(p > 0)) return 0;
  if (p >= 1) return n;
  if (n <= 40) { let k = 0; for (let i = 0; i < n; i++) if (r() < p) k++; return k; }
  const k = Math.round(n * p + Math.sqrt(n * p * (1 - p)) * normalDraw(r));
  return clamp(k, 0, n);
}
// Marsaglia-Tsang, with the standard boost below shape 1.
function gammaDraw(shape, scale, r) {
  if (!(shape > 0) || !(scale > 0)) return 0;
  if (shape < 1) return gammaDraw(shape + 1, scale, r) * Math.pow(r() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (let guard = 0; guard < 500; guard++) {
    let x, v;
    do { x = normalDraw(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
  return d * scale;
}
// A multiplier with mean 1 and the given log-variance. Used for the volume
// shocks, where a lognormal and a gamma are indistinguishable at these
// dispersions and the lognormal is monotone in a normal draw, which is what
// lets one script latent move two teams in opposite directions.
function logNormOf(z, cv) {
  if (!(cv > 0)) return 1;
  const s2 = Math.log(1 + cv * cv);
  return Math.exp(Math.sqrt(s2) * z - s2 / 2);
}

// ── fitted shapes, per role ─────────────────────────────────────────────────
//   volCv   how much of his usual workload he gets, week to week
//   volDud  and how often that collapses outright (hurt, benched, game gone)
//   effS2   the spread on each catch / carry / attempt, as a share of the
//           average gain squared
//   effDud  a day where the yards are not there at all — shadowed, jammed,
//           thrown at underneath all afternoon
const SIM_ROLE = {
  QB:  { volCv: 0.173, volDud: 0.02, volDudAt: 0.10, effS2: 0.60, effDud: 0.08, effDudAt: 0.50 },
  RB:  { volCv: 0.374, volDud: 0.02, volDudAt: 0.10, effS2: 1.60, effDud: 0.04, effDudAt: 0.30 },
  REC: { volCv: 0.224, volDud: 0.12, volDudAt: 0.70, effS2: 0.40, effDud: 0.18, effDudAt: 0.50 }
};
// Team level, measured over 1,140 team-games.
const SIM_TEAM = {
  passCv: 0.153,       // week-to-week swing in a team's pass attempts
  rushCv: 0.195,
  // The two sides of one game do not move independently. Rush attempts run at
  // -0.51 against each other — the clearest single correlation in football,
  // and why two opposing backs is a worse parlay than it looks. Pass attempts
  // run at -0.15. Our passing against their rushing is 0.01, i.e. nothing,
  // which is why the script needs two latents and not one.
  passScript: 0.389,   // sqrt(0.151)
  rushScript: 0.713,   // sqrt(0.508)
  // How much a man's share of his own offence moves week to week. A Dirichlet
  // was the obvious choice and it is wrong: with one concentration it hands a
  // third receiver three times the relative swing of a first, and the real
  // spread of a WR3's receptions is nothing like that. So each man's share
  // gets its own lognormal wobble at a constant RELATIVE size, and the shares
  // are then renormalised — which also produces the push between teammates
  // for free, since a bigger slice for one is a smaller slice for the rest.
  // Fitted so the simulated spread of receptions and carries matches the real
  // one. Carries move more than twice as much as targets do: the committee
  // backfield, stated as a number.
  tgtShareCv: 0.170,
  carShareCv: 0.400,
  // Within one team, throwing and running trade off at -0.33: get ahead and
  // you run it out, fall behind and you throw. Across the two teams it is
  // -0.15 on pass attempts and -0.51 on rush attempts, while OUR passing
  // against THEIR running is 0.01 — nothing. No single script latent can
  // produce all four; two can, with the leftovers correlated inside each team.
  withinTeam: -0.507,
  leakCatch: 0.64      // catch rate for the targets nobody is pricing
};
function setSimShape(role, team) {
  if (role) Object.keys(role).forEach(k => { SIM_ROLE[k] = Object.assign({}, SIM_ROLE[k], role[k]); });
  if (team) Object.assign(SIM_TEAM, team);
  return { SIM_ROLE: SIM_ROLE, SIM_TEAM: SIM_TEAM };
}
const simShape = () => ({ SIM_ROLE: JSON.parse(JSON.stringify(SIM_ROLE)), SIM_TEAM: Object.assign({}, SIM_TEAM) });
const simRole = pos => pos === "QB" ? "QB" : (pos === "RB" || pos === "FB" ? "RB" : "REC");
// A two-point multiplier with mean 1: the bad day, and every other day.
function dudMul(u, rate, level) {
  if (!(rate > 0)) return 1;
  return (u < rate ? level : 1) / (rate * level + 1 - rate);
}

// Simulate one game N times. `sides` is [home, away]; each is the player list
// loadGameProps produced for that team.
//
// The ORDER is the whole point. Team volume is drawn first; targets and
// carries are then shared out of that fixed pool; the quarterback's passing
// line is the sum of what his receivers did. So a receiver's big day IS the
// quarterback's big day, two backs splitting one pile of carries push against
// each other, and nothing anywhere has to be told to correlate with anything.
function simulateGame(sides, opts) {
  opts = opts || {};
  const N = opts.n || 10000;
  const r = rng(opts.seed != null ? opts.seed : 0x9E3779B9);
  const T = SIM_TEAM;
  const MK = ["rec", "recYds", "car", "rushYds", "passAtt", "passYds", "passTD", "atd"];

  const men = [];
  sides.forEach((list, si) => (list || []).forEach(pl => {
    const role = simRole((pl.player || {}).pos);
    const out = {}; MK.forEach(k => out[k] = new Float32Array(N));
    men.push({ si, pl, role, R: SIM_ROLE[role], p: pl.proj, out });
  }));

  const side = sides.map((list, si) => {
    const mine = men.filter(m => m.si === si);
    const vol = (list && list[0] && list[0].vol) || {};
    const qb = mine.filter(m => m.role === "QB").sort((a, b) => b.p.ePass - a.p.ePass)[0] || null;
    const tgtSum = mine.reduce((s, m) => s + (m.p.eTgt || 0), 0);
    const carSum = mine.reduce((s, m) => s + (m.p.eCar || 0), 0);
    const passAtt = Math.max(tgtSum, vol.passAtt || tgtSum || 1);
    const rushAtt = Math.max(carSum, vol.rushAtt || carSum || 1);
    // The quarterback's projected yards are the anchor. Whatever the priced
    // receivers do not account for belongs to everybody else on the roster.
    const qbYds = qb ? qb.p.passYds.mean : mine.reduce((s, m) => s + m.p.recYds.mean, 0) / 0.82;
    const mineYds = mine.reduce((s, m) => s + (m.p.recYds.mean || 0), 0);
    const leakTgt = Math.max(0, passAtt - tgtSum), leakCar = Math.max(0, rushAtt - carSum);
    return { mine, vol, qb, passAtt, rushAtt, leakTgt, leakCar,
      leakYpr: leakTgt > 0.2 ? Math.max(0, qbYds - mineYds) / (leakTgt * T.leakCatch) : 0,
      leakYpc: Math.max(2.5, vol.ypc || 4.2),
      passTD: vol.passTD || 1.4 };
  });

  // Share a fixed pool out exactly, so the parts always add to the whole.
  // Independent draws per man would let five receivers between them be thrown
  // at more times than the team threw, which is where a naive simulation
  // quietly loses the correlation it was built to capture.
  const alloc = new Float64Array(64);
  function multinomial(n, w, k, r) {
    let left = n, wl = 0;
    for (let i = 0; i < k; i++) wl += w[i];
    for (let i = 0; i < k; i++) {
      if (left <= 0 || wl <= 1e-12) { alloc[i] = 0; continue; }
      const a = binomDraw(left, clamp(w[i] / wl, 0, 1), r);
      alloc[i] = a; left -= a; wl -= w[i];
    }
    return left;                                   // whatever was not handed out
  }
  const wT = new Float64Array(64), wC = new Float64Array(64);

  for (let it = 0; it < N; it++) {
    const zPass = normalDraw(r), zRush = normalDraw(r);
    for (let si = 0; si < side.length; si++) {
      const S = side[si], k = S.mine.length; if (!k) continue;
      const sgn = si === 0 ? 1 : -1;
      // A team that gets ahead throws less and runs more; the other side does
      // the reverse. One draw seen from two ends, not two assumptions.
      const e1 = normalDraw(r);
      const e2 = T.withinTeam * e1 + Math.sqrt(1 - T.withinTeam * T.withinTeam) * normalDraw(r);
      const zp = -T.passScript * sgn * zPass + Math.sqrt(1 - T.passScript * T.passScript) * e1;
      const zr =  T.rushScript * sgn * zRush + Math.sqrt(1 - T.rushScript * T.rushScript) * e2;
      const nPass = poisDraw(S.passAtt * logNormOf(zp, T.passCv), r);
      const nRush = poisDraw(S.rushAtt * logNormOf(zr, T.rushCv), r);

      // Usage: his slice of the week, times whether he is right today.
      for (let i = 0; i < k; i++) {
        const m = S.mine[i], R = m.R;
        m._dud = dudMul(r(), R.volDud, R.volDudAt);
        wT[i] = m.p.eTgt > 1e-6 ? m.p.eTgt * logNormOf(normalDraw(r), T.tgtShareCv) * m._dud : 0;
        wC[i] = m.p.eCar > 1e-6 ? m.p.eCar * logNormOf(normalDraw(r), T.carShareCv) * m._dud : 0;
      }
      wT[k] = S.leakTgt > 1e-6 ? S.leakTgt * logNormOf(normalDraw(r), T.tgtShareCv) : 0;
      wC[k] = S.leakCar > 1e-6 ? S.leakCar * logNormOf(normalDraw(r), T.carShareCv) : 0;

      multinomial(nPass, wT, k + 1, r);
      const tgt = alloc.slice(0, k + 1);
      multinomial(nRush, wC, k + 1, r);
      const car = alloc.slice(0, k + 1);

      let teamRecYds = 0;
      for (let i = 0; i < k; i++) {
        const m = S.mine[i], R = m.R, P = m.p;
        const eff = dudMul(r(), R.effDud, R.effDudAt);
        let rec = 0, recYds = 0;
        if (tgt[i] > 0) {
          rec = binomDraw(tgt[i], clamp(P.catchRate, 0.05, 0.98), r);
          if (rec > 0) {
            const mu = rec * P.ypr * eff, vr = rec * R.effS2 * P.ypr * P.ypr * eff * eff;
            recYds = vr > 1e-9 ? gammaDraw(mu * mu / vr, vr / mu, r) : mu;
          }
        }
        let rushYds = 0;
        if (car[i] > 0) {
          const e2 = m.role === "QB" ? 1 : eff;
          const mu = car[i] * P.ypc * e2, vr = car[i] * SIM_ROLE.RB.effS2 * P.ypc * P.ypc * e2 * e2;
          rushYds = vr > 1e-9 ? gammaDraw(mu * mu / vr, vr / mu, r) : mu;
        }
        m.out.rec[it] = rec; m.out.recYds[it] = recYds;
        m.out.car[it] = car[i]; m.out.rushYds[it] = rushYds;
        teamRecYds += recYds;
      }
      // What the men nobody prices did with the rest of it.
      let leakYds = 0;
      if (tgt[k] > 0 && S.leakYpr > 0) {
        const rec = binomDraw(tgt[k], T.leakCatch, r);
        if (rec > 0) {
          const le = dudMul(r(), SIM_ROLE.REC.effDud, SIM_ROLE.REC.effDudAt);
          const mu = rec * S.leakYpr * le, vr = rec * SIM_ROLE.REC.effS2 * S.leakYpr * S.leakYpr * le * le;
          leakYds = gammaDraw(mu * mu / vr, vr / mu, r);
        }
      }
      // The quarterback's line IS his receivers' lines added up.
      if (S.qb) {
        const py = teamRecYds + leakYds;
        S.qb.out.passAtt[it] = nPass;
        S.qb.out.passYds[it] = py;
        S.qb.out.passTD[it] = poisDraw(S.passTD * clamp(py / Math.max(40, S.qb.p.passYds.mean), 0.15, 2.6), r);
      }
      // Scoring rides on the afternoon he actually had, not his season
      // average: a back who got nine carries in a blowout the wrong way does
      // not vulture a one-yard touchdown.
      for (let i = 0; i < k; i++) {
        const m = S.mine[i], P = m.p;
        const lam = (P.lamRec || 0) * clamp(m.out.recYds[it] / Math.max(8, P.recYds.mean), 0.1, 3) +
                    (P.lamRush || 0) * clamp(m.out.rushYds[it] / Math.max(8, P.rushYds.mean), 0.1, 3);
        m.out.atd[it] = poisDraw(lam, r) > 0 ? 1 : 0;
      }
    }
  }
  return { n: N, men, side };
}

// ── reading the simulation ──────────────────────────────────────────────────
// The quantiles of what was simulated. This is the range the board shows, and
// it is not decoration: a receiver whose number is 54 yards has a middle half
// running roughly 25 to 75, and a quarter of the time he finishes outside even
// that. Anyone betting a prop should see that before the price.
function quantiles(arr, qs) {
  const a = Float64Array.from(arr); a.sort();
  const n = a.length;
  return qs.map(q => {
    const i = (n - 1) * clamp(q, 0, 1), lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
  });
}
const RANGE_QS = [0.10, 0.25, 0.50, 0.75, 0.90];
function simRange(samples) {
  const q = quantiles(samples, RANGE_QS);
  let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i];
  return { mean: s / samples.length, p10: q[0], p25: q[1], median: q[2], p75: q[3], p90: q[4] };
}

// Every market the board would hang on one simulated player, with the range
// and an exact tail off the simulation rather than off a fitted curve.
function simMarkets(man) {
  const out = [], pos = (man.pl.player || {}).pos || "", isQB = pos === "QB", N = man.out.rec.length;
  const add = (key, label, type, samples, min, step) => {
    const R = simRange(samples);
    if (type !== "binary" && !(R.mean >= min)) return;
    const sorted = Float64Array.from(samples); sorted.sort();
    out.push({ key, label, type, range: R, mean: R.mean, n: N, step,
      // P(X > line), read straight off the sorted draws.
      tail: line => {
        let lo = 0, hi = N;
        while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] > line) hi = m; else lo = m + 1; }
        return (N - lo) / N;
      },
      ourLine: null });
  };
  if (isQB) add("passYds", "Pass yds", "yards", man.out.passYds, 90, 5);
  if (isQB) add("passAtt", "Pass att", "count", man.out.passAtt, 15, 0.5);
  if (isQB) add("passTD", "Pass TD", "count", man.out.passTD, 0.6, 0.5);
  add("rushYds", "Rush yds", "yards", man.out.rushYds, 15, 2.5);
  add("car", "Rush att", "count", man.out.car, 5, 0.5);
  if (!isQB) add("recYds", "Rec yds", "yards", man.out.recYds, 15, 2.5);
  if (!isQB) add("rec", "Receptions", "count", man.out.rec, 1.6, 0.5);
  {
    let s = 0; for (let i = 0; i < N; i++) s += man.out.atd[i];
    if (s / N >= 0.08) out.push({ key: "atd", label: "Anytime TD", type: "binary",
      mean: s / N, n: N, range: null, step: null, ourLine: null, tail: () => s / N });
  }
  out.forEach(m => {
    if (m.type === "binary") return;
    m.ourLine = m.type === "count" ? Math.max(0.5, Math.round(m.range.median) - 0.5)
                                   : Math.round(m.range.median / m.step) * m.step - m.step / 2;
    if (m.ourLine <= 0) m.ourLine = m.step / 2;
  });
  return out;
}

// A leg, carrying the one thing a parlay needs: which of the simulated
// afternoons it won on.
function simLeg(man, mkt, side, line) {
  const src = man.out[mkt.key], N = src.length;
  const hit = new Uint8Array(N);
  let w = 0;
  for (let i = 0; i < N; i++) {
    const ok = mkt.type === "binary" ? src[i] > 0.5 : (side === "Under" ? src[i] < line : src[i] > line);
    hit[i] = ok ? 1 : 0; w += ok ? 1 : 0;
  }
  return { man, mkt, side, line, hit, p: w / N, n: N,
    player: (man.pl.player || {}).name, pos: (man.pl.player || {}).pos, teamId: man.pl.teamId };
}
// The joint probability of a set of legs: the share of simulated afternoons on
// which all of them came in. No copula, no matrix, no independence assumption
// — and it costs one pass over a byte array.
function parlayProb(legs) {
  if (!legs.length) return 0;
  const N = legs[0].n;
  let w = 0;
  outer: for (let i = 0; i < N; i++) {
    for (let j = 0; j < legs.length; j++) if (!legs[j].hit[i]) continue outer;
    w++;
  }
  return w / N;
}
// What the legs multiply out to if you pretend they are independent — which is
// what a book that prices each leg separately is charging you for.
const naiveProb = legs => legs.reduce((a, l) => a * l.p, 1);

// ── building the ticket ─────────────────────────────────────────────────────
// A straight parlay pays the product of its legs' decimal odds. That is the
// whole opportunity: the PAYOUT is computed as though the legs were
// independent, and they are not. Where the true joint probability beats the
// product of the singles, the book is handing out a price it did not mean to.
//
// This is the same trade the baseball board makes on a two-man hit double, and
// the football version is bigger, because a quarterback's yards are literally
// the sum of his receivers' yards while a book still prices them apart.
function buildParlays(legs, opts) {
  opts = opts || {};
  const size = clamp(opts.size || 2, 2, 4);
  const minP = opts.minP != null ? opts.minP : 0.03;
  const kf = opts.kelly != null ? opts.kelly : 0.25;
  const priced = legs.filter(l => l.dec > 1);          // only legs we can actually price
  const top = clamp(opts.pool || 14, 2, 24);
  const pool = priced.slice().sort((a, b) => b.p - a.p).slice(0, top);
  const out = [];
  const idx = new Array(size).fill(0);
  (function rec(start, depth) {
    if (depth === size) {
      const set = idx.map(i => pool[i]);
      // A man appearing twice in the same ticket is usually barred, and where
      // it is allowed it is the most correlated ticket on the board, so it is
      // offered but flagged rather than quietly mixed in.
      const names = {}; let samePlayer = false;
      set.forEach(l => { if (names[l.player]) samePlayer = true; names[l.player] = 1; });
      const p = parlayProb(set);
      if (p >= minP) {
        const naive = naiveProb(set);
        const dec = set.reduce((a, l) => a * l.dec, 1);
        const ev = p * dec - 1;
        const b = dec - 1;
        out.push({ legs: set, p, naive, lift: p - naive,
          liftPct: naive > 0 ? p / naive - 1 : 0,
          dec, american: probToAm(1 / dec), fair: probToAm(p), ev,
          kelly: b > 0 ? Math.max(0, kf * (p * dec - 1) / b) : 0,
          samePlayer, sameTeam: set.every(l => l.teamId === set[0].teamId),
          sameGame: set.every(l => l.gameId === set[0].gameId) });
      }
      return;
    }
    for (let i = start; i < pool.length; i++) { idx[depth] = i; rec(i + 1, depth + 1); }
  })(0, 0);
  out.sort((a, b) => (opts.rank === "lift" ? b.lift - a.lift : b.ev - a.ev) || b.p - a.p);
  return out;
}

// ── the number system ───────────────────────────────────────────────────────
// One number on a prop tells you nothing about why. The baseball board splits
// a hitter's night into how bad the arm is and how good the bats are; this is
// the football version, and it has four levers instead of two.
//
// Each is the projection re-run with that lever alone switched on, so the
// parts add up to the whole by construction rather than by assertion:
//
//   VOLUME   the game itself — pace, total, and which way the script runs.
//            A back in a game his team is favoured to lead gets carries a
//            back in a shootout never sees.
//   MATCHUP  the eleven men opposite: what that defence gives up, per attempt
//            and per target, against what the league gives up.
//   BODIES   who is out. The biggest mover of a prop line in the hour before
//            kickoff, and the one the market is slowest on.
//   WEATHER  cold and wet, and honestly labelled: the feed does not carry
//            wind, which is the only weather that really moves a passing line.
//
// SPOT is the four of them together: how far this afternoon sits from a
// neutral one, in the prop's own units and as points of probability at his
// line. It is the thesis of the bet in one number.
function propSpot(L, pl, ts, ctx, key) {
  const neutral = { pts: L.avgTotal / 2, total: L.avgTotal, mgn: 0 };
  const mkVol = (g, def, wx, uf) => teamVolume(L, ts,
    g ? ctx.pts : neutral.pts, g ? ctx.total : neutral.total, g ? ctx.mgn : neutral.mgn,
    def || null, wx || null, uf || null);
  const meanOf = (vol, scale) => {
    const pr = projectPlayer(L, pl, vol, ts, scale || null);
    if (key === "atd") return pr.anytimeTD;
    if (key === "passTD") return pr.passTD;
    if (key === "rec") return pr.rec.mean;
    if (key === "car") return pr.car.mean;
    const d = pr[key];
    return d && d.mean != null ? d.mean : null;
  };
  const base   = meanOf(mkVol(false, null, null, null));
  const vol    = meanOf(mkVol(true,  null, null, null));
  const match  = meanOf(mkVol(true,  ctx.def, null, null));
  const wthr   = meanOf(mkVol(true,  ctx.def, ctx.wx, null));
  const units  = meanOf(mkVol(true,  ctx.def, ctx.wx, ctx.units));
  const full   = meanOf(mkVol(true,  ctx.def, ctx.wx, ctx.units), ctx.scale);
  if (base == null) return null;
  return { base, full, spot: full - base,
    volume: vol - base, matchup: match - vol, weather: wthr - match,
    bodies: (units - wthr) + (full - units),
    pct: base > 1e-9 ? full / base - 1 : 0 };
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
  // Fit the mapping ONLY on games we can actually rate. A game against a team
  // outside the league carries a pooled average on one side and a thirty-point
  // line on the other, and feeding those to the fit bends it for every real
  // game on the board — on a college slate it dragged our numbers to 0.72 of
  // the market's scale, which is most of why large underdogs were filling the
  // card. Excluding them puts it back at 0.96.
  const fitRows = raw.filter(x => !x.p.pooled);
  const cal = {
    margin: calibrateSlate(fitRows.filter(x => x.o && x.o.spreadHome != null).map(x => ({ model: x.p.margin, market: -x.o.spreadHome }))),
    total: calibrateSlate(fitRows.filter(x => x.o && x.o.total != null).map(x => ({ model: x.p.total, market: x.o.total })))
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
    // Keep the two sample sizes apart. How far to trust a DEFENSIVE rate is a
    // different question from how far to trust an offence's pace, because last
    // season's defence is a much weaker guide to this one — sweeping the trust
    // against the exchange's ladders put last season's seventeen games at about
    // the worth of two and a half of this season's, and full trust in it was
    // measurably WORSE than ignoring the defence altogether.
    mix.nCur = b.gp; mix.nPrior = a.gp;
    stats[k] = mix;
  });

  return { league: leagueKey, L, season: slate.season, week: slate.week, ratings, cal, mktW: useW, mktWTotal: useWT, games: priced, teamStats: stats, rawTeamStats: teamStats };
}

// Props for one game, on demand. NFL pulls a league-wide feed once and reuses
// it; college has to walk two rosters, which is why it is a button and not a
// default.
async function loadGameProps(board, entry, cache, onStatus, opts) {
  opts = opts || {};
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
  }
  // Who is not playing. A man who is out should not be projected at all, and
  // the snaps he is not taking go to the players behind him — which is the
  // single biggest thing that moves a prop line in the hour before kickoff.
  let inj = {};
  const ik = "inj:" + entry.game.id;
  if (cache[ik] === undefined) {
    try { cache[ik] = await loadInjuries(L, entry.game.id); }
    catch (e) { cache[ik] = null; }
  }
  inj = cache[ik] || {};
  const wx = weatherFactor(entry.game);

  // Depth charts tell us which of those names are starters. Cached per team.
  const depthOf = async tid => {
    const dk = "depth:" + L.key + ":" + tid;
    if (cache[dk] === undefined) {
      try { cache[dk] = await loadDepthChart(L, tid, board.season); }
      catch (e) { cache[dk] = null; }
    }
    return cache[dk];
  };
  const depth = {};
  depth[homeId] = await depthOf(homeId);
  depth[awayId] = await depthOf(awayId);
  const units = {};
  units[homeId] = unitsOut(inj[homeId], depth[homeId]);
  units[awayId] = unitsOut(inj[awayId], depth[awayId]);

  const out = [];
  [[homeId, entry.proj.homePts, entry.blend.margin, awayId], [awayId, entry.proj.awayPts, -entry.blend.margin, homeId]]
    .forEach(([tid, pts, mgn, oppId]) => {
    const ts = board.teamStats[tid];
    const def = defenceProfile(board.teamStats[oppId]);
    const uf = unitFactors(units[tid], units[oppId], opts.unitStrength);
    const vol = teamVolume(L, ts, pts, entry.blend.total, mgn, def, wx, uf);
    const squad = players.filter(p => p.teamId === tid);
    const rows = squad.map(pl => {
      const status = (inj[tid] || {})[String(pl.id)] || null;
      return { pl, status, avail: injuryWeight(status), pr: projectPlayer(L, pl, vol, ts) };
    });
    // Redistribute: scale everyone by availability, then put the team's volume
    // back where it was, so what the absent man is not getting is shared out
    // rather than quietly vanishing from the offence.
    // Not all of it comes back to the men on this list. A team hangs props on
    // five or six players and fields more than that, so some of an absent
    // starter's work goes to somebody nobody is pricing. Eighty-five percent of
    // it returns to the modelled players; the rest leaks, which is nearer the
    // truth than handing every last target to the second receiver.
    const LEAK = 0.85;
    ["eTgt", "eCar", "ePass"].forEach(k => {
      const before = rows.reduce((a, r) => a + (r.pr[k] || 0), 0);
      const after = rows.reduce((a, r) => a + (r.pr[k] || 0) * r.avail, 0);
      const back = after > 1e-9 ? before / after : 1;
      rows.forEach(r => {
        r.scale = r.scale || {};
        r.scale[k] = r.avail * (1 + LEAK * (back - 1));
      });
    });
    rows.forEach(r => {
      if (r.avail <= 0) return;                       // out: no line at all
      const pr = projectPlayer(L, r.pl, vol, ts, r.scale);
      const mkts = propMarkets(pr);
      if (mkts.length) out.push({
        teamId: tid, player: r.pl, proj: pr, markets: mkts, vol,
        status: r.status, avail: r.avail,
        matchup: { def, wx, oppId, units: uf, own: units[tid], opp: units[oppId] }
      });
    });
  });
  // Rank by how much of the offence a player is actually being handed.
  out.sort((a, b) => (b.proj.eTgt + b.proj.eCar + b.proj.ePass * 0.6) - (a.proj.eTgt + a.proj.eCar + a.proj.ePass * 0.6));
  return out;
}

// ── the exchange ────────────────────────────────────────────────────────────
// A sportsbook takes 4.5% out of a two-way market and can limit you for
// winning. Kalshi is an exchange: the two sides of an NFL moneyline quote a
// cent apart with six figures of size behind them, and nobody gets limited.
// Three things follow, and they are worth more than any rating.
//
//  1. BEST EXECUTION. The same outcome is for sale at two venues. Taking the
//     cheaper one is free money — no model has to be right — and on a live
//     slate the exchange is the cheaper side of the trade about half the time,
//     by up to two cents. Two cents on a coin flip is a 4% swing, which is the
//     entire hold.
//
//  2. A VIG-FREE FAIR PRICE. The midpoint of a penny-wide two-sided market is
//     a better estimate of the true probability than any de-vig of a
//     sportsbook's number, because there is almost nothing to strip out.
//
//  3. THE WHOLE DISTRIBUTION, QUOTED. The exchange hangs every half point as
//     its own contract, so the ladder IS the market's cumulative distribution.
//     That is a free, real-money check on our own — and it is how the totals
//     model got caught being far too narrow.
//
// Fees are charged on entry and are NOT a rounding error: 7% x price x
// (1 - price) is 1.75 cents on a coin flip, so an edge under two cents is not
// an edge. Every number here is quoted after them.
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const KALSHI_FEE = 0.07;
const KALSHI_SERIES = {
  nfl: { ml: "KXNFLGAME", spread: "KXNFLSPREAD", total: "KXNFLTOTAL" }
};
const kalshiFee = (price, rate) => (rate == null ? KALSHI_FEE : rate) * price * (1 - price);

// Kalshi serves its public data without cross-origin headers, so a browser
// needs a bridge (kalshi-proxy/worker.js). Node talks to it directly.
let kalshiBase = null;
function setKalshiProxy(url) { kalshiBase = url ? String(url).replace(/\/+$/, "") : null; }
const kalshiUrl = path => (kalshiBase || KALSHI_API) + path;

const kNum = v => (v === null || v === undefined || v === "") ? null : (isFinite(parseFloat(v)) ? parseFloat(v) : null);
const kNorm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

async function loadKalshiSeries(ticker) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 4; page++) {
    const d = await getJSON(kalshiUrl(`/markets?series_ticker=${ticker}&status=open&limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`), 2);
    (d.markets || []).forEach(m => out.push(m));
    cursor = d.cursor || "";
    if (!cursor || !(d.markets || []).length) break;
  }
  return out;
}
// One market, in our terms. Kalshi moved to dollar-denominated fields; the
// older integer-cent names are kept as a fallback so this does not go dark on
// a schema change.
function kalshiMarket(m, kind) {
  const dollars = (a, b) => {
    const v = kNum(m[a]);
    if (v != null) return v;
    const c = kNum(m[b]);
    return c == null ? null : c / 100;
  };
  return {
    ticker: m.ticker,
    kind,
    label: m.yes_sub_title || m.title || m.ticker,
    team: kNorm(m.yes_sub_title).replace(/wins by over.*/, "").trim(),
    strike: kNum(m.floor_strike),
    yesBid: dollars("yes_bid_dollars", "yes_bid"),
    yesAsk: dollars("yes_ask_dollars", "yes_ask"),
    bidSize: kNum(m.yes_bid_size_fp) || 0,
    askSize: kNum(m.yes_ask_size_fp) || 0,
    oi: kNum(m.open_interest_fp) || 0,
    vol: kNum(m.volume_24h_fp) || 0,
    close: m.close_time
  };
}
// The committed snapshot, for a browser that cannot reach the exchange itself.
// Same shape as a live load, plus an age — which the board shows, because a
// price an hour old is for finding a candidate, not for firing at blind.
const KALSHI_SNAPSHOT = "data/kalshi-football.json";
function kalshiFromSnapshot(json, leagueKey) {
  const lg = ((json || {}).leagues || {})[leagueKey];
  if (!lg || !lg.events) return null;
  const events = {};
  Object.entries(lg.events).forEach(([key, ev]) => {
    const out = { key, ml: [], spread: [], total: [] };
    ["ml", "spread", "total"].forEach(kind => (ev[kind] || []).forEach(m => out[kind].push({
      ticker: m.t, kind,
      label: m.l,
      team: kNorm(m.l).replace(/wins by over.*/, "").trim(),
      strike: m.s == null ? null : m.s,
      yesBid: m.b == null ? null : m.b,
      yesAsk: m.a == null ? null : m.a,
      bidSize: m.bs || 0, askSize: m.as || 0, oi: m.oi || 0, vol: 0
    })));
    events[key] = out;
  });
  return { events, ok: true, snapshot: true, at: json.at || null };
}
async function loadKalshiSnapshot(leagueKey, url) {
  const j = await getJSON((url || KALSHI_SNAPSHOT) + "?t=" + Date.now(), 1);
  const k = kalshiFromSnapshot(j, leagueKey);
  if (!k || !Object.keys(k.events).length) throw new Error("snapshot has nothing for " + leagueKey);
  return k;
}

// Everything the exchange has on this league, grouped by game. The event
// ticker carries the series name, so it is stripped: the moneyline, the spread
// ladder and the total ladder for one game must land in the same bucket.
async function loadKalshi(leagueKey, onStatus) {
  const S = KALSHI_SERIES[leagueKey];
  if (!S) return { events: {}, ok: false, error: "no exchange series for " + leagueKey };
  const kinds = ["ml", "spread", "total"];
  let done = 0;
  const lists = await pool(kinds, async k => {
    const r = await loadKalshiSeries(S[k]);
    done++; if (onStatus) onStatus("Reading the exchange…", done / kinds.length);
    return r;
  }, 3);
  if (lists.every(l => !l || !l.length)) {
    // Live is out. Fall back to whatever the scheduled snapshot last committed.
    try { return await loadKalshiSnapshot(leagueKey); }
    catch (e) { return { events: {}, ok: false, error: "exchange unreachable and no snapshot on file" }; }
  }
  const events = {};
  kinds.forEach((k, i) => (lists[i] || []).forEach(m => {
    const key = String(m.event_ticker || "").replace(/^KX\w+?-/, "");
    if (!key) return;
    const e = events[key] || (events[key] = { key, ml: [], spread: [], total: [] });
    e[k].push(kalshiMarket(m, k));
  }));
  return { events, ok: true };
}
// Tie an exchange event to a game on our board. Kalshi truncates team names
// ("New York G", "Los Angeles R"), so a prefix match on the full team name is
// both the loosest thing that is still safe and the only thing that works. Two
// teams meet once in a week, so both names matching is identification enough.
function matchKalshi(board, kal) {
  if (!kal || !kal.ok) return 0;
  let n = 0;
  Object.values(kal.events).forEach(ev => {
    const names = ev.ml.map(m => kNorm(m.label)).filter(Boolean);
    if (names.length < 2) return;
    const entry = board.games.find(g => {
      const h = kNorm(g.game.home.name), a = kNorm(g.game.away.name);
      return names.every(nm => h.startsWith(nm) || a.startsWith(nm));
    });
    if (!entry) return;
    const home = kNorm(entry.game.home.name);
    ev.homeTeam = names.find(nm => home.startsWith(nm)) || null;
    ev.game = entry; entry.kalshi = ev; n++;
  });
  return n;
}
// Which side of the game is this contract on? Decided against the matched
// game's own team names, because the exchange renders the same club
// differently in different series ("Northern Illi" on the moneyline, "Northern
// Illinois" on the spread ladder) and a string mismatch here silently flips
// the sign of the whole ladder. Returns null when it cannot tell, and the
// caller skips the contract rather than guessing.
function kalshiIsHome(ev, team) {
  if (!team) return null;
  if (ev.game) {
    const h = kNorm(ev.game.game.home.name), a = kNorm(ev.game.game.away.name);
    if (h.startsWith(team) || team.startsWith(h)) return true;
    if (a.startsWith(team) || team.startsWith(a)) return false;
  }
  if (ev.homeTeam != null) return team === ev.homeTeam;
  return null;
}

// Fit a normal to the ladder's midpoints. The exchange is quoting a whole
// cumulative distribution; this reads its mean and its width back out, which
// is the cheapest sanity check on our own that exists.
function kalshiImplied(ev) {
  const fitTo = (pts, lo, hi) => {
    if (pts.length < 5) return null;
    let best = null;
    for (let mu = lo; mu <= hi; mu += 0.5) {
      for (let sg = 6; sg <= 24; sg += 0.25) {
        let e = 0;
        for (const q of pts) e += Math.pow((1 - normCdf((q.s - mu) / sg)) - q.p, 2);
        if (!best || e < best.err) best = { mu, sigma: sg, err: e, n: pts.length };
      }
    }
    return best;
  };
  const mid = m => (m.yesBid != null && m.yesAsk != null) ? (m.yesBid + m.yesAsk) / 2 : null;
  const tp = [];
  ev.total.forEach(m => { const p = mid(m); if (p != null && m.strike != null) tp.push({ s: m.strike, p }); });
  const sp = [];
  ev.spread.forEach(m => {
    const p = mid(m); if (p == null || m.strike == null) return;
    const home = kalshiIsHome(ev, m.team); if (home == null) return;
    // Put every rung on the home team's scale so one fit covers both ladders.
    sp.push(home ? { s: m.strike, p } : { s: -m.strike, p: 1 - p });
  });
  return { total: fitTo(tp, 10, 90), margin: fitTo(sp, -40, 40) };
}

// Price every contract on this game against our distribution, after fees.
// `side` is what you would actually do: buy YES at the ask, or buy NO at one
// minus the bid. Both are quoted as a cost per $1 of payout.
function priceKalshiGame(board, entry, opts) {
  opts = opts || {};
  const ev = entry.kalshi; if (!ev) return [];
  const L = board.L;
  const feeRate = opts.feeRate != null ? opts.feeRate : KALSHI_FEE;
  const minSize = opts.minSize != null ? opts.minSize : 25;
  const kf = opts.kelly != null ? opts.kelly : 0.25;
  const w = opts.mktW != null ? opts.mktW : (board.mktW != null ? board.mktW : L.mktW);
  const pmf = marginPmf(entry.blend.margin, entry.proj.sigMargin, L.keyDamp);
  const ml = mlProbs(pmf);
  const out = [];

  const consider = (m, kind, pYes, label, extra) => {
    if (pYes == null || !isFinite(pYes)) return;
    // The midpoint of a two-sided exchange quote is a market price, and it gets
    // the same treatment as the sportsbook's line: our number is blended toward
    // it at the weight the backtest says our number has earned. Without this the
    // deep rungs light up on nothing but our own tail error — a 2-point
    // disagreement on a 12-cent contract reads as 20% EV, and it is not there.
    const mid = (m.yesBid != null && m.yesAsk != null) ? (m.yesBid + m.yesAsk) / 2 : null;
    const pModel = pYes;
    if (mid != null) pYes = clamp(w * pYes + (1 - w) * mid, 1e-4, 1 - 1e-4);
    const take = (side, cost, size, p) => {
      if (cost == null || !(cost > 0.01) || !(cost < 0.99)) return;
      if (!(size >= minSize)) return;
      const all = cost + kalshiFee(cost, feeRate);
      const ev$ = p - all;                       // dollars per $1 contract
      const b = (1 - all) / all;
      const f = b > 0 ? Math.max(0, (p * b - (1 - p)) / b) * kf : 0;
      out.push({
        venue: "kalshi", gameId: entry.game.id, league: board.league, market: kind, side,
        home: entry.game.home, away: entry.game.away, date: entry.game.date,
        ticker: m.ticker, label: label + (side === "no" ? " — NO" : ""),
        p, pModel: side === "no" ? 1 - pModel : pModel, mid, w,
        cost, allIn: all, fee: kalshiFee(cost, feeRate),
        ev: ev$ / all,                            // return per dollar risked
        evCents: ev$ * 100, kelly: f, size, oi: m.oi, vol: m.vol,
        strike: m.strike, blend: entry.blend, proj: entry.proj, thin: entry.proj.thin
      });
    };
    take("yes", m.yesAsk, m.askSize, pYes);
    take("no", m.yesBid == null ? null : 1 - m.yesBid, m.bidSize, 1 - pYes);
    if (extra) extra();
  };

  ev.ml.forEach(m => {
    const isHome = kalshiIsHome(ev, m.team); if (isHome == null) return;
    const p = (isHome ? ml.home : ml.away) / Math.max(1e-9, 1 - ml.push);
    consider(m, "ml", p, m.label + " ML");
  });
  ev.spread.forEach(m => {
    if (m.strike == null) return;
    const isHome = kalshiIsHome(ev, m.team); if (isHome == null) return;
    // "wins by over s" — strictly more than s, which spreadProbs already means.
    const p = isHome ? spreadProbs(pmf, -m.strike).win : spreadProbs(pmf, m.strike).lose;
    consider(m, "spread", p, m.label);
  });
  ev.total.forEach(m => {
    if (m.strike == null) return;
    consider(m, "total", totalProbs(entry.blend.total, entry.proj.sigTotal, m.strike).over, "Over " + m.strike);
  });
  return out;
}

// The same outcome, two venues. No model is involved and none is needed: one
// of these prices is simply better than the other.
function kalshiCross(entry, opts) {
  opts = opts || {};
  const feeRate = opts.feeRate != null ? opts.feeRate : KALSHI_FEE;
  const ev = entry.kalshi, o = entry.odds;
  if (!ev || !o || o.mlHome == null || o.mlAway == null) return [];
  const rows = [];
  ev.ml.forEach(m => {
    const isHome = kalshiIsHome(ev, m.team); if (isHome == null) return;
    const bookAm = isHome ? o.mlHome : o.mlAway;
    const bookOther = isHome ? o.mlAway : o.mlHome;
    if (bookAm == null || m.yesAsk == null) return;
    const bookCost = amToProb(bookAm);
    const exCost = m.yesAsk + kalshiFee(m.yesAsk, feeRate);
    const mid = m.yesBid != null ? (m.yesBid + m.yesAsk) / 2 : null;
    // Buy this side on the exchange, the other side at the book: if the two
    // all-in costs come to less than a dollar, the dollar is already yours.
    const arb = bookOther == null ? null : 1 - (exCost + amToProb(bookOther));
    rows.push({
      market: "ml", outcome: m.label + " ML",
      team: m.label, isHome, bookAm, bookCost, exAsk: m.yesAsk, exCost, mid,
      better: exCost < bookCost ? "exchange" : "book",
      gainCents: Math.abs(bookCost - exCost) * 100,
      size: m.askSize, oi: m.oi, arb: arb, ticker: m.ticker
    });
  });

  // The spread. A book line of -3.5 on the home team is the same outcome as the
  // exchange's "home wins by over 3.5" contract, so the two prices can be put
  // side by side and the cheaper one taken.
  if (o.spreadHome != null) {
    const want = -o.spreadHome;                       // home must win by more than this
    ev.spread.forEach(m => {
      if (m.strike == null || m.yesAsk == null) return;
      const isHome = kalshiIsHome(ev, m.team); if (isHome == null) return;
      const covers = isHome ? (m.strike === want) : (m.strike === -want);
      if (!covers) return;
      const bookAm = isHome ? o.spreadOddsHome : o.spreadOddsAway;
      if (bookAm == null) return;
      const bookCost = amToProb(bookAm), exCost = m.yesAsk + kalshiFee(m.yesAsk, feeRate);
      rows.push({
        market: "spread", outcome: m.label, team: m.team, isHome, bookAm, bookCost,
        exAsk: m.yesAsk, exCost, mid: m.yesBid != null ? (m.yesBid + m.yesAsk) / 2 : null,
        better: exCost < bookCost ? "exchange" : "book",
        gainCents: Math.abs(bookCost - exCost) * 100,
        size: m.askSize, oi: m.oi, arb: null, ticker: m.ticker
      });
    });
  }
  // And the total, the same way.
  if (o.total != null) {
    ev.total.forEach(m => {
      if (m.strike !== o.total || m.yesAsk == null) return;
      const bookCost = amToProb(o.overOdds), exCost = m.yesAsk + kalshiFee(m.yesAsk, feeRate);
      rows.push({
        market: "total", outcome: "Over " + m.strike, team: null, isHome: null,
        bookAm: o.overOdds, bookCost, exAsk: m.yesAsk, exCost,
        mid: m.yesBid != null ? (m.yesBid + m.yesAsk) / 2 : null,
        better: exCost < bookCost ? "exchange" : "book",
        gainCents: Math.abs(bookCost - exCost) * 100,
        size: m.askSize, oi: m.oi, arb: null, ticker: m.ticker
      });
      // Under is the NO side of the same contract, bought at one minus the bid.
      if (m.yesBid != null && o.underOdds != null) {
        const cost = 1 - m.yesBid, all = cost + kalshiFee(cost, feeRate);
        rows.push({
          market: "total", outcome: "Under " + m.strike, team: null, isHome: null,
          bookAm: o.underOdds, bookCost: amToProb(o.underOdds), exAsk: cost, exCost: all,
          mid: m.yesAsk != null ? 1 - (m.yesBid + m.yesAsk) / 2 : null,
          better: all < amToProb(o.underOdds) ? "exchange" : "book",
          gainCents: Math.abs(amToProb(o.underOdds) - all) * 100,
          size: m.bidSize, oi: m.oi, arb: null, ticker: m.ticker
        });
      }
    });
  }
  return rows;
}

// ── the exchange, on players ────────────────────────────────────────────────
// Player props are the softest market in football and the widest on the
// exchange: eight to ten cents between bid and ask, against one cent on a game
// moneyline. That cuts both ways. Nobody is arbitraging these, so the mid can
// be wrong — but crossing a ten-cent spread costs five cents plus the fee, so
// a disagreement has to be worth more than about seven cents before taking it
// is anything other than paying the spread for the privilege of being right.
//
// Our shape was fitted against these ladders: the standard deviations now
// agree with the market's to within a fraction of a yard. A central
// disagreement of about five points remains and there is no way to tell from
// here whether it is our projection or the market's — which is exactly why
// nothing below crosses a spread on five points.
const KALSHI_PROP_SERIES = {
  nfl: { passYds: "KXNFLPASSYDS", recYds: "KXNFLRECYDS", rec: "KXNFLREC", passTD: "KXNFLPASSTDS" }
};
const kPlayerKey = t => String(t || "").split(":")[0].toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

// Player ladders out of the committed snapshot, same shape as a live load.
function kalshiPropsFromSnapshot(json, leagueKey) {
  const lg = ((json || {}).leagues || {})[leagueKey];
  if (!lg || !lg.props) return null;
  const events = {};
  Object.entries(lg.props).forEach(([key, players]) => {
    const ev = events[key] || (events[key] = {});
    Object.entries(players).forEach(([name, kinds]) => {
      const who = kPlayerKey(name);
      const pl = ev[who] || (ev[who] = {});
      Object.entries(kinds).forEach(([kind, list]) => {
        pl[kind] = (list || []).map(m => ({
          strike: m.s, bid: m.b, ask: m.a, mid: (m.b + m.a) / 2, spread: m.a - m.b,
          askSize: m.as || 0, bidSize: m.bs || 0, oi: m.oi || 0, ticker: m.t
        })).sort((a, b) => a.strike - b.strike);
      });
    });
  });
  return Object.keys(events).length ? { events, ok: true, snapshot: true, at: json.at || null } : null;
}

async function loadKalshiProps(leagueKey, onStatus) {
  const S = KALSHI_PROP_SERIES[leagueKey];
  if (!S) return { events: {}, ok: false, error: "no player markets for " + leagueKey };
  const kinds = Object.keys(S);
  let done = 0;
  const lists = await pool(kinds, async k => {
    const r = await loadKalshiSeries(S[k]);
    done++; if (onStatus) onStatus("Reading player markets…", done / kinds.length);
    return r;
  }, 4);
  if (lists.every(l => !l || !l.length)) {
    // Live is out — read the player ladders the scheduled snapshot committed.
    try {
      const j = await getJSON(KALSHI_SNAPSHOT + "?t=" + Date.now(), 1);
      const k = kalshiPropsFromSnapshot(j, leagueKey);
      if (k) return k;
    } catch (e) { /* fall through to the honest answer */ }
    return { events: {}, ok: false, error: "no player markets for " + leagueKey };
  }
  const events = {};
  kinds.forEach((kind, i) => (lists[i] || []).forEach(m => {
    const key = String(m.event_ticker || "").replace(/^KX\w+?-/, "");
    const who = kPlayerKey(m.title);
    const strike = kNum(m.floor_strike);
    const bid = kNum(m.yes_bid_dollars), ask = kNum(m.yes_ask_dollars);
    if (!key || !who || strike == null || bid == null || ask == null) return;
    const ev = events[key] || (events[key] = {});
    const pl = ev[who] || (ev[who] = {});
    (pl[kind] || (pl[kind] = [])).push({
      strike, bid, ask, mid: (bid + ask) / 2, spread: ask - bid,
      askSize: kNum(m.yes_ask_size_fp) || 0, bidSize: kNum(m.yes_bid_size_fp) || 0,
      oi: kNum(m.open_interest_fp) || 0, ticker: m.ticker
    });
  }));
  Object.values(events).forEach(ev => Object.values(ev).forEach(pl =>
    Object.values(pl).forEach(list => list.sort((a, b) => a.strike - b.strike))));
  return { events, ok: true };
}

// Our prop probabilities carry a systematic offset against the exchange, and
// it is big enough to decide every recommendation. Measured across a slate our
// number sits about five points BELOW the market's in the middle of the
// ladders, so the board fills up with unders — twenty-five of twenty-five on
// the first run, several of them against markets quoted a cent wide with eight
// hundred contracts behind them. A market that tight is not five points wrong.
//
// So the same discipline the game board already uses: fit our probabilities
// onto the market's scale across the whole slate, in log-odds where
// probabilities actually live, and keep only what disagrees after that. The
// slope catches over-confidence, the intercept catches the offset, and both
// are shrunk so one odd week cannot bend the curve.
const logit = p => Math.log(clamp(p, 1e-4, 1 - 1e-4) / (1 - clamp(p, 1e-4, 1 - 1e-4)));
const expit = z => 1 / (1 + Math.exp(-z));

function calibrateProbs(pairs, n0) {
  const good = (pairs || []).filter(q => q && isFinite(q.p) && isFinite(q.market) &&
    q.p > 0.02 && q.p < 0.98 && q.market > 0.02 && q.market < 0.98);
  const n = good.length;
  if (n < 40) return { a: 0, b: 1, n, applied: false };
  const xs = good.map(q => logit(q.p)), ys = good.map(q => logit(q.market));
  const mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n;
  let cov = 0, varX = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); varX += Math.pow(xs[i] - mx, 2); }
  let b = varX > 1e-9 ? cov / varX : 1;
  const k = n0 == null ? 120 : n0;                   // shrink toward no correction
  b = clamp((b * n + 1 * k) / (n + k), 0.6, 1.6);
  const a = my - b * mx;
  return { a, b, n, applied: true };
}
const applyProbCal = (cal, p) => (cal && cal.applied) ? expit(cal.a + cal.b * logit(p)) : p;

// The rung closest to a line we care about, if the exchange quotes one.
function kalshiRung(props, entry, playerName, kind, line) {
  if (!props || !props.ok || !entry || !entry.kalshi) return null;
  const ev = props.events[entry.kalshi.key]; if (!ev) return null;
  const pl = ev[kPlayerKey(playerName)]; if (!pl) return null;
  const list = pl[kind]; if (!list || !list.length) return null;
  let best = null;
  list.forEach(r => {
    const d = Math.abs(r.strike - line);
    if (!best || d < best.d) best = { d, r };
  });
  return best ? Object.assign({ distance: best.d }, best.r) : null;
}

// Is our disagreement big enough to be worth crossing this spread? Buying the
// yes at the ask costs the ask plus the fee; selling it means buying the no at
// one minus the bid. Anything that does not clear both is quoted as "inside
// the spread" rather than dressed up as a play.
// How much of a player projection is ours and how much is the market's. Half.
//
// It is tempting to give our number more: our volumes agree with the exchange
// in aggregate, our standard deviations now match it to a fraction of a yard,
// and the game markets that feed the projection are validated to a point. It
// is equally tempting to give the market more: it is real money. But the one
// thing actually measured is that we and the exchange disagree by about five
// points in the middle of these ladders, and NOTHING here can say which of us
// is wrong. Fifty-fifty is what "I do not know" looks like when it has to be a
// number, and it halves the stake, which is the right direction to be wrong in.
const PROP_W = 0.5;
// How wide a market is quoted is itself information. A contract quoted a cent
// apart with fifteen hundred behind it is a market that has been looked at; one
// quoted ten cents apart with ten contracts up has not. Trusting both the same
// amount is how you end up staking four percent of a bankroll on disagreeing by
// twenty-four points with a market that is almost certainly right.
//
// So our share of the blend slides with the spread: a third on a penny-wide
// quote, two thirds on a ten-cent one. Neither extreme — even a tight prop
// market is not a closing NFL spread, and even a wide one is real money.
function propWeight(spread) {
  if (spread == null || !isFinite(spread)) return PROP_W;
  return clamp(0.33 + 0.33 * ((spread - 0.02) / 0.06), 0.33, 0.66);
}
// A price with nothing behind it is a quote, not a market. Ten contracts is not
// a bet you can make.
const PROP_MIN_SIZE = 25;
// And no single player prop is worth a large share of a bankroll when the model
// behind it has never been graded against a result.
const PROP_MAX_STAKE = 0.015;

function priceKalshiProp(rung, ourP, opts) {
  opts = opts || {};
  const feeRate = opts.feeRate != null ? opts.feeRate : KALSHI_FEE;
  const kf = opts.kelly != null ? opts.kelly : 0.25;
  const w = opts.propW != null ? opts.propW : propWeight(rung ? rung.spread : null);
  if (!rung || ourP == null) return null;
  const pRaw = ourP;
  if (opts.probCal) ourP = applyProbCal(opts.probCal, ourP);
  const pModel = ourP;
  if (rung.mid != null) ourP = clamp(w * ourP + (1 - w) * rung.mid, 1e-4, 1 - 1e-4);
  const sides = [];
  if (rung.ask != null && rung.ask > 0.01 && rung.ask < 0.99) {
    const cost = rung.ask + kalshiFee(rung.ask, feeRate);
    sides.push({ side: "over", cost, p: ourP, ev: (ourP - cost) / cost, size: rung.askSize });
  }
  if (rung.bid != null && rung.bid > 0.01 && rung.bid < 0.99) {
    const raw = 1 - rung.bid, cost = raw + kalshiFee(raw, feeRate);
    sides.push({ side: "under", cost, p: 1 - ourP, ev: ((1 - ourP) - cost) / cost, size: rung.bidSize });
  }
  if (!sides.length) return null;
  sides.sort((a, b) => b.ev - a.ev);
  const best = sides[0];
  const b = (1 - best.cost) / best.cost;
  best.kelly = b > 0 ? Math.min(PROP_MAX_STAKE, Math.max(0, (best.p * b - (1 - best.p)) / b) * kf) : 0;
  best.w = w;
  best.mid = rung.mid;
  best.pModel = best.side === "under" ? 1 - pModel : pModel;
  best.pRaw = best.side === "under" ? 1 - pRaw : pRaw;
  best.spreadCents = rung.spread * 100;
  best.strike = rung.strike;
  // Crossing costs half the spread on top of the fee. An edge that does not
  // clear both is not a trade, it is a way of paying the spread to be right.
  best.hurdle = rung.spread / 2 + kalshiFee(best.cost, feeRate);
  const minSize = opts.minSize != null ? opts.minSize : PROP_MIN_SIZE;
  best.tradeable = best.size >= minSize;
  best.worth = (best.p - best.cost) > best.hurdle && best.tradeable;
  return best;
}

// ── keeping score ───────────────────────────────────────────────────────────
// A losing bet tells you nothing. Twenty losing bets tell you almost nothing:
// at these prices a real 3% edge still loses eight of twenty about a fifth of
// the time. Profit and loss is the slowest possible way to learn whether a
// system works, and the most expensive.
//
// Closing line value is the fast way. If the number moves toward your side
// after you bet it, you are consistently buying better than the market's final
// opinion, and that shows up in twenty bets rather than two thousand. If it
// moves away, no run of winners means the process is sound — you are getting
// the worst of it and being paid by variance, which stops.
//
// So this grades both, and reports the error bar on each, because a record of
// 3-7 and a record of 7-3 are the same evidence about a coin.

// Final scores for a whole day in one call — lighter than a game at a time.
async function loadResults(L, yyyymmdd) {
  const g = L.groups ? "&groups=" + L.groups : "";
  const d = await getJSON(`${SITE}/${L.path}/scoreboard?limit=400${g}&dates=${yyyymmdd}`, 2);
  const out = {};
  (d.events || []).forEach(ev => {
    const p = parseEvent(ev, L.key);
    if (p) out[p.id] = p;
  });
  return out;
}
// What the book settled on. The difference between this and what you took is
// the only early read on whether the process is any good.
async function loadClosingLine(L, eventId) {
  const d = await getJSON(`${CORE}/${L.core}/events/${eventId}/competitions/${eventId}/odds`, 2);
  const raw = pickBook(d.items);
  if (!raw) return null;
  const H = raw.homeTeamOdds || {}, A = raw.awayTeamOdds || {};
  const close = k => {
    const c = (H.close || {})[k] || {};
    return c.american != null ? num(String(c.american).replace("+", "")) : null;
  };
  const closeA = k => {
    const c = (A.close || {})[k] || {};
    return c.american != null ? num(String(c.american).replace("+", "")) : null;
  };
  return {
    book: (raw.provider || {}).name || "book",
    spreadHome: close("pointSpread"),
    mlHome: close("moneyLine"),
    mlAway: closeA("moneyLine"),
    total: raw.overUnder != null ? num(raw.overUnder) : null
  };
}
// Win, lose or push, from the score that actually happened.
function gradeBet(bet, res) {
  if (!res || !res.final || res.hs == null || res.as == null) return null;
  const margin = res.hs - res.as, total = res.hs + res.as;
  if (bet.market === "spread") {
    const v = bet.side === "home" ? margin + bet.line : -margin + bet.line;
    return v > 1e-9 ? 1 : (v < -1e-9 ? 0 : 0.5);
  }
  if (bet.market === "ml") {
    if (margin === 0) return 0.5;
    return (bet.side === "home") === (margin > 0) ? 1 : 0;
  }
  if (bet.market === "total") {
    if (total === bet.line) return 0.5;
    return (bet.side === "over") === (total > bet.line) ? 1 : 0;
  }
  return null;
}
const betReturn = (bet, res) => res == null ? null
  : (res === 0.5 ? 0 : (res === 1 ? (amToDec(bet.price) - 1) * bet.stake : -bet.stake));

// Expected value of the bet you made, priced at the CLOSING number. Positive
// means you bought better than the market's last word, which is the thing that
// predicts whether this works long before the money does.
function betCLV(bet, close, L) {
  if (!close) return null;
  const dec = amToDec(bet.price); if (!dec) return null;
  let p = null, push = 0;
  if (bet.market === "ml") {
    if (close.mlHome == null || close.mlAway == null) return null;
    const dv = devig(close.mlHome, close.mlAway);
    p = bet.side === "home" ? dv.p1 : dv.p2;
  } else if (bet.market === "spread") {
    if (close.spreadHome == null) return null;
    const pmf = marginPmf(-close.spreadHome, L.sigMargin, L.keyDamp);
    const sp = spreadProbs(pmf, bet.side === "home" ? bet.line : -bet.line);
    p = bet.side === "home" ? sp.win : sp.lose;
    push = sp.push;
  } else if (bet.market === "total") {
    if (close.total == null) return null;
    const tp = totalProbs(close.total, L.sigTotal, bet.line);
    p = bet.side === "over" ? tp.over : tp.under;
    push = tp.push;
  }
  if (p == null) return null;
  return {
    ev: evUnit(p, push, bet.price),      // per $1 staked, at closing fair value
    fair: probToAm(p / Math.max(1e-9, 1 - push)),
    closeLine: bet.market === "total" ? close.total : (bet.market === "spread" ? close.spreadHome : null),
    closeMl: bet.side === "home" ? close.mlHome : close.mlAway
  };
}
// The scoreboard for a pile of bets: money, and the thing that matters sooner.
function betSummary(bets) {
  const done = bets.filter(b => b.result != null);
  const rets = done.map(b => betReturn(b, b.result));
  const staked = done.reduce((a, b) => a + (b.result === 0.5 ? 0 : b.stake), 0);
  const pnl = rets.reduce((a, v) => a + v, 0);
  const n = done.length;
  const unit = done.map((b, i) => b.stake > 0 ? rets[i] / b.stake : 0);   // per $1
  const mean = n ? unit.reduce((a, v) => a + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(unit.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / (n - 1)) : 0;
  const se = n ? sd / Math.sqrt(n) : null;
  const clvs = bets.map(b => b.clv && b.clv.ev != null ? b.clv.ev : null).filter(v => v != null);
  const cMean = clvs.length ? clvs.reduce((a, v) => a + v, 0) / clvs.length : null;
  const cSd = clvs.length > 1 ? Math.sqrt(clvs.reduce((a, v) => a + Math.pow(v - cMean, 2), 0) / (clvs.length - 1)) : 0;
  const cSe = clvs.length ? cSd / Math.sqrt(clvs.length) : null;
  return {
    n, open: bets.length - n,
    win: done.filter(b => b.result === 1).length,
    lose: done.filter(b => b.result === 0).length,
    push: done.filter(b => b.result === 0.5).length,
    pnl, staked, roi: staked > 0 ? pnl / staked : null,
    roiSe: se, roiT: se > 0 ? mean / se : null,
    clvN: clvs.length, clv: cMean, clvSe: cSe, clvT: cSe > 0 ? cMean / cSe : null
  };
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
      if (p.pooled) return;              // same exclusion the live board uses
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
      plays.push({ market: "spread", week: g.week, side, edge: pn - mp, p: pn, price, res: gradeSpread(side), nullEv: mp * amToDec(price) - 1 });
    });
    if (o.mlHome != null && o.mlAway != null) {
      const m = mlProbs(pmf), dvm = devig(o.mlHome, o.mlAway);
      const gradeML = side => actMargin === 0 ? 0.5 : ((side === "home") === (actMargin > 0) ? 1 : 0);
      [["home", m.home, dvm.p1, o.mlHome], ["away", m.away, dvm.p2, o.mlAway]].forEach(([side, p, mp, price]) => {
        const pn = p / Math.max(1e-9, 1 - m.push);
        plays.push({ market: "ml", week: g.week, side, edge: pn - mp, p: pn, price, res: gradeML(side), nullEv: mp * amToDec(price) - 1 });
      });
    }
    if (o.total != null) {
      const tp = totalProbs(bl.total, proj.sigTotal, o.total), dvt = devig(o.overOdds, o.underOdds);
      const gradeT = side => actTotal === o.total ? 0.5 : ((side === "over") === (actTotal > o.total) ? 1 : 0);
      [["over", tp.over, dvt.p1, o.overOdds], ["under", tp.under, dvt.p2, o.underOdds]].forEach(([side, p, mp, price]) => {
        const pn = p / Math.max(1e-9, 1 - tp.push);
        plays.push({ market: "total", week: g.week, side, edge: pn - mp, p: pn, price, res: gradeT(side), nullEv: mp * amToDec(price) - 1 });
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
      // Testing ROI against zero asks the wrong question. A bet with NO skill
      // at all does not return zero — it returns minus the hold. So the null is
      // what these exact prices would have paid if our probability carried no
      // information beyond the market's own: that is the skill, and it is the
      // only thing that says whether the model is doing anything.
      const nulls = sel.map(p => p.nullEv == null ? 0 : p.nullEv);
      const nullMean = nulls.reduce((a, b) => a + b, 0) / n;
      const skill = mean - nullMean;
      acc.buckets.push({
        market, edge: t, n, win, lose, push, pnl,
        roi: pnl / (win + lose || 1),
        avgPrice: pxSum / n, se, t: se > 0 ? mean / se : 0,
        vig: -nullMean, skill, skillT: se > 0 ? skill / se : 0,
        significant: se > 0 && Math.abs(skill / se) >= 2
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
  teamVolume, loadRoster, loadPlayersNFL, projectPlayer,
  defenceProfile, defFactor, log5, DEF_CARRY, weatherFactor, injuryWeight, loadInjuries, LEAGUE,
  loadDepthChart, unitsOut, unitFactors, UNIT_OF, setPropShape, propShape, propMarkets, priceProp, loadGameProps,
  rng, normInv, poisDraw, binomDraw, gammaDraw, logNormOf, SIM_ROLE, SIM_TEAM, setSimShape, simShape, simRole,
  simulateGame, quantiles, simRange, simMarkets, simLeg, parlayProb, naiveProb, buildParlays, propSpot,
  backtest, summarise,
  loadResults, loadClosingLine, gradeBet, betReturn, betCLV, betSummary,
  KALSHI_API, KALSHI_SERIES, KALSHI_FEE, kalshiFee, setKalshiProxy,
  loadKalshi, loadKalshiSnapshot, kalshiFromSnapshot, KALSHI_SNAPSHOT, matchKalshi, kalshiImplied, priceKalshiGame, kalshiCross,
  KALSHI_PROP_SERIES, loadKalshiProps, kalshiPropsFromSnapshot, kalshiRung, calibrateProbs, applyProbCal, priceKalshiProp, propWeight, PROP_MAX_STAKE, PROP_MIN_SIZE
};
});
