// The arithmetic of a cross-venue arb, kept pure so it can be tested without
// a network.
//
// A pair of binary markets that resolve on the same fact gives two trades:
//   buy Kalshi YES + buy the Polymarket outcome that is Kalshi's NO
//   buy Kalshi NO  + buy the Polymarket outcome that is Kalshi's YES
// Either way exactly one leg pays $1 per contract at settlement. If the two
// asks plus both venues' taker fees come to less than $1, the difference is
// the profit — *if* the markets really do resolve on the same fact. That
// "if" is the whole risk, and it is not something arithmetic can check.

// Kalshi taker fee: 0.07 × C × P × (1−P), rounded UP to the cent, per order.
// Some series carry a multiplier (fee_multiplier on /series).
export function kalshiFee(count, price, mult = 1, rate = 0.07) {
  if (!(count > 0)) return 0;
  const raw = rate * mult * count * price * (1 - price);
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

// Polymarket taker fee: C × feeRate × p × (1−p), in USDC. feeRate comes from
// the market's feeSchedule.rate and is 0 where feesEnabled is false.
export function polyFee(count, price, rate = 0) {
  if (!(count > 0) || !(rate > 0)) return 0;
  return +(count * rate * price * (1 - price)).toFixed(6);
}

// A ladder is [[price, size], ...] sorted best (cheapest ask) first.
export function sortAsks(levels) {
  return (levels || [])
    .map(([p, s]) => [+p, +s])
    .filter(([p, s]) => p > 0 && p < 1 && s > 0)
    .sort((a, b) => a[0] - b[0]);
}

// Walk both ask ladders together, taking contracts only while the marginal
// contract still clears minEdge after fees. Contracts are whole numbers:
// Kalshi counts are integers, and matching counts is the point of the hedge.
//
// legA / legB: { asks, fee: (count, price) => dollars }
// Returns the fill plan with worst prices (these become the limit prices).
export function planArb(legA, legB, { maxContracts = Infinity, minEdge = 0.01 } = {}) {
  const A = sortAsks(legA.asks).map(l => l.slice());
  const B = sortAsks(legB.asks).map(l => l.slice());
  const fillsA = [], fillsB = [];
  let i = 0, j = 0, total = 0;
  const marginal = (fee, p) => fee(1000, p) / 1000; // per-contract fee rate, before rounding

  while (i < A.length && j < B.length && total < maxContracts) {
    const [pa, sa] = A[i], [pb, sb] = B[j];
    const unit = pa + pb + marginal(legA.fee, pa) + marginal(legB.fee, pb);
    if (1 - unit < minEdge) break;
    const take = Math.floor(Math.min(sa, sb, maxContracts - total));
    if (take < 1) { if (sa < sb) i++; else j++; continue; }
    fillsA.push([pa, take]); fillsB.push([pb, take]);
    total += take;
    A[i][1] -= take; B[j][1] -= take;
    if (A[i][1] < 1) i++;
    if (B[j][1] < 1) j++;
  }
  if (!total) return null;

  // Fees are charged on the whole order; Kalshi rounds each fill up to the
  // cent, so charge each level separately — slightly pessimistic, never low.
  const cost = f => f.reduce((s, [p, n]) => s + p * n, 0);
  const fees = (f, fee) => f.reduce((s, [p, n]) => s + fee(n, p), 0);
  const costA = cost(fillsA), costB = cost(fillsB);
  const feesA = fees(fillsA, legA.fee), feesB = fees(fillsB, legB.fee);
  const outlay = costA + costB + feesA + feesB;
  const profit = total - outlay;
  return {
    contracts: total,
    limitA: fillsA[fillsA.length - 1][0],
    limitB: fillsB[fillsB.length - 1][0],
    costA: r4(costA), costB: r4(costB), feesA: r4(feesA), feesB: r4(feesB),
    outlay: r4(outlay), payout: total, profit: r4(profit),
    edgePerContract: r4(profit / total),
    roi: r4(profit / outlay)
  };
}

// Return on capital annualised over the time the money sits locked up.
export function annualised(roi, closesAt, now = Date.now()) {
  const days = (new Date(closesAt).getTime() - now) / 86400000;
  if (!(days > 0) || !isFinite(roi)) return null;
  return r4(Math.pow(1 + roi, 365 / Math.max(days, 1)) - 1);
}

const r4 = x => Math.round(x * 1e4) / 1e4;
