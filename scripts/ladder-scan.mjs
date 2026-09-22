#!/usr/bin/env node
// What the ladder WOULD pick right now, across every sport, without placing,
// publishing or alerting anything.
//
//   node scripts/ladder-scan.mjs              today's slate
//   node scripts/ladder-scan.mjs 2026-09-24   a given slate day
//
// The same candidate builders and the same choose() the alerter runs, so a
// scan is a faithful preview of a lock — except that it ignores the clock.
import { readFileSync, existsSync } from "fs";
import M from "../dd-model.js";
import { fetchHitQuotes, lookup as quoteFor } from "./kalshi-quotes.mjs";
import { slateStarts, mlbCandidates, nbaCandidates, nflCandidates, sportRecords, benched, choose, getJSON } from "./ladder-sports.mjs";

const day = process.argv[2] || M.slateYmd();
const BAND = { lo: +(process.env.DD_BAND_LO || -350), hi: +(process.env.DD_BAND_HI || -200) };
const LEG_PRICE = +(process.env.DD_LEG_PRICE || M.LADDER.price);
const now = Date.now();
const log = m => console.log(m);

const L = existsSync("data/ladder.json") ? JSON.parse(readFileSync("data/ladder.json", "utf8")) : { bets: [] };
const sched = await getJSON(`${M.API}/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team,venue,lineups`);
const games = (sched?.dates?.[0]?.games || []).filter(g => !/postpon|suspend|cancel/i.test(g.status?.detailedState || ""));
const other = await slateStarts(day);
const starts = games.map(g => ({ sport: "MLB", start: g.gameDate })).concat(other);
log(`slate ${day}: ${games.length} MLB, ${other.filter(g => g.sport === "NBA").length} NBA, ${other.filter(g => g.sport === "NFL").length} NFL`);
if (starts.length) {
  const first = Math.min(...starts.map(g => Date.parse(g.start)));
  log(`first game ${new Date(first).toISOString()} → the ladder locks at ${new Date(first - 3600e3).toISOString()}`);
}

const cands = [];
const liveMlb = games.filter(g => now < Date.parse(g.gameDate));
if (liveMlb.length) {
  try {
    const board = await M.buildBoard({ getJSON, day, cal: null, american: -175, schedule: { dates: [{ games: liveMlb }] }, onStatus: () => {} });
    let quotes = null;
    try { quotes = await fetchHitQuotes(); } catch (e) { log("MLB: Kalshi down — " + e.message); }
    const live_ = quotes && quotes.size >= 10;
    const r = mlbCandidates(board, liveMlb, c => {
      if (!live_) return { american: LEG_PRICE, ask: 1 / M.decFromAmerican(LEG_PRICE), source: "assumed" };
      const g = liveMlb.find(x => x.gamePk === c.gk);
      const q = quoteFor(quotes, c.name, g && g.gameDate);
      return q ? { american: q.american, ask: q.ask, bid: q.bid, spread: q.spread, ticker: q.ticker, source: "kalshi" } : null;
    });
    log(`MLB: ${r.candidates.length} priced of ${board.candidates.length} bats (${r.unlisted} not on Kalshi)${live_ ? "" : " — ASSUMED price"}`);
    cands.push(...r.candidates);
  } catch (e) { log("MLB failed: " + e.stack); }
} else log("MLB: nothing still to play");
for (const [sport, fn] of [["NBA", nbaCandidates], ["NFL", nflCandidates]]) {
  if (!other.some(g => g.sport === sport && !g.started)) { log(`${sport}: no games still to play`); continue; }
  try {
    const t = Date.now();
    const r = await fn(day, { say: () => {} });
    log(`${sport}: ${r.candidates.length} priced — ${r.note} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
    cands.push(...r.candidates);
  } catch (e) { log(`${sport} failed: ${e.stack}`); }
}

const res = choose(cands, sportRecords(L.bets), { band: BAND, blocked: benched(L.bets, M.LADDER.maxStreak) });
const inBand = s => cands.filter(c => c.sport === s && c.price <= BAND.hi && c.price >= BAND.lo).length;
log(`\n${cands.length} props · in band: MLB ${inBand("MLB")}, NBA ${inBand("NBA")}, NFL ${inBand("NFL")} · eligible ${res.ranked.length} · model below price ${res.doubted.length} · benched ${res.benched.length}`);
log("\n  #  sport player                     prop                         price   chance  model  context");
res.ranked.slice(0, 15).forEach((c, i) => log(
  `${String(i + 1).padStart(3)}  ${c.sport.padEnd(5)} ${c.player.slice(0, 26).padEnd(26)} ${c.need.slice(0, 28).padEnd(28)} ${String(c.price).padStart(5)}  ${(c.pAdj * 100).toFixed(1).padStart(5)}%  ${(c.p * 100).toFixed(1).padStart(5)}%  ${c.context >= 0 ? "+" : ""}${c.context.toFixed(2)}`));
for (const s of ["MLB", "NBA", "NFL"]) {
  const top = res.ranked.find(c => c.sport === s);
  if (top) log(`best ${s}: ${top.player} ${top.need} @ ${top.price} — ${top.teams} — ${(top.pAdj * 100).toFixed(1)}% · ${top.why.join("; ")}`);
}
log(res.pick ? `\nPICK: ${res.pick.sport} ${res.pick.player} ${res.pick.need} @ ${res.pick.price} (${res.pick.teams})` : "\nPICK: none");
