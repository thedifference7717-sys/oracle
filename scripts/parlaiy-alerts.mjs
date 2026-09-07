// DAIly Double — Telegram alerts (GitHub Actions cron, self-looping every ~60s).
//
// 1. At lock (1h before the day's first pitch) sends the strongest two-man
//    same-game hit parlays that actually clear the price on offer.
// 2. Then tracks each double from live boxscores: a leg lands (1/2 in), the
//    double CASHES (both hitters record a hit), or it DIES (game final).
// 3. At settlement every graded leg is folded back into the calibration log
//    and published to data/model-log.json, which the dashboard reads on load.
//
// The board itself is NOT computed here — it comes from dd-model.js, the same
// file the dashboard runs, so the two can never disagree.
//
// State (dedupe + locked board + calibration) lives in state.json, carried
// between runs by the workflow's Actions cache. Requires repo secrets
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import M from "../dd-model.js";

const STATE_FILE = "state.json";
const PUBLIC_LOG = "data/model-log.json";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT) { console.log("Telegram secrets not set — skipping."); process.exit(0); }

const API = M.API;
const TOP = 3;                                   // doubles to alert
const SNAP_V = M.VERSION;                        // board schema = model version
// Price the doubles are graded against. Override with DD_PRICE (American odds)
// in the workflow to match whatever your book is actually offering.
const PRICE = +(process.env.DD_PRICE || 100);
// Only alert a double whose modelled edge over that price clears this. Set
// DD_MIN_EDGE=0 to go back to alerting the top 3 regardless.
const MIN_EDGE = +(process.env.DD_MIN_EDGE || 0.02);

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const prettyDate = d => { const [y, mo, da] = d.split("-").map(Number); return `${MONTHS[mo-1]} ${da}`; };
const pct = v => Math.round(v * 100) + "%";
const av = v => v == null ? "—" : v.toFixed(3).replace(/^0/, "");

async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.json(); }
async function tg(text) {
  await j(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
}

// Trim a scored candidate down to what the tracker and the calibration log
// need. `p` is kept because grading compares the outcome against exactly the
// number we published.
const slim = c => ({
  id: c.id, name: c.name, team: c.teamName, slot: c.slot, posted: c.posted,
  avg: c.avg, proj: c.projAvg, p: c.p, eAb: c.eAb,
  sp: c.spName, spBaa: c.spBaa, plt: c.plt
});

async function computeDoubles(day, games, cal) {
  const board = await M.buildBoard({
    getJSON: j, day, cal, american: PRICE,
    schedule: { dates: [{ games }] },
    onStatus: m => console.log("  ·", m)
  });
  if (!board.pairs.length) return null;
  return {
    date: day, v: SNAP_V, price: PRICE,
    doubles: board.pairs.map(d => ({
      a: slim(d.a), b: slim(d.b), prob: d.prob, naive: d.naive, lift: d.lift,
      rho: d.rho, sameTeam: d.sameTeam, edge: d.ev ? d.ev.edge : 0,
      evPct: d.ev ? d.ev.evPct : 0, kelly: d.ev ? d.ev.quarterKelly : 0,
      gk: d.gk, venue: d.venue, teams: d.teams, bothPosted: d.bothPosted
    }))
  };
}

async function main() {
  const day = M.slateYmd();
  const sched = await j(`${API}/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team,venue,lineups`);
  const games = (sched?.dates?.[0]?.games || []).filter(g => !/postpon|suspend|cancel/i.test(g.status?.detailedState || ""));
  if (!games.length) { console.log(`No MLB games ${day}.`); return; }
  const starts = games.map(g => Date.parse(g.gameDate)).filter(t => !isNaN(t));
  const lockAt = Math.min(...starts) - 3600000;
  if (Date.now() < lockAt) { console.log(`Pre-lock (locks ${new Date(lockAt).toISOString()}).`); return; }

  let blob = {};
  try { if (existsSync(STATE_FILE)) blob = JSON.parse(readFileSync(STATE_FILE, "utf8")) || {}; } catch (e) { console.log("State read failed:", e.message); }
  const D = blob.dd = blob.dd || {};
  D.results = D.results || {};
  D.record = D.record || { w: 0, l: 0 };
  // The calibration log. Because the eligible pool barely turns over, a
  // per-player residual accumulates real signal across a season.
  D.cal = D.cal || { v: SNAP_V, legs: {}, global: { n: 0, hits: 0, sump: 0 } };
  if (D.cal.v !== SNAP_V) { console.log("Model version changed — resetting calibration."); D.cal = { v: SNAP_V, legs: {}, global: { n: 0, hits: 0, sump: 0 } }; }
  let changed = false;

  let snap = (D.snap && D.snap.date === day && D.snap.v === SNAP_V && D.snap.doubles?.length) ? D.snap : null;
  if (!snap) {
    console.log("Computing doubles…");
    snap = await computeDoubles(day, games, D.cal);
    if (snap) { D.snap = snap; changed = true; }
  }
  if (!snap) { console.log("Could not produce doubles."); return; }

  // Alert only what clears the price. A double we would not bet is not a pick.
  let picks = snap.doubles.filter(d => d.edge >= MIN_EDGE).slice(0, TOP);
  if (!picks.length) picks = snap.doubles.slice(0, TOP);   // still track the best available

  // ── Lock alert (once) ──
  if (D.lockDate !== day) {
    const legLine = c => `   • <b>${c.name}</b> #${c.slot}${c.posted ? " ✓LU" : ""} · ${av(c.avg)}→${av(c.proj)} proj · ${c.eAb.toFixed(1)} AB\n     vs ${c.sp || "SP TBD"}${c.spBaa != null ? " (" + av(c.spBaa) + ")" : ""}${c.plt === "adv" ? " ▲plat" : c.plt === "dis" ? " ▽plat" : ""} · <b>${pct(c.p)}</b>`;
    const body = picks.map((d, i) =>
      `<b>#${i + 1}</b> · ${pct(d.prob)} both hit · fair ${M.amOdds(d.prob)} vs your ${PRICE > 0 ? "+" : ""}${PRICE}\n` +
      `   <b>EDGE ${(d.edge * 100 >= 0 ? "+" : "") + (d.edge * 100).toFixed(1)}pts · EV ${(d.evPct >= 0 ? "+" : "") + d.evPct.toFixed(1)}% · stake ${(d.kelly * 100).toFixed(1)}% bank</b>\n` +
      `   ${d.teams}${d.sameTeam ? " · SAME TEAM" : ""} · correlation +${(d.lift * 100).toFixed(1)}pts over naive\n${legLine(d.a)}\n${legLine(d.b)}`
    ).join("\n\n");
    const anyEdge = picks.some(d => d.edge >= MIN_EDGE);
    await tg(`🎲 <b>DAILY DOUBLE LOCKED</b> · ${prettyDate(day)}\n` +
      `${picks.length} two-man same-game hit parlays · priced vs ${PRICE > 0 ? "+" : ""}${PRICE}\n` +
      (anyEdge ? "" : `⚠️ <i>None clear the ${(MIN_EDGE * 100).toFixed(1)}pt edge bar — shown for tracking only.</i>\n`) +
      `➖➖➖➖➖➖➖➖\n${body}`);
    D.lockDate = day; D.results = {}; changed = true;
    console.log("Lock alert sent.");
  }

  // ── Live tracking (boxscores) ──
  const gks = [...new Set(picks.map(d => d.gk))];
  const fin = {};
  games.forEach(g => { if (gks.includes(g.gamePk)) fin[g.gamePk] = g.status?.abstractGameState === "Final" && !/postpon|suspend|cancel/i.test(g.status?.detailedState || ""); });
  const hitsById = {};
  await M.pool(gks.filter(pk => { const g = games.find(x => x.gamePk === pk); return g && g.status?.abstractGameState !== "Preview"; }), async pk => {
    const b = await j(`${API}/game/${pk}/boxscore`);
    ["home", "away"].forEach(side => {
      const pl = b?.teams?.[side]?.players || {};
      Object.values(pl).forEach(pp => { const st = pp?.stats?.batting; if (st && pp.person?.id != null) hitsById[pp.person.id] = +st.hits || 0; });
    });
  }, 5);

  let cashed = Object.values(D.results).filter(r => r.cashed).length;
  let dead = Object.values(D.results).filter(r => r.dead).length;
  const tally = () => `Today: 💣 ${cashed} · 💀 ${dead} of ${picks.length}  ·  All-time ${D.record.w}-${D.record.l}`;

  // Fold a leg into the calibration log exactly once, whatever happens to the
  // double it sat in. Graded on the final boxscore only.
  const gradeLeg = (leg, gotHit) => {
    const seen = D.cal.graded = D.cal.graded || {};
    const key = `${day}:${leg.id}`;
    if (seen[key]) return;
    seen[key] = 1;
    M.record(D.cal, leg.id, leg.p, gotHit);
    changed = true;
  };

  for (let i = 0; i < picks.length; i++) {
    const d = picks[i]; const key = `${d.a.id}_${d.b.id}`; const st = D.results[key] = D.results[key] || {};
    if (st.cashed || st.dead) continue;
    const hA = (hitsById[d.a.id] || 0) >= 1, hB = (hitsById[d.b.id] || 0) >= 1;
    const inCount = (hA ? 1 : 0) + (hB ? 1 : 0);
    const final = !!fin[d.gk];
    if (inCount === 2) {
      cashed++; D.record.w++;
      gradeLeg(d.a, true); gradeLeg(d.b, true);
      await tg(`💣 <b>CASHED — Double #${i + 1}</b>\nBoth hit! ${d.a.name} + ${d.b.name}\n${tally()}`);
      st.cashed = true; changed = true; console.log(`Double #${i + 1} cashed.`);
    } else if (final) {
      dead++; D.record.l++;
      gradeLeg(d.a, hA); gradeLeg(d.b, hB);
      const cold = [!hA ? d.a.name : null, !hB ? d.b.name : null].filter(Boolean).join(" & ");
      await tg(`💀 <b>DEAD — Double #${i + 1}</b>\nHitless: ${cold} (final)\n${tally()}`);
      st.dead = true; changed = true; console.log(`Double #${i + 1} dead.`);
    } else if (inCount === 1 && !st.half) {
      const got = hA ? d.a.name : d.b.name, need = hA ? d.b.name : d.a.name;
      await tg(`✅ <b>1/2 IN — Double #${i + 1}</b>\n${got} has a hit · need ${need}`);
      st.half = true; changed = true; console.log(`Double #${i + 1} half.`);
    }
  }

  // ── Day-end summary + publish calibration (once) ──
  const allSettled = picks.every(d => { const st = D.results[`${d.a.id}_${d.b.id}`]; return st && (st.cashed || st.dead); });
  if (allSettled && D.summaryDate !== day) {
    const wonToday = picks.filter(d => D.results[`${d.a.id}_${d.b.id}`].cashed).length;
    const n = D.record.w + D.record.l;
    const pctW = n ? Math.round(D.record.w / n * 100) : 0;
    const g = D.cal.global;
    const calLine = g.n > 0
      ? `\nModel calibration: predicted <b>${pct(g.sump / g.n)}</b> per leg, actual <b>${pct(g.hits / g.n)}</b> over ${g.n} graded legs`
      : "";
    await tg(`📊 <b>DAY DONE</b> · ${prettyDate(day)}\nToday: <b>${wonToday}/${picks.length}</b> doubles cashed\nAll-time record: <b>${D.record.w}-${D.record.l}</b> (${pctW}%)${calLine}`);
    D.summaryDate = day; changed = true; console.log("Day summary sent.");

    // Publish the calibration log for the dashboard. Keep it small: drop the
    // per-day dedupe keys, which are state, not signal.
    try {
      mkdirSync("data", { recursive: true });
      const pub = { v: D.cal.v, updated: new Date().toISOString(), through: day, record: D.record, global: g, legs: D.cal.legs };
      writeFileSync(PUBLIC_LOG, JSON.stringify(pub));
      D.publishedDate = day;
      console.log(`Published ${PUBLIC_LOG} (${Object.keys(D.cal.legs).length} players).`);
    } catch (e) { console.log("Publish failed:", e.message); }
  }

  try { writeFileSync(STATE_FILE, JSON.stringify(blob)); } catch (e) { console.log("State write failed:", e.message); }
  console.log(`Done — 💣 ${cashed} / 💀 ${dead} of ${picks.length}.${changed ? " [state updated]" : ""}`);
}

main().catch(e => { console.error(e); process.exit(1); });
