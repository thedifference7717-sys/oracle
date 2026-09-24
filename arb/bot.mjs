#!/usr/bin/env node
// The trading loop. DRY RUN unless --live is passed.
//
//   node arb/bot.mjs                       # watch pairs.json, print what it would do
//   node arb/bot.mjs --live --max-contracts 20 --max-exposure 200 --min-edge 0.02
//
// Only pairs with "verified": true are traded. Each opportunity is executed
// as two fill-or-kill orders: Kalshi first, then Polymarket. FOK means a leg
// fills completely or not at all, so the only way to end up unhedged is the
// second leg failing after the first filled. When that happens the bot
// retries the hedge once at break-even, and if that fails it sells the Kalshi
// leg back, writes the incident down, and STOPS. It does not keep trading
// with a hole in the book.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as K from "./lib/kalshi.mjs";
import * as P from "./lib/polymarket.mjs";
import { loadPairs, evaluate } from "./lib/pairs.mjs";
import { args } from "./scan.mjs";
import { sleep } from "./lib/http.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const a = args();
const cfg = {
  live: !!a.live,
  pairs: a.pairs || join(HERE, "pairs.json"),
  minEdge: +(a["min-edge"] ?? 0.02),          // dollars per contract, after fees
  maxContracts: +(a["max-contracts"] ?? 20),  // per trade
  maxExposure: +(a["max-exposure"] ?? 200),   // dollars across all open arbs
  interval: +(a.interval ?? 15) * 1000,
  once: !!a.once
};
const STATE = join(HERE, "state.json"), LOG = join(HERE, "trades.jsonl");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { exposure: 0, trades: 0, halted: null };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const log = rec => appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), live: cfg.live, ...rec }) + "\n");

async function execute(r) {
  const { pair, best, pm } = r;
  const { kalshiSide, poly, plan } = best;
  const n = plan.contracts;

  // The books were just read; the market status was cached. Check it again.
  const km = await K.market(pair.kalshi);
  if (km.status !== "active") { console.log(`  skip: Kalshi market is ${km.status}`); return; }

  // 1. Kalshi leg, fill-or-kill.
  const k = await K.buy({ ticker: pair.kalshi, side: kalshiSide, count: n, limit: plan.limitA });
  if (!k.ok) { log({ pair: pair.name, event: "kalshi_not_filled", plan }); console.log("  Kalshi leg did not fill — nothing done"); return; }

  // 2. Polymarket leg, fill-or-kill at the planned limit.
  let p = await P.buy({ token: poly.token, count: n, limit: plan.limitB, tickSize: pm.tickSize, negRisk: pm.negRisk }).catch(e => ({ ok: false, error: e.message }));

  // 3. Missed? Re-read the book and hedge at anything up to break-even.
  if (!p.ok) {
    const b = await P.book(poly.token);
    const ceiling = +(1 - plan.limitA - plan.feesA / n - 0.005).toFixed(3);
    let need = n, worst = null;
    for (const [px, sz] of b.asks) { if (px > ceiling) break; worst = px; need -= sz; if (need <= 0) break; }
    if (need <= 0) p = await P.buy({ token: poly.token, count: n, limit: worst, tickSize: pm.tickSize, negRisk: pm.negRisk }).catch(e => ({ ok: false, error: e.message }));
  }

  if (!p.ok) {
    // 4. Unhedged. Sell the Kalshi leg back into the best bid and stop.
    const kb = await K.book(pair.kalshi);
    const bids = kalshiSide === "yes" ? kb.yesBids : kb.noBids;
    const bestBid = bids.length ? Math.max(...bids.map(l => l[0])) : 0.01;
    const u = await K.sell({ ticker: pair.kalshi, side: kalshiSide, count: n, floor: bestBid }).catch(e => ({ error: e.message }));
    state.halted = `unhedged on ${pair.name} at ${new Date().toISOString()} — check both accounts`;
    save();
    log({ pair: pair.name, event: "UNHEDGED_UNWIND", plan, kalshi: k.order, poly: p, unwind: u });
    console.error(`\n!!! Polymarket leg failed after Kalshi filled. Unwind sent. Bot HALTED.\n!!! ${JSON.stringify(p).slice(0, 300)}`);
    process.exit(2);
  }

  state.exposure += plan.outlay; state.trades++; save();
  log({ pair: pair.name, event: "filled", route: best.describe, plan, kalshi: k.order, poly: p.response });
  console.log(`  FILLED: ${best.describe}`);
}

async function tick(pairs) {
  for (const pair of pairs) {
    let r;
    try { r = await evaluate(pair, { minEdge: cfg.minEdge, maxContracts: cfg.maxContracts }); }
    catch (e) { console.log(`${pair.name || pair.kalshi}: ${e.message}`); continue; }
    if (!r.best) continue;
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`${stamp} ${pair.name}\n  ${r.best.describe}`);
    if (r.status && r.status !== "active") { console.log(`  skip: Kalshi market is ${r.status}`); continue; }
    if (state.exposure + r.best.plan.outlay > cfg.maxExposure) { console.log(`  skip: would exceed max exposure $${cfg.maxExposure} (at $${state.exposure.toFixed(2)})`); continue; }
    if (!cfg.live) { log({ pair: pair.name, event: "dry_run", route: r.best.describe, plan: r.best.plan }); continue; }
    await execute(r);
  }
}

async function main() {
  if (cfg.live && !(cfg.minEdge >= 0.005)) { console.error("--live needs --min-edge of at least 0.005 ($/contract after fees)."); process.exit(1); }
  if (state.halted) { console.error(`Halted: ${state.halted}\nFix it, then delete arb/state.json's "halted" field to resume.`); process.exit(2); }
  const all = loadPairs(cfg.pairs);
  const pairs = all.filter(p => p.verified === true);
  console.log(`${cfg.live ? "LIVE" : "DRY RUN"} — ${pairs.length}/${all.length} verified pairs, min edge ${cfg.minEdge}/contract, ≤${cfg.maxContracts} per trade, exposure cap $${cfg.maxExposure}`);
  if (!pairs.length) { console.log("No verified pairs. Run `node arb/scan.mjs discover`, check the rules, and add them to arb/pairs.json."); return; }
  if (cfg.live) console.log(`Kalshi balance: $${(await K.balance()).toFixed(2)}`);
  for (;;) {
    await tick(pairs);
    if (cfg.once) break;
    await sleep(cfg.interval);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
