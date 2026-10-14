// ─────────────────────────────────────────────────────────────────────────────
// FX Fib Ladder — the strategy, and nothing of the page.
//
// forex.html runs these rules live; scripts/fx-tune.mjs replays them over years
// of FX candles to pick the settings. One copy, so the settings the tuner picks
// are exactly the rules the page runs. Every knob is in `params` (see
// DEFAULTS — the crypto ladder's tuned rules, the starting point).
//
// Browser: window.FxEngine. Node: module.exports.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FxEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const LOT = 100000;
const H1 = 3600, H4 = 14400, H8 = 28800;
// Typical OANDA round-trip spread (pips), quote currency (sets pip value), pip,
// price decimals, and which way the pair moves with the dollar (+1: USD is the
// base, −1: USD is the quote).
const PAIRS = {
  EURUSD: { spread: 1.2, q: "USD", pip: 1e-4, dp: 5, usd: -1 },
  GBPUSD: { spread: 1.8, q: "USD", pip: 1e-4, dp: 5, usd: -1 },
  AUDUSD: { spread: 1.4, q: "USD", pip: 1e-4, dp: 5, usd: -1 },
  USDCHF: { spread: 1.8, q: "CHF", pip: 1e-4, dp: 5, usd: 1 },
  USDJPY: { spread: 1.4, q: "JPY", pip: 1e-2, dp: 3, usd: 1 },
};
const SYMS = Object.keys(PAIRS);

// The crypto Fib Ladder's tuned rules ("Best found by tuning (Oct 5)").
const DEFAULTS = {
  name: "Crypto rules (Oct 5)",
  tf: H4,          // candle the setup is read on
  len: 20,         // swing = this many candles each side
  inLo: 0.236,     // first (shallowest) limit
  inHi: 0.5,       // last (deepest) limit; a break already past it is skipped
  stop: 1.272,     // one stop for the whole position
  tp: 0,           // every leg's target
  adxN: 14,
  adxMin: 20,      // 0 = off
  usdFilter: true, // trade only with the dollar's latest break
  usdTf: H8,
  usdLen: 20,
  legs: 10,
  ratio: 2,        // deepest leg = ratio × first
};

// USD per unit of base for a price move `d`, converted at price `at`.
const usdPer = (sym, d, at) => PAIRS[sym].q === "USD" ? d : d / at;

/* ── candles ──────────────────────────────────────────── */
// OANDA's candles are anchored on the New York close (17:00 New York), so a 4h
// bar opens at 21:00/01:00/… UTC in summer and 22:00/02:00/… in winter.
const nyCache = new Map();
let NYF = null;
function nyLag(t) {                     // hours New York is behind UTC (4 or 5)
  const day = Math.floor(t / 86400);
  let v = nyCache.get(day);
  if (v == null) {
    NYF = NYF || new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
    v = (12 - (+NYF.format(new Date((day * 86400 + 12 * 3600) * 1000))) + 24) % 24;
    nyCache.set(day, v);
  }
  return v;
}
function bucket(t, P, align) {
  if (align === "utc" || P <= H1) return Math.floor(t / P) * P;
  const off = ((17 + nyLag(t)) * 3600) % P;
  return Math.floor((t - off) / P) * P + off;
}
function aggregate(c, P, align) {
  const out = [];
  let b = null;
  for (const x of c) {
    const k = bucket(x.t, P, align);
    if (!b || b.t !== k) { b = { t: k, o: x.o, h: x.h, l: x.l, c: x.c }; out.push(b); }
    else { if (x.h > b.h) b.h = x.h; if (x.l < b.l) b.l = x.l; b.c = x.c; }
  }
  return out;
}

/* ── indicators ───────────────────────────────────────── */
function pivots(c, len) {
  const n = c.length, H = new Uint8Array(n), L = new Uint8Array(n);
  for (let i = len; i < n - len; i++) {
    let isH = true, isL = true;
    for (let j = i - len; j < i && (isH || isL); j++) { if (!(c[i].h > c[j].h)) isH = false; if (!(c[i].l < c[j].l)) isL = false; }
    for (let j = i + 1; j <= i + len && (isH || isL); j++) { if (!(c[i].h >= c[j].h)) isH = false; if (!(c[i].l <= c[j].l)) isL = false; }
    H[i] = isH ? 1 : 0; L[i] = isL ? 1 : 0;
  }
  return { H, L };
}
// Market-structure breaks: a close through the latest unbroken confirmed swing.
// MSS = against the trend so far, MSB = with it. events[k] = break at bar k's close.
function structure(c, len) {
  const { H, L } = pivots(c, len);
  const events = new Array(c.length).fill(null);
  let actH = null, actL = null, trend = 0;
  for (let k = 0; k < c.length; k++) {
    if (actH && c[k].c > actH.p) { events[k] = { k, dir: "long", type: trend === -1 ? "MSS" : "MSB", level: actH.p, piv: actH.i }; trend = 1; actH = null; }
    else if (actL && c[k].c < actL.p) { events[k] = { k, dir: "short", type: trend === 1 ? "MSS" : "MSB", level: actL.p, piv: actL.i }; trend = -1; actL = null; }
    const i = k - len;                  // pivot i is confirmed once bar i+len closes
    if (i >= len) { if (H[i]) actH = { i, p: c[i].h }; if (L[i]) actL = { i, p: c[i].l }; }
  }
  return events;
}
function adx(c, n) {
  const out = new Array(c.length).fill(null);
  let tr = 0, pdm = 0, ndm = 0, sum = 0, a = null;
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i <= n) { tr += t; pdm += p; ndm += m; }
    else { tr += t - tr / n; pdm += p - pdm / n; ndm += m - ndm / n; }
    if (i < n || tr <= 0) continue;
    const pdi = 100 * pdm / tr, ndi = 100 * ndm / tr;
    const dx = pdi + ndi > 0 ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0;
    if (i < 2 * n - 1) sum += dx;
    else if (i === 2 * n - 1) { a = (sum + dx) / n; out[i] = a; }
    else { a = (a * (n - 1) + dx) / n; out[i] = a; }
  }
  return out;
}

/* ── USD structure (the crypto ladder's BTC-8h filter, for FX) ─ */
// Equal-weight dollar index from the five pairs' closed bars (log prices, the
// XXXUSD pairs inverted), rolled up to `usdTf`; its breaks give the USD side.
// `bars` = {SYM: closed bars on the same timing}.
function usdStructure(bars, params, align) {
  const p = Object.assign({}, DEFAULTS, params);
  if (SYMS.some(s => !bars[s] || !bars[s].length)) return null;
  const maps = SYMS.map(s => new Map(bars[s].map(b => [b.t, b])));
  const ts = bars[SYMS[0]].map(b => b.t).filter(t => maps.every(m => m.has(t)));
  if (!ts.length) return null;
  const idx = ts.map(t => {
    let o = 0, h = 0, l = 0, c = 0;
    SYMS.forEach((s, j) => {
      const b = maps[j].get(t), sg = PAIRS[s].usd;
      o += sg * Math.log(b.o); c += sg * Math.log(b.c);
      h += sg > 0 ? Math.log(b.h) : -Math.log(b.l);
      l += sg > 0 ? Math.log(b.l) : -Math.log(b.h);
    });
    return { t, o: o / 5, h: h / 5, l: l / 5, c: c / 5 };
  });
  const lastClose = idx[idx.length - 1].t + p.tf;
  const big = aggregate(idx, p.usdTf, align).filter(b => b.t + p.usdTf <= lastClose);
  const ev = structure(big, p.usdLen);
  return { breaks: ev.filter(Boolean).map(e => ({ dir: e.dir, type: e.type, closeT: big[e.k].t + p.usdTf })) };
}
function usdDirAt(U, T) {
  if (!U) return null;
  let d = null;
  for (const b of U.breaks) { if (b.closeT <= T) d = b; else break; }
  return d;
}

/* ── the ladder ───────────────────────────────────────── */
// Long: swing high = 0, swing low = 1. Short mirrored.
function fibOf(dir, hi, lo) {
  const r = hi - lo;
  return dir === "long" ? f => hi - f * r : f => lo + f * r;
}
// `legs` limits across inLo → inHi, weights 1 → ratio, those price has already
// passed left out, sized so all of them filled lose no more than `risk` at the
// stop. Lots round to 0.01 without going over; if the 0.01 minimum still
// overshoots, the shallowest legs go.
function buildLegs(sym, dir, hi, lo, close, risk, params) {
  const p = Object.assign({}, DEFAULTS, params);
  const L = dir === "long", at = fibOf(dir, hi, lo), stop = at(p.stop), tp = at(p.tp), n = p.legs;
  const legs = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1), f = p.inLo + (p.inHi - p.inLo) * t, price = at(f);
    legs.push({ i: i + 1, f, price, w: 1 + (p.ratio - 1) * t,
                passed: L ? price > close : price < close,
                rpu: usdPer(sym, Math.abs(price - stop), stop), wpu: usdPer(sym, Math.abs(tp - price), tp) });
  }
  const size = live => {
    const K = risk / live.reduce((a, l) => a + l.w * l.rpu, 0);
    live.forEach(l => { l.raw = l.w * K / LOT; l.lots = Math.max(0.01, Math.floor(l.raw * 100 + 1e-9) / 100); });
    let spent = live.reduce((a, l) => a + l.lots * LOT * l.rpu, 0);
    for (const l of live.slice().sort((a, b) => (b.raw - b.lots) - (a.raw - a.lots))) {
      const add = 0.01 * LOT * l.rpu;
      if (l.raw > l.lots && spent + add <= risk + 1e-9) { l.lots = Math.round((l.lots + 0.01) * 100) / 100; spent += add; }
    }
    return spent;
  };
  let live = legs.filter(l => !l.passed);
  while (live.length && size(live) > risk + 1e-9) { live[0].dropped = true; live = live.slice(1); }
  legs.forEach(l => { if (l.passed || l.dropped) { l.lots = 0; l.off = true; } });
  legs.forEach(l => { l.risk = l.lots * LOT * l.rpu; l.win = l.lots * LOT * l.wpu; });
  return { dir, hi, lo, at, stop, tp, legs, live: legs.filter(l => !l.off).length };
}

/* ── replay: the rules, bar by bar ────────────────────── */
// Orders placed at a bar's close work during the next bar. During a bar: limits
// fill at their price; a filled position stops out at the stop or exits at the
// target (the stop wins when one bar spans both; no target on a bar that also
// filled). At the close: an unfilled ladder follows a new extreme, and a break
// that passes the filters replaces any unfilled ladder.
//
// ctx: {params, risk, U, align, costPips, forming, ev, ad} — ev/ad optional
// precomputed structure()/adx() for these bars (the tuner reuses them).
function simulate(sym, bars, ctx) {
  const p = Object.assign({}, DEFAULTS, ctx.params);
  const c = bars, risk = ctx.risk, cost = (ctx.costPips || 0) * PAIRS[sym].pip;
  const ev = ctx.ev || structure(c, p.len), ad = p.adxMin > 0 ? (ctx.ad || adx(c, p.adxN)) : null;
  let lad = null, last = null;
  const trades = [];
  const filled = l => l.legs.filter(x => x.fill);
  const close = (l, exit, t, how) => {
    const f = filled(l), r = f.reduce((a, x) => a + x.risk, 0);
    const lots = f.reduce((a, x) => a + x.lots, 0);
    const gross = f.reduce((a, x) => a + x.lots * LOT * usdPer(sym, l.dir === "long" ? exit - x.price : x.price - exit, exit), 0);
    const pnl = gross - lots * LOT * usdPer(sym, cost, exit);
    const tr = { sym, dir: l.dir, type: l.type, t0: l.fillT, t1: t, legs: f.length, lots,
                 avg: f.reduce((a, x) => a + x.lots * x.price, 0) / lots, exit, how, pnl, R: r > 0 ? pnl / r : 0 };
    if (l.rec) l.rec.outcome = tr;
    trades.push(tr);
  };
  const during = (b, endT) => {
    if (!lad) return;
    const L = lad.dir === "long", had = filled(lad).length > 0;
    let fresh = false;
    for (const x of lad.legs) if (!x.off && !x.fill && (L ? b.l <= x.price : b.h >= x.price)) { x.fill = true; fresh = true; }
    if (fresh && !had) lad.fillT = b.t;
    if (!fresh && !had) return;
    if (L ? b.l <= lad.stop : b.h >= lad.stop) { close(lad, lad.stop, endT, "stop"); lad = null; return; }
    if (!fresh && (L ? b.h >= lad.tp : b.l <= lad.tp)) { close(lad, lad.tp, endT, "target"); lad = null; }
  };
  for (let k = 0; k < c.length; k++) {
    const b = c[k], T = b.t + p.tf;
    during(b, T);
    if (lad && !lad.legs.some(x => x.fill) && (lad.dir === "long" ? b.h > lad.hi : b.l < lad.lo)) {
      const hi = lad.dir === "long" ? b.h : lad.hi, lo = lad.dir === "long" ? lad.lo : b.l;
      const moved = buildLegs(sym, lad.dir, hi, lo, b.c, risk, p);
      if (!moved.live && lad.rec) lad.rec.cancelled = "no orders left after the move";
      lad = moved.live ? Object.assign(moved, { type: lad.type, k0: lad.k0, t0: lad.t0, moves: (lad.moves || 0) + 1, rec: lad.rec }) : null;
    }
    const e = ev[k];
    if (!e) continue;
    // the move that made the break: from the far extreme since the broken swing to here
    let hi, lo;
    if (e.dir === "long") {
      let li = e.piv; for (let j = e.piv; j <= k; j++) if (c[j].l < c[li].l) li = j;
      lo = c[li].l; hi = -Infinity; for (let j = li; j <= k; j++) if (c[j].h > hi) hi = c[j].h;
    } else {
      let hj = e.piv; for (let j = e.piv; j <= k; j++) if (c[j].h > c[hj].h) hj = j;
      hi = c[hj].h; lo = Infinity; for (let j = hj; j <= k; j++) if (c[j].l < lo) lo = c[j].l;
    }
    const U8 = p.usdFilter ? usdDirAt(ctx.U, T) : null;
    const wantUsd = PAIRS[sym].usd > 0 ? e.dir : (e.dir === "long" ? "short" : "long");
    const deep = fibOf(e.dir, hi, lo)(p.inHi);
    const rec = { e, t: T, hi, lo, close: b.c, adx: ad ? ad[k] : null, usd: U8, wantUsd,
                  usdOk: !p.usdFilter || (!!U8 && U8.dir === wantUsd),
                  adxOk: !(p.adxMin > 0) || (ad[k] != null && ad[k] >= p.adxMin),
                  pastHalf: e.dir === "long" ? b.c < deep : b.c > deep,
                  heldBy: lad && lad.legs.some(x => x.fill) ? "filled" : null };
    rec.ok = rec.usdOk && rec.adxOk && !rec.pastHalf && !rec.heldBy;
    if (rec.ok) {
      const nl = buildLegs(sym, e.dir, hi, lo, b.c, risk, p);
      if (nl.live) {
        if (lad && lad.rec) lad.rec.cancelled = "replaced by a newer break";
        lad = Object.assign(nl, { type: e.type, k0: k, t0: T, moves: 0, rec }); rec.placed = true;
      } else rec.noLegs = true;
    }
    last = rec;
  }
  if (ctx.forming) during(ctx.forming, ctx.forming.t + p.tf);
  return { lad, last, trades, adxNow: ad ? ad[ad.length - 1] : null };
}

// Summary of a list of trades: count, hit rate, net $, and R measured against
// the per-trade budget `cap` (so a one-leg fill that wins $10 is +0.025R on a
// $400 cap, not the +0.5R it is against its own small risk) — total, mean, and
// the worst peak-to-trough run, in time order.
function stats(trades, cap) {
  const T = trades.slice().sort((a, b) => a.t1 - b.t1);
  let r = 0, peak = 0, dd = 0, net = 0, w = 0;
  for (const t of T) { r += t.pnl / cap; net += t.pnl; if (t.pnl > 0) w++; peak = Math.max(peak, r); dd = Math.max(dd, peak - r); }
  return { n: T.length, wins: w, hit: T.length ? w / T.length : 0, R: r, avgR: T.length ? r / T.length : 0, net, maxDD: dd };
}

return { LOT, H1, H4, H8, PAIRS, SYMS, DEFAULTS, usdPer, nyLag, bucket, aggregate, pivots, structure, adx,
         usdStructure, usdDirAt, fibOf, buildLegs, simulate, stats };
});
