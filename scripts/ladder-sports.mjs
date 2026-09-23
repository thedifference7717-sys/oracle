// The ladder's one bet a day, chosen across every sport on the slate.
//
//   MLB  a hitter to record a hit                 (Kalshi KXMLBHIT, 1+)
//   NBA  points, rebounds, assists, threes made   (KXNBAPTS / REB / AST / 3PT)
//   NFL  passing, receiving, rushing yards        (KXNFLPASSYDS / RECYDS / RUSHYDS)
//
// Each sport's own model says how likely each of its props is — the same
// model files the boards run, so the ladder cannot disagree with them — and
// every prop is priced at what it actually costs on Kalshi at the moment of
// the lock. ladder-select.js then decides between them, and it does NOT just
// take the biggest number: a sport with no settled record has not earned its
// model's opinion yet, so its number is pulled toward the market's until it
// has. See the top of ladder-select.js for why that matters.
//
// Everything that touches the network lives here; the decision itself
// (choose) is pure so it can be tested without one.
import { createRequire } from "module";
import { quoteOf, probToAmerican, normName } from "./kalshi-quotes.mjs";
const require = createRequire(import.meta.url);
const HW = require("../hairdwood-model.js");
const GM = require("../gridiron-model.js");
const LS = require("../ladder-select.js");

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";

export const SPORT = {
  MLB: { emoji: "⚾", espn: null },
  NBA: { emoji: "🏀", espn: "basketball/nba" },
  NFL: { emoji: "🏈", espn: "football/nfl" }
};

// What each market is called on a bet slip, and the Kalshi series it trades in.
export const MARKETS = {
  MLB: { hit: { label: "hits", series: "KXMLBHIT" } },
  NBA: {
    pts: { label: "points", series: "KXNBAPTS" },
    reb: { label: "rebounds", series: "KXNBAREB" },
    ast: { label: "assists", series: "KXNBAAST" },
    tpm: { label: "threes made", series: "KXNBA3PT" }
  },
  NFL: {
    passYds: { label: "passing yards", series: "KXNFLPASSYDS" },
    recYds: { label: "receiving yards", series: "KXNFLRECYDS" },
    rushYds: { label: "rushing yards", series: "KXNFLRUSHYDS" }
  }
};

// "25+ points", "250+ passing yards", "to record a hit". A Kalshi strike of
// 24.5 is the contract that pays on 25 or more.
export function needText(sport, market, line) {
  if (sport === "MLB" && market === "hit") return "to record a hit";
  const m = (MARKETS[sport] || {})[market];
  const n = Math.floor(+line) + 1;
  return `${n}+ ${m ? m.label : market}`;
}

const say0 = m => process.stderr.write(m + "\n");

export async function getJSON(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "sportsai-ladder" } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) { last = e; await new Promise(s => setTimeout(s, 600 * (i + 1))); }
  }
  throw last || new Error("unreachable " + url);
}

const compact = day => String(day).replace(/-/g, "");

// ── when does the slate start ───────────────────────────────────────────────
// The ladder locks an hour before the FIRST game of the day in ANY sport, so
// it needs every sport's start times, not just baseball's. One scoreboard call
// per sport; cheap enough to repeat every pass.
export async function slateStarts(day, { get = getJSON } = {}) {
  const out = [];
  for (const sport of ["NBA", "NFL"]) {
    try {
      const d = await get(`${ESPN}/${SPORT[sport].espn}/scoreboard?limit=200&dates=${compact(day)}`);
      for (const ev of d.events || []) {
        if (HW.etDayOf(ev.date) !== day) continue;
        const st = ((((ev.competitions || [])[0] || {}).status || {}).type) || {};
        if (/postpon|cancel/i.test(st.name || "")) continue;
        out.push({ sport, id: String(ev.id), start: ev.date,
                   started: st.state === "in" || st.state === "post" || st.completed === true,
                   name: ev.shortName || ev.name || "" });
      }
    } catch (e) { say0(`  · ladder: ${sport} schedule unavailable (${e.message})`); }
  }
  return out;
}

// ── Kalshi player props ─────────────────────────────────────────────────────
// Every open market in a series. Paginated: a full NFL week of yardage ladders
// is well past one page.
export async function fetchSeries(series, { get = getJSON } = {}) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 6; page++) {
    const d = await get(`${KALSHI}/markets?series_ticker=${series}&status=open&limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    (d.markets || []).forEach(m => out.push(m));
    cursor = d.cursor || "";
    if (!cursor || !(d.markets || []).length) break;
  }
  return out;
}

// The player a prop contract is on. Kalshi puts "Name: 25+" in the title on
// some series and in the sub-title on others; take whichever carries a colon.
export function propPlayer(m) {
  const opts = [m.title, m.yes_sub_title, m.no_sub_title, m.subtitle].filter(Boolean).map(String);
  const t = opts.find(s => s.includes(":")) || opts[0] || "";
  return t.split(":")[0].trim();
}

// The line a contract pays over. Kalshi's floor_strike is already the half
// point below the threshold (24.5 for "25+") on every series checked; a
// series that ever quotes the whole number as "or more" is corrected here.
export function strikeOf(m) {
  const s = parseFloat(m.floor_strike);
  if (!isFinite(s)) return null;
  return /or_equal|greater_or/i.test(String(m.strike_type || "")) && Number.isInteger(s) ? s - 0.5 : s;
}

// name -> [{ strike, bid, ask, american, ... }], two-sided quotes only.
export function indexProps(markets) {
  const idx = new Map();
  for (const m of markets || []) {
    const strike = strikeOf(m);
    if (strike == null) continue;
    const q = quoteOf(m);
    if (!(q.ask > 0 && q.ask < 1)) continue;
    const player = propPlayer(m);
    const key = normName(player);
    if (!key) continue;
    const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
    const row = {
      player, strike, ticker: m.ticker, event: m.event_ticker,
      bid: q.bid, ask: q.ask, american: probToAmerican(q.ask),
      spread: q.bid != null ? +(q.ask - q.bid).toFixed(2) : null,
      askSize: n(m.yes_ask_size_fp), bidSize: n(m.yes_bid_size_fp),
      at: m.occurrence_datetime || m.expected_expiration_time || null
    };
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(row);
  }
  return idx;
}

// Quotes for this man in this game. A contract for his NEXT game shares his
// name, so anything resolving far from tonight's start is dropped.
export function quotesFor(idx, name, start) {
  const list = idx.get(normName(name)) || [];
  const t = Date.parse(start);
  if (isNaN(t)) return list;
  return list.filter(q => { const a = Date.parse(q.at); return isNaN(a) || Math.abs(a - t) < 18 * 3600e3; });
}

// The widest bid-ask spread a leg may carry, in dollars per contract.
export const MAX_SPREAD = 0.10;

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const fin = v => v != null && isFinite(+v);

// ── MLB ─────────────────────────────────────────────────────────────────────
// The baseball board is built by the caller (parlaiy-alerts already has it);
// this only puts its hitters into the common shape, priced at their Kalshi ask.
// `priceFor` is the caller's: it knows whether the feed is up and what to fall
// back to if it is not.
export function mlbCandidates(board, live, priceFor) {
  const out = [];
  let unlisted = 0;
  for (const c of (board && board.candidates) || []) {
    const q = priceFor(c);
    if (!q) { unlisted++; continue; }
    // A one-sided quote is not a market: Otto Lopez went into the 9/22 Robin
    // on a 70c ask with no bid at all. Needs a real bid and a spread a bettor
    // could actually trade at.
    if (q.source === "kalshi" && !(q.bid > 0 && q.spread != null && q.spread <= MAX_SPREAD)) { unlisted++; continue; }
    const g = live.find(x => x.gamePk === c.gk);
    out.push({
      sport: "MLB", market: "hit", line: 0.5, need: needText("MLB", "hit"),
      player: c.name, playerId: c.id, p: c.p, price: q.american,
      kalshi: q.source === "kalshi" ? { ticker: q.ticker, bid: q.bid, ask: q.ask, spread: q.spread } : null,
      priceSource: q.source,
      start: g ? g.gameDate : null, gk: c.gk, eventId: String(c.gk),
      teams: `${c.teamName} ${c.isHome ? "vs" : "@"} ${c.oppName}`,
      homeAway: c.isHome ? "home" : "away",
      // Context for the tie-break: last-30 average against his season line,
      // and how hard tonight's starter is to hit against league average.
      formEdge: fin(c.rAvg) && c.avg > 0 ? clamp(c.rAvg / c.avg - 1, -1, 1) : null,
      oppWeakness: fin(c.spBaa) ? clamp(c.spBaa / 0.245 - 1, -1, 1) : null,
      detail: `#${c.slot} · vs ${c.spName || "SP TBD"}${c.posted ? " · lineup confirmed" : ` · projected, ${Math.round((c.startProb || 0) * 100)}% to start`}`,
      mlb: { slot: c.slot, posted: !!c.posted, startProb: c.startProb, sp: c.spName || null }
    });
  }
  return { candidates: out, unlisted };
}

// ── NBA ─────────────────────────────────────────────────────────────────────
// The HAIrdwood board prices a full ladder of lines for every rotation player;
// each Kalshi strike is matched to the rung at exactly that line.
export async function nbaCandidates(day, { get = getJSON, say = say0 } = {}) {
  const board = await HW.buildBoard({ getJSON: get, day, onStatus: m => say("  · NBA: " + m) });
  if (board.empty || !board.legs.length) return { candidates: [], note: board.empty ? `no NBA games${board.nextDay ? ` (next ${board.nextDay})` : ""}` : "no NBA legs" };
  const idx = {};
  for (const [mk, m] of Object.entries(MARKETS.NBA)) {
    try { idx[mk] = indexProps(await fetchSeries(m.series, { get })); }
    catch (e) { say(`  · NBA: ${m.series} unavailable (${e.message})`); idx[mk] = new Map(); }
  }
  const quoted = Object.values(idx).reduce((a, m) => a + m.size, 0);
  if (!quoted) return { candidates: [], note: "no NBA props listed on Kalshi" };
  const now = Date.now(), out = [];
  let noRung = 0;
  for (const leg of board.legs) {
    if (leg.game.started || !(Date.parse(leg.game.date) > now)) continue;
    const qs = quotesFor(idx[leg.market] || new Map(), leg.pl.name, leg.game.date);
    for (const q of qs) {
      if (!(q.bid > 0 && q.spread != null && q.spread <= MAX_SPREAD)) continue;   // no real market
      const r = (leg.rungs || []).find(x => Math.abs(x.line - q.strike) < 1e-6);
      if (!r) { noRung++; continue; }
      const def = leg.factors && leg.factors.def && leg.factors.def[leg.market];
      out.push({
        sport: "NBA", market: leg.market, line: q.strike, need: needText("NBA", leg.market, q.strike),
        player: leg.pl.name, playerId: String(leg.pl.id), eventId: String(leg.gameId),
        p: r.p, price: q.american, priceSource: "kalshi",
        kalshi: { ticker: q.ticker, bid: q.bid, ask: q.ask, spread: q.spread },
        start: leg.game.date,
        teams: `${leg.teamAbbr} ${leg.isHome ? "vs" : "@"} ${leg.oppAbbr}`,
        homeAway: leg.isHome ? "home" : "away",
        status: leg.status || null,
        recentGames: leg.form ? leg.form.n : null,
        formEdge: leg.form && leg.seasonAvg > 0 ? clamp(leg.form.avg / leg.seasonAvg - 1, -1, 1) : null,
        oppWeakness: fin(def) ? clamp(def - 1, -1, 1) : null,
        detail: `proj ${leg.mean.toFixed(1)} in ${leg.mins.minutes.toFixed(0)} min` +
                (leg.form ? ` · over this line ${leg.form.hits} of his last ${leg.form.n}` : "") +
                (leg.b2b ? " · back-to-back" : ""),
        projected: +leg.mean.toFixed(2)
      });
    }
  }
  return { candidates: out, note: `${board.legs.length} legs, ${quoted} players quoted${noRung ? `, ${noRung} strikes off the model's ladder` : ""}` };
}

// ── NFL ─────────────────────────────────────────────────────────────────────
// PlAIybook simulates each game ten thousand times; a yardage prop's chance is
// read straight off the simulated afternoons, calibrated to the exchange across
// the slate and blended with each rung's own mid by how tightly it is quoted —
// the same two steps the football board takes before it prices anything.
const kPlayerKey = t => String(t || "").split(":")[0].toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

export async function nflCandidates(day, { get = getJSON, say = say0 } = {}) {
  // The board's own series list has no rushing ladder; the ladder bets one.
  GM.KALSHI_PROP_SERIES.nfl.rushYds = GM.KALSHI_PROP_SERIES.nfl.rushYds || MARKETS.NFL.rushYds.series;
  const now = Date.now();
  // The week THIS day belongs to. Left to itself the board loads ESPN's
  // "current" week, which on a Tuesday is the one that just finished — every
  // game final, nothing to bet, and Thursday's game never considered.
  const sb = await get(`${ESPN}/football/nfl/scoreboard?limit=50&dates=${compact(day)}`);
  // A dated scoreboard carries the week on each event rather than at the top.
  const ev0 = (sb.events || []).find(e => HW.etDayOf(e.date) === day) || (sb.events || [])[0] || {};
  const season = (sb.season || {}).year || (ev0.season || {}).year;
  const week = (sb.week || {}).number || (ev0.week || {}).number;
  if (!season || !week) return { candidates: [], note: `no NFL week for this day (keys: ${Object.keys(sb).join(",")}; event keys: ${Object.keys(ev0).join(",")})` };
  const board = await GM.loadLeagueBoard("nfl", { season, week }, () => {});
  const today = board.games.filter(e => HW.etDayOf(e.game.date) === day && !e.game.final && Date.parse(e.game.date) > now);
  if (!today.length) return { candidates: [], note: "no NFL games" };
  const kal = await GM.loadKalshi("nfl");
  GM.matchKalshi(board, kal);
  const kprops = await GM.loadKalshiProps("nfl");
  if (!kprops || !kprops.ok) return { candidates: [], note: "no NFL props listed on Kalshi" };

  const cache = {}, games = [];
  for (const entry of today) {
    if (!entry.kalshi) { say(`  · NFL: ${entry.game.away.abbr} @ ${entry.game.home.abbr} not matched on Kalshi`); continue; }
    let list;
    try { list = await GM.loadGameProps(board, entry, cache, () => {}, {}); } catch (e) { say(`  · NFL: props failed (${e.message})`); continue; }
    const home = list.filter(p => p.teamId === entry.game.home.id);
    const away = list.filter(p => p.teamId === entry.game.away.id);
    if (!home.length && !away.length) continue;
    const seed = String(entry.game.id).split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
    const sim = GM.simulateGame([home, away], { n: 10000, seed });
    const byPlayer = {}, manOf = {};
    sim.men.forEach(man => {
      manOf[man.pl.player.id] = man;
      const by = {}; GM.simMarkets(man).forEach(mk => by[mk.key] = mk);
      byPlayer[man.pl.player.id] = by;
    });
    games.push({ entry, list, byPlayer, manOf });
  }
  const rungsOf = (entry, name, key) => {
    const ev = kprops.events[entry.kalshi.key] || {};
    return ((ev[kPlayerKey(name)] || {})[key]) || [];
  };
  // Fit our simulated tails onto the exchange's scale across every quoted rung.
  const pairs = [];
  games.forEach(({ entry, list, byPlayer }) => list.forEach(pl => Object.keys(MARKETS.NFL).forEach(key => {
    const sm = (byPlayer[pl.player.id] || {})[key];
    if (!sm) return;
    rungsOf(entry, pl.player.name, key).forEach(r => { if (r.mid != null) pairs.push({ p: sm.tail(r.strike), market: r.mid }); });
  })));
  const probCal = GM.calibrateProbs(pairs);

  const out = [];
  let dropped = 0;
  for (const { entry, list, byPlayer, manOf } of games) {
    for (const pl of list) {
      const man = manOf[pl.player.id];
      if (!man) continue;
      for (const key of Object.keys(MARKETS.NFL)) {
        const sm = (byPlayer[pl.player.id] || {})[key];
        if (!sm) continue;
        for (const r of rungsOf(entry, pl.player.name, key)) {
          if (!(r.ask > 0 && r.ask < 1) || !(r.spread <= GM.MAX_SPREAD) ||
              Math.max(r.askSize || 0, r.bidSize || 0) < GM.MIN_LEG_SIZE) { dropped++; continue; }
          const leg = GM.simLeg(man, sm, "Over", r.strike);
          const pm = GM.applyProbCal(probCal, leg.p);
          // Past this far apart it is a broken input, not an edge.
          if (Math.abs(pm - r.mid) > GM.MAX_DISAGREE) { dropped++; continue; }
          const w = GM.propWeight(r.spread);
          const p = clamp(w * pm + (1 - w) * r.mid, 1e-4, 1 - 1e-4);
          const isHome = pl.teamId === entry.game.home.id;
          const us = isHome ? entry.game.home.abbr : entry.game.away.abbr;
          const them = isHome ? entry.game.away.abbr : entry.game.home.abbr;
          out.push({
            sport: "NFL", market: key, line: r.strike, need: needText("NFL", key, r.strike),
            player: pl.player.name, playerId: String(pl.player.id), eventId: String(entry.game.id),
            p, pModel: +pm.toFixed(4), price: probToAmerican(r.ask), priceSource: "kalshi",
            kalshi: { ticker: r.ticker, bid: r.bid, ask: r.ask, spread: +r.spread.toFixed(2) },
            start: entry.game.date, teams: `${us} ${isHome ? "vs" : "@"} ${them}`,
            homeAway: isHome ? "home" : "away",
            status: pl.status || null,
            detail: `${pl.player.pos || ""} · sim median ${Math.round(sm.range.median)} ${MARKETS.NFL[key].label}`.trim(),
            projected: +sm.mean.toFixed(1)
          });
        }
      }
    }
  }
  return { candidates: out, note: `${games.length} game(s), ${pairs.length} quoted rungs, calibration ${probCal.applied ? "applied" : "not applied (thin slate)"}${dropped ? `, ${dropped} rungs too thin or too far off` : ""}` };
}

// ── the decision ────────────────────────────────────────────────────────────
// How each sport's model has done on the ladder so far. MLB also has the
// alerter's running calibration over every graded leg, which is a far bigger
// sample than the ladder alone.
export function sportRecords(bets, mlbCal) {
  const rec = { MLB: { n: 0 }, NBA: { n: 0 }, NFL: { n: 0 } };
  const done = (bets || []).filter(b => (b.status === "won" || b.status === "lost") && b.p != null);
  for (const s of Object.keys(rec)) {
    const mine = done.filter(b => (b.sport || "MLB") === s);
    if (mine.length) rec[s] = { n: mine.length,
      predicted: mine.reduce((a, b) => a + +b.p, 0) / mine.length,
      actual: mine.filter(b => b.status === "won").length / mine.length };
  }
  const g = mlbCal && mlbCal.global;
  if (g && g.n > rec.MLB.n) rec.MLB = { n: g.n, predicted: g.sump / g.n, actual: g.hits / g.n };
  return rec;
}

// Nobody rides the ladder more than two days running, in any sport.
export const benchKey = b => `${b.sport || "MLB"}:${b.playerId != null ? String(b.playerId) : String(b.pick || b.player || "").toLowerCase()}`;
export function benched(bets, maxStreak = 2) {
  const placed = (bets || []).filter(b => (b.pick || b.playerId != null) && ["won", "lost", "open"].includes(b.status))
    .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = placed.slice(-maxStreak);
  if (last.length < maxStreak) return new Set();
  const k = benchKey(last[0]);
  return last.every(b => benchKey(b) === k) ? new Set([k]) : new Set();
}

// The one bet. Ranked by ladder-select on each prop's chance of winning after
// its sport's record is accounted for, with form and matchup breaking ties,
// inside the ladder's price band. On top of that the model must at least agree
// with the price: a prop the model itself rates below what the market charges
// is not the likeliest winner, it is the market's favourite that we doubt.
export function choose(candidates, records, { band, blocked = new Set(), minEdge = 0, poolTolerance = 0.03 } = {}) {
  const r = LS.select(candidates, records, { band });
  const ranked = [], bench = [], doubted = [];
  for (const c of r.eligible) {
    // The model's own number against the price, before any record correction:
    // a bias measured on one or two settled rungs is noise, and letting it
    // decide agreement would wave through anything from a sport that got lucky.
    c.rawEdge = c.implied != null ? +(c.p - c.implied).toFixed(4) : null;
    if (c.rawEdge != null && c.rawEdge < minEdge) { doubted.push(c); continue; }
    if (blocked.has(benchKey(c))) { bench.push(c); continue; }
    ranked.push(c);
  }
  // The Dub's and the Robin's pool. Looser than the ladder's — a parlay may
  // take the market's favourites — but not blind: a man our own model rates
  // well below his price (a doubtful starter the market has not caught up
  // with) is not one of the likeliest winners just because the price says so.
  const pool = r.eligible.filter(c => c.implied == null || c.p >= c.implied - poolTolerance);
  return { pick: ranked[0] || null, ranked, benched: bench, doubted, pool, rejected: r.rejected, all: r.all, band: r.band };
}

// ── settling a basketball or football rung ──────────────────────────────────
// Only once the game is final: yardage can go backwards on a sack or a loss,
// and a record settled on a guess is not a record.
// Returns null while it is not knowable yet.
export async function settleRung(b, { get = getJSON } = {}) {
  if (b.sport !== "NBA" && b.sport !== "NFL") return null;
  const d = await get(`${ESPN}/${SPORT[b.sport].espn}/summary?event=${b.eventId}`);
  const st = (((((d.header || {}).competitions || [])[0] || {}).status || {}).type) || {};
  const final = st.completed === true || st.state === "post";
  if (/postpon|cancel/i.test(st.name || "")) return { status: "void", actual: null, note: "game not played — stake returned" };
  // Points, rebounds, assists and threes only ever go up, so an NBA prop is
  // won the moment the line is passed — graded then, not at the final buzzer.
  // Yards can go backwards (a sack, a loss on a run), so football waits.
  if (!final) {
    if (b.sport !== "NBA" || st.state !== "in") return null;
    const r = HW.settle({ playerId: b.playerId, market: b.market, line: b.line }, HW.parseBoxScore(d));
    return r && r.status === "won" ? r : null;
  }
  if (b.sport === "NBA") {
    const box = HW.parseBoxScore(d);
    const r = HW.settle({ playerId: b.playerId, market: b.market, line: b.line }, box);
    return r || { status: "void", actual: null, note: "not in the box score — stake returned" };
  }
  const players = await GM.loadPlayerStats(GM.LEAGUES.nfl, b.eventId);
  const me = players[kPlayerKey(b.pick)];
  // Not in the box score at all is a man who did not play: books void that.
  if (!me) return { status: "void", actual: null, note: "did not play — stake returned" };
  const got = me[b.market] != null ? +me[b.market] : 0;      // in the box but no line here = 0 yards
  return { status: got > b.line ? "won" : "lost", actual: got,
           note: `${got} ${MARKETS.NFL[b.market] ? MARKETS.NFL[b.market].label : b.market} against a ${b.line} line` };
}

// ── the Dub and the Robin ───────────────────────────────────────────────────
// Both are built from the same priced, ranked pool as the ladder, at the same
// lock: every prop inside the price band that no veto rules out and that our
// model rates within three points of its price, likeliest first. That is
// looser than the ladder's "model agrees with the price" test — the ladder
// compounds, a parlay does not — but it still keeps out a man the market
// likes and the model does not.
const legOf = c => ({
  sport: c.sport, player: c.player, playerId: c.playerId, market: c.market, line: c.line, need: c.need,
  eventId: c.eventId, gk: c.gk, teams: c.teams, start: c.start, price: c.price, priceSource: c.priceSource || "kalshi",
  kalshi: c.kalshi || null, p: +(+c.p).toFixed(4), pAdj: +(+c.pAdj).toFixed(4), detail: c.detail || null
});
const dec = a => { a = +a; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); };
const american = d => d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
const sameMan = (a, b) => a.sport === b.sport && String(a.playerId ?? a.player) === String(b.playerId ?? b.player);
const gameKey = c => `${c.sport}:${c.eventId}`;

// The best two-leg parlay: the likeliest pair from DIFFERENT games (so the two
// legs are as close to independent as a parlay gets, and the joint chance is
// honest), never including the ladder's own bet. Taking the top leg and the
// best leg from another game is optimal for a product of two.
export function pickDub(pool, ladderRow) {
  const legs = (pool || []).filter(c => !(ladderRow && ladderRow.pick && sameMan(c, { sport: ladderRow.sport || "MLB", playerId: ladderRow.playerId, player: ladderRow.pick })));
  const a = legs[0];
  if (!a) return null;
  const b = legs.find(c => c !== a && gameKey(c) !== gameKey(a) && !sameMan(c, a));
  if (!b) return null;
  const prob = a.pAdj * b.pAdj, d = dec(a.price) * dec(b.price);
  return { legs: [legOf(a), legOf(b)], prob: +prob.toFixed(4), price: american(d), fair: american(1 / prob) };
}

// The six likeliest props, one per game where the slate allows it — a round
// robin assumes its legs are independent, and two legs from one game are not.
export function pickRobin(pool, n = 6) {
  const out = [], games = new Set();
  for (const c of pool || []) {
    if (out.length >= n) break;
    if (games.has(gameKey(c)) || out.some(x => sameMan(x, c))) continue;
    out.push(c); games.add(gameKey(c));
  }
  // A thin slate: fill from games already used rather than bet fewer legs.
  for (const c of pool || []) {
    if (out.length >= n) break;
    if (out.includes(c) || out.some(x => sameMan(x, c))) continue;
    out.push(c);
  }
  return out.length >= 3 ? { legs: out.map(legOf), sizes: robinSizes(out) } : null;
}

// Every size of round robin over these legs, at each leg's own price: how many
// tickets, what the average ticket pays, how many should cash, and what that
// is worth per unit staked on every ticket.
export function robinSizes(legs) {
  const n = legs.length, rows = [];
  const combos = (m, start = 0, acc = []) => m === 0 ? [acc] :
    Array.from({ length: n - start }, (_, i) => combos(m - 1, start + i + 1, acc.concat(start + i))).flat();
  for (let m = 2; m <= n; m++) {
    const cs = combos(m);
    let expBack = 0, pay = 0, expWin = 0;
    for (const c of cs) {
      const p = c.reduce((a, i) => a * legs[i].pAdj, 1), d = c.reduce((a, i) => a * dec(legs[i].price), 1);
      expBack += p * d; pay += d; expWin += p;
    }
    rows.push({ m, tickets: cs.length, avgPays: +(pay / cs.length).toFixed(3), expWin: +expWin.toFixed(3),
                ev: +(expBack / cs.length - 1).toFixed(4) });
  }
  return rows;
}

// One leg of any sport against its final box score. null while unknowable.
export async function settleLeg(leg, { get = getJSON } = {}) {
  if (leg.sport === "NBA" || leg.sport === "NFL") {
    return settleRung({ sport: leg.sport, eventId: leg.eventId, playerId: leg.playerId, market: leg.market, line: leg.line, pick: leg.player }, { get });
  }
  const API = "https://statsapi.mlb.com/api/v1";
  const sc = await get(`${API}/schedule?gamePk=${leg.gk}`);
  const g = (((sc.dates || [])[0] || {}).games || [])[0];
  const state = g && g.status && g.status.abstractGameState;
  if (!g || state === "Preview") return null;
  if (/postpon|cancel/i.test(g.status.detailedState || "")) return { status: "void", actual: null, note: "game not played" };
  const bx = await get(`${API}/game/${leg.gk}/boxscore`);
  let hits = null;
  for (const side of ["home", "away"]) for (const pp of Object.values(bx?.teams?.[side]?.players || {})) {
    if (String(pp?.person?.id) === String(leg.playerId) && pp?.stats?.batting && pp.stats.batting.atBats != null) hits = +pp.stats.batting.hits || 0;
  }
  if (hits >= 1) return { status: "won", actual: hits, note: `${hits} hit${hits === 1 ? "" : "s"}` };
  if (state !== "Final") return null;
  if (hits == null) return { status: "void", actual: null, note: "did not play" };
  return { status: "lost", actual: 0, note: "hitless" };
}

// A parlay settles on its live legs: a void leg drops out, as at a book.
export function gradeDub(b) {
  const r = b.legs.map(l => l.result);
  if (r.some(x => x === "lost")) return "lost";
  if (r.some(x => x == null || x === "open")) return null;
  return r.every(x => x === "void") ? "void" : "won";
}
export function gradeRobin(b) {
  if (b.legs.some(l => l.result == null || l.result === "open")) return null;
  const live = b.legs.map(l => l.result);
  const n = b.legs.length, out = [];
  const combos = (m, start = 0, acc = []) => m === 0 ? [acc] :
    Array.from({ length: n - start }, (_, i) => combos(m - 1, start + i + 1, acc.concat(start + i))).flat();
  for (let m = 2; m <= n; m++) {
    let cashed = 0, back = 0, tickets = 0;
    for (const c of combos(m)) {
      tickets++;
      if (c.some(i => live[i] === "lost")) continue;
      const kept = c.filter(i => live[i] === "won");
      const d = kept.length ? kept.reduce((a, i) => a * dec(b.legs[i].price), 1) : 1;   // all-void ticket: stake back
      cashed += kept.length ? 1 : 0; back += d;
    }
    out.push({ m, tickets, cashed, back: +back.toFixed(3), pl: +(back - tickets).toFixed(3) });
  }
  return { hit: live.filter(x => x === "won").length, of: n, sizes: out };
}
