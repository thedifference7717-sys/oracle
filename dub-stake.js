// How much rides on each Dub and each Robin, from a bankroll you set for each.
//
//   First Dub          10% of the starting bankroll      $100 -> $10.00
//   After a win        10% of the new balance            $118 -> $11.80
//   After a loss       the last stake plus 12.5%         $10  -> $11.25 -> $12.66
//   After a void       the same stake again
//
// Losses compound: each one adds 12.5% to the stake before it, until a win
// resets the stake to 10% of whatever the balance is by then.
//
// The Robin runs the same rule on its own bankroll. Its day's bet is split
// evenly across the tickets of the size played, and a day counts as a win
// when those tickets paid back more than they cost.
//
// One file for the page and the alerter, so the stake on your phone and the
// stake in the Telegram alert cannot disagree.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DubStake = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PCT = 0.10, MISS_GAIN = 0.125;
  const r2 = v => Math.round(v * 100) / 100;
  const dec = a => { a = +a; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); };

  // bets: the published Dub rows. priceOf(b) is the price a bettor actually
  // got for that day (their own typed odds, else the published parlay price).
  function chain(bets, bankroll, opts) {
    const o = opts || {};
    const pct = o.pct != null ? o.pct : PCT, gain = o.missGain != null ? o.missGain : MISS_GAIN;
    const priceOf = o.priceOf || (b => b.price);
    const start = +bankroll > 0 ? +bankroll : 100;
    let balance = start, stake = r2(start * pct), why = "10% of the starting bankroll";
    const rows = [];
    let w = 0, l = 0;
    const list = (bets || []).filter(b => b && b.status !== "noplay" && Array.isArray(b.legs))
      .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    // How a day settled, for a given stake. The Dub's is its own status at its
    // price; the Robin supplies its own (a day is a win when the tickets paid
    // back more than they cost).
    const outcomeOf = o.outcomeOf || ((b, st) => b.status === "won" ? { status: "won", pl: r2(st * (dec(priceOf(b)) - 1)) }
                                               : b.status === "lost" ? { status: "lost", pl: -st }
                                               : b.status === "void" ? { status: "void", pl: 0 } : null);
    for (const b of list) {
      const out = outcomeOf(b, stake);
      const row = { date: b.date, stake, why, status: out ? out.status : "open", price: priceOf(b), pl: 0, balance };
      if (out && out.status === "won") {
        row.pl = out.pl; balance = r2(balance + row.pl); w++;
        stake = r2(balance * pct); why = "10% of the balance after a win";
      } else if (out && out.status === "lost") {
        row.pl = out.pl; balance = r2(balance + row.pl); l++;
        stake = r2(stake * (1 + gain)); why = "last stake + 12.5% after a loss";
      } else if (out && out.status === "void") {
        why = o.voidWhy || "same stake — the last Dub was void";
      } else {
        rows.push(row); continue;                     // open: nothing moves until it settles
      }
      row.balance = balance;
      rows.push(row);
    }
    return { start, balance, next: stake, why, rows, w, l, pl: r2(balance - start), canFund: stake <= balance + 1e-9 };
  }

  // The stake that rides on a given day: that day's row if it exists, else the
  // next one the chain would place.
  function stakeFor(res, day) {
    const r = res.rows.find(x => x.date === day);
    return r ? { stake: r.stake, why: r.why } : { stake: res.next, why: res.why };
  }

  // The Robin, played at one size (by 2s, by 3s...): the day's bet is split
  // evenly across that size's tickets. graded.sizes[].pl is per unit on every
  // ticket, so the day's profit is that times the per-ticket stake.
  function robinSize(b, size) {
    const sizes = (b.graded && b.graded.sizes) || b.sizes || [];
    return sizes.find(z => z.m === size) || sizes[sizes.length - 1] || null;
  }
  function robinOutcome(size) {
    return (b, st) => {
      if (!b.graded) return null;
      const z = robinSize(b, size);
      if (!z || !z.tickets) return null;
      const pl = r2(z.pl * st / z.tickets);
      return { status: pl > 0 ? "won" : pl < 0 ? "lost" : "void", pl };
    };
  }
  function robinChain(bets, bankroll, size) {
    return chain(bets, bankroll, { outcomeOf: robinOutcome(size), voidWhy: "same stake — the last Robin broke even" });
  }

  return { chain, stakeFor, robinChain, robinSize, PCT, MISS_GAIN };
});
