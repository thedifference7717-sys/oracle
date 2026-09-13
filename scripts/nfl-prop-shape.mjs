#!/usr/bin/env node
// Fits every constant in the prop simulator against real NFL games, and
// scores the fit on a season it never saw.
//
//   node scripts/nfl-prop-shape.mjs            fit on 2023, score on 2024
//   node scripts/nfl-prop-shape.mjs 2024 2025  fit on the first, score on the second
//
// Box scores are cached under .cache/box/ so a re-run costs nothing.
//
// What it fits, and why each one exists:
//
//   PER-ROLE SHAPE. How much of his usual workload a man gets in a given week,
//   how often that collapses outright, and how much the yards wobble on top.
//   A plain gamma cannot hold the mass that really sits near zero without
//   throwing its right tail out to compensate, which is why there is an
//   explicit "dud" — shadowed, hurt, benched, game gone the wrong way.
//
//   TEAM STRUCTURE. How much a team's volume swings, how the two sides of one
//   game push against each other, and how much a man's share of his own
//   offence moves. These are what make the simulation's correlations come out
//   right without anything being told to correlate.
//
// The headline check is the PIT: push every real game through the fitted
// distribution and the answers should be spread evenly over 0-1. Chi-square on
// 19 degrees of freedom; under about 40 is a good fit, and what this replaced
// scored 120-320.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = path.join(ROOT, ".cache", "box");
const SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

const [TRAIN, TEST] = (process.argv.slice(2).map(Number).filter(Boolean).length === 2
  ? process.argv.slice(2).map(Number) : [2023, 2024]);

const M = (await import(path.join(ROOT, "gridiron-model.js"))).default ??
          (await import(path.join(ROOT, "gridiron-model.js")));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── the games ───────────────────────────────────────────────────────────────
async function j(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return await r.json(); }
    catch (e) { if (i === tries - 1) throw e; await new Promise(s => setTimeout(s, 400 * (i + 1))); }
  }
}
async function pool(items, fn, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k]); } catch {} } }));
}
async function season(year) {
  fs.mkdirSync(CACHE, { recursive: true });
  const ids = [];
  for (const [st, wks] of [[2, 18], [3, 5]]) {
    for (let w = 1; w <= wks; w++) {
      const d = await j(`${SITE}/scoreboard?limit=400&dates=${year}&seasontype=${st}&week=${w}`);
      (d.events || []).forEach(e => {
        const c = (e.competitions || [])[0];
        if (((c?.status) || {}).type?.completed) ids.push({ id: e.id, year, week: w });
      });
    }
  }
  const need = ids.filter(x => !fs.existsSync(`${CACHE}/${x.id}.json`));
  if (need.length) {
    process.stderr.write(`${year}: fetching ${need.length} of ${ids.length} box scores\n`);
    let done = 0;
    await pool(need, async x => {
      const d = await j(`${SITE}/summary?event=${x.id}`);
      fs.writeFileSync(`${CACHE}/${x.id}.json`, JSON.stringify({ meta: x, boxscore: d.boxscore }));
      if (++done % 50 === 0) process.stderr.write(`  ${done}/${need.length}\n`);
    }, 8);
  }
  return ids;
}
const WANT = {
  passing:   { passAtt: "completions/passingAttempts", passYds: "passingYards", passTD: "passingTouchdowns" },
  rushing:   { car: "rushingAttempts", rushYds: "rushingYards" },
  receiving: { rec: "receptions", recYds: "receivingYards", tgt: "receivingTargets" }
};
const numOf = v => { const n = parseFloat(String(v).split("/").pop()); return isFinite(n) ? n : 0; };
const attOf = v => { const p = String(v).split("/"); const n = parseFloat(p[1] ?? p[0]); return isFinite(n) ? n : 0; };
function rowsFor(ids) {
  const out = [];
  for (const g of ids) {
    let d; try { d = JSON.parse(fs.readFileSync(`${CACHE}/${g.id}.json`, "utf8")); } catch { continue; }
    const teams = (d.boxscore || {}).players || [];
    if (teams.length !== 2) continue;
    teams.forEach((T, ti) => {
      const by = {};
      (T.statistics || []).forEach(cat => {
        const map = WANT[cat.name]; if (!map) return;
        const keys = cat.keys || [];
        (cat.athletes || []).forEach(a => {
          const id = a.athlete?.id; if (!id) return;
          const r = by[id] = by[id] || { id, name: a.athlete.displayName, teamId: T.team?.id, side: ti };
          for (const [k, label] of Object.entries(map)) {
            const i = keys.indexOf(label); if (i < 0) continue;
            r[k] = k === "passAtt" ? attOf(a.stats[i]) : numOf(a.stats[i]);
          }
        });
      });
      Object.values(by).forEach(r => out.push({ gid: g.id, season: g.year, ...r }));
    });
  }
  return out;
}

// ── the fit ─────────────────────────────────────────────────────────────────
const MK = ["passYds", "passAtt", "passTD", "rushYds", "car", "recYds", "rec", "tgt"];
// Only where a book would actually post a line.
const MIN = { passYds: 150, passAtt: 20, passTD: 0.8, rushYds: 20, car: 6, recYds: 20, rec: 2.0 };
const PAIRS = [
  { role: "REC", cnt: "rec",     yds: "recYds",  N: 16 },
  { role: "RB",  cnt: "car",     yds: "rushYds", N: 34 },
  { role: "QB",  cnt: "passAtt", yds: "passYds", N: 60 }
];

const _pmf = new Map();
function countPmf(rate, cv2, dud, dudAt, N) {
  const ck = Math.round(rate * 20) + "|" + cv2 + "|" + dud + "|" + dudAt + "|" + N;
  const got = _pmf.get(ck); if (got) return got;
  if (_pmf.size > 400000) _pmf.clear();
  const rr = Math.round(rate * 20) / 20;
  const B = dud * dudAt + 1 - dud, k = cv2 > 1e-9 ? 1 / cv2 : 1e9;
  const comp = (w, mul) => {
    const r = rr * mul / B, out = []; let prev = M.nbAtLeast(r, k, 0);
    for (let i = 0; i <= N; i++) { const nx = M.nbAtLeast(r, k, i + 1); out.push(w * (prev - nx)); prev = nx; }
    return out;
  };
  const a = comp(dud, dudAt), b = comp(1 - dud, 1);
  const val = a.map((v, i) => v + b[i]);
  _pmf.set(ck, val); return val;
}
const countTail = (rate, p, n, N) => {
  const pmf = countPmf(rate, p.cv2, p.vd, p.vdAt, N); let t = 0;
  for (let i = Math.max(0, n); i <= N; i++) t += pmf[i]; return t;
};
function ydsTail(rate, p, y1, y, N) {
  const pmf = countPmf(rate, p.cv2, p.vd, p.vdAt, N);
  const B = p.ed * p.edAt + 1 - p.ed, eg = 1 / B, em = p.edAt / B, s2 = p.s2 * y1 * y1;
  let t = 0;
  for (let i = 1; i <= N; i++) {
    if (pmf[i] < 1e-9) continue;
    const mu = i * y1, vr = i * s2;
    t += pmf[i] * (p.ed * M.gammaTail(mu * em, vr * em * em, y) + (1 - p.ed) * M.gammaTail(mu * eg, vr * eg * eg, y));
  }
  return t;
}
// Probability-integral transform: if the shape is right, u is uniform.
function pit(arr, p, P, yr) {
  const B = 20, hc = new Array(B).fill(0), hy = new Array(B).fill(0); let n = 0;
  for (const d of arr) {
    if (d.season !== yr) continue; n++;
    const hi = countTail(d.rate, p, d.c, P.N), nx = countTail(d.rate, p, d.c + 1, P.N);
    hc[clamp(Math.floor((1 - hi + 0.5 * (hi - nx)) * B), 0, B - 1)]++;       // mid-P on a count
    hy[clamp(Math.floor((1 - ydsTail(d.rate, p, d.y1, Math.max(1e-6, d.y), P.N)) * B), 0, B - 1)]++;
  }
  const e = n / B, chi = h => h.reduce((t, o) => t + (o - e) * (o - e) / e, 0);
  const dec = h => Array.from({ length: 10 }, (_, i) => 100 * (h[2 * i] + h[2 * i + 1]) / n);
  return { n, chiC: chi(hc), chiY: chi(hy), decC: dec(hc), decY: dec(hy) };
}

const ids = [...await season(TRAIN), ...await season(TEST)];
const rows = rowsFor(ids);
console.log(`${rows.length.toLocaleString()} player-games over ${new Set(rows.map(r => r.gid)).size} games\n`);

const key = r => r.season + ":" + r.id, agg = {};
rows.forEach(r => { const a = agg[key(r)] = agg[key(r)] || { n: 0, sum: {} }; a.n++; MK.forEach(m => a.sum[m] = (a.sum[m] || 0) + (r[m] || 0)); });
Object.values(agg).forEach(a => { a.role = a.sum.passAtt >= 60 ? "QB" : (a.sum.car > (a.sum.rec || 0) * 1.2 && a.sum.car >= 30 ? "RB" : "REC"); });
const byPS = {}; rows.forEach(r => (byPS[key(r)] = byPS[key(r)] || []).push(r));

// Leave-one-out throughout: a player's own game never contributes to the mean
// it is measured against, or every player shows a spurious -1/(n-1).
function build(P) {
  const out = [];
  for (const [k, gs] of Object.entries(byPS)) {
    const a = agg[k];
    if (a.n < 8 || a.role !== P.role) continue;
    if (!(a.sum[P.cnt] / a.n >= MIN[P.cnt]) || !(a.sum[P.yds] / a.n >= MIN[P.yds])) continue;
    for (const g of gs) {
      const n1 = a.n - 1;
      const rate = (a.sum[P.cnt] - (g[P.cnt] || 0)) / n1;
      const yTot = (a.sum[P.yds] - (g[P.yds] || 0)) / n1;
      if (!(rate > 0.2 && yTot > 1)) continue;
      out.push({ c: g[P.cnt] || 0, y: g[P.yds] || 0, rate, y1: yTot / rate, season: g.season });
    }
  }
  return out;
}
console.log("PER-ROLE SHAPE   (fitted on " + TRAIN + ", scored on " + TEST + ")");
const FIT = {};
for (const P of PAIRS) {
  const arr = build(P);
  let bc = null;
  for (const cv2 of [0.01,0.02,0.03,0.05,0.07,0.10,0.14,0.18,0.24,0.30])
    for (let vd = 0; vd <= 0.20; vd += 0.02)
      for (const vdAt of [0.1,0.2,0.3,0.4,0.5,0.6,0.7]) {
        const r = pit(arr, { cv2, vd, vdAt, s2: 1, ed: 0, edAt: 1 }, P, TRAIN);
        if (!bc || r.chiC < bc.chi) bc = { cv2, vd, vdAt, chi: r.chiC };
        if (vd === 0) break;
      }
  let by = null;
  for (const s2 of [0.4,0.6,0.8,1.0,1.3,1.6,2.0,2.5,3.0])
    for (let ed = 0; ed <= 0.24; ed += 0.02)
      for (const edAt of [0.1,0.2,0.3,0.4,0.5,0.6,0.7]) {
        const r = pit(arr, { ...bc, s2, ed, edAt }, P, TRAIN);
        if (!by || r.chiY < by.chi) by = { s2, ed, edAt, chi: r.chiY };
        if (ed === 0) break;
      }
  const p = { cv2: bc.cv2, vd: bc.vd, vdAt: bc.vdAt, s2: by.s2, ed: by.ed, edAt: by.edAt };
  FIT[P.role] = { volCv: +Math.sqrt(p.cv2).toFixed(3), volDud: +p.vd.toFixed(2), volDudAt: +p.vdAt.toFixed(2),
                  effS2: +p.s2.toFixed(2), effDud: +p.ed.toFixed(2), effDudAt: +p.edAt.toFixed(2) };
  const t = pit(arr, p, P, TEST), z = pit(arr, { cv2: 0.001, vd: 0, vdAt: 1, s2: 1, ed: 0, edAt: 1 }, P, TEST);
  console.log(`\n  ${P.role}  (${P.cnt} / ${P.yds})   ${arr.length.toLocaleString()} player-games`);
  console.log(`    workload swing cv ${FIT[P.role].volCv}` +
    (p.vd > 0 ? `, collapses ${(100*p.vd).toFixed(0)}% of weeks to ${(100*p.vdAt).toFixed(0)}% of normal` : ", no collapse"));
  console.log(`    per-event yard variance ${p.s2.toFixed(2)}x mean^2` +
    (p.ed > 0 ? `, yards gone ${(100*p.ed).toFixed(0)}% of weeks at ${(100*p.edAt).toFixed(0)}%` : ""));
  // The reference is a plain Poisson count with a gamma on top and no dud —
  // the simplest thing anyone would write down. It is NOT the shape this
  // replaced in the model; that comparison is in the commit that added this
  // file (receiving yards 317 -> 38, carries 136 -> 16, rushing yards
  // 117 -> 33, passing yards 69 -> 34, all out of sample).
  console.log(`    ${TEST} chi (19 df):  count ${t.chiC.toFixed(0)}   yards ${t.chiY.toFixed(0)}   [plain Poisson+gamma reference: ${z.chiC.toFixed(0)} / ${z.chiY.toFixed(0)}]`);
  console.log(`      count deciles  ${t.decC.map(v => v.toFixed(1).padStart(5)).join("")}`);
  console.log(`      yards deciles  ${t.decY.map(v => v.toFixed(1).padStart(5)).join("")}`);
}

// ── team structure ──────────────────────────────────────────────────────────
const byGT = {};
rows.forEach(r => { const k = r.gid + ":" + r.side;
  const t = byGT[k] = byGT[k] || { gid: r.gid, season: r.season, teamId: r.teamId, pass: 0, rush: 0 };
  t.pass += r.passAtt || 0; t.rush += r.car || 0; });
const teamSeason = {};
Object.values(byGT).forEach(t => (teamSeason[t.season + ":" + t.teamId] = teamSeason[t.season + ":" + t.teamId] || []).push(t));
function dispOf(sel) {
  let n = 0, s = 0;
  Object.values(teamSeason).forEach(gs => { if (gs.length < 8) return;
    const tot = gs.reduce((a, g) => a + sel(g), 0);
    gs.forEach(g => { const m = (tot - sel(g)) / (gs.length - 1); if (!(m > 3)) return;
      n++; s += (Math.pow(sel(g) - m, 2) - m) / (m * m); });      // Var = m + m^2 cv^2
  });
  return s / n;
}
function corrOf(pickA, pickB, sameTeam) {
  const byGame = {}; Object.values(byGT).forEach(t => (byGame[t.gid] = byGame[t.gid] || []).push(t));
  const mean = {}; Object.values(teamSeason).forEach(gs => {
    mean[gs[0].season + ":" + gs[0].teamId] = { p: gs.reduce((a, g) => a + g.pass, 0), r: gs.reduce((a, g) => a + g.rush, 0), n: gs.length }; });
  const z = (t, f) => { const m = mean[t.season + ":" + t.teamId]; if (!m || m.n < 8) return null;
    const v = f === "p" ? t.pass : t.rush, mu = (m[f] - v) / (m.n - 1);
    return mu > 3 ? (v - mu) / Math.sqrt(mu + mu * mu * (f === "p" ? 0.0234 : 0.0381)) : null; };
  const X = [], Y = [];
  Object.values(byGame).forEach(g => { if (g.length !== 2) return;
    (sameTeam ? [[0,0],[1,1]] : [[0,1],[1,0]]).forEach(([i, k]) => {
      const a = z(g[i], pickA), b = z(g[k], pickB); if (a == null || b == null) return;
      if (!sameTeam && pickA === pickB && i === 1) return;        // one reading per unordered pair
      X.push(a); Y.push(b); }); });
  const n = X.length, mx = X.reduce((a, b) => a + b, 0) / n, my = Y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (X[i]-mx)*(Y[i]-my); sxx += (X[i]-mx)**2; syy += (Y[i]-my)**2; }
  return { r: sxy / Math.sqrt(sxx * syy), n };
}
const passCv2 = dispOf(g => g.pass), rushCv2 = dispOf(g => g.rush);
const pp = corrOf("p", "p", false), rr = corrOf("r", "r", false), pr = corrOf("p", "r", false), wt = corrOf("p", "r", true);
console.log("\nTEAM STRUCTURE   (all games, " + Object.values(byGT).length.toLocaleString() + " team-games)");
console.log(`  pass attempts swing        cv ${Math.sqrt(passCv2).toFixed(3)}`);
console.log(`  rush attempts swing        cv ${Math.sqrt(rushCv2).toFixed(3)}`);
console.log(`  their passes vs ours       r ${pp.r.toFixed(3)}   -> passScript ${Math.sqrt(Math.max(0,-pp.r)).toFixed(3)}`);
console.log(`  their rushes vs ours       r ${rr.r.toFixed(3)}   -> rushScript ${Math.sqrt(Math.max(0,-rr.r)).toFixed(3)}`);
console.log(`  our passes vs their rushes r ${pr.r.toFixed(3)}   (~0: the script needs two latents, not one)`);
const sp = Math.sqrt(Math.max(0, -pp.r)), sr = Math.sqrt(Math.max(0, -rr.r));
console.log(`  our passes vs our rushes   r ${wt.r.toFixed(3)}   -> withinTeam ${(wt.r / (Math.sqrt(1-sp*sp) * Math.sqrt(1-sr*sr))).toFixed(3)}`);
console.log("\nSIM_ROLE = " + JSON.stringify(FIT));
console.log("SIM_TEAM passCv/rushCv/passScript/rushScript/withinTeam = " +
  [Math.sqrt(passCv2), Math.sqrt(rushCv2), sp, sr, wt.r / (Math.sqrt(1-sp*sp)*Math.sqrt(1-sr*sr))].map(v => v.toFixed(3)).join(" / "));
console.log("\nShare-drift (tgtShareCv, carShareCv) is tuned against these by simulation —");
console.log("see the sweep in the commit that introduced this file.");
