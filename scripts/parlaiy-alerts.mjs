// ParlAIy Telegram alerts — runs from GitHub Actions cron every ~5 minutes.
//
// 1. Once the board locks (1h before first pitch), sends the day's 7 picks.
// 2. Sends a message the moment any pick clears Over 2.5 combined H+R+RBI.
//
// Uses the same shared jsonblob store as the dashboard: reads the locked list
// published by whichever device built it, and if none did, computes the list
// itself with the identical deterministic math and publishes it for the
// dashboard to restore. Alert dedupe state also lives in the blob.
//
// Requires repo secrets TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; exits
// quietly if they are not configured.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT) {
  console.log("Telegram secrets not set — skipping (add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID repo secrets).");
  process.exit(0);
}

const API = "https://statsapi.mlb.com/api/v1";
const STORE = "https://jsonblob.com/api/jsonBlob/019ebce8-d3e5-70a0-a72f-8e991113b4bc";
const RR_N = 7, RR_LINE = 3, RR_DEF_ODDS = 130;

const PARK = {"Coors Field":110,"Fenway Park":108,"Great American Ball Park":104,"Globe Life Field":103,"Chase Field":103,"Wrigley Field":102,"Yankee Stadium":102,"Citizens Bank Park":102,"Oriole Park at Camden Yards":101,"Rogers Centre":101,"American Family Field":101,"Truist Park":101,"Kauffman Stadium":101,"Daikin Park":100,"Minute Maid Park":100,"Nationals Park":100,"Dodger Stadium":100,"Angel Stadium":100,"Busch Stadium":99,"Target Field":99,"Progressive Field":99,"Rate Field":99,"PNC Park":99,"Comerica Park":99,"Citi Field":98,"Petco Park":97,"loanDepot park":96,"T-Mobile Park":96,"Oracle Park":95,"Sutter Health Park":100,"George M. Steinbrenner Field":101};
const park = n => { if (!n) return 100; if (PARK[n] != null) return PARK[n]; const k = Object.keys(PARK).find(k => n.includes(k) || k.includes(n)); return k ? PARK[k] : 100; };

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
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

// One pick per game, highest score first — identical to the dashboard.
function topPicks(list) {
  const seen = new Set();
  return list.filter(p => { const gk = (p.g2 && p.g2.gameKey != null) ? p.g2.gameKey : ("t" + p.teamId); if (seen.has(gk)) return false; seen.add(gk); return true; }).slice(0, RR_N);
}

// Deterministic list build — a Node port of the dashboard's load(): 14-day
// window ending yesterday, SP BAA through yesterday, same filters and score.
async function computeList(endStr, games) {
  const base = new Date(endStr + "T00:00:00");
  const rEnd = new Date(base); rEnd.setDate(rEnd.getDate() - 1);
  const start = new Date(base); start.setDate(start.getDate() - 14);
  const rankEndStr = ymd(rEnd), startStr = ymd(start), season = base.getFullYear();

  const byTeam = {};
  games.forEach(g => {
    const v = g.venue?.name, h = g.teams.home, a = g.teams.away, gk = g.gamePk;
    byTeam[h.team.id] = { opp: a.team?.abbreviation || a.team?.name, isHome: true, venue: v, sp: a.probablePitcher?.fullName, spId: a.probablePitcher?.id, gameKey: gk };
    byTeam[a.team.id] = { opp: h.team?.abbreviation || h.team?.name, isHome: false, venue: v, sp: h.probablePitcher?.fullName, spId: h.probablePitcher?.id, gameKey: gk };
  });

  const tids = Object.keys(byTeam); const active = new Set(), rostered = new Set();
  await pool(tids, async tid => { const d = await j(`${API}/teams/${tid}/roster?rosterType=active`); if (d?.roster) { rostered.add(String(tid)); d.roster.forEach(p => active.add(p.person.id)); } }, 6);

  const hd = await j(`${API}/stats?stats=byDateRange&group=hitting&startDate=${startStr}&endDate=${rankEndStr}&sportId=1&limit=2000&gameType=R&playerPool=All`);
  const all = (hd?.stats?.[0]?.splits || []).map(s => ({
    id: s.player?.id, name: s.player?.fullName, teamId: s.team?.id, team: s.team?.name, pos: s.position?.abbreviation,
    avg: parseFloat(s.stat?.avg) || 0, hr: +s.stat?.homeRuns || 0, rbi: +s.stat?.rbi || 0, runs: +s.stat?.runs || 0,
    hits: +s.stat?.hits || 0, ab: +s.stat?.atBats || 0
  }));
  const pool0 = all.filter(p => p.ab >= 25 && p.avg >= 0.300 && byTeam[p.teamId] && (!rostered.has(String(p.teamId)) || active.has(p.id)));
  if (!pool0.length) return null;

  const nrm = (arr, key) => { const v = arr.map(x => x[key]), mn = Math.min(...v), mx = Math.max(...v); return x => mx > mn ? (x[key] - mn) / (mx - mn) : 0; };
  let na = nrm(pool0, "avg"), nh = nrm(pool0, "hr"), nr = nrm(pool0, "rbi"), nru = nrm(pool0, "runs");
  pool0.forEach(p => { p.pre = na(p) + nh(p) + nr(p) + nru(p); });
  pool0.sort((a, b) => b.pre - a.pre);
  let cand = pool0.slice(0, 40);

  const logs = await pool(cand, async p => {
    const d = await j(`${API}/people/${p.id}/stats?stats=gameLog&group=hitting&season=${season}&gameType=R`);
    return (d?.stats?.[0]?.splits || []).filter(x => x.stat && x.date && x.date >= startStr && x.date <= rankEndStr);
  }, 6);
  cand.forEach((p, i) => { let hot = 0; (logs[i] || []).forEach(gm => { const c = (+gm.stat.hits || 0) + (+gm.stat.runs || 0) + (+gm.stat.rbi || 0); if (c >= RR_LINE) hot++; }); p.hotG = hot; });

  cand.forEach(p => { p.g2 = byTeam[p.teamId]; p.park = park(p.g2.venue); });
  const spIds = [...new Set(cand.map(p => p.g2.spId).filter(Boolean))]; const baaMap = {};
  await pool(spIds, async pid => {
    const d = await j(`${API}/people/${pid}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R`);
    const gsp = (d?.stats?.[0]?.splits || []).filter(x => x.stat && x.date && x.date <= rankEndStr);
    let hits = 0, ab = 0; gsp.forEach(x => { hits += (+x.stat.hits || 0); ab += (+x.stat.atBats || 0); });
    let rh = 0, rab = 0; gsp.slice(-3).forEach(x => { rh += (+x.stat.hits || 0); rab += (+x.stat.atBats || 0); });
    const rec = rab >= 15 ? rh / rab : null;
    if (ab >= 30) { baaMap[pid] = { s: hits / ab, r: rec }; return; }
    const d2 = await j(`${API}/people/${pid}/stats?stats=season&group=pitching&season=${season}&gameType=R`);
    const st = d2?.stats?.[0]?.splits?.[0]?.stat; if (st && st.avg != null) baaMap[pid] = { s: parseFloat(st.avg), r: rec };
  }, 6);
  cand.forEach(p => { const bm = p.g2.spId != null ? baaMap[p.g2.spId] : null; p.baa = bm ? bm.s : null; p.rbaa = bm && bm.r != null ? bm.r : null; });

  cand = cand.filter(p => p.hotG >= 4 && !(p.baa != null && p.baa <= 0.215) && !(p.rbaa != null && p.rbaa <= 0.200));
  if (!cand.length) return null;

  na = nrm(cand, "avg"); nh = nrm(cand, "hr"); nr = nrm(cand, "rbi"); nru = nrm(cand, "runs"); const ng = nrm(cand, "hotG");
  cand.forEach(p => { p.effBaa = p.baa != null ? (p.rbaa != null ? 0.6 * p.baa + 0.4 * p.rbaa : p.baa) : null; });
  const bArr = cand.map(p => p.effBaa).filter(v => v != null); const bMin = bArr.length ? Math.min(...bArr) : 0.22, bMax = bArr.length ? Math.max(...bArr) : 0.28;
  const pArr = cand.map(p => p.park); const pkMin = Math.min(...pArr), pkMax = Math.max(...pArr);
  cand.forEach(p => {
    const hot = 0.35 * ng(p) + 0.25 * na(p) + 0.15 * nh(p) + 0.125 * nr(p) + 0.125 * nru(p);
    const nb = (p.effBaa != null && bMax > bMin) ? (p.effBaa - bMin) / (bMax - bMin) : 0.5;
    const npk = pkMax > pkMin ? (p.park - pkMin) / (pkMax - pkMin) : 0.5; const mu = 0.7 * nb + 0.3 * npk;
    p.hotN = Math.round(hot * 100); p.muN = Math.round(mu * 100); p.score = Math.round((0.5 * hot + 0.5 * mu) * 100);
  });
  cand.sort((a, b) => b.score - a.score);
  return { date: endStr, list: cand.map(p => ({ id: p.id, name: p.name, team: p.team, teamId: p.teamId, pos: p.pos, avg: p.avg, hr: p.hr, rbi: p.rbi, runs: p.runs, hotG: p.hotG, g2: p.g2, park: p.park, baa: p.baa, rbaa: p.rbaa, hotN: p.hotN, muN: p.muN, score: p.score })) };
}

async function main() {
  const day = slateYmd();
  const sched = await j(`${API}/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team,venue`);
  const games = sched?.dates?.[0]?.games || [];
  if (!games.length) { console.log(`No MLB games ${day}.`); return; }
  const starts = games.map(g => Date.parse(g.gameDate)).filter(t => !isNaN(t));
  const lockAt = Math.min(...starts) - 3600000;
  if (Date.now() < lockAt) { console.log(`Pre-lock (locks ${new Date(lockAt).toISOString()}) — nothing to do.`); return; }

  let blob = {};
  try { blob = await j(STORE) || {}; } catch (e) { console.log("Store read failed:", e.message); }
  const P = blob.parlaiy = blob.parlaiy || {};
  P.alerts = P.alerts || {};
  let changed = false;

  let snap = (P.snap && P.snap.date === day && P.snap.list?.length) ? P.snap : null;
  if (!snap) {
    console.log("No published list — computing deterministically…");
    snap = await computeList(day, games);
    if (snap) { P.snap = snap; changed = true; }
  }
  if (!snap) { console.log("Could not produce a list."); return; }
  const picks = topPicks(snap.list);

  // ── Lock alert (once per day) ──
  if (P.alerts.lockDate !== day) {
    const rr = P.rr || {}; const stake = (rr.days || []).find(x => x.date === day)?.stake ?? rr.stake ?? 1;
    const odds = rr.odds || RR_DEF_ODDS;
    const lines = picks.map((p, i) =>
      `${i + 1}. <b>${p.name}</b> (${p.team || ""}) ${p.g2.isHome ? "vs" : "@"} ${p.g2.opp || "TBD"} — ${p.g2.sp || "SP TBD"}${p.baa != null ? " · BAA " + p.baa.toFixed(3).replace(/^0/, "") : ""} · SCORE ${p.score}`).join("\n");
    const combos = picks.length * (picks.length - 1) / 2;
    await tg(`🔒 <b>ParlAIy LOCKED — ${day}</b>\nOver 2.5 H+R+RBI · round robin ${picks.length} picks / ${combos} doubles\nStake $${(+stake).toFixed(2)} per double · outlay $${(combos * stake).toFixed(2)} · legs ${odds > 0 ? "+" : ""}${odds}\n\n${lines}`);
    P.alerts.lockDate = day; P.alerts.hits = {}; P.alerts.deads = {}; changed = true;
    console.log("Lock alert sent.");
  }

  // ── Hit alerts (each pick, once) ──
  const wanted = new Set(picks.map(p => p.g2?.gameKey).filter(v => v != null));
  const startedPks = games.filter(g => wanted.has(g.gamePk) && g.status?.abstractGameState !== "Preview").map(g => g.gamePk);
  const m = {};
  await pool(startedPks, async pk => {
    const b = await j(`${API}/game/${pk}/boxscore`);
    ["home", "away"].forEach(side => {
      const pl = b?.teams?.[side]?.players || {};
      Object.values(pl).forEach(pp => {
        const st = pp?.stats?.batting;
        if (st && pp.person?.id != null && ((+st.gamesPlayed || 0) > 0 || (+st.plateAppearances || 0) > 0 || (+st.runs || 0) > 0))
          m[pp.person.id] = { c: (+st.hits || 0) + (+st.runs || 0) + (+st.rbi || 0), h: +st.hits || 0, r: +st.runs || 0, rbi: +st.rbi || 0 };
      });
    });
  }, 5);
  P.alerts.hits = P.alerts.hits || {};
  P.alerts.deads = P.alerts.deads || {};
  let cashed = Object.keys(P.alerts.hits).length;
  let dead = Object.keys(P.alerts.deads).length;
  for (const p of picks) {
    const s = m[p.id];
    if (s && s.c >= RR_LINE && !P.alerts.hits[p.id]) {
      cashed++;
      await tg(`💣 <b>LEG CASHED — ${p.name}</b>\n${s.h} H · ${s.r} R · ${s.rbi} RBI (${s.c}/${RR_LINE})\n💣 ${cashed} cashed · 💀 ${dead} dead of ${picks.length}`);
      P.alerts.hits[p.id] = s.c; changed = true;
      console.log(`Hit alert sent: ${p.name} (${s.c}).`);
    } else if (fin[p.teamId] && !(s && s.c >= RR_LINE) && !P.alerts.hits[p.id] && !P.alerts.deads[p.id]) {
      // game over without clearing (or never played)
      dead++;
      const line = s ? `${s.h} H · ${s.r} R · ${s.rbi} RBI (${s.c}/${RR_LINE})` : "DNP — never entered the game";
      await tg(`💀 <b>LEG DEAD — ${p.name}</b>\n${line}\n💣 ${cashed} cashed · 💀 ${dead} dead of ${picks.length}`);
      P.alerts.deads[p.id] = true; changed = true;
      console.log(`Dead alert sent: ${p.name}.`);
    }
  }

  if (changed) {
    try { await j(STORE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(blob) }); }
    catch (e) { console.log("Store write failed:", e.message); }
  }
  console.log(`Done — ${cashed} cashed / ${dead} dead of ${picks.length}, ${startedPks.length} games started.`);
}

main().catch(e => { console.error(e); process.exit(1); });
