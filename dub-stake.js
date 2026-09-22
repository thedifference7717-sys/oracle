// How much rides on each Dub, from a bankroll you set.
//
//   First Dub          10% of the starting bankroll      $100 -> $10.00
//   After a win        10% of the new balance            $118 -> $11.80
//   After a loss       the last stake plus 12.5%         $10  -> $11.25 -> $12.66
//   After a void       the same stake again
//
// Losses compound: each one adds 12.5% to the stake before it, until a win
// resets the stake to 10% of whatever the balance is by then.
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
    for (const b of list) {
      const row = { date: b.date, stake, why, status: b.status, price: priceOf(b), pl: 0, balance };
      if (b.status === "won") {
        row.pl = r2(stake * (dec(row.price) - 1)); balance = r2(balance + row.pl); w++;
        stake = r2(balance * pct); why = "10% of the balance after a win";
      } else if (b.status === "lost") {
        row.pl = -stake; balance = r2(balance - stake); l++;
        stake = r2(stake * (1 + gain)); why = "last stake + 12.5% after a loss";
      } else if (b.status === "void") {
        why = "same stake — the last Dub was void";
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

  return { chain, stakeFor, PCT, MISS_GAIN };
});
