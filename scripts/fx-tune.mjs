// Tune the FX Fib Ladder on real FX history.
//
// Replays fx-engine.js — the same code forex.html runs — over years of hourly
// Dukascopy candles for the five pairs, across a grid of settings, and picks the
// best on the older data (in-sample) before reporting how that pick did on the
// recent data it never saw (out-of-sample). Writes:
//   data/fx-tuned.json      the picked rules (forex.html loads them) + results
//   docs/fx-tune-report.md  the full table
//
//   node scripts/fx-tune.mjs                 fetch (cached in .cache/fx) and tune
//   node scripts/fx-tune.mjs --synthetic     random-walk data, to test the plumbing
//
// Costs: a round-trip spread per filled lot (SPREAD below, typical OANDA majors).
// Not modelled: swap, slippage beyond the spread, partial fills.
import { createRequire } from "module";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
const require = createRequire(import.meta.url);
const E = require("../fx-engine.js");

const FROM = "2019-01-01", SPLIT = "2024-07-01";          // in-sample before, out-of-sample after
const SPREAD = Object.fromEntries(E.SYMS.map(s => [s, E.PAIRS[s].spread]));
const RISK = 400, ALIGN = "oanda";
const MIN_IS_TRADES = 60;

const GRID = {
  tf: [E.H1, E.H4, E.H8],
  len: [5, 10, 20, 30],
  zone: [[0.236, 0.5], [0.382, 0.618], [0.5, 0.786], [0.236, 0.618]],
  stop: [1.0, 1.272, 1.618],
  tp: [-0.272, 0, 0.236],
  adxMin: [0, 20, 25],
  usd: ["off", "x2", "24h"],          // dollar filter: none, 2× the setup candle, daily
};
const BASELINE = { tf: E.H4, len: 20, inLo: 0.236, inHi: 0.5, stop: 1.272, tp: 0, adxMin: 20, usdFilter: true, usdTf: E.H8, usdLen: 20 };

function configs() {
  const out = [];
  for (const tf of GRID.tf) for (const len of GRID.len) for (const [inLo, inHi] of GRID.zone)
    for (const stop of GRID.stop) for (const tp of GRID.tp) for (const adxMin of GRID.adxMin) for (const usd of GRID.usd) {
      if (tp > inLo - 0.1) continue;                       // the target must sit clear of the first limit
      const usdTf = usd === "x2" ? tf * 2 : 86400;
      if (usd === "24h" && usdTf <= tf) continue;
      out.push({ tf, len, inLo, inHi, stop, tp, adxMin, usdFilter: usd !== "off", usdTf, usdLen: 20 });
    }
  return out;
}
const key = c => [c.tf / 3600 + "h", "len" + c.len, c.inLo + "-" + c.inHi, "sl" + c.stop, "tp" + c.tp,
  "adx" + c.adxMin, c.usdFilter ? "usd" + c.usdTf / 3600 + "h" : "nousd"].join(" ");

/* ── data ─────────────────────────────────────────────── */
async function fetchPair(sym) {
  const file = `.cache/fx/${sym}.json`;
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, "utf8"));
    if (c.length && Date.now() / 1000 - c[c.length - 1].t < 7 * 86400) return c;   // re-fetch once a week stale
  }
  const { getHistoricalRates } = require("dukascopy-node");
  console.log(`fetching ${sym} h1 ${FROM} → now from Dukascopy…`);
  // One year at a time, one pair at a time: Dukascopy answers 202 (try again)
  // when hit with many requests at once, so go gently and retry with backoff.
  const rows = [];
  const end = new Date();
  for (let y = +FROM.slice(0, 4); y <= end.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1)), to = y === end.getUTCFullYear() ? end : new Date(Date.UTC(y + 1, 0, 1));
    for (let attempt = 1; ; attempt++) {
      try {
        const part = await getHistoricalRates({
          instrument: sym.toLowerCase(), dates: { from, to },
          timeframe: "h1", priceType: "bid", format: "json", volumes: false, ignoreFlats: true,
          batchSize: 2, pauseBetweenBatchesMs: 1500, retryCount: 5, pauseBetweenRetriesMs: 5000,
        });
        rows.push(...part);
        console.log(`  ${sym} ${y}: ${part.length}`);
        break;
      } catch (e) {
        if (attempt >= 6) throw e;
        const wait = 15000 * attempt;
        console.log(`  ${sym} ${y}: ${e.message} — retrying in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  const c = rows.map(r => ({ t: Math.floor(r.timestamp / 1000), o: r.open, h: r.high, l: r.low, c: r.close }))
    .filter(x => x.c > 0).sort((a, b) => a.t - b.t).filter((x, i, a) => !i || x.t !== a[i - 1].t);
  mkdirSync(".cache/fx", { recursive: true });
  writeFileSync(file, JSON.stringify(c));
  console.log(`  ${sym}: ${c.length} candles, ${new Date(c[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(c[c.length - 1].t * 1000).toISOString().slice(0, 10)}`);
  return c;
}
function synthetic() {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
  const N = 24 * 5 * 52 * 3, t0 = Date.parse("2022-01-03T00:00:00Z") / 1000;
  const base = { EURUSD: 1.08, GBPUSD: 1.3, AUDUSD: 0.66, USDCHF: 0.88, USDJPY: 150 };
  let u = 0, d = 0; const U = [];
  for (let i = 0; i < N; i++) { if (i % 300 === 0) d = (rnd() - 0.5) * 0.00012; u += d + g() * 0.0007; U.push(u); }
  const out = {};
  for (const s of E.SYMS) {
    let own = 0, prev = base[s]; const c = [];
    for (let i = 0; i < N; i++) {
      own += g() * 0.0004;
      const p = base[s] * Math.exp(E.PAIRS[s].usd * U[i] + own), w = Math.abs(g()) * 0.0003 * p;
      const day = Math.floor(i / 24), t = t0 + (Math.floor(day / 5) * 7 + (day % 5)) * 86400 + (i % 24) * 3600;
      c.push({ t, o: prev, h: Math.max(prev, p) + w, l: Math.min(prev, p) - w, c: p }); prev = p;
    }
    out[s] = c;
  }
  return out;
}

/* ── evaluation ───────────────────────────────────────── */
// Everything that depends only on the candle / swing length is computed once.
function prepare(raw) {
  const P = {};
  for (const tf of GRID.tf) {
    const bars = {};
    for (const s of E.SYMS) bars[s] = E.aggregate(raw[s], tf, ALIGN);
    const lastT = Math.min(...E.SYMS.map(s => raw[s][raw[s].length - 1].t));
    for (const s of E.SYMS) bars[s] = bars[s].filter(b => b.t + tf <= lastT);   // closed bars only
    const ad = {}, ev = {};
    for (const s of E.SYMS) { ad[s] = E.adx(bars[s], 14); ev[s] = {}; for (const len of GRID.len) ev[s][len] = E.structure(bars[s], len); }
    const U = {};
    for (const usdTf of new Set([tf * 2, 86400])) if (usdTf > tf) U[usdTf] = E.usdStructure(bars, { tf, usdTf, usdLen: 20 }, ALIGN);
    P[tf] = { bars, ad, ev, U };
  }
  return P;
}
const splitT = Date.parse(SPLIT + "T00:00:00Z") / 1000;
function evaluate(P, cfg) {
  const prep = P[cfg.tf], all = [];
  const perPair = {};
  for (const s of E.SYMS) {
    const ev = prep.ev[s][cfg.len] || E.structure(prep.bars[s], cfg.len);
    const r = E.simulate(s, prep.bars[s], { params: Object.assign({}, cfg, { legs: 10, ratio: 2 }), risk: RISK,
      U: cfg.usdFilter ? prep.U[cfg.usdTf] : null, align: ALIGN, costPips: SPREAD[s], ev, ad: prep.ad[s] });
    perPair[s] = r.trades;
    all.push(...r.trades);
  }
  const is = all.filter(t => t.t1 < splitT), oos = all.filter(t => t.t1 >= splitT);
  const pairsUp = E.SYMS.filter(s => E.stats(perPair[s].filter(t => t.t1 < splitT), RISK).R > 0).length;
  return { cfg, is: E.stats(is, RISK), oos: E.stats(oos, RISK), pairsUp,
           pairs: Object.fromEntries(E.SYMS.map(s => [s, { is: E.stats(perPair[s].filter(t => t.t1 < splitT), RISK), oos: E.stats(perPair[s].filter(t => t.t1 >= splitT), RISK) }])) };
}

/* ── workers ──────────────────────────────────────────── */
if (!isMainThread) {
  const P = prepare(workerData.raw);
  const out = workerData.cfgs.map(c => { const r = evaluate(P, c); delete r.pairs; return r; });
  parentPort.postMessage(out);
} else {
  const synth = process.argv.includes("--synthetic");
  const raw = synth ? synthetic() : {};
  if (!synth) for (const s of E.SYMS) raw[s] = await fetchPair(s);      // sequential: be gentle with the feed
  const cfgs = configs();
  const nW = Math.max(1, Math.min(os.cpus().length, 8));
  console.log(`${cfgs.length} configurations × 5 pairs on ${nW} workers…`);
  const t0 = Date.now();
  const chunks = Array.from({ length: nW }, (_, i) => cfgs.filter((_, j) => j % nW === i));
  const results = (await Promise.all(chunks.map(ch => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { raw, cfgs: ch } });
    w.on("message", res); w.on("error", rej);
  })))).flat();
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Pick on in-sample only: enough trades, positive on most pairs, then most R.
  const eligible = results.filter(r => r.is.n >= MIN_IS_TRADES && r.pairsUp >= 3);
  const ranked = (eligible.length ? eligible : results).sort((a, b) => b.is.R - a.is.R || a.is.maxDD - b.is.maxDD);
  const P = prepare(raw);
  const best = evaluate(P, ranked[0].cfg), base = evaluate(P, BASELINE);
  const fmt = s => `${s.n} | ${(100 * s.hit).toFixed(0)}% | ${s.R >= 0 ? "+" : ""}${s.R.toFixed(1)}R | ${s.avgR.toFixed(3)} | ${s.maxDD.toFixed(1)}R | $${Math.round(s.net).toLocaleString("en-US")}`;
  const first = new Date(Math.min(...E.SYMS.map(s => raw[s][0].t)) * 1000).toISOString().slice(0, 10);
  const last = new Date(Math.max(...E.SYMS.map(s => raw[s][raw[s].length - 1].t)) * 1000).toISOString().slice(0, 10);
  const isLabel = `${first} → ${SPLIT}`, oosLabel = `${SPLIT} → ${last}`;

  const lines = [
    `# FX Fib Ladder — tuning report`, ``,
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`scripts/fx-tune.mjs\`${synth ? " — **SYNTHETIC DATA, plumbing test only**" : ""}.`,
    `Data: Dukascopy hourly bid, ${first} → ${last}, OANDA (New York close) candle timing.`,
    `Costs: round-trip spread per lot (${Object.entries(SPREAD).map(([s, v]) => s + " " + v).join(", ")} pips). No swap or slippage.`,
    `Sizing: $${RISK} max at the stop per trade; R = net $ ÷ $${RISK}. ${cfgs.length} settings tried; picked on **${isLabel}** only (≥ ${MIN_IS_TRADES} trades, positive on ≥ 3 of 5 pairs, most net), then checked on **${oosLabel}**, which the pick never saw.`, ``,
    `| | trades | hit | total | R/trade | worst run | net $ |`, `|---|---|---|---|---|---|---|`,
    `| **Picked** · tuning | ${fmt(best.is)} |`, `| **Picked** · unseen | ${fmt(best.oos)} |`,
    `| Crypto rules · tuning | ${fmt(base.is)} |`, `| Crypto rules · unseen | ${fmt(base.oos)} |`, ``,
    `**Picked:** \`${key(best.cfg)}\``, ``,
    `## Picked, per pair`, ``, `| pair | tuning | unseen |`, `|---|---|---|`,
    ...E.SYMS.map(s => `| ${s} | ${best.pairs[s].is.n} tr · ${(100 * best.pairs[s].is.hit).toFixed(0)}% · ${best.pairs[s].is.R.toFixed(1)}R | ${best.pairs[s].oos.n} tr · ${(100 * best.pairs[s].oos.hit).toFixed(0)}% · ${best.pairs[s].oos.R.toFixed(1)}R |`), ``,
    `## Top 25 on the tuning period (with how each did unseen)`, ``,
    `| settings | tuning: tr · hit · R · worst | unseen: tr · hit · R · worst |`, `|---|---|---|`,
    ...ranked.slice(0, 25).map(r => `| \`${key(r.cfg)}\` | ${r.is.n} · ${(100 * r.is.hit).toFixed(0)}% · ${r.is.R.toFixed(1)} · ${r.is.maxDD.toFixed(1)} | ${r.oos.n} · ${(100 * r.oos.hit).toFixed(0)}% · ${r.oos.R.toFixed(1)} · ${r.oos.maxDD.toFixed(1)} |`), ``,
    `How many of the top 25 stayed positive unseen: **${ranked.slice(0, 25).filter(r => r.oos.R > 0).length} / 25**.`, ``,
  ];
  const oosUp = best.oos.R > 0;
  const today = new Date().toISOString().slice(0, 10);
  const out = {
    generated: new Date().toISOString(), synthetic: synth,
    params: Object.assign({ name: `FX tuned (${today})`, adxN: 14, legs: 10, ratio: 2 }, best.cfg),
    split: { isLabel, oosLabel },
    best: { is: best.is, oos: best.oos }, baseline: { is: base.is, oos: base.oos },
    summary: `Picked from ${cfgs.length} settings on ${isLabel}, then run on ${oosLabel} unseen: ` +
      `${best.oos.n} trades, ${(100 * best.oos.hit).toFixed(0)}% hit, ${best.oos.R >= 0 ? "+" : ""}${best.oos.R.toFixed(1)}R after spread.`,
    note: (oosUp ? "It held up on the period it was not tuned on. " : "It did NOT hold up on the period it was not tuned on — treat these rules with caution. ") +
      "Replays fill limits at their price, take the stop first when a candle spans both, and charge a typical OANDA spread; swap and slippage are not included.",
    top: ranked.slice(0, 25).map(r => ({ key: key(r.cfg), is: r.is, oos: r.oos })),
  };
  mkdirSync("data", { recursive: true });
  writeFileSync("data/fx-tuned.json", JSON.stringify(out, null, 1) + "\n");
  writeFileSync("docs/fx-tune-report.md", lines.join("\n"));
  console.log(lines.join("\n"));
}
