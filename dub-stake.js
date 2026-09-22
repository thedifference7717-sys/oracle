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
// The Robin has its own bankroll and its own rule — see robinChain below:
// $1 a ticket on the full round robin until the balance covers ten full days,
// then up 10% at each new ten-day mark.
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

  // ── The Robin ────────────────────────────────────────────────────────────
  // The Robin plays the FULL round robin every day: every 2-, 3-, 4-, 5- and
  // 6-leg ticket, 57 of them with six legs. Every ticket is the same unit:
  //
  //   $1.00 a ticket until the balance is over $570  (10 x a full day at $1)
  //   $1.10 a ticket until it is over $627           (10 x a full day at $1.10)
  //   $1.21 until $689.70, and so on — each time up 10%.
  //
  // The unit only ever steps UP: a losing run keeps the unit where it is
  // rather than cutting it. The 10x is measured against a full six-leg day
  // (57 tickets), so a thinner five-leg slate does not move the goalposts.
  const ROBIN_TICKETS = 57, ROBIN_COVER = 10, ROBIN_STEP = 0.10, ROBIN_UNIT = 1;
  const robinUnitAt = level => ROBIN_UNIT * Math.pow(1 + ROBIN_STEP, level);
  const robinBar = level => ROBIN_COVER * ROBIN_TICKETS * robinUnitAt(level);
  function robinLevel(balance, level) {
    let k = level || 0;
    while (balance > robinBar(k) + 1e-9) k++;
    return k;
  }
  function robinSize(b, size) {
    const sizes = (b.graded && b.graded.sizes) || b.sizes || [];
    return sizes.find(z => z.m === size) || sizes[sizes.length - 1] || null;
  }
  // bets: the published Robin rows. Every graded size is played, at the unit.
  function robinChain(bets, bankroll) {
    const start = +bankroll > 0 ? +bankroll : 570;
    let balance = start, level = robinLevel(start, 0);
    const rows = [];
    let w = 0, l = 0;
    const list = (bets || []).filter(b => b && b.status !== "noplay" && Array.isArray(b.legs))
      .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const b of list) {
      const unit = r2(robinUnitAt(level));
      const sizes = (b.graded && b.graded.sizes) || b.sizes || [];
      const tickets = sizes.reduce((a, z) => a + (z.tickets || 0), 0);
      const row = { date: b.date, unit, tickets, stake: r2(unit * tickets), status: "open", pl: 0, balance, bar: r2(robinBar(level)) };
      if (b.graded) {
        row.pl = r2(sizes.reduce((a, z) => a + (z.pl || 0), 0) * unit);
        row.status = row.pl > 0 ? "won" : row.pl < 0 ? "lost" : "void";
        balance = r2(balance + row.pl); row.balance = balance;
        if (row.pl > 0) w++; else if (row.pl < 0) l++;
        level = robinLevel(balance, level);                   // up only, never down
      }
      rows.push(row);
    }
    const unit = r2(robinUnitAt(level));
    return { start, balance, unit, level, bar: r2(robinBar(level)), rows, w, l, pl: r2(balance - start),
             perDay: r2(unit * ROBIN_TICKETS) };
  }
  // The unit that rides on a given day: that day's row if it exists, else the
  // one the next Robin would be played at.
  function robinUnitFor(res, day) {
    const r = res.rows.find(x => x.date === day);
    return r ? { unit: r.unit, bar: r.bar } : { unit: res.unit, bar: res.bar };
  }

  return { chain, stakeFor, robinChain, robinUnitFor, robinSize, PCT, MISS_GAIN, ROBIN_TICKETS };
});
