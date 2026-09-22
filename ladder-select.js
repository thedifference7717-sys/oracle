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

  // ── CONTEXT: form, opponent, injuries ────────────────────────────────────
  //
  // The per-sport models already fold all of this into their probability —
  // dd-model pulls last-30-day hitting form, hairdwood carries status,
  // questionable, outShare, recentMin and usage. So the one thing this layer
  // must NOT do is score form again and multiply it in: that double-counts
  // what p already knows and quietly makes the number wrong.
  //
  // Context is used three ways instead, none of which touch p:
  //
  //   VETO        a fact that disqualifies the bet outright. A man listed out
  //               is not a 78% chance of anything.
  //   CONFIDENCE  a fact that makes the model's own number less believable
  //               without making it wrong — a questionable tag, a thin recent
  //               sample. This reduces how far we trust p and hands the
  //               difference to the market, which is the same lever the
  //               calibration weighting already pulls.
  //   TIE-BREAK   everything else. Two candidates inside a couple of points
  //               of each other are not meaningfully different, and THAT is
  //               where recent form and how the opponent has been playing
  //               decide it, rather than a third decimal place of p.
  //
  // Two candidates within this much adjusted probability are treated as level.
  const TIE_BAND = 0.02;
  // Below this many recent games there is not enough to judge form on.
  const MIN_RECENT = 3;

  // Facts that end the conversation.
  const VETOES = [
    { key: "out",        why: "listed out or doubtful",
      test: c => c.status && /^(out|doubtful|inactive|susp)/i.test(String(c.status)) },
    { key: "noLineup",   why: "not in a confirmed lineup",
      test: c => c.requiresLineup === true && c.posted === false },
    { key: "thinRecent", why: `fewer than ${MIN_RECENT} recent games to judge`,
      test: c => c.recentGames != null && c.recentGames < MIN_RECENT },
    { key: "noVolume",   why: "no recent workload — not an established role",
      test: c => c.recentVolume != null && c.recentVolume <= 0 }
  ];

  function vetoes(c) {
    return VETOES.filter(v => { try { return v.test(c); } catch (e) { return false; } });
  }

  // How believable the model's own number is for THIS candidate, 0..1. Applied
  // on top of the sport's earned trust, never to p itself.
  function confidence(c) {
    let k = 1, notes = [];
    if (c.status && /^quest/i.test(String(c.status))) { k *= 0.5; notes.push("questionable — model trusted half as far"); }
    if (c.status && /^prob/i.test(String(c.status)))  { k *= 0.85; notes.push("probable"); }
    if (c.recentGames != null && c.recentGames < 10) {
      const f = clamp(c.recentGames / 10, 0.3, 1);
      k *= f; notes.push(`${c.recentGames} recent games — a thin sample`);
    }
    if (c.minutesTrend != null && c.minutesTrend < -0.15) {
      k *= 0.8; notes.push("workload trending down");
    }
    return { k: clamp(k, 0, 1), notes };
  }

  // The tie-break score. Only consulted between candidates that are already
  // level on probability, so it can be a blunt instrument without doing harm.
  // Positive is better: the player is going well, the opponent is not.
  function contextScore(c) {
    let s = 0;
    if (c.formEdge != null) s += clamp(+c.formEdge, -1, 1);          // player vs his own baseline
    if (c.oppWeakness != null) s += clamp(+c.oppWeakness, -1, 1);    // opponent conceding this stat lately
    if (c.minutesTrend != null) s += clamp(+c.minutesTrend, -1, 1) * 0.5;
    if (c.homeAway === "home") s += 0.05;
    return +s.toFixed(4);
  }

  // Why this candidate, in words, so a pick can be argued with.
  function reasons(c, adj, conf, vet) {
    const out = [];
    for (const v of vet) out.push(`VETO: ${v.why}`);
    if (c.formEdge != null) out.push(`${c.formEdge >= 0 ? "in form" : "below his baseline"} (${(c.formEdge * 100).toFixed(0)}% vs own rate)`);
    if (c.oppWeakness != null) out.push(`${c.oppWeakness >= 0 ? "soft matchup" : "tough matchup"} (${(c.oppWeakness * 100).toFixed(0)}% vs league)`);
    if (c.recentGames != null) out.push(`${c.recentGames} recent games`);
    if (c.status) out.push(`status: ${c.status}`);
    out.push(...conf.notes);
    if (adj.priced) out.push(`market ${(adj.market * 100).toFixed(1)}%, model ${(adj.own * 100).toFixed(1)}%`);
    else out.push("no tradeable price — anchored to the band");
    return out;
  }

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
  function adjusted(c, rec, confK) {
    const n = rec && rec.n > 0 ? rec.n : 0;
    const bias = rec && rec.n > 0 && rec.predicted != null && rec.actual != null
      ? rec.actual - rec.predicted : 0;
    const own = clamp((+c.p || 0) + bias, 0.01, 0.99);
    const mkt = c.price != null ? impliedFrom(c.price) : null;
    const anchor = mkt != null ? mkt : NO_PRICE_PRIOR;
    // The sport's earned trust, further reduced by anything about THIS
    // candidate that makes its number less believable. Both pull the same
    // lever — toward the market — because that is the honest place to go when
    // you are less sure, rather than inventing a different probability.
    const w = trust(n) * (confK == null ? 1 : confK);
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
      const vet = vetoes(c);
      const conf = confidence(c);
      const a = adjusted(c, (records || {})[c.sport], conf.k);
      return Object.assign({}, c, {
        pAdj: a.p, pOwn: a.own, anchor: a.anchor, trust: a.weight,
        bias: a.bias, implied: a.market, edge: a.edge, priced: a.priced,
        inBand: o.requireBand === false ? true : inBand(c.price, band),
        vetoes: vet.map(v => v.key), vetoed: vet.length > 0,
        confidence: conf.k, context: contextScore(c),
        why: reasons(c, a, conf, vet)
      });
    });
    const eligible = rows.filter(r => r.inBand && !r.vetoed);
    // Rank on the adjusted number — the question asked is which is likeliest
    // to hit, and this is that number after each model's record is accounted
    // for. Ties break toward the shorter price, which busts less often, and
    // a ladder is punished by busts more than it is rewarded by payouts.
    //
    // Probability first, but bucketed: two candidates inside TIE_BAND of each
    // other are not really different, and pretending a third decimal place
    // separates them is false precision. Inside a bucket the question becomes
    // the one that actually distinguishes them — who is going well, against
    // whom — and only then the shorter price, which busts less often.
    const bucket = p => Math.round(p / TIE_BAND);
    eligible.sort((x, y) =>
      bucket(y.pAdj) - bucket(x.pAdj) ||
      y.context - x.context ||
      y.pAdj - x.pAdj ||
      (x.price - y.price));
    return {
      pick: eligible[0] || null, eligible, all: rows, band,
      rejected: rows.filter(r => r.vetoed || !r.inBand)
        .map(r => ({ sport: r.sport, player: r.player, market: r.market,
                     price: r.price,
                     reason: r.vetoed ? r.vetoes.join(", ") : "outside the price band" }))
    };
  }

  return { select, adjusted, inBand, trust, vetoes, confidence, contextScore,
           STAB, NO_PRICE_PRIOR, TIE_BAND, MIN_RECENT, impliedFrom };
});
