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
const TOP = 5;                                   // doubles to alert
const SNAP_V = M.VERSION;                        // board schema = model version
// Price the doubles are graded against. Override with DD_PRICE (American odds)
// in the workflow to match whatever your book is actually offering.
const PRICE = +(process.env.DD_PRICE || 100);
// The edge a double must clear over that price to be labelled a bet rather
// than tracked. It no longer decides WHICH doubles appear — the board is the
// top TOP regardless — so set this to taste without ever shortening the board.
const MIN_EDGE = +(process.env.DD_MIN_EDGE || 0.02);

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const prettyDate = d => { const [y, mo, da] = d.split("-").map(Number); return `${MONTHS[mo-1]} ${da}`; };
const pct = v => Math.round(v * 100) + "%";
const pts = v => (v >= 0 ? "+" : "") + (v * 100).toFixed(1);
const av = v => v == null ? "—" : v.toFixed(3).replace(/^0/, "");

async function j(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`); return r.json(); }
async function tg(text) {
  await j(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
}

// Telegram rejects anything over 4096 characters outright — the whole alert is
// lost, not truncated. A five-double board runs close enough to that to matter,
// so split on blank lines, which fall between doubles and never inside a tag.
const TG_LIMIT = 3900;
async function tgLong(text) {
  if (text.length <= TG_LIMIT) return tg(text);
  let buf = "";
  for (const block of text.split("\n\n")) {
    if (block.length > TG_LIMIT) {            // shouldn't happen; send it unstyled rather than lose it
      if (buf) { await tg(buf); buf = ""; }
      await tg(block.replace(/<[^>]+>/g, "").slice(0, TG_LIMIT));
      continue;
    }
    if (buf && buf.length + 2 + block.length > TG_LIMIT) { await tg(buf); buf = ""; }
    buf = buf ? buf + "\n\n" + block : block;
  }
  if (buf) await tg(buf);
}

// Trim a scored candidate down to what the tracker and the calibration log
// need. `p` is kept because grading compares the outcome against exactly the
// number we published.
const slim = c => ({
  id: c.id, name: c.name, team: c.teamName, slot: c.slot, posted: c.posted,
  avg: c.avg, proj: c.projAvg, p: c.p, eAb: c.eAb,
  sp: c.spName, spBaa: c.spBaa, spHr9: c.spHr9, plt: c.plt
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
      soft: d.soft, offIdx: d.offIdx, spotDelta: d.spotDelta,
      rho: d.rho, sameTeam: d.sameTeam, edge: d.ev ? d.ev.edge : 0,
      evPct: d.ev ? d.ev.evPct : 0, kelly: d.ev ? d.ev.quarterKelly : 0,
      gk: d.gk, venue: d.venue, teams: d.teams, bothPosted: d.bothPosted
    }))
  };
}

// ── waves and locking ───────────────────────────────────────────────────────
// A slate is not one event, and a game is not bettable until its lineup is up.
// Lineups post about 3-4 hours before first pitch, and the two code paths in
// the model are not variations on each other — with a posted lineup the
// candidates ARE the nine men batting, in their real slots; without one they
// are the whole roster with slots guessed from plate appearances per game and
// a 19% scratch haircut. Locking a game early therefore does not produce a
// slightly worse pick, it produces different players entirely. So nothing is
// locked until its own lineup is confirmed.
const WAVE_GAP_MS = 3 * 3600000;   // games within 3h of the first are one wave
const HOUR = 3600000;

// Both lineups posted, nine deep — the same test buildBoard applies.
const posted = g => {
  const lu = g.lineups || {};
  return Array.isArray(lu.homePlayers) && lu.homePlayers.length >= 9
      && Array.isArray(lu.awayPlayers) && lu.awayPlayers.length >= 9;
};

function splitWaves(games) {
  const rows = games.map(g => ({ g, t: Date.parse(g.gameDate) }))
    .filter(r => !isNaN(r.t)).sort((a, b) => a.t - b.t);
  if (!rows.length) return [];
  const cut = rows[0].t + WAVE_GAP_MS;
  const early = rows.filter(r => r.t <= cut), late = rows.filter(r => r.t > cut);
  const wave = (key, label, rs) => ({ key, label, games: rs.map(r => r.g), lockAt: rs[0].t - HOUR, firstPitch: rs[0].t });
  // An all-day or all-night slate is a single wave; don't invent a second board.
  if (!late.length) return [wave("all", "DAILY DOUBLE", rows)];
  return [wave("early", "EARLY BOARD", early), wave("main", "MAIN BOARD", late)];
}

const legLine = c => `   • <b>${c.name}</b> #${c.slot}${c.posted ? " ✓LU" : ""} · ${av(c.avg)}→${av(c.proj)} proj · ${c.eAb.toFixed(1)} AB\n     vs ${c.sp || "SP TBD"}${c.spBaa != null ? " (" + av(c.spBaa) + " BAA" + (c.spHr9 != null ? ", " + c.spHr9.toFixed(1) + " HR/9" : "") + ")" : ""}${c.plt === "adv" ? " ▲plat" : c.plt === "dis" ? " ▽plat" : ""} · <b>${pct(c.p)}</b>`;

const betBlock = (d, i) =>
  `<b>#${i + 1}</b> · ${pct(d.prob)} both hit · fair ${M.amOdds(d.prob)} vs your ${PRICE > 0 ? "+" : ""}${PRICE}\n` +
  `   <b>EDGE ${(d.edge * 100 >= 0 ? "+" : "") + (d.edge * 100).toFixed(1)}pts · EV ${(d.evPct >= 0 ? "+" : "") + d.evPct.toFixed(1)}% · stake ${(d.kelly * 100).toFixed(1)}% bank</b>\n` +
  `   ${d.teams}${d.sameTeam ? " · SAME TEAM" : ""} · correlation +${(d.lift * 100).toFixed(1)}pts over naive\n` +
  `   SPOT ${pts(d.spotDelta)}pts vs league <i>(soft arm ${pts(d.soft)} · bats ${pts(d.offIdx)})</i>\n${legLine(d.a)}\n${legLine(d.b)}`;

const watchLine = d =>
  `   ${d.teams} — ${d.a.name} + ${d.b.name} · ${pct(d.prob)} · fair ${M.amOdds(d.prob)} · edge ${(d.edge * 100 >= 0 ? "+" : "") + (d.edge * 100).toFixed(1)}pts`;

async function sendBoard(label, day, gameCount, firstPitch, bets, watch) {
  const first = new Date(firstPitch).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const head = `🎲 <b>${label}</b> · ${prettyDate(day)}\n${gameCount} confirmed lineup${gameCount === 1 ? "" : "s"} · first pitch ${first} ET · priced vs ${PRICE > 0 ? "+" : ""}${PRICE}\n`;
  if (!bets.length) {
    // Nothing clears the bar. Say so in two lines rather than dumping five
    // doubles that would only ever be talked out of.
    const best = watch.slice(0, 2).map(watchLine).join("\n");
    await tgLong(head + `🚫 <b>NO BETS</b> — nothing clears the ${(MIN_EDGE * 100).toFixed(1)}pt edge bar.\n` +
      (best ? `➖➖➖➖➖➖➖➖\nClosest, for reference only:\n${best}` : ""));
    return;
  }
  const body = bets.map(betBlock).join("\n\n");
  const tail = watch.length
    ? `\n\n👀 <b>WATCHLIST</b> — <i>not locked, not tracked, not bet</i>\n${watch.map(watchLine).join("\n")}`
    : "";
  await tgLong(head + `🔒 <b>${bets.length} LOCKED</b> · clearing the ${(MIN_EDGE * 100).toFixed(1)}pt edge bar\n` +
    `➖➖➖➖➖➖➖➖\n${body}${tail}`);
}

async function main() {
  const day = M.slateYmd();
  const sched = await j(`${API}/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team,venue,lineups`);
  const games = (sched?.dates?.[0]?.games || []).filter(g => !/postpon|suspend|cancel/i.test(g.status?.detailedState || ""));
  if (!games.length) { console.log(`No MLB games ${day}.`); return; }
  const waves = splitWaves(games);
  if (!waves.length) { console.log("No parseable start times."); return; }

  let blob = {};
  try { if (existsSync(STATE_FILE)) blob = JSON.parse(readFileSync(STATE_FILE, "utf8")) || {}; } catch (e) { console.log("State read failed:", e.message); }
  const D = blob.dd = blob.dd || {};
  D.record = D.record || { w: 0, l: 0 };
  D.boards = D.boards || {};
  D.lockedGames = D.lockedGames || {};
  D.waveSent = D.waveSent || {};
  D.cal = D.cal || { v: SNAP_V, legs: {}, global: { n: 0, hits: 0, sump: 0 } };
  if (D.cal.v !== SNAP_V) { console.log("Model version changed — resetting calibration."); D.cal = { v: SNAP_V, legs: {}, global: { n: 0, hits: 0, sump: 0 } }; }
  let changed = false;

  // Migration off the single-lock scheme: adopt a board already alerted under
  // the old shape so the changeover neither re-sends a locked slate nor drops
  // its tracking. It kept the top 3, so that is what stays tracked.
  if (D.snap && D.lockDate === D.snap.date && !D.boards[`${D.snap.date}:all`]) {
    D.boards[`${D.snap.date}:all`] = { date: D.snap.date, label: "DAILY DOUBLE",
      v: D.snap.v, picks: (D.snap.doubles || []).slice(0, 3), watch: [], results: D.results || {} };
    console.log("Migrated the single-lock board into the wave scheme.");
    changed = true;
  }
  if (D.snap || D.lockDate || D.results) { delete D.snap; delete D.lockDate; delete D.results; changed = true; }

  const now = Date.now();
  const waveOf = {};
  waves.forEach(w => w.games.forEach(g => { waveOf[g.gamePk] = w; }));

  // A game is ready to lock when its lineup is CONFIRMED, its wave (or its own
  // hour mark, whichever is sooner) has arrived, and it has not started.
  const ready = games.filter(g => {
    const t = Date.parse(g.gameDate); if (isNaN(t)) return false;
    if (D.lockedGames[`${day}:${g.gamePk}`]) return false;
    if (!posted(g)) return false;
    const w = waveOf[g.gamePk];
    const openAt = Math.min(w ? w.lockAt : Infinity, t - HOUR);
    return now >= openAt && now < t;
  }).sort((a, b) => Date.parse(a.gameDate) - Date.parse(b.gameDate));

  const waiting = games.filter(g => {
    const t = Date.parse(g.gameDate);
    const w = waveOf[g.gamePk];
    return !isNaN(t) && !D.lockedGames[`${day}:${g.gamePk}`] && now < t
      && now >= Math.min(w ? w.lockAt : Infinity, t - HOUR) && !posted(g);
  });
  if (waiting.length) console.log(`${waiting.length} game(s) past their lock but lineup not posted — held back, not bet blind.`);

  if (ready.length) {
    const w = waveOf[ready[0].gamePk];
    const key = w ? w.key : "late";
    const label = (w && !D.waveSent[`${day}:${key}`]) ? `${w.label} LOCKED` : "LATE ADD";
    console.log(`Locking ${ready.length} confirmed game(s) as ${label}…`);
    const snap = await computeDoubles(day, ready, D.cal);
    if (snap) {
      const all = snap.doubles;
      const bets = all.filter(d => d.edge >= MIN_EDGE).slice(0, TOP);
      const watch = all.filter(d => !bets.includes(d)).slice(0, Math.max(0, TOP - bets.length));
      await sendBoard(label, day, ready.length, Date.parse(ready[0].gameDate), bets, watch);
      const id = `${day}:${key}:${Object.keys(D.boards).length}`;
      D.boards[id] = { date: day, label, picks: bets, watch, results: {} };
      ready.forEach(g => { D.lockedGames[`${day}:${g.gamePk}`] = 1; });
      if (w) D.waveSent[`${day}:${key}`] = 1;
      changed = true;
      console.log(`${label}: ${bets.length} locked, ${watch.length} watchlist.`);
    } else console.log("Could not produce doubles for the ready games.");
  }

  // ── Live tracking: only what was actually locked ──
  const boards = Object.values(D.boards).filter(b => b.date === day);
  const allPicks = boards.flatMap(b => (b.picks || []).map((d, i) => ({ d, b, tag: `${b.label.replace(" LOCKED", "")} #${i + 1}` })));
  // Watchlist legs are graded for calibration but never messaged or recorded —
  // they measure the model, they are not bets.
  const gradeOnly = boards.flatMap(b => (b.watch || []).map(d => ({ d, b })));
  if (!allPicks.length && !gradeOnly.length) {
    try { writeFileSync(STATE_FILE, JSON.stringify(blob)); } catch (e) { console.log("State write failed:", e.message); }
    console.log("Nothing locked yet."); return;
  }

  const gks = [...new Set([...allPicks, ...gradeOnly].map(x => x.d.gk))];
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

  const allRes = () => boards.flatMap(b => Object.values(b.results || {}));
  let cashed = allRes().filter(r => r.cashed).length;
  let dead = allRes().filter(r => r.dead).length;
  const tally = () => `Today: 💣 ${cashed} · 💀 ${dead} of ${allPicks.length}  ·  All-time ${D.record.w}-${D.record.l}`;

  const gradeLeg = (leg, gotHit) => {
    const seen = D.cal.graded = D.cal.graded || {};
    const k = `${day}:${leg.id}`;
    if (seen[k]) return;
    seen[k] = 1;
    M.record(D.cal, leg.id, leg.p, gotHit);
    changed = true;
  };

  for (const { d, b, tag } of allPicks) {
    b.results = b.results || {};
    const key = `${d.a.id}_${d.b.id}`; const st = b.results[key] = b.results[key] || {};
    if (st.cashed || st.dead) continue;
    const hA = (hitsById[d.a.id] || 0) >= 1, hB = (hitsById[d.b.id] || 0) >= 1;
    const inCount = (hA ? 1 : 0) + (hB ? 1 : 0);
    if (inCount === 2) {
      cashed++; D.record.w++;
      gradeLeg(d.a, true); gradeLeg(d.b, true);
      await tg(`💣 <b>CASHED — ${tag}</b>\nBoth hit! ${d.a.name} + ${d.b.name}\n${tally()}`);
      st.cashed = true; changed = true; console.log(`${tag} cashed.`);
    } else if (fin[d.gk]) {
      dead++; D.record.l++;
      gradeLeg(d.a, hA); gradeLeg(d.b, hB);
      const cold = [!hA ? d.a.name : null, !hB ? d.b.name : null].filter(Boolean).join(" & ");
      await tg(`💀 <b>DEAD — ${tag}</b>\nHitless: ${cold} (final)\n${tally()}`);
      st.dead = true; changed = true; console.log(`${tag} dead.`);
    } else if (inCount === 1 && !st.half) {
      const got = hA ? d.a.name : d.b.name, need = hA ? d.b.name : d.a.name;
      await tg(`✅ <b>1/2 IN — ${tag}</b>\n${got} has a hit · need ${need}`);
      st.half = true; changed = true; console.log(`${tag} half.`);
    }
  }
  // Silent grading of the watchlist once its games are final.
  for (const { d } of gradeOnly) {
    if (!fin[d.gk]) continue;
    gradeLeg(d.a, (hitsById[d.a.id] || 0) >= 1);
    gradeLeg(d.b, (hitsById[d.b.id] || 0) >= 1);
  }

  // ── Day-end summary (once every game has locked or started, and all settled) ──
  const everyGameResolved = games.every(g => {
    const t = Date.parse(g.gameDate);
    return D.lockedGames[`${day}:${g.gamePk}`] || isNaN(t) || now >= t;
  });
  const allSettled = everyGameResolved && allPicks.every(({ d, b }) => {
    const st = b.results[`${d.a.id}_${d.b.id}`]; return st && (st.cashed || st.dead);
  });
  if (allSettled && allPicks.length && D.summaryDate !== day) {
    const won = allPicks.filter(({ d, b }) => b.results[`${d.a.id}_${d.b.id}`].cashed).length;
    const n = D.record.w + D.record.l;
    const pctW = n ? Math.round(D.record.w / n * 100) : 0;
    const g = D.cal.global;
    const calLine = g.n > 0
      ? `\nModel calibration: predicted <b>${pct(g.sump / g.n)}</b> per leg, actual <b>${pct(g.hits / g.n)}</b> over ${g.n} graded legs`
      : "";
    const perBoard = boards.length > 1
      ? "\n" + boards.filter(b => b.picks?.length).map(b => `${b.label.replace(" LOCKED", "")}: ${b.picks.filter(d => b.results[`${d.a.id}_${d.b.id}`]?.cashed).length}/${b.picks.length}`).join(" · ")
      : "";
    await tg(`📊 <b>DAY DONE</b> · ${prettyDate(day)}\nBets: <b>${won}/${allPicks.length}</b> cashed${perBoard}\nAll-time record: <b>${D.record.w}-${D.record.l}</b> (${pctW}%)${calLine}`);
    D.summaryDate = day; changed = true; console.log("Day summary sent.");

    try {
      mkdirSync("data", { recursive: true });
      const pub = { v: D.cal.v, updated: new Date().toISOString(), through: day, record: D.record, global: g, legs: D.cal.legs };
      writeFileSync(PUBLIC_LOG, JSON.stringify(pub));
      D.publishedDate = day;
      console.log(`Published ${PUBLIC_LOG} (${Object.keys(D.cal.legs).length} players).`);
    } catch (e) { console.log("Publish failed:", e.message); }
  }

  try { writeFileSync(STATE_FILE, JSON.stringify(blob)); } catch (e) { console.log("State write failed:", e.message); }
  console.log(`Done — 💣 ${cashed} / 💀 ${dead} of ${allPicks.length} locked.${changed ? " [state updated]" : ""}`);
}

main().catch(e => { console.error(e); process.exit(1); });
