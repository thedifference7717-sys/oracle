// Price a confirmed pair against live books on both venues and return the
// better of its two routes, sized to the depth that actually clears.
import { readFileSync } from "node:fs";
import * as K from "./kalshi.mjs";
import * as P from "./polymarket.mjs";
import { planArb, annualised } from "./math.mjs";

export function loadPairs(file) {
  const pairs = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(pairs)) throw new Error(`${file} must be a JSON array of pairs`);
  return pairs;
}

const metaCache = new Map();
async function meta(pair) {
  const key = pair.kalshi + "|" + pair.polySlug;
  if (metaCache.has(key)) return metaCache.get(key);
  const km = await K.market(pair.kalshi);
  const ev = (await K.pub(`/events/${km.event_ticker}`)).event || {};
  const mult = pair.kalshiFeeMultiplier ?? await K.feeMultiplier(ev.series_ticker);
  const pm = P.describe(await P.marketBySlug(pair.polySlug));
  const same = pm.outcomes.find(o => o.name === pair.polyOutcomeSameAsKalshiYes);
  const opp = pm.outcomes.find(o => o.name !== pair.polyOutcomeSameAsKalshiYes);
  if (!same || !opp || pm.outcomes.length !== 2)
    throw new Error(`${pair.polySlug}: outcome "${pair.polyOutcomeSameAsKalshiYes}" not one of ${pm.outcomes.map(o => o.name).join(", ")}`);
  const m = { km, mult, pm, same, opp, closes: km.expected_expiration_time || km.close_time };
  metaCache.set(key, m);
  return m;
}

export async function evaluate(pair, { minEdge = 0.01, maxContracts = 100 } = {}) {
  const { km, mult, pm, same, opp, closes } = await meta(pair);
  const [kb, bSame, bOpp] = await Promise.all([K.book(pair.kalshi), P.book(same.token), P.book(opp.token)]);
  const kFee = K.feeFn(mult), pFee = P.feeFn(pm.feeRate);

  const routes = [
    { kalshiSide: "yes", poly: opp, plan: planArb({ asks: kb.yesAsks, fee: kFee }, { asks: bOpp.asks, fee: pFee }, { minEdge, maxContracts }) },
    { kalshiSide: "no", poly: same, plan: planArb({ asks: kb.noAsks, fee: kFee }, { asks: bSame.asks, fee: pFee }, { minEdge, maxContracts }) }
  ].filter(r => r.plan && r.plan.contracts >= pm.minSize);

  const best = routes.sort((a, b) => b.plan.profit - a.plan.profit)[0];
  const status = km.status;
  return {
    pair, status, closes, pm, kalshiBook: kb,
    best: best && {
      ...best,
      apy: annualised(best.plan.roi, closes),
      describe: `BUY ${best.plan.contracts} Kalshi ${best.kalshiSide.toUpperCase()} ≤${best.plan.limitA} + ` +
        `BUY ${best.plan.contracts} Poly "${best.poly.name}" ≤${best.plan.limitB} → ` +
        `outlay $${best.plan.outlay}, pays $${best.plan.payout}, profit $${best.plan.profit} (${(best.plan.roi * 100).toFixed(2)}%)`
    }
  };
}
