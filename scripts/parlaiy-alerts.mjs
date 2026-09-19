// Two BAIgger — Telegram alerts (GitHub Actions cron, self-looping every ~60s).
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
import { execSync } from "child_process";
import { pathToFileURL } from "url";
import M from "../dd-model.js";

const STATE_FILE = "state.json";
const PUBLIC_LOG = "data/model-log.json";
const LEDGER = "data/ledger.json";

// ── the public bet ledger ───────────────────────────────────────────────────
// Every alerted bet is written here the moment it is sent, with the time it
// was published and the game's first pitch beside it, and updated in place
// when it settles. The workflow commits this file immediately, so the repo's
// own history timestamps the pick — anyone can check that the commit landed
// before first pitch. That is the difference between a record that is
// verifiable and one that is merely asserted, and it is the entire asset of a
// picks business. It lives in the repo rather than the Actions cache because
// the cache is disposable and a track record cannot be.
//
// THE RECORD CANNOT DEPEND ON ONE WRITE LANDING.
//
// data/ledger.json is a TRACKED file. The run loop commits and pushes it after
// every pass, and a pass that cannot push leaves the row only in the working
// tree — where the next `git pull --rebase --autostash` can revert it, and
// where a cancelled runner loses it outright. Meanwhile `D.seen[key]` lives in
// gitignored state.json, which no git operation touches and the Actions cache
// carries forward. So the two disagree in exactly the way that hurts: state
// says the game is decided, the ledger has no row, and the per-game loop skips
// the game forever. The bet was alerted, was graded, and never appeared in the
// record.
//
// That is what happened on 2026-09-18: two doubles went out on Telegram, both
// cashed, and data/ledger.json has not changed since the 17th.
//
// The ladder already had this fixed. The doubles now get the same three
// defences: read the ledger as the UNION of this checkout, what is actually
// published on origin/main, and the rows this runner holds in state; keep a
// copy of every row in that same gitignored state; and reconcile the two on
// every pass so a row that went missing is rebuilt rather than skipped.
let ledgerStateRows = [];
function readLedgerLocal() {
  try { const L = JSON.parse(readFileSync(LEDGER, "utf8")); if (Array.isArray(L.bets)) return L; } catch (e) {}
  return null;
}
function readLedgerOrigin() {
  try {
    const raw = execSync(`git show origin/main:${LEDGER} 2>/dev/null`, { encoding: "utf8" });
    const L = JSON.parse(raw);
    return Array.isArray(L.bets) ? L : null;
  } catch (e) { return null; }   // not fetched, not committed yet, or no git
}
function readLedger() {
  const local = readLedgerLocal(), origin = readLedgerOrigin();
  const base = local || origin || { v: 1, sport: "MLB", bets: [] };
  const byId = new Map();
  // A settled row always beats an open one, whichever copy it came from: the
  // only way these disagree is that one side graded the bet and the other has
  // not seen it yet, and losing a grade is worse than losing a timestamp.
  const put = b => {
    if (!b || !b.id) return;
    const prev = byId.get(b.id);
    if (!prev || (prev.status === "open" && b.status !== "open")) byId.set(b.id, b);
  };
  (origin ? origin.bets : []).forEach(put);
  (local ? local.bets : []).forEach(put);
  ledgerStateRows.forEach(put);
  const bets = [...byId.values()]
    .sort((a, b) => String(a.published || a.date || "").localeCompare(String(b.published || b.date || "")));
  if (local && bets.length !== local.bets.length) {
    console.log(`ledger: merged — ${local.bets.length} local + ${origin ? origin.bets.length : 0} published = ${bets.length} rows.`);
  }
  return { ...base, bets };
}
function writeLedger(L) {
  L.updated = new Date().toISOString();
  mkdirSync("data", { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(L, null, 1));
}
// Keep a copy of the row where git cannot reach it. This is what lets the next
// pass tell "never bet" apart from "bet, and the row was lost".
function _setLedgerStateRows(rows) { ledgerStateRows = Array.isArray(rows) ? rows : []; }
function rememberLedgerRow(D, row) {
  if (!row || !row.id) return;
  ledgerStateRows = ledgerStateRows.filter(b => b.id !== row.id).concat([row]);
  if (D) D.ledgerRows = ledgerStateRows;
}
function ledgerRowFor(key, b, d, g) {
  return {
    id: key, date: b.date, sport: "MLB",
    published: b.published || null,                       // when we sent it
    firstPitch: b.firstPitch || (g ? g.gameDate : null),  // what it must precede
    teams: b.teams, venue: d.venue || null,
    price: b.price != null ? b.price : PRICE,
    prob: d.prob, edge: d.edge, evPct: d.evPct, kelly: d.kelly,
    soft: d.soft != null ? d.soft : null, softBar: MIN_SOFT,
    stakeRate: b.stakeRate != null ? b.stakeRate : PER_SPOT_PT, stakeBasis: "spot",
    stake: b.stake != null ? b.stake : +stakeFor(d).toFixed(2),
    qualifiedOn: "soft",
    sameTeam: !!d.sameTeam,
    legs: [d.a, d.b].map(c => ({ id: c.id, name: c.name, slot: c.slot, p: c.p, sp: c.sp || null })),
    status: "open"
  };
}
function ledgerOpen(key, day, g, d, D, meta) {
  const L = readLedger();
  if (L.bets.some(b => b.id === key)) return;            // never publish a pick twice
  const row = ledgerRowFor(key, meta, d, g);
  L.bets.push(row);
  writeLedger(L);
  rememberLedgerRow(D, row);
}
function ledgerSettle(key, won, hits, D) {
  const L = readLedger();
  const b = L.bets.find(x => x.id === key);
  if (!b || b.status !== "open") return;
  b.status = won ? "won" : "lost";
  b.settled = new Date().toISOString();
  b.hits = hits;
  writeLedger(L);
  rememberLedgerRow(D, b);
}
// Every pass: make the ledger agree with what state says was actually bet.
// Runs over every day state still holds, not just today, so a row lost on a
// previous day is recovered as soon as a run carrying this code starts.
function reconcileLedger(D, games) {
  const L = readLedger();
  let added = 0, settled = 0;
  for (const [key, b] of Object.entries(D.bets || {})) {
    const d = b.double;
    if (!d || !d.a || !d.b) continue;
    let row = L.bets.find(x => x.id === key);
    if (!row) {
      row = ledgerRowFor(key, b, d, (games || []).find(x => x.gamePk === b.gk));
      // A row rebuilt after the fact cannot claim the thing that makes this
      // record worth anything — a commit that predates first pitch. Say so on
      // the row rather than quietly stamping it with today's time.
      if (!b.published) {
        row.recovered = true;
        row.note = "Alerted on Telegram but its ledger row never reached the repo; rebuilt from the run's own saved state, so it carries no publication timestamp.";
      }
      L.bets.push(row); added++;
    }
    const want = b.results && b.results.cashed ? "won" : b.results && b.results.dead ? "lost" : "open";
    if (want !== "open" && row.status === "open") {
      row.status = want;
      row.settled = row.settled || new Date().toISOString();
      if (row.hits == null && b.results.hits) row.hits = b.results.hits;
      settled++;
    }
    rememberLedgerRow(D, row);
  }
  if (added || settled) {
    L.bets.sort((a, b) => String(a.published || a.date || "").localeCompare(String(b.published || b.date || "")));
    writeLedger(L);
    console.log(`ledger: recovered ${added} missing row(s) and settled ${settled} from state.`);
  }
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT) { console.log("Telegram secrets not set — skipping."); process.exit(0); }

const API = M.API;
const SNAP_V = M.VERSION;                        // board schema = model version
// Price the doubles are graded against. Override with DD_PRICE (American odds)
// in the workflow to match whatever your book is actually offering.
// The double is genuinely offered around -150 to -175, not +100. Defaulting to
// the worst end keeps the board conservative: a bet that clears at -175 clears
// at any better price, while the reverse is how you alert losers.
const PRICE = +(process.env.DD_PRICE || -175);
// The edge a game's pair must clear to be worth alerting, as a fraction: 0.02
// is two points of probability over your price's breakeven. Marginal edges are
// inside the model's own error bars, so a real bar filters more noise than it
// costs in missed spots. Override with DD_MIN_EDGE.
//
// As of the soft-arm rule this no longer gates the DOUBLE at all — softness
// does. It still gates the ladder, and still sets the margin the single-leg
// alert asks for.
// Parsed defensively: unset, empty or malformed falls back to the 2-point bar,
// while an explicit DD_MIN_EDGE=0 really does mean "alert anything positive"
// (a plain || would swallow it, since 0 is falsy).
const _minEdge = process.env.DD_MIN_EDGE;
const MIN_EDGE = (_minEdge == null || _minEdge.trim() === "" || isNaN(+_minEdge)) ? 0.02 : +_minEdge;
// Dollars staked per edge point, matching the dashboard's rule. Recorded on
// every bet at publish time rather than applied to the ledger afterwards: if
// the rate is ever changed, past bets must keep the stake they were actually
// published with, or the record quietly rewrites itself.
// Dollars per SPOT point. DD_PER_SPOT_PT is the name; DD_PER_EDGE_PT is still
// read so an existing repo variable keeps working after the rename.
const PER_SPOT_PT = +(process.env.DD_PER_SPOT_PT || process.env.DD_PER_EDGE_PT || 2.50);
// Softness of the opposing arm the double must face, in points of hit
// probability against a league-neutral leg. SOFT holds the offence at league
// average and asks only how bad the starter, his bullpen, the defence and the
// park are — so it measures the spot rather than the hitters, and a double is
// only taken where the spot is genuinely soft.
//
// This is a second gate, not a replacement for the edge bar: a soft spot at a
// bad price is still a bad bet. Both have to pass. Override with DD_MIN_SOFT
// (as a fraction, so 0.049 is +4.9pts); an explicit 0 really does mean no
// softness requirement, which a plain || would have swallowed.
const _minSoft = process.env.DD_MIN_SOFT;
const MIN_SOFT = (_minSoft == null || _minSoft.trim() === "" || isNaN(+_minSoft)) ? 0.049 : +_minSoft;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const prettyDate = d => { const [y, mo, da] = d.split("-").map(Number); return `${MONTHS[mo-1]} ${da}`; };
const pct = v => Math.round(v * 100) + "%";
const pts = v => (v >= 0 ? "+" : "") + (v * 100).toFixed(1);
const money = v => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
// Stake scales with the SPOT, not the edge. Softness is what now decides
// whether a game is a bet at all, so sizing off the price was measuring a
// different thing from the one being selected on — and with no edge bar it
// broke outright: a qualifying game at a bad price produced a stake of zero,
// which is not a bet size, it is a contradiction. SPOT is this lineup against
// this arm in this park, in points of hit probability over league average, so
// a stake that scales with it puts more money on softer spots. The price is
// still shown; it just no longer sets the size.
const stakeFor = d => Math.max(0, +((d.spotDelta || 0) * 100).toFixed(1)) * PER_SPOT_PT;
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

// ── per-game locking ────────────────────────────────────────────────────────
// One game, one pair, one alert, the moment BOTH its lineups are posted. No
// slate-wide ranking and no waves: cross-game competition was never real edge,
// it just meant a good spot lost its slot to a better one somewhere else. A
// game is judged on its own merits and alerted only if the model would
// actually bet it at your price.
//
// The lineups are the lock, and a clock is not. An earlier version also waited
// until an hour before first pitch, which held a pick back long after the
// information that decides it was already public — lineups usually post three
// to four hours out — and spent the difference doing nothing except shortening
// the window to shop the price.
//
// What has not changed is that nothing locks blind. The two paths in the model
// are not variations on each other: with a posted lineup the candidates ARE
// the nine men batting, in their real slots, at a 0.985 scratch factor;
// without one they are the whole roster with slots guessed from plate
// appearances per game. Locking early does not give a slightly worse pick, it
// gives different players — so a game with no lineup is simply not eligible.

// One hour, in milliseconds. The ladder's lock still uses it; the per-game
// doubles no longer do.
const HOUR = 3600000;

// Both lineups posted, nine deep — the same test buildBoard applies.
const posted = g => {
  const lu = g.lineups || {};
  return Array.isArray(lu.homePlayers) && lu.homePlayers.length >= 9
      && Array.isArray(lu.awayPlayers) && lu.awayPlayers.length >= 9;
};

// ── THE LADDER ──────────────────────────────────────────────────────────────
// One bet a day, one leg, the best play on the slate, staked off the
// compounding ladder in dd-model.js. The whole point of it living here rather
// than only on the dashboard is that the rung has to be PUBLISHED before first
// pitch to mean anything — data/ladder.json is committed by the workflow the
// moment the bet is opened, so the repo's own history timestamps it.
//
// Timing, stated plainly because it is the one real compromise: the rung is
// placed at the FIRST lock of the day — the first game inside its hour with a
// posted lineup — and chosen from every game whose lineup is already up at
// that instant. Games that post later cannot be considered, because by then
// the early game has started and skipping it was never an option we had. So
// "best play of the day" means best play available at the moment we must
// choose, which is the only version of it that can actually be bet.
const LADDER_FILE = "data/ladder.json";
// The price a single "to record a hit" prop is actually offered at. Overridden
// with DD_LEG_PRICE. This is an assumption until the real number is confirmed,
// and it decides both whether there is a bet and how fast the ladder climbs.
const LEG_PRICE = +(process.env.DD_LEG_PRICE || -250);

// Read the ledger as the UNION of this runner's copy and what is actually
// published on origin/main.
//
// Either one alone is unsafe. The local file alone misses a rung another run
// published, so a fresh checkout would place a second rung for the same day
// and announce it. Origin alone misses a rung this run placed but has not
// managed to push yet, so it would announce that one twice. Taking both, keyed
// by date, means a rung announced anywhere is never announced again — which is
// the only guarantee that matters, because a Telegram message cannot be
// unsent.
function readLadderLocal() {
  try { const L = JSON.parse(readFileSync(LADDER_FILE, "utf8")); if (Array.isArray(L.bets)) return L; } catch (e) {}
  return null;
}
function readLadderOrigin() {
  try {
    const raw = execSync(`git show origin/main:${LADDER_FILE} 2>/dev/null`, { encoding: "utf8" });
    const L = JSON.parse(raw);
    return Array.isArray(L.bets) ? L : null;
  } catch (e) { return null; }   // not fetched, not committed yet, or no git
}
// Rows this runner has placed, held in gitignored state so a git operation
// cannot lose them. data/ladder.json is tracked and publish() rebases; a row
// written but not yet pushed gets reverted with the file. Keeping a copy here
// means the next pass restores it into the ledger and tries the push again,
// instead of the pick simply disappearing from the record.
let stateRows = [];
function readLadderFile() {
  const local = readLadderLocal(), origin = readLadderOrigin();
  const base = local || origin || { v: 1, sport: "MLB", cfg: M.LADDER, bets: [] };
  if (!local || !origin) {
    if (!stateRows.length) return base;
    const seen = new Set(base.bets.map(b => b.date));
    return { ...base, bets: base.bets.concat(stateRows.filter(b => !seen.has(b.date))) };
  }
  const byDate = new Map();
  // Origin first, so a row that reached the repo wins over a local draft of
  // the same day; then anything local, then anything this runner placed that
  // neither has — the last of which is the row a failed push reverted away.
  for (const b of origin.bets) byDate.set(b.date, b);
  for (const b of local.bets) if (!byDate.has(b.date)) byDate.set(b.date, b);
  for (const b of stateRows) if (!byDate.has(b.date)) byDate.set(b.date, b);
  const merged = [...byDate.values()].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (merged.length !== local.bets.length) {
    console.log(`ladder: merged ledger — ${local.bets.length} local + ${origin.bets.length} published = ${merged.length} rows.`);
  }
  return { ...base, bets: merged };
}
function writeLadderFile(L) {
  L.updated = new Date().toISOString();
  L.cfg = M.LADDER;
  L.state = (({ account, base, stake, rung, cycle, pl, cycles, canFund }) =>
    ({ account, base, stake, rung, cycle, pl, cycles, canFund }))(M.ladder(L.bets));
  mkdirSync("data", { recursive: true });
  writeFileSync(LADDER_FILE, JSON.stringify(L, null, 1));
}

async function ladderPlace(day, games, D, saveState) {
  // THE dedupe, and it lives in state.json rather than in the ledger.
  //
  // data/ladder.json is a TRACKED file, and publish() runs
  // `git pull --rebase --autostash`. When a push fails, that rebase reverts
  // tracked files to origin's copy — so a rung written but not yet pushed is
  // wiped from the working tree, the next pass sees no row for today, and it
  // places and alerts a SECOND player for the same day. That is exactly how
  // Garcia became Diaz, and Arraez became Tatis before it.
  //
  // state.json is gitignored, so no git operation can touch it. It is the same
  // store the per-game doubles have always deduped through, and those have
  // never double-alerted. Checked first and written the instant the rung is
  // placed, before the alert is even sent.
  if (D && D.ladderDay === day) return;
  const L = readLadderFile();
  if (L.bets.some(b => b.date === day)) {                    // belt: the ledger agrees
    if (D) { D.ladderDay = day; if (saveState) saveState(); }
    return;
  }
  if (L.bets.some(b => b.status === "open")) {               // never stack rungs
    console.log("ladder: previous rung still open — not placing another.");
    return;
  }
  const now = Date.now();
  // The ladder keeps the clock, and deliberately does not use the doubles'
  // lineup trigger. It makes ONE choice across the whole slate, so the moment
  // it chooses decides how much of that slate is confirmed. Locking when the
  // first game's lineups post would fire three or four hours out, when almost
  // every other game is still a projection, and the cross-slate comparison it
  // is supposed to make would be mostly guesswork. An hour before the first
  // pitch, most lineups are in and the field is real.
  //
  // A double is the opposite case: it is judged on one game alone, so that
  // game's own lineups are all the information it will ever need and there is
  // nothing to wait for once they land.
  const locking = games.some(g => { const t = Date.parse(g.gameDate); return !isNaN(t) && now >= t - HOUR && now < t; });
  if (!locking) return;
  // EVERY game that has not started, not just the ones with a lineup up. The
  // model already prices an unposted bat off his projected slot and multiplies
  // by his real chance of starting (starts per team game, capped at 0.95;
  // posted is 0.985, and anyone under 0.55 is dropped as a part-timer). So a
  // projected leg and a confirmed leg are directly comparable in expected
  // value, and a confirmed regular outranks an unposted equivalent on its own
  // without needing a rule to say so.
  //
  // Restricting this to posted lineups threw away most of the slate: at the
  // first lock of the day only the earliest game or two has a lineup up, so
  // the ladder was picking the best of two games and calling it the best play
  // of the day. The doubles alerter still waits for a confirmed lineup per
  // game — that is a different bet on a single game, and it can afford to
  // wait because each game locks on its own clock. The ladder cannot: it
  // chooses once, for the whole slate.
  const live = games.filter(g => now < Date.parse(g.gameDate));
  if (!live.length) { console.log("ladder: at lock, every game has already started — skipping today."); return; }

  const st = M.ladder(L.bets);
  if (!st.canFund) {
    await tg(`🪜 <b>LADDER STOPPED</b>\nRung ${st.rung} of cycle ${st.cycle} needs ${money(st.stake)} and the account is down to ${money(st.account)}.\nThe escalation has no next move that is not a deposit. No bet.`);
    if (D) { D.ladderDay = day; if (saveState) saveState(); }
    L.bets.push({ date: day, status: "skipped", reason: "account cannot fund the rung",
                  stake: st.stake, account: st.account, published: new Date().toISOString() });
    writeLadderFile(L);
    return;
  }

  const board = await M.buildBoard({
    getJSON: j, day, cal: null, american: PRICE,
    schedule: { dates: [{ games: live }] },
    onStatus: m => console.log("  · ladder:", m)
  });
  const lbe = 1 / M.decFromAmerican(LEG_PRICE);
  // Nobody rides the ladder more than two days running; after that he sits out
  // one placement. Computed from the ledger rather than from anything held in
  // this runner, so a fresh checkout applies the same bench.
  const blocked = M.ladderBlocked(L.bets);
  let best = null, benched = null;
  for (const c of board.candidates) {
    const edge = c.p - lbe;                       // c.p already carries scratch risk
    if (blocked.has(M.pickKey({ playerId: c.id, pick: c.name }))) {
      if (!benched || edge > benched.edge) benched = { c, edge };
      continue;
    }
    if (!best || edge > best.edge) best = { c, edge };
  }
  if (benched) {
    console.log(`ladder: ${benched.c.name} benched — two days running, sitting this one out` +
      `${best ? ` (he was ${benched.edge > best.edge ? "ahead of" : "behind"} ${best.c.name})` : ""}.`);
  }
  if (!best) { console.log("ladder: no candidate could be scored."); return; }
  if (best.edge < MIN_EDGE) {
    console.log(`ladder: best leg ${best.c.name} at ${(best.edge * 100).toFixed(1)}pts — under the bar, no rung today.`);
    if (D) { D.ladderDay = day; if (saveState) saveState(); }
    L.bets.push({ date: day, status: "noplay", reason: `best leg ${(best.edge * 100).toFixed(1)}pts, under the +${(MIN_EDGE * 100).toFixed(1)}pt bar`,
                  published: new Date().toISOString() });
    writeLadderFile(L);
    return;
  }

  const c = best.c, g = live.find(x => x.gamePk === c.gk);
  const row = {
    id: `${day}:ladder`, date: day, sport: "MLB",
    published: new Date().toISOString(),
    firstPitch: g ? g.gameDate : null,
    cycle: st.cycle, rung: st.rung, seed: st.base,
    stake: st.stake, price: LEG_PRICE, p: c.p, edge: best.edge,
    pick: c.name, playerId: c.id, slot: c.slot, gk: c.gk,
    posted: !!c.posted, startProb: c.startProb,
    teams: `${c.teamName} ${c.isHome ? "vs" : "@"} ${c.oppName}`, sp: c.spName || null,
    fromGames: live.length, status: "open"
  };
  L.bets.push(row);
  // Claim the day in gitignored state BEFORE writing the ledger or sending the
  // alert. If anything below fails, the worst case is a rung that was claimed
  // and not announced — recoverable. The reverse, announced and not claimed,
  // is what sends a second player to a phone.
  if (D) {
    D.ladderDay = day; D.ladderPick = { pick: c.name, playerId: c.id, gk: c.gk };
    D.ladderRows = (D.ladderRows || []).filter(b => b.date !== day).concat([row]);
    stateRows = D.ladderRows;
    if (saveState) saveState();
  }
  writeLadderFile(L);

  const risk = M.ladderRisk(c.p, LEG_PRICE, st);
  const first = g ? new Date(g.gameDate).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "—";
  await tg(
    `🪜 <b>THE LADDER</b> · cycle ${st.cycle}, day ${st.rung} of ${M.LADDER.rungs}\n` +
    `➖➖➖➖➖➖➖➖\n` +
    `<b>${money(st.stake)}</b> on <b>${c.name}</b> to record a hit\n` +
    `#${c.slot} · ${c.teamName} ${c.isHome ? "vs" : "@"} ${c.oppName} · ${first} ET\n` +
    `vs ${c.spName || "SP TBD"}\n\n` +
    `🎯 <b>BET ONLY BETTER THAN ${M.amOdds(c.p - MIN_EDGE)}</b>\n` +
    `${pct(c.p)} to hit · fair ${M.amOdds(c.p)} · ${pts(best.edge)}pts vs ${LEG_PRICE}\n` +
    `${c.posted ? "✓ Confirmed in the lineup" : `⚠ Lineup not posted — projected #${c.slot}, ${pct(c.startProb)} to start (already priced in)`}\n` +
    `Best of ${board.candidates.length} bats across all ${live.length} game${live.length === 1 ? "" : "s"} on the slate\n` +
    `${live.filter(posted).length} of ${live.length} games had confirmed lineups at lock\n` +
    `${benched && benched.edge > best.edge ? `⏸ ${benched.c.name} rated higher but has ridden two days running — benched\n` : ""}` +
    `\n` +
    `<i>Your money at risk: ${money(st.base)} (the seed). Riding on top of it: ${money(st.stake - st.base)} of theirs.\n` +
    (risk ? `Five straight at this rate completes ${(risk.cycleWin * 100).toFixed(1)}% of the time for ${money(risk.cycleProfit)}. Account ${money(st.account)}.` : "") +
    `</i>`
  );
  console.log(`ladder: ${money(st.stake)} on ${c.name} (${(best.edge * 100).toFixed(1)}pts), cycle ${st.cycle} day ${st.rung}.`);
}

async function ladderSettle(hitsById, finalByGk) {
  const L = readLadderFile();
  const b = L.bets.find(x => x.status === "open");
  if (!b || b.playerId == null) return;
  const hits = hitsById[b.playerId];
  const got = (hits || 0) >= 1;
  if (!got && !finalByGk[b.gk]) return;                       // still live
  b.status = got ? "won" : "lost";
  b.hits = hits || 0;
  b.settled = new Date().toISOString();
  writeLadderFile(L);
  const st = M.ladder(L.bets);
  const C = M.LADDER;
  if (got) {
    const ret = +(b.stake * M.decFromAmerican(b.price)).toFixed(2);
    const done = b.rung >= C.rungs;
    await tg(
      `🪜 ${done ? "<b>CYCLE COMPLETE</b>" : `<b>RUNG ${b.rung} IN</b>`} — ${b.pick} had ${b.hits} hit${b.hits === 1 ? "" : "s"}\n` +
      `${money(b.stake)} returns ${money(ret)}\n` +
      (done
        ? `All ${C.rungs} days. ${money(b.seed)} of yours became ${money(ret)} — ${money(ret - b.seed)} profit.\nAccount ${money(st.account)}. Next cycle seeds at ${money(st.base)} (10% of it).`
        : `It all rides tomorrow: <b>${money(ret)}</b> on day ${b.rung + 1} of ${C.rungs}.\nStill only ${money(b.seed)} of your money in this cycle.`)
    );
  } else {
    await tg(
      `🪜 <b>CYCLE BUSTED</b> on day ${b.rung} of ${C.rungs} — ${b.pick} went hitless\n` +
      `Cost: ${money(b.seed)}, the seed, which is all it was ever going to cost whichever day it landed.\n` +
      `Account ${money(st.account)}. Next cycle restarts ${Math.round(C.missGain * 100)}% bigger at <b>${money(st.base)}</b>.` +
      (st.canFund ? "" : `\n⚠ The account cannot fund that rung. The ladder stops here.`)
    );
  }
  console.log(`ladder: ${b.pick} ${got ? "HIT" : "hitless"} — account ${money(st.account)}.`);
}

// On a night when no double cleared the bar the main grading pass never runs,
// but an open rung still has to be graded — it is a different bet on a
// different game. This fetches just that one boxscore.
async function settleLadderOnly(games) {
  const b = readLadderFile().bets.find(x => x.status === "open");
  if (!b || b.gk == null) return;
  const g = games.find(x => x.gamePk === b.gk);
  if (!g || g.status?.abstractGameState === "Preview") return;
  const bx = await j(`${API}/game/${b.gk}/boxscore`);
  const hitsById = {};
  ["home", "away"].forEach(side => {
    const pl = bx?.teams?.[side]?.players || {};
    Object.values(pl).forEach(pp => { const st = pp?.stats?.batting; if (st && pp.person?.id != null) hitsById[pp.person.id] = +st.hits || 0; });
  });
  const fin = { [b.gk]: g.status?.abstractGameState === "Final" && !/postpon|suspend|cancel/i.test(g.status?.detailedState || "") };
  await ladderSettle(hitsById, fin);
}

const legLine = c => `• <b>${c.name}</b> #${c.slot} · ${av(c.avg)}→${av(c.proj)} proj · ${c.eAb.toFixed(1)} AB\n  vs ${c.sp || "SP TBD"}${c.spBaa != null ? " (" + av(c.spBaa) + " BAA" + (c.spHr9 != null ? ", " + c.spHr9.toFixed(1) + " HR/9" : "") + ")" : ""}${c.plt === "adv" ? " ▲plat" : c.plt === "dis" ? " ▽plat" : ""} · <b>${pct(c.p)}</b>`;

async function alertGame(day, g, d) {
  const first = new Date(g.gameDate).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  await tgLong(
    `⚾ <b>TWO BAIGGER</b> · ${d.teams}\n` +
    `First pitch ${first} ET · ${d.venue || ""}\n` +
    `➖➖➖➖➖➖➖➖\n` +
    // The double is offered anywhere from +100 to -175 depending on the legs,
    // and this job cannot see the board's price. So it states the threshold
    // instead of asserting an edge against a number it had to guess.
    `🎯 <b>FAIR PRICE ${M.amOdds(d.prob)}</b> — anything better than that is value\n` +
    `${pct(d.prob)} both hit\n` +
    `<i>Stake ${money(stakeFor(d))} — ${pts(d.spotDelta)}pts of spot × ${money(PER_SPOT_PT)}\n` +
    `Checked against ${PRICE > 0 ? "+" : ""}${PRICE}: edge ${(d.edge * 100 >= 0 ? "+" : "") + (d.edge * 100).toFixed(1)}pts` +
      `${d.edge > 0 ? "" : " — no edge at that price, shop for a better one"}</i>\n` +
    `Soft arm ${pts(d.soft)}pts (bar +${(MIN_SOFT * 100).toFixed(1)}) · ${d.sameTeam ? "SAME TEAM" : "OPPOSING"} · correlation +${(d.lift * 100).toFixed(1)}pts over naive\n\n` +
    `${legLine(d.a)}\n${legLine(d.b)}\n\n` +
    `<i>SPOT ${pts(d.spotDelta)}pts vs league (soft arm ${pts(d.soft)} · bats ${pts(d.offIdx)})</i>`
  );
}

async function main() {
  const day = M.slateYmd();
  const sched = await j(`${API}/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team,venue,lineups`);
  const games = (sched?.dates?.[0]?.games || []).filter(g => !/postpon|suspend|cancel/i.test(g.status?.detailedState || ""));
  if (!games.length) { console.log(`No MLB games ${day}.`); return; }

  let blob = {};
  try { if (existsSync(STATE_FILE)) blob = JSON.parse(readFileSync(STATE_FILE, "utf8")) || {}; } catch (e) { console.log("State read failed:", e.message); }
  const D = blob.dd = blob.dd || {};
  D.record = D.record || { w: 0, l: 0 };
  D.bets = D.bets || {};              // `${day}:${gamePk}` -> { date, teams, gk, double, results }
  D.seen = D.seen || {};              // `${day}:${gamePk}` -> "bet" | "noedge" | "missed"
  D.cal = D.cal || { v: SNAP_V, legs: {}, global: { n: 0, hits: 0, sump: 0 } };
  // Rows this runner has published, held where git cannot revert them. Loaded
  // before anything reads the ledger, because readLedger() merges them in.
  ledgerStateRows = Array.isArray(D.ledgerRows) ? D.ledgerRows : [];
  if (D.cal.v !== SNAP_V) { console.log("Model version changed — resetting calibration."); D.cal = { v: SNAP_V, legs: {}, global: { n: 0, hits: 0, sump: 0 } }; }
  let changed = false;

  // ── Migrate off the board-based schemes ───────────────────────────────────
  // The changeover happens mid-evening with games in flight, so adopt today's
  // already-locked doubles rather than dropping them: without this their
  // CASHED/DEAD never arrives and they never reach the record. Seeding `seen`
  // at the same time stops a game that was already decided today from getting
  // a second, per-game alert.
  const adopt = (d, results) => {
    if (!d || d.gk == null) return;
    const k = `${day}:${d.gk}`;
    if (!D.bets[k]) D.bets[k] = { date: day, teams: d.teams, gk: d.gk, double: d, results: results || {} };
    D.seen[k] = "bet"; changed = true;
  };
  for (const b of Object.values(D.boards || {})) {
    if (b.date !== day) continue;
    (b.picks || []).forEach(d => adopt(d, (b.results || {})[`${d.a.id}_${d.b.id}`]));
    // Watchlist doubles were shown but never bet — mark their games decided so
    // they are not re-alerted, without inventing a bet that was never placed.
    (b.watch || []).forEach(d => { const k = `${day}:${d.gk}`; if (!D.seen[k]) { D.seen[k] = "noedge"; changed = true; } });
  }
  if (D.snap && D.snap.date === day) {
    (D.snap.doubles || []).slice(0, 3).forEach(d => adopt(d, (D.results || {})[`${d.a.id}_${d.b.id}`]));
  }
  // Any game the old scheme had locked but that produced no adopted bet is
  // still a decided game.
  for (const k of Object.keys(D.lockedGames || {})) {
    if (k.startsWith(`${day}:`) && !D.seen[k]) { D.seen[k] = "noedge"; changed = true; }
  }
  const migrated = Object.keys(D.bets).filter(k => k.startsWith(`${day}:`)).length;
  for (const k of ["snap", "lockDate", "results", "boards", "lockedGames", "waveSent"]) {
    if (D[k] !== undefined) { delete D[k]; changed = true; }
  }
  if (migrated) console.log(`Carried ${migrated} of today's doubles across from the board scheme.`);

  // Keyed per game per day now, so prune anything older than a few days to
  // stop state.json growing without bound.
  const keepFrom = M.ymd(new Date(Date.now() - 3 * 86400000));
  for (const store of [D.bets, D.seen, D.cal.graded || {}]) {
    for (const k of Object.keys(store)) {
      const d0 = k.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d0) && d0 < keepFrom) { delete store[k]; changed = true; }
    }
  }
  // The held ledger rows keep a longer window than D.bets: they are the only
  // copy of a row whose push has not landed, and three days is not much rope
  // if the repo is unreachable over a weekend. Two weeks bounds the file
  // without making a lost row unrecoverable.
  const rowsFrom = M.ymd(new Date(Date.now() - 14 * 86400000));
  if (ledgerStateRows.length) {
    const kept = ledgerStateRows.filter(b => !b.date || b.date >= rowsFrom);
    if (kept.length !== ledgerStateRows.length) { ledgerStateRows = kept; D.ledgerRows = kept; changed = true; }
  }

  // Before deciding anything new, make the published record agree with what
  // state says was actually bet — on every day state still holds, not just
  // today. Placed above the per-game loop and above the "nothing alerted yet"
  // return so a quiet day still repairs a noisy one.
  try { reconcileLedger(D, games); } catch (e) { console.log("ledger reconcile failed:", e.message); }

  const now = Date.now();
  for (const g of games) {
    const t = Date.parse(g.gameDate); if (isNaN(t)) continue;
    const key = `${day}:${g.gamePk}`;
    if (D.seen[key]) continue;                       // already decided on this game
    if (now >= t) {                                  // never alert a game already underway
      D.seen[key] = "missed"; changed = true;
      console.log(`game ${g.gamePk}: first pitch passed without a lineup — skipped.`);
      continue;
    }
    // Both lineups posted IS the lock. The clock is not: waiting for a fixed
    // hour before first pitch held a pick back long after the information that
    // decides it was already public, which costs shopping time on the price
    // for no gain. Lineups usually post three to four hours out, so this locks
    // earlier and on better information — and it never locks blind, because a
    // game with no lineup simply is not eligible yet.
    if (!posted(g)) continue;

    const snap = await computeDoubles(day, [g], D.cal);
    const d = snap && snap.doubles && snap.doubles[0];
    if (!d) { console.log(`game ${g.gamePk}: no pair could be built.`); D.seen[key] = "noedge"; changed = true; continue; }
    // No edge bar on the double any more: a soft arm is the whole test. The
    // price is still reported on every alert, because whether it is worth
    // taking at the number your book shows is a separate question from
    // whether the spot qualifies — and the alert answers both rather than
    // pretending the second one decides eligibility.
    if (d.soft < MIN_SOFT) {
      D.seen[key] = "noedge"; changed = true;
      console.log(`game ${g.gamePk} (${d.teams}): soft arm ${pts(d.soft)}pts, under +${(MIN_SOFT * 100).toFixed(1)} — no bet.`);
      continue;
    }
    await alertGame(day, g, d);
    const meta = {
      date: day, teams: d.teams, gk: g.gamePk, double: d, results: {},
      published: new Date().toISOString(), firstPitch: g.gameDate,
      price: PRICE, stakeRate: PER_SPOT_PT, stake: +stakeFor(d).toFixed(2)
    };
    D.bets[key] = meta;
    D.seen[key] = "bet"; changed = true;
    ledgerOpen(key, day, g, d, D, meta);
    console.log(`game ${g.gamePk} (${d.teams}): ALERTED at edge ${(d.edge * 100).toFixed(1)}pts.`);
  }

  // ── The ladder's one rung for today ──
  // Placed after the per-game pass so any game that just locked is already in
  // the posted set. Failures here must never take the doubles tracker down
  // with them — the ladder is one bet, the tracker is the record.
  // Restore any row a failed push reverted out of the tracked ledger, so it is
  // re-written and re-pushed rather than lost.
  stateRows = Array.isArray(D.ladderRows) ? D.ladderRows : [];
  if (stateRows.length) {
    const L0 = readLadderFile();
    if (L0.bets.length !== (readLadderLocal()?.bets?.length ?? -1)) {
      writeLadderFile(L0);
      console.log(`ladder: restored ${stateRows.length} row(s) from state into the ledger.`);
    }
  }
  const saveState = () => { try { writeFileSync(STATE_FILE, JSON.stringify(blob)); } catch (e) { console.log("State write failed:", e.message); } };
  try { await ladderPlace(day, games, D, saveState); } catch (e) { console.log("ladder place failed:", e.message); }

  // ── Live tracking of everything alerted today ──
  const todays = Object.entries(D.bets).filter(([, b]) => b.date === day).map(([k, b]) => ({ k, b }));
  // An open ladder rung still has to be graded even on a night when no double
  // cleared the bar — those are different bets on different games.
  if (!todays.length) {
    try { await settleLadderOnly(games); } catch (e) { console.log("ladder settle failed:", e.message); }
    try { writeFileSync(STATE_FILE, JSON.stringify(blob)); } catch (e) { console.log("State write failed:", e.message); }
    console.log("Nothing alerted yet today."); return;
  }

  const openLadder = (() => { try { return readLadderFile().bets.find(b => b.status === "open") || null; } catch (e) { return null; } })();
  const gks = [...new Set([...todays.map(x => x.b.gk), ...(openLadder && openLadder.gk != null ? [openLadder.gk] : [])])];
  const fin = {};
  games.forEach(g => { if (gks.includes(g.gamePk)) fin[g.gamePk] = g.status?.abstractGameState === "Final" && !/postpon|suspend|cancel/i.test(g.status?.detailedState || ""); });
  const hitsById = {};
  await M.pool(gks.filter(pk => { const g = games.find(x => x.gamePk === pk); return g && g.status?.abstractGameState !== "Preview"; }), async pk => {
    const bx = await j(`${API}/game/${pk}/boxscore`);
    ["home", "away"].forEach(side => {
      const pl = bx?.teams?.[side]?.players || {};
      Object.values(pl).forEach(pp => { const st = pp?.stats?.batting; if (st && pp.person?.id != null) hitsById[pp.person.id] = +st.hits || 0; });
    });
  }, 5);

  let cashed = todays.filter(x => x.b.results.cashed).length;
  let dead = todays.filter(x => x.b.results.dead).length;
  const tally = () => `Today: 💣 ${cashed} · 💀 ${dead} of ${todays.length}  ·  All-time ${D.record.w}-${D.record.l}`;

  const gradeLeg = (leg, gotHit) => {
    const seen = D.cal.graded = D.cal.graded || {};
    const gk = `${day}:${leg.id}`;
    if (seen[gk]) return;
    seen[gk] = 1;
    M.record(D.cal, leg.id, leg.p, gotHit);
    changed = true;
  };

  for (const { b } of todays) {
    const st = b.results;
    if (st.cashed || st.dead) continue;
    const d = b.double;
    const hA = (hitsById[d.a.id] || 0) >= 1, hB = (hitsById[d.b.id] || 0) >= 1;
    const inCount = (hA ? 1 : 0) + (hB ? 1 : 0);
    if (inCount === 2) {
      cashed++; D.record.w++;
      gradeLeg(d.a, true); gradeLeg(d.b, true);
      await tg(`💣 <b>CASHED — ${b.teams}</b>\nBoth hit! ${d.a.name} + ${d.b.name}\n${tally()}`);
      st.cashed = true; st.hits = [hitsById[d.a.id] || 0, hitsById[d.b.id] || 0];
      changed = true; console.log(`${b.teams} cashed.`);
      ledgerSettle(`${day}:${b.gk}`, true, st.hits, D);
    } else if (fin[b.gk]) {
      dead++; D.record.l++;
      gradeLeg(d.a, hA); gradeLeg(d.b, hB);
      const cold = [!hA ? d.a.name : null, !hB ? d.b.name : null].filter(Boolean).join(" & ");
      await tg(`💀 <b>DEAD — ${b.teams}</b>\nHitless: ${cold} (final)\n${tally()}`);
      st.dead = true; st.hits = [hitsById[d.a.id] || 0, hitsById[d.b.id] || 0];
      changed = true; console.log(`${b.teams} dead.`);
      ledgerSettle(`${day}:${b.gk}`, false, st.hits, D);
    } else if (inCount === 1 && !st.half) {
      const got = hA ? d.a.name : d.b.name, need = hA ? d.b.name : d.a.name;
      await tg(`✅ <b>1/2 IN — ${b.teams}</b>\n${got} has a hit · need ${need}`);
      st.half = true; changed = true; console.log(`${b.teams} half.`);
    }
  }

  try { await ladderSettle(hitsById, fin); } catch (e) { console.log("ladder settle failed:", e.message); }

  // ── Day-end summary (once every game has been decided and every bet settled) ──
  const everyGameDecided = games.every(g => D.seen[`${day}:${g.gamePk}`]);
  const allSettled = everyGameDecided && todays.every(({ b }) => b.results.cashed || b.results.dead);
  if (allSettled && D.summaryDate !== day) {
    const won = todays.filter(({ b }) => b.results.cashed).length;
    const skipped = games.filter(g => D.seen[`${day}:${g.gamePk}`] === "noedge").length;
    const missed = games.filter(g => D.seen[`${day}:${g.gamePk}`] === "missed").length;
    const n = D.record.w + D.record.l;
    const pctW = n ? Math.round(D.record.w / n * 100) : 0;
    const gl = D.cal.global;
    const calLine = gl.n > 0
      ? `\nModel calibration: predicted <b>${pct(gl.sump / gl.n)}</b> per leg, actual <b>${pct(gl.hits / gl.n)}</b> over ${gl.n} graded legs`
      : "";
    await tg(`📊 <b>DAY DONE</b> · ${prettyDate(day)}\n` +
      `Bets: <b>${won}/${todays.length}</b> cashed · ${skipped} game${skipped === 1 ? "" : "s"} had no edge` +
      (missed ? ` · ${missed} missed (no lineup)` : "") +
      `\nAll-time record: <b>${D.record.w}-${D.record.l}</b> (${pctW}%)${calLine}`);
    D.summaryDate = day; changed = true; console.log("Day summary sent.");

    try {
      mkdirSync("data", { recursive: true });
      const pub = { v: D.cal.v, updated: new Date().toISOString(), through: day, record: D.record, global: gl, legs: D.cal.legs };
      writeFileSync(PUBLIC_LOG, JSON.stringify(pub));
      D.publishedDate = day;
      console.log(`Published ${PUBLIC_LOG} (${Object.keys(D.cal.legs).length} players).`);
    } catch (e) { console.log("Publish failed:", e.message); }
  }

  try { writeFileSync(STATE_FILE, JSON.stringify(blob)); } catch (e) { console.log("State write failed:", e.message); }
  console.log(`Done — 💣 ${cashed} / 💀 ${dead} of ${todays.length} alerted.${changed ? " [state updated]" : ""}`);
}

// Run when invoked as a script; stay inert when imported, so the ledger
// recovery logic can be exercised by a test instead of only in production.
const _direct = (() => {
  const entry = process.argv[1];
  if (!entry) return false;                 // -e / REPL: not a script run
  try { return import.meta.url === pathToFileURL(entry).href; } catch (e) { return true; }
})();
if (_direct) main().catch(e => { console.error(e); process.exit(1); });

export { readLedger, writeLedger, ledgerOpen, ledgerSettle, reconcileLedger, rememberLedgerRow, _setLedgerStateRows };
