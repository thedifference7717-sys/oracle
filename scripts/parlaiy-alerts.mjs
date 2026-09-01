// DAIly Double — Telegram alerts (GitHub Actions cron, self-looping every ~60s).
//
// 1. At lock (1h before the day's first pitch) sends the 3 strongest two-man
//    same-game hit parlays, once.
// 2. Then tracks each double from live boxscores: a leg lands (1/2 in), the
//    double CASHES (both hitters record a hit), or it DIES (game final, not both).
//
// State (dedupe + locked board) lives in state.json, carried between runs by the
// workflow's Actions cache. Requires repo secrets TELEGRAM_BOT_TOKEN / _CHAT_ID.

import { readFileSync, writeFileSync, existsSync } from "fs";
const STATE_FILE = "state.json";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT) { console.log("Telegram secrets not set — skipping."); process.exit(0); }

const API = "https://statsapi.mlb.com/api/v1";
const TOP = 3;          // number of doubles to alert
const SNAP_V = 1;       // board schema version
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const prettyDate = d => { const [y, mo, da] = d.split("-").map(Number); return `${MONTHS[mo-1]} ${da}`; };

const PARK = {"Coors Field":112,"Fenway Park":107,"Great American Ball Park":102,"Globe Life Field":101,"Chase Field":103,"Wrigley Field":101,"Yankee Stadium":101,"Citizens Bank Park":101,"Oriole Park at Camden Yards":100,"Rogers Centre":101,"American Family Field":100,"Truist Park":100,"Kauffman Stadium":103,"Daikin Park":100,"Minute Maid Park":100,"Nationals Park":100,"Dodger Stadium":99,"Angel Stadium":100,"Busch Stadium":99,"Target Field":99,"Progressive Field":99,"Rate Field":100,"PNC Park":100,"Comerica Park":101,"Citi Field":98,"Petco Park":97,"loanDepot park":98,"T-Mobile Park":96,"Oracle Park":98,"Sutter Health Park":101,"George M. Steinbrenner Field":100};
const park = n => { if (!n) return 100; if (PARK[n] != null) return PARK[n]; const k = Object.keys(PARK).find(k => n.includes(k) || k.includes(n)); return k ? PARK[k] : 100; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function platoon(bat, pit) { if (!bat || !pit) return null; if (bat === "S") return "adv"; return bat !== pit ? "adv" : "dis"; }
function amOdds(p) { if (!(p > 0 && p < 1)) return "—"; const dec = 1 / p; return dec >= 2 ? "+" + Math.round((dec - 1) * 100) : "-" + Math.round(100 / (dec - 1)); }
function hitProb(seasonAVG, recentAVG, rab, spBAA, kRate, plt, pk) {
  const own = rab >= 15 ? 0.55 * seasonAVG + 0.45 * recentAVG : seasonAVG;
  const pit = spBAA != null ? spBAA : 0.250;
  let x = 0.62 * own + 0.38 * pit;
  if (kRate != null) x *= clamp(1 + (0.22 - kRate) * 0.6, 0.90, 1.10);
  if (plt === "adv") x *= 1.05; else if (plt === "dis") x *= 0.96;
  x *= (0.99 + (pk - 100) / 100 * 0.2);
  x = clamp(x, 0.15, 0.44);
  return 1 - Math.pow(1 - x, 3.9);
}

async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.json(); }
async function pool(items, fn, size) {
  const out = new Array(items.length); let i = 0;
  const w = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } } };
  await Promise.all(Array.from({ length: Math.min(size, items.length || 1) }, w));
  return out;
}
function etNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); }
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function slateYmd() { const d = etNow(); d.setHours(d.getHours() - 6); return ymd(d); }
async function tg(text) {
  await j(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
}

// Deterministic build of the day's doubles — Node port of the dashboard's load().
async function computeDoubles(day, games) {
  const season = +day.slice(0, 4);
  const rEnd = etNow(); rEnd.setDate(rEnd.getDate() - 1); const rStart = etNow(); rStart.setDate(rStart.getDate() - 14);
  const rEndStr = ymd(rEnd), rStartStr = ymd(rStart);

  const G = games.map(g => ({
    pk: g.gamePk, venue: g.venue?.name, park: park(g.venue?.name),
    home: { id: g.teams.home.team.id, name: g.teams.home.team.abbreviation || g.teams.home.team.name, sp: g.teams.away.probablePitcher },
    away: { id: g.teams.away.team.id, name: g.teams.away.team.abbreviation || g.teams.away.team.name, sp: g.teams.home.probablePitcher }
  }));
  const teamIds = [...new Set(G.flatMap(g => [g.home.id, g.away.id]))];
  const rosterByTeam = {};
  await pool(teamIds, async tid => { const d = await j(`${API}/teams/${tid}/roster?rosterType=active`); rosterByTeam[tid] = (d?.roster || []).filter(p => p.position?.type !== "Pitcher").map(p => ({ id: p.person.id, name: p.person.fullName, pos: p.position?.abbreviation })); }, 6);

  const [seasonD, recentD] = await Promise.all([
    j(`${API}/stats?stats=season&group=hitting&season=${season}&sportId=1&limit=3000&gameType=R&playerPool=All`),
    j(`${API}/stats?stats=byDateRange&group=hitting&startDate=${rStartStr}&endDate=${rEndStr}&sportId=1&limit=3000&gameType=R&playerPool=All`)
  ]);
  const seasonById = {}, recentById = {};
  (seasonD?.stats?.[0]?.splits || []).forEach(s => { if (s.player?.id != null) seasonById[s.player.id] = { avg: parseFloat(s.stat?.avg) || 0, ab: +s.stat?.atBats || 0, k: +s.stat?.strikeOuts || 0, pa: +s.stat?.plateAppearances || 0 }; });
  (recentD?.stats?.[0]?.splits || []).forEach(s => { if (s.player?.id != null) recentById[s.player.id] = { ravg: parseFloat(s.stat?.avg) || 0, rab: +s.stat?.atBats || 0 }; });

  const cand = [];
  G.forEach(g => {
    [[g.home, g.away], [g.away, g.home]].forEach(([team]) => {
      (rosterByTeam[team.id] || []).forEach(pl => {
        const ss = seasonById[pl.id]; if (!ss) return;
        if (ss.ab < 120 || ss.avg < 0.250) return;
        const rr = recentById[pl.id] || { ravg: ss.avg, rab: 0 };
        cand.push({ id: pl.id, name: pl.name, pos: pl.pos, teamName: team.name, opp: (team === g.home ? g.away : g.home).name, oppSP: team.sp, gk: g.pk, park: g.park, venue: g.venue, avg: ss.avg, krate: ss.pa > 0 ? ss.k / ss.pa : null, ravg: rr.ravg, rab: rr.rab });
      });
    });
  });
  if (!cand.length) return null;

  const spIds = [...new Set(cand.map(c => c.oppSP?.id).filter(Boolean))]; const baaMap = {}, handMap = {};
  await pool(spIds, async pid => { const d = await j(`${API}/people/${pid}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R`); let h = 0, ab = 0; (d?.stats?.[0]?.splits || []).forEach(x => { if (x.stat && x.date && x.date <= rEndStr) { h += (+x.stat.hits || 0); ab += (+x.stat.atBats || 0); } }); baaMap[pid] = ab >= 40 ? h / ab : null; }, 6);
  const ids = [...new Set([...cand.map(c => c.id), ...spIds])];
  for (let i = 0; i < ids.length; i += 40) { try { const d = await j(`${API}/people?personIds=${ids.slice(i, i + 40).join(",")}`); (d.people || []).forEach(p => handMap[p.id] = { bat: p.batSide?.code, pit: p.pitchHand?.code }); } catch (e) {} }

  cand.forEach(c => { const spid = c.oppSP?.id; c.baa = spid != null ? baaMap[spid] : null; const plt = platoon(handMap[c.id]?.bat, spid != null ? handMap[spid]?.pit : null); c.p = hitProb(c.avg, c.ravg, c.rab, c.baa, c.krate, plt, c.park); });

  const byGame = {}; cand.forEach(c => { (byGame[c.gk] = byGame[c.gk] || []).push(c); });
  const slim = c => ({ id: c.id, name: c.name, team: c.teamName, avg: c.avg, ravg: c.ravg, baa: c.baa, p: c.p, sp: c.oppSP?.fullName || null });
  let doubles = Object.values(byGame).map(list => { list.sort((a, b) => b.p - a.p); if (list.length < 2) return null; const a = list[0], b = list[1]; return { a: slim(a), b: slim(b), prob: a.p * b.p, gk: a.gk, venue: a.venue, teams: `${a.teamName} vs ${a.opp}` }; }).filter(Boolean);
  doubles.sort((x, y) => y.prob - x.prob);
  return { date: day, v: SNAP_V, doubles };
}

async function main() {
  const day = slateYmd();
  const sched = await j(`${API}/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team,venue`);
  const games = (sched?.dates?.[0]?.games || []).filter(g => !/postpon|suspend|cancel/i.test(g.status?.detailedState || ""));
  if (!games.length) { console.log(`No MLB games ${day}.`); return; }
  const starts = games.map(g => Date.parse(g.gameDate)).filter(t => !isNaN(t));
  const lockAt = Math.min(...starts) - 3600000;
  if (Date.now() < lockAt) { console.log(`Pre-lock (locks ${new Date(lockAt).toISOString()}).`); return; }

  let blob = {};
  try { if (existsSync(STATE_FILE)) blob = JSON.parse(readFileSync(STATE_FILE, "utf8")) || {}; } catch (e) { console.log("State read failed:", e.message); }
  const D = blob.dd = blob.dd || {};
  D.results = D.results || {};
  let changed = false;

  let snap = (D.snap && D.snap.date === day && D.snap.v === SNAP_V && D.snap.doubles?.length) ? D.snap : null;
  if (!snap) { console.log("Computing doubles…"); snap = await computeDoubles(day, games); if (snap) { D.snap = snap; changed = true; } }
  if (!snap) { console.log("Could not produce doubles."); return; }
  const picks = snap.doubles.slice(0, TOP);

  // ── Lock alert (once) ──
  if (D.lockDate !== day) {
    const body = picks.map((d, i) => {
      const legLine = c => `   • <b>${c.name}</b> ${c.avg.toFixed(3).replace(/^0/, "")} — vs ${c.sp || "SP TBD"}${c.baa != null ? " (" + c.baa.toFixed(3).replace(/^0/, "") + ")" : ""} · ${Math.round(c.p * 100)}%`;
      return `<b>#${i + 1}</b> · STRENGTH ${Math.round(d.prob * 100)} · ≈ ${amOdds(d.prob)}\n   ${d.teams}\n${legLine(d.a)}\n${legLine(d.b)}`;
    }).join("\n\n");
    await tg(`🎲 <b>DAILY DOUBLE LOCKED</b> · ${prettyDate(day)}\n${TOP} two-man same-game hit parlays\n➖➖➖➖➖➖➖➖\n${body}`);
    D.lockDate = day; D.results = {}; changed = true;
    console.log("Lock alert sent.");
  }

  // ── Live tracking (boxscores) ──
  const gks = [...new Set(picks.map(d => d.gk))];
  const fin = {};
  games.forEach(g => { if (gks.includes(g.gamePk)) fin[g.gamePk] = g.status?.abstractGameState === "Final" && !/postpon|suspend|cancel/i.test(g.status?.detailedState || ""); });
  const hitsById = {};
  await pool(gks.filter(pk => { const g = games.find(x => x.gamePk === pk); return g && g.status?.abstractGameState !== "Preview"; }), async pk => {
    const b = await j(`${API}/game/${pk}/boxscore`);
    ["home", "away"].forEach(side => { const pl = b?.teams?.[side]?.players || {}; Object.values(pl).forEach(pp => { const st = pp?.stats?.batting; if (st && pp.person?.id != null) hitsById[pp.person.id] = +st.hits || 0; }); });
  }, 5);

  let cashed = Object.values(D.results).filter(r => r.cashed).length;
  let dead = Object.values(D.results).filter(r => r.dead).length;
  const tally = () => `Doubles: 💣 ${cashed} · 💀 ${dead} of ${picks.length}`;
  for (let i = 0; i < picks.length; i++) {
    const d = picks[i]; const key = `${d.a.id}_${d.b.id}`; const st = D.results[key] = D.results[key] || {};
    if (st.cashed || st.dead) continue;
    const hA = (hitsById[d.a.id] || 0) >= 1, hB = (hitsById[d.b.id] || 0) >= 1;
    const inCount = (hA ? 1 : 0) + (hB ? 1 : 0);
    const final = !!fin[d.gk];
    if (inCount === 2) {
      cashed++;
      await tg(`💣 <b>CASHED — Double #${i + 1}</b>\nBoth hit! ${d.a.name} + ${d.b.name}\n${tally()}`);
      st.cashed = true; changed = true; console.log(`Double #${i + 1} cashed.`);
    } else if (final) {
      dead++;
      const cold = [!hA ? d.a.name : null, !hB ? d.b.name : null].filter(Boolean).join(" & ");
      await tg(`💀 <b>DEAD — Double #${i + 1}</b>\nHitless: ${cold} (final)\n${tally()}`);
      st.dead = true; changed = true; console.log(`Double #${i + 1} dead.`);
    } else if (inCount === 1 && !st.half) {
      const got = hA ? d.a.name : d.b.name, need = hA ? d.b.name : d.a.name;
      await tg(`✅ <b>1/2 IN — Double #${i + 1}</b>\n${got} has a hit · need ${need}`);
      st.half = true; changed = true; console.log(`Double #${i + 1} half.`);
    }
  }

  try { writeFileSync(STATE_FILE, JSON.stringify(blob)); } catch (e) { console.log("State write failed:", e.message); }
  console.log(`Done — 💣 ${cashed} / 💀 ${dead} of ${picks.length}.${changed ? " [state updated]" : ""}`);
}

main().catch(e => { console.error(e); process.exit(1); });
