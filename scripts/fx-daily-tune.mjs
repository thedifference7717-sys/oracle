// Tune the FX Daily 2:1 trade (fx-daily.js) on real FX history.
//
// One trade a day across the five pairs, target 2× the stop: risk $500 to make
// $1,000, every trade settled within 24 hours (closed at market if neither hits). Break-even is a 33% hit rate before spread. Tries every combination
// of direction filter × entry × exit below, picks on the older data for
// consistency year to year, and checks the pick on the recent data it never
// saw. Publishes data/fx-daily.json (the page runs it) only if the pick also
// made money unseen. Report: docs/fx-daily-report.md.
//
//   node scripts/fx-daily-tune.mjs               reads .cache/fx/<PAIR>.json (scripts/fx-fetch-histdata.py)
//   node scripts/fx-daily-tune.mjs --synthetic   random-walk data, to test the plumbing
import { createRequire } from "module";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
const require = createRequire(import.meta.url);
const E = require("../fx-engine.js"), F = require("../fx-daily.js");

const SPLIT = "2024-07-01", RISK = 500, MIN_IS_TRADES = 150;   // (every-day pool: ≥ 200 trades a year)
const BIAS = ["none", "prevday", "d1s3", "d1s5", "h4s10", "usd", "ema50", "cot",
              "d1s5+h4s10", "d1s5+cot", "d1s5+usd", "h4s10+cot", "ema50+cot", "d1s5+ema50"];      // "+" = both must agree
const FIBS = [[0.382, 0.786], [0.382, 1], [0.5, 0.786], [0.5, 0.886], [0.5, 1], [0.5, 1.13], [0.618, 0.886], [0.618, 1], [0.618, 1.13], [0.705, 1.13]];

function configs() {
  const out = [];
  for (const bias of BIAS) {
    for (const len of [3, 5, 10]) for (const [lim, stop] of FIBS) for (const win of [[7, 16], [0, 24]])
      for (const exit of ["h24", "eod"]) for (const minStop of [10, 20])
        out.push({ bias, entry: "fib", len, lim, stop, win, exit, minStop });
    for (const asiaStop of ["opp", "mid"]) for (const win of [[7, 12], [7, 16]]) for (const exit of ["h24", "eod"]) for (const minStop of [10, 20])
      out.push({ bias, entry: "asia", asiaStop, win, exit, minStop });
    for (const pdStop of ["mid", "q"]) for (const win of [[7, 16], [0, 24]]) for (const exit of ["h24", "eod"]) for (const minStop of [10, 20])
      out.push({ bias, entry: "pdh", pdStop, win, exit, minStop });
    for (const win of [[7, 12], [7, 16]]) for (const exit of ["h24", "eod"]) for (const minStop of [5, 10])
      out.push({ bias, entry: "sweep", win, exit, minStop });
    // Every day, no waiting for a setup: at market at 9:00 New York.
    if (bias !== "none") for (const stopMode of EVERY_STOPS) for (const pick of ["adx", ...E.SYMS]) for (const exit of ["h24", "eod"])
      out.push({ bias, entry: "ny9", stopMode, pick, exit, minStop: 10, win: [0, 24] });
  }
  return out;
}
const EVERY_STOPS = ["atr1.5", "atr2", "atr3", "atr4", "swing6", "swing12"];
const key = c => c.entry === "ny9" ? [c.bias, "9am-NY market", "stop-" + c.stopMode, "pair-" + c.pick, c.exit].join(" ") : [c.bias, c.entry === "fib" ? `fib len${c.len} lim${c.lim} stop${c.stop}` : c.entry === "asia" ? `asia stop-${c.asiaStop}` : c.entry === "pdh" ? `pdh stop-${c.pdStop}` : "sweep",
  `${c.win[0]}-${c.win[1]}utc`, c.exit, `min${c.minStop}p`].join(" ");

/* ── data ─────────────────────────────────────────────── */
function loadRaw(synth) {
  if (synth) {
    let a = 0x9e3779b9; const rnd = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };   // mulberry32: an LCG's correlated draws fake trends
    const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / Math.sqrt(0.5); };
    const N = 24 * 5 * 52 * 3, t0 = Date.parse("2022-01-03T00:00:00Z") / 1000, out = {};
    const base = { EURUSD: 1.08, GBPUSD: 1.3, AUDUSD: 0.66, USDCHF: 0.88, USDJPY: 150 };
    for (const s of E.SYMS) {
      let prev = base[s], x = 0; const c = [];
      for (let i = 0; i < N; i++) {
        x += g() * 0.0009; const p = base[s] * Math.exp(x), w = Math.abs(g()) * 0.0004 * p;
        const day = Math.floor(i / 24), t = t0 + (Math.floor(day / 5) * 7 + (day % 5)) * 86400 + (i % 24) * 3600;
        c.push({ t, o: prev, h: Math.max(prev, p) + w, l: Math.min(prev, p) - w, c: p }); prev = p;
      }
      out[s] = c;
    }
    return out;
  }
  const out = {};
  for (const s of E.SYMS) {
    const f = `.cache/fx/${s}.json`;
    if (!existsSync(f)) throw new Error(`${f} missing — run scripts/fx-fetch-histdata.py first`);
    out[s] = JSON.parse(readFileSync(f, "utf8"));
  }
  return out;
}
function prepAll(raw, cot) {
  const lastT = Math.min(...E.SYMS.map(s => raw[s][raw[s].length - 1].t));
  const h1 = {}, h4 = {};
  for (const s of E.SYMS) { h1[s] = raw[s].filter(b => b.t + 3600 <= lastT); h4[s] = E.aggregate(h1[s], E.H4, "oanda"); }
  const usd = E.usdStructure(h4, { tf: E.H4, usdTf: E.H8, usdLen: 20 }, "oanda");
  return E.SYMS.map(s => F.prepare(s, h1[s], { usd, cot: cot && cot[s] }));
}

/* ── scoring ──────────────────────────────────────────── */
let splitT = Date.parse(SPLIT + "T00:00:00Z") / 1000;
function stats(T) {
  let r = 0, peak = 0, dd = 0, w = 0, tg = 0;
  for (const t of T) { r += t.R; if (t.R > 0) w++; if (t.how === "target") tg++; peak = Math.max(peak, r); dd = Math.max(dd, peak - r); }
  const yrs = T.length ? (T[T.length - 1].fillT - T[0].fillT) / (365.25 * 86400) : 0;
  return { n: T.length, hit: T.length ? w / T.length : 0, tgt: T.length ? tg / T.length : 0, R: r, avgR: T.length ? r / T.length : 0, maxDD: dd, perYear: yrs > 0.5 ? T.length / yrs : T.length };
}
function evaluate(preps, cfg, detail) {
  const { trades, perPair } = F.simulate(preps, cfg);
  const done = trades.filter(t => !t.open);
  const is = done.filter(t => t.fillT < splitT), oos = done.filter(t => t.fillT >= splitT);
  const years = {};
  for (const t of is) { const y = new Date(t.fillT * 1000).getUTCFullYear(); years[y] = (years[y] || 0) + t.R; }
  const yr = Object.values(years);
  const r = { cfg, is: stats(is), oos: stats(oos), upYears: yr.filter(v => v > 0).length, nYears: yr.length, worstYear: yr.length ? Math.min(...yr) : 0 };
  if (detail) {
    r.pairs = Object.fromEntries(E.SYMS.map(s => [s, { is: stats(perPair[s].filter(t => !t.open && t.fillT < splitT)), oos: stats(perPair[s].filter(t => !t.open && t.fillT >= splitT)) }]));
    r.byPair = Object.fromEntries(E.SYMS.map(s => [s, stats(oos.filter(t => t.sym === s))]));
    r.last = done.slice(-15).map(t => ({ sym: t.sym, dir: t.dir, fillT: t.fillT, entry: t.entry, stop: t.stop, tp: t.tp, how: t.how, R: t.R }));
  }
  return r;
}

/* ── run ──────────────────────────────────────────────── */
if (!isMainThread) {
  splitT = workerData.splitT;
  const preps = prepAll(workerData.raw, workerData.cot);
  parentPort.postMessage(workerData.cfgs.map(c => evaluate(preps, c)));
} else {
  const synth = process.argv.includes("--synthetic");
  const raw = loadRaw(synth);
  const cot = !synth && existsSync("data/fx-cot.json") ? JSON.parse(readFileSync("data/fx-cot.json", "utf8")).pairs : null;
  const first = Math.max(...E.SYMS.map(s => raw[s][0].t)), last = Math.min(...E.SYMS.map(s => raw[s][raw[s].length - 1].t));
  let split = SPLIT;
  if (splitT < first + (last - first) / 2) { split = new Date((first + (last - first) * 2 / 3) * 1000).toISOString().slice(0, 10); splitT = Date.parse(split + "T00:00:00Z") / 1000; }
  const cfgs = configs().filter(c => c.bias !== "cot" || cot);
  const nW = Math.max(1, Math.min(os.cpus().length, 8));
  console.log(`${cfgs.length} daily setups × 5 pairs on ${nW} workers…`);
  const t0 = Date.now();
  const chunks = Array.from({ length: nW }, (_, i) => cfgs.filter((_, j) => j % nW === i));
  const results = (await Promise.all(chunks.map(ch => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { raw, cot, cfgs: ch, splitT } });
    w.on("message", res); w.on("error", rej);
  })))).flat();
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Pick on the tuning period only: enough trades, then the most money-making
  // years, the least-bad worst year, the most R.
  const rank = rs => rs.slice().sort((a, b) => b.upYears - a.upYears || b.worstYear - a.worstYear || b.is.R - a.is.R);
  const setups = results.filter(r => r.cfg.entry !== "ny9"), every = results.filter(r => r.cfg.entry === "ny9");
  const pool = setups.filter(r => r.is.n >= MIN_IS_TRADES);
  const ranked = rank(pool.length ? pool : setups);
  // The every-day trade: needs a trade on most weekdays (≥ 200 a year in the tuning period),
  // and must actually be a +$1,000-or-−$500 trade — the full target hit at least 20% of
  // the time — not mostly small closes at the 24-hour mark.
  const everyPool = every.filter(r => r.is.perYear >= 200 && r.is.tgt >= 0.2);
  const everyRanked = rank(everyPool.length ? everyPool : every);
  const preps = prepAll(raw, cot);
  const best = evaluate(preps, ranked[0].cfg, true);
  const held = best.oos.R > 0 && best.oos.n >= 20;
  const ev = everyRanked.length ? evaluate(preps, everyRanked[0].cfg, true) : null;
  const evHeld = !!ev && ev.oos.R > 0 && ev.oos.n >= 100;
  const d = t => new Date(t * 1000).toISOString().slice(0, 10);
  const isLabel = `${d(first)} → ${split}`, oosLabel = `${split} → ${d(last)}`;
  const usd$ = R => (R >= 0 ? "+$" : "−$") + Math.round(Math.abs(R) * RISK).toLocaleString("en-US");
  const fmt = s => `${s.n} | ${s.perYear.toFixed(0)} | ${(100 * s.tgt).toFixed(0)}% | ${(100 * s.hit).toFixed(0)}% | ${s.R >= 0 ? "+" : ""}${s.R.toFixed(1)}R | ${usd$(s.R)} | ${s.maxDD.toFixed(1)}R`;
  const byBias = BIAS.map(b => ranked.find(r => r.cfg.bias === b)).filter(Boolean);
  const share = results.filter(r => r.is.n >= MIN_IS_TRADES);
  const lines = [
    `# FX Daily 2:1 — tuning report`, ``,
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`scripts/fx-daily-tune.mjs\`${synth ? " — **SYNTHETIC DATA, plumbing test only**" : ""}.`,
    `One trade a day across EURUSD, GBPUSD, AUDUSD, USDCHF, USDJPY (first fill wins, never two open). Target 2× the stop: **risk $${RISK} to make $${2 * RISK}**, every trade settled within 24 hours (closed at market if neither hits). "Any profit" counts time exits that closed up; "full wins" are the +$${2 * RISK} target. Break-even ≈ 33% before spread; spread is charged on every trade.`,
    `${cfgs.length} setups tried. Picked on **${isLabel}** only (≥ ${MIN_IS_TRADES} trades, then most profitable years, least-bad worst year, most R); checked on **${oosLabel}**, unseen.`, ``,
    `| | trades | per year | full +$${2 * RISK} wins | any profit | total | at $${RISK}/trade | worst run |`, `|---|---|---|---|---|---|---|---|`,
    `| **Picked** · tuning | ${fmt(best.is)} |`, `| **Picked** · unseen | ${fmt(best.oos)} |`, ``,
    `**Picked:** \`${key(best.cfg)}\` — profitable in ${ranked[0].upYears} of ${ranked[0].nYears} tuning years.`, ``,
    `**Published:** ${held ? "yes — it also made money unseen, so forex.html shows its trade each day." : "**no** — it did not make money on the unseen period."}`, ``,
    ...(ev ? [
      `## The every-day trade (at market, 9:00 am New York)`, ``,
      `A trade every weekday — no waiting for a setup. ${every.length} variations: direction filter × stop (ATR or recent swing; never under 10 pips) × which pair (strongest 4h ADX, or a fixed one) × exit. Picked the same way, on the tuning period only, among those trading ≥ 200 days a year whose full +$${2 * RISK} target hit ≥ 20% of the time.`, ``,
      `| | trades | per year | full +$${2 * RISK} wins | any profit | total | at $${RISK}/trade | worst run |`, `|---|---|---|---|---|---|---|---|`,
      `| **Every day** · tuning | ${fmt(ev.is)} |`, `| **Every day** · unseen | ${fmt(ev.oos)} |`, ``,
      `**Picked:** \`${key(ev.cfg)}\`. **Published:** ${evHeld ? "yes — it also made money unseen." : "**no** — it lost on the unseen period; the alert still sends it each day, marked untested."}`, ``,
      `| top 10 every-day settings | up yrs | tuning: tr · full · any · R | unseen: tr · full · any · R |`, `|---|---|---|---|`,
      ...everyRanked.slice(0, 10).map(r => `| \`${key(r.cfg)}\` | ${r.upYears}/${r.nYears} | ${r.is.n} · ${(100 * r.is.tgt).toFixed(0)}% · ${(100 * r.is.hit).toFixed(0)}% · ${r.is.R.toFixed(1)} | ${r.oos.n} · ${(100 * r.oos.tgt).toFixed(0)}% · ${(100 * r.oos.hit).toFixed(0)}% · ${r.oos.R.toFixed(1)} |`), ``,
      `Every-day variations positive unseen: **${every.length ? (100 * every.filter(r => r.oos.R > 0).length / every.length).toFixed(0) : 0}%**.`, ``,
    ] : []),
    `## Best by direction filter (ranked on the tuning period)`, ``,
    `| direction | settings | tuning: tr · hit · R | unseen: tr · hit · R |`, `|---|---|---|---|`,
    ...byBias.map(r => `| ${r.cfg.bias} | \`${key(r.cfg)}\` | ${r.is.n} · ${(100 * r.is.hit).toFixed(0)}% · ${r.is.R.toFixed(1)} | ${r.oos.n} · ${(100 * r.oos.hit).toFixed(0)}% · ${r.oos.R.toFixed(1)} |`), ``,
    `## Top 25 on the tuning period`, ``,
    `| settings | up yrs | tuning: tr · hit · R | unseen: tr · hit · R |`, `|---|---|---|---|`,
    ...ranked.slice(0, 25).map(r => `| \`${key(r.cfg)}\` | ${r.upYears}/${r.nYears} | ${r.is.n} · ${(100 * r.is.hit).toFixed(0)}% · ${r.is.R.toFixed(1)} | ${r.oos.n} · ${(100 * r.oos.hit).toFixed(0)}% · ${r.oos.R.toFixed(1)} |`), ``,
    `Top 25 still positive unseen: **${ranked.slice(0, 25).filter(r => r.oos.R > 0).length} / 25**. All setups with enough trades positive unseen: **${share.length ? (100 * share.filter(r => r.oos.R > 0).length / share.length).toFixed(0) : 0}%**.`, ``,
    `## The past 50% winners — and what happened next`, ``,
    `Every setup with at least 200 trades over the whole history, ranked by hit rate on **${isLabel}**. A 2:1 setup needs ~34% to break even; the question is whether a high past hit rate carries on into the unseen period.`, ``,
    `| settings | tuning: tr · hit · R | unseen: tr · hit · R |`, `|---|---|---|`,
    ...results.filter(r => r.is.n + r.oos.n >= 200).sort((a, b) => b.is.hit - a.is.hit).slice(0, 15)
      .map(r => `| \`${key(r.cfg)}\` | ${r.is.n} · **${(100 * r.is.hit).toFixed(0)}%** (${(100 * r.is.tgt).toFixed(0)}% full) · ${r.is.R.toFixed(1)} | ${r.oos.n} · **${(100 * r.oos.hit).toFixed(0)}%** (${(100 * r.oos.tgt).toFixed(0)}% full) · ${r.oos.R.toFixed(1)} |`), ``,
    `Setups that won ≥ 50% of trades in the tuning period: **${results.filter(r => r.is.n >= MIN_IS_TRADES && r.is.hit >= 0.5).length}**; of those, still ≥ 50% unseen: **${results.filter(r => r.is.n >= MIN_IS_TRADES && r.is.hit >= 0.5 && r.oos.hit >= 0.5 && r.oos.n >= 20).length}**.`, ``,
    `## Picked, if each pair traded alone`, ``, `| pair | tuning | unseen |`, `|---|---|---|`,
    ...E.SYMS.map(s => `| ${s} | ${best.pairs[s].is.n} tr · ${(100 * best.pairs[s].is.hit).toFixed(0)}% · ${best.pairs[s].is.R.toFixed(1)}R | ${best.pairs[s].oos.n} tr · ${(100 * best.pairs[s].oos.hit).toFixed(0)}% · ${best.pairs[s].oos.R.toFixed(1)}R |`), ``,
  ];
  const out = {
    generated: new Date().toISOString(), synthetic: synth, risk: RISK,
    params: held ? Object.assign({ name: `Daily 2:1 (${new Date().toISOString().slice(0, 10)})` }, best.cfg) : null,
    candidate: best.cfg, key: key(best.cfg), split: { isLabel, oosLabel },
    best: { is: best.is, oos: best.oos }, last: best.last,
    everyday: ev ? {
      params: evHeld ? Object.assign({ name: `Every day 2:1 (${new Date().toISOString().slice(0, 10)})` }, ev.cfg) : null,
      candidate: ev.cfg, key: key(ev.cfg), best: { is: ev.is, oos: ev.oos }, last: ev.last,
      summary: `${evHeld ? "Held up" : "Untested — lost on the unseen period"}: picked from ${every.length} every-day variations on ${isLabel}; on ${oosLabel}, unseen: ` +
        `${ev.oos.n} trades, ${(100 * ev.oos.tgt).toFixed(0)}% hit the +$${2 * RISK} target, ${ev.oos.R >= 0 ? "+" : ""}${ev.oos.R.toFixed(1)}R (${usd$(ev.oos.R)}) after spread.`,
    } : null,
    summary: held
      ? `Picked from ${cfgs.length} one-a-day setups on ${isLabel}; on ${oosLabel}, unseen: ${best.oos.n} trades, ${(100 * best.oos.hit).toFixed(0)}% hit, ${best.oos.R >= 0 ? "+" : ""}${best.oos.R.toFixed(1)}R (${usd$(best.oos.R)} at $${RISK} a trade) after spread.`
      : `No one-a-day 2:1 setup held up: the most consistent of ${cfgs.length} on ${isLabel} made ${best.oos.R.toFixed(1)}R on ${oosLabel} unseen (${(100 * best.oos.hit).toFixed(0)}% hit, needs ~34%).`,
  };
  const dir = synth ? ".cache/fx-synthetic" : null;
  mkdirSync(dir || "data", { recursive: true });
  writeFileSync(dir ? dir + "/fx-daily.json" : "data/fx-daily.json", JSON.stringify(out, null, 1) + "\n");
  writeFileSync(dir ? dir + "/fx-daily-report.md" : "docs/fx-daily-report.md", lines.join("\n"));
  console.log(lines.join("\n"));
}
