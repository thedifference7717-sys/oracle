// ─────────────────────────────────────────────────────────────────────────────
// FX Daily 2:1 — one trade a day, target twice the stop ($1,000 vs $500).
//
// Each trading day (New York close to New York close) every pair may set up;
// the first order to fill across the five pairs is the day's trade, the rest
// are cancelled. Target = 2 × the stop distance, so a win is +2R and a loss
// −1R, less the spread. scripts/fx-daily-tune.mjs replays this over years of
// hourly candles to pick the settings; forex.html runs the picked ones.
//
// Browser: window.FxDaily (needs FxEngine). Node: module.exports.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./fx-engine.js"));
  else root.FxDaily = factory(root.FxEngine);
})(typeof self !== "undefined" ? self : this, function (E) {
"use strict";

const H1 = 3600, H4 = 14400, D1 = 86400;
const DEFAULTS = {
  bias: "none",      // direction: none | prevday | d1s3 | d1s5 | h4s10 | usd | ema50 | cot
  entry: "fib",      // fib (pullback after a 1h break) | asia (London breakout of the Asian range)
  len: 5,            // fib: 1h swing length for the break
  lim: 0.5,          // fib: limit at this retracement of the breaking move
  stop: 1.0,         // fib: stop at this retracement (beyond the limit)
  asiaStop: "opp",   // asia: stop at the opposite side of the range, or its middle
  win: [7, 16],      // UTC hours a setup may be armed in (London open → NY afternoon)
  exit: "hold",      // hold (until target/stop, max 3 days) | eod (flat at the NY close)
  minStop: 10,       // skip setups whose stop is closer than this many pips
  rr: 2,             // target = rr × stop distance
};

// Trading day of time t = the New York-close day it falls in (opens 17:00 NY).
const dayOf = t => E.bucket(t, D1, "oanda");
const utcH = t => new Date(t * 1000).getUTCHours();

function ema(vals, n) {
  const out = new Array(vals.length).fill(null), k = 2 / (n + 1);
  let e = null;
  for (let i = 0; i < vals.length; i++) { e = e == null ? vals[i] : vals[i] * k + e * (1 - k); if (i >= n - 1) out[i] = e; }
  return out;
}
// Latest structure-break direction as of each bar's close: [{T: close time, dir}]
function breakDirs(bars, P, len) {
  const ev = E.structure(bars, len), out = [];
  ev.forEach((e, k) => { if (e) out.push({ T: bars[k].t + P, dir: e.dir }); });
  return out;
}
function lastAt(list, T, key) {
  let lo = 0, hi = list.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m][key] <= T) { i = m; lo = m + 1; } else hi = m - 1; }
  return i < 0 ? null : list[i];
}

// Everything per pair that does not depend on the entry settings.
// h1: closed 1h bars (UTC); usd: E.usdStructure on 4h/8h (or null); cot: rows.
function prepare(sym, h1, ctx) {
  const d1 = E.aggregate(h1, D1, "oanda"), h4 = E.aggregate(h1, H4, "oanda");
  const days = new Map();                           // day start → [first, last] 1h index
  h1.forEach((b, i) => { const d = dayOf(b.t); const r = days.get(d); if (!r) days.set(d, [i, i]); else r[1] = i; });
  const e50 = ema(h4.map(b => b.c), 50);
  return {
    sym, h1, d1, h4, days: [...days.entries()].sort((a, b) => a[0] - b[0]),
    d1s3: breakDirs(d1, D1, 3), d1s5: breakDirs(d1, D1, 5), h4s10: breakDirs(h4, H4, 10),
    ema50: h4.map((b, i) => ({ T: b.t + H4, dir: e50[i] == null ? null : (b.c > e50[i] ? "long" : "short") })),
    prevday: d1.map(b => ({ T: b.t + D1, dir: b.c > b.o ? "long" : b.c < b.o ? "short" : null })),
    usd: ctx.usd ? ctx.usd.breaks.map(b => ({ T: b.closeT, dir: E.PAIRS[sym].usd > 0 ? b.dir : (b.dir === "long" ? "short" : "long") })) : null,
    cot: ctx.cot ? ctx.cot.map(r => ({ T: r.t, dir: r.lev > 0 ? "long" : r.lev < 0 ? "short" : null })) : null,
    ev: {},                                          // 1h structure per swing length, filled lazily
  };
}
function biasAt(P, mode, T) {
  if (mode === "none") return "both";
  const list = P[mode];
  if (!list) return null;
  const r = lastAt(list, T, "T");
  return r ? r.dir : null;
}

// One pair, one day: the order this pair would fill first, and how it ends.
// Returns null (no trade) or {sym, dir, fillT, entry, stop, tp, exitT, exit, R, how, setupT, hi, lo}.
// live: also return what is still working at the last bar ({pending: true, …}),
// for the page.
function pairDay(P, dayT, i0, i1, p, bias, live) {
  const h1 = P.h1, pip = E.PAIRS[P.sym].pip, cost = E.PAIRS[P.sym].spread * pip;
  const allow = d => bias === "both" || bias === d;
  if (!bias) return null;
  let order = null;                                  // pending {dir, entry, stop, tp, setupT, hi, lo}
  const mkOrder = (dir, entry, stop, setupT, hi, lo) => {
    const dist = Math.abs(entry - stop);
    if (dist < p.minStop * pip) return null;
    return { dir, entry, stop, tp: dir === "long" ? entry + p.rr * dist : entry - p.rr * dist, setupT, hi, lo, dist };
  };
  let asia = null;
  if (p.entry === "asia") {
    let hi = -Infinity, lo = Infinity, n = 0;
    for (let i = i0; i <= i1; i++) { const h = utcH(h1[i].t); if (h < 7 && h1[i].t >= dayT) { hi = Math.max(hi, h1[i].h); lo = Math.min(lo, h1[i].l); n++; } }
    if (n >= 4) asia = { hi, lo };
  }
  let ev = null;
  if (p.entry === "fib") ev = P.ev[p.len] || (P.ev[p.len] = E.structure(h1, p.len));
  for (let i = i0; i <= i1; i++) {
    const b = h1[i], h = utcH(b.t);
    // 1) a working order fills during this bar
    if (order) {
      const L = order.dir === "long";
      const hit = order.kind === "stop" ? (L ? b.h >= order.entry : b.l <= order.entry) : (L ? b.l <= order.entry : b.h >= order.entry);
      if (hit) return finish(P, order, i, p, cost);
    }
    // 2) at the close: arm (or replace) the order
    if (h + 1 < p.win[0] || h + 1 > p.win[1]) continue;
    if (p.entry === "fib") {
      const e = ev[i];
      if (!e || !allow(e.dir)) continue;
      let hi, lo;
      if (e.dir === "long") { let li = e.piv; for (let j = e.piv; j <= i; j++) if (h1[j].l < h1[li].l) li = j; lo = h1[li].l; hi = -Infinity; for (let j = li; j <= i; j++) hi = Math.max(hi, h1[j].h); }
      else { let hj = e.piv; for (let j = e.piv; j <= i; j++) if (h1[j].h > h1[hj].h) hj = j; hi = h1[hj].h; lo = Infinity; for (let j = hj; j <= i; j++) lo = Math.min(lo, h1[j].l); }
      const at = E.fibOf(e.dir, hi, lo), entry = at(p.lim), stop = at(p.stop);
      if (e.dir === "long" ? b.c <= entry : b.c >= entry) continue;     // already pulled back past the limit
      const o = mkOrder(e.dir, entry, stop, b.t + H1, hi, lo);
      if (o) { o.kind = "limit"; order = o; }
    } else if (asia && !order && h + 1 >= 7) {
      // both sides armed as stop orders at 07:00; the first to trade is the trade
      const mid = (asia.hi + asia.lo) / 2;
      const L = allow("long") ? mkOrder("long", asia.hi, p.asiaStop === "mid" ? mid : asia.lo, b.t + H1, asia.hi, asia.lo) : null;
      const S = allow("short") ? mkOrder("short", asia.lo, p.asiaStop === "mid" ? mid : asia.hi, b.t + H1, asia.hi, asia.lo) : null;
      if (L) L.kind = "stop"; if (S) S.kind = "stop";
      if (!L && !S) return null;
      // two-sided: watch both from the next bar
      for (let j = i + 1; j <= i1; j++) {
        const x = h1[j];
        if (utcH(x.t) + 1 > p.win[1]) break;
        const lh = L && x.h >= L.entry, sh = S && x.l <= S.entry;
        // Both sides in one hour: whichever filled first was also run through its
        // stop (the stop is the other side or the middle, both crossed) — a loss.
        // Skipping these days would quietly drop guaranteed losers.
        if (lh && sh) {
          const o = L.dist <= S.dist ? L : S, cost = E.PAIRS[P.sym].spread * E.PAIRS[P.sym].pip;
          return Object.assign({ sym: P.sym, fillT: x.t, exitT: x.t + H1, exit: o.stop, how: "stop", R: -1 - cost / o.dist }, o);
        }
        if (lh) return finish(P, L, j, p, cost);
        if (sh) return finish(P, S, j, p, cost);
      }
      if (live && i1 === h1.length - 1 && utcH(h1[i1].t) + 1 < p.win[1])
        return { sym: P.sym, pending: true, kind: "stop", both: [L, S].filter(Boolean), hi: asia.hi, lo: asia.lo };
      return null;
    }
  }
  if (live && order && i1 === h1.length - 1) return Object.assign({ sym: P.sym, pending: true }, order);
  if (live && p.entry === "asia" && i1 === h1.length - 1 && !asia) return { sym: P.sym, pending: true, forming: true };
  return null;
}
// From the fill bar on: stop or target (stop first if one bar spans both; the
// fill bar can only stop out), or the time exit.
function finish(P, o, i, p, cost) {
  const h1 = P.h1, L = o.dir === "long";
  const fillT = h1[i].t;
  const end = p.exit === "eod" ? dayOf(fillT) + D1 : fillT + 3 * D1;
  const R = x => ((L ? x - o.entry : o.entry - x) - cost) / o.dist;
  const out = (exit, t, how) => Object.assign({ sym: P.sym, fillT, exitT: t, exit, how, R: R(exit) }, o);
  for (let j = i; j < h1.length; j++) {
    const x = h1[j];
    if (x.t >= end) return out(h1[j - 1].c, h1[j - 1].t + H1, "time");
    if (L ? x.l <= o.stop : x.h >= o.stop) return out(o.stop, x.t + H1, "stop");
    if (j > i && (L ? x.h >= o.tp : x.l <= o.tp)) return out(o.tp, x.t + H1, "target");
  }
  return Object.assign({ sym: P.sym, fillT, open: true, R: R(h1[h1.length - 1].c) }, o);
}

// All pairs, every day: the first fill of the day is the trade. Returns trades
// in time order; `perPair` = what each pair alone would have done.
function simulate(preps, params) {
  const p = Object.assign({}, DEFAULTS, params);
  const daySet = new Set();
  preps.forEach(P => P.days.forEach(([d]) => daySet.add(d)));
  const days = [...daySet].sort((a, b) => a - b);
  const idx = preps.map(P => new Map(P.days));
  const trades = [], perPair = {};
  preps.forEach(P => perPair[P.sym] = []);
  let busyUntil = 0;
  for (const d of days) {
    let best = null;
    preps.forEach((P, k) => {
      const r = idx[k].get(d);
      if (!r) return;
      const bias = biasAt(P, p.bias, d);
      const t = pairDay(P, d, r[0], r[1], p, bias);
      if (!t) return;
      perPair[P.sym].push(t);
      if (t.fillT >= busyUntil && (!best || t.fillT < best.fillT)) best = t;
    });
    if (best) { trades.push(best); busyUntil = best.open ? Infinity : best.exitT; }   // never two at once
  }
  return { trades, perPair };
}

// Today's state for the page: per pair, the order working now or the trade it
// took today; plus the day's trade (the first fill).
function today(preps, params) {
  const p = Object.assign({}, DEFAULTS, params);
  const out = { pairs: {}, trade: null };
  preps.forEach(P => {
    const last = P.days[P.days.length - 1];
    if (!last) return;
    const [d, [i0, i1]] = last;
    const bias = biasAt(P, p.bias, d);
    const t = pairDay(P, d, i0, i1, p, bias, true);
    out.pairs[P.sym] = { day: d, bias, trade: t };
    if (t && !t.pending && (!out.trade || t.fillT < out.trade.fillT)) out.trade = t;
  });
  return out;
}

return { DEFAULTS, dayOf, prepare, biasAt, pairDay, simulate, today };
});
