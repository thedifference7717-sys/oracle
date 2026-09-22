// Which one bet rides the ladder today, across every sport.
//
// Each sport's model nominates its best candidate; this picks between them.
// That sounds like "take the highest probability" and it cannot be, because
// the three numbers are not on the same scale:
//
//   MLB  144 graded legs, 74.3% predicted against 73.6% actual
//   NBA    0 graded legs
//   NFL    0 graded legs
//
// Compare those raw and the ladder does not pick the best bet, it picks the
// most overconfident MODEL — and an untested one has nothing holding it down,
// so it wins every night until the losses arrive. With basketball opening that
// would be NBA by default for weeks, and it would look like it was working.
//
// So a model's own number is trusted in proportion to what it has actually
// demonstrated, and the rest of the weight goes to the market, which has no
// opinion to defend. A sport with no record can still be picked — but only
// when the PRICE says it is the likeliest, not when the model says so. As
// rungs settle, the model earns its weight back.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LadderSelect = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // Legs at which a model's own probability carries half the weight. 200 is
  // the same order as the per-stat stabilisation points inside dd-model.js,
  // and it is deliberately slow: this is the guard against a new model, so it
  // should not be easy to switch off.
  const STAB = 200;

  // Where a probability goes when there is no market to compare it against.
  // The middle of the -200/-350 band the ladder bets in, so an unpriced
  // candidate is treated as typical rather than as good.
  const NO_PRICE_PRIOR = 0.72;

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const decFromAmerican = a => { a = +a; if (!a) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); };
  const impliedFrom = american => { const d = decFromAmerican(american); return d ? 1 / d : null; };

  // How much of its own opinion a model has earned.
  const trust = n => (n > 0 ? n / (n + STAB) : 0);

  // One candidate's probability, after both corrections that its record
  // justifies: the measured bias (a model that runs hot gets marked down by
  // exactly how hot it has run) and the shrink toward the market.
  function adjusted(c, rec) {
    const n = rec && rec.n > 0 ? rec.n : 0;
    const bias = rec && rec.n > 0 && rec.predicted != null && rec.actual != null
      ? rec.actual - rec.predicted : 0;
    const own = clamp((+c.p || 0) + bias, 0.01, 0.99);
    const mkt = c.price != null ? impliedFrom(c.price) : null;
    const anchor = mkt != null ? mkt : NO_PRICE_PRIOR;
    const w = trust(n);
    return {
      p: clamp(w * own + (1 - w) * anchor, 0.01, 0.99),
      own, anchor, weight: w, bias,
      market: mkt,
      edge: mkt != null ? own - mkt : null,
      priced: mkt != null
    };
  }

  // The band the ladder bets in. A price outside it is not a near miss, it is
  // a different bet — too short and the cycle cannot pay for its own busts,
  // too long and five in a row stops being a plan.
  function inBand(american, band) {
    if (american == null) return false;
    const lo = band && band.lo != null ? band.lo : -350;
    const hi = band && band.hi != null ? band.hi : -200;
    const a = +american;
    return a <= hi && a >= lo;      // e.g. -350 <= -275 <= -200
  }

  // records: { MLB: {n, predicted, actual}, NBA: {...}, ... }
  // candidates: [{ sport, player, market, line, p, price, teams, start, why }]
  function select(candidates, records, opts) {
    const o = opts || {};
    const band = o.band || { lo: -350, hi: -200 };
    const rows = (candidates || []).map(c => {
      const a = adjusted(c, (records || {})[c.sport]);
      return Object.assign({}, c, {
        pAdj: a.p, pOwn: a.own, anchor: a.anchor, trust: a.weight,
        bias: a.bias, implied: a.market, edge: a.edge, priced: a.priced,
        inBand: o.requireBand === false ? true : inBand(c.price, band)
      });
    });
    const eligible = rows.filter(r => r.inBand);
    // Rank on the adjusted number — the question asked is which is likeliest
    // to hit, and this is that number after each model's record is accounted
    // for. Ties break toward the shorter price, which busts less often, and
    // a ladder is punished by busts more than it is rewarded by payouts.
    eligible.sort((x, y) => y.pAdj - x.pAdj || (x.price - y.price));
    return { pick: eligible[0] || null, eligible, all: rows, band };
  }

  return { select, adjusted, inBand, trust, STAB, NO_PRICE_PRIOR, impliedFrom };
});
