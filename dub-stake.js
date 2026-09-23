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
// every ticket of the full round robin at the balance divided by 570, so the
// bankroll always covers ten full days.
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
      row.balance = balance; row.run = { w, l };              // the running record after this one
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
  // 6-leg ticket, 57 of them with six legs. Every ticket is the same unit,
  // and the unit is the balance divided by 570 — so the bankroll always
  // covers exactly ten full days (10 x 57 tickets) at the unit it is betting:
  //
  //   $570.00 -> $1.00 a ticket      $694.52 -> $1.22      $538.33 -> $0.94
  //
  // It moves with the balance every day, up after a winning day and down
  // after a losing one, rounded to the cent. The 570 is measured against a
  // full six-leg day, so a thinner five-leg slate does not move it.
  const ROBIN_TICKETS = 57, ROBIN_COVER = 10, ROBIN_DAYS = ROBIN_COVER * ROBIN_TICKETS;
  const robinUnitOf = balance => r2(Math.max(0, balance) / ROBIN_DAYS);
  function robinSize(b, size) {
    const sizes = (b.graded && b.graded.sizes) || b.sizes || [];
    return sizes.find(z => z.m === size) || sizes[sizes.length - 1] || null;
  }
  // A graded Robin as a record of its bets: every ticket won, lost or pushed
  // (a ticket whose legs all voided returns its stake), and its legs.
  const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); };
  function robinTickets(b) {
    const sizes = (b && b.graded && b.graded.sizes) || [];
    if (!sizes.length) return null;
    const res = (b.legs || []).map(l => l.result);
    const voids = res.filter(x => x === "void").length;
    let w = 0, l = 0, p = 0;
    for (const z of sizes) { const push = choose(voids, z.m); w += z.cashed; p += push; l += z.tickets - z.cashed - push; }
    return { w, l, p, legsW: res.filter(x => x === "won").length, legsL: res.filter(x => x === "lost").length, legsV: voids };
  }
  // bets: the published Robin rows. Every graded size is played, at the unit.
  function robinChain(bets, bankroll) {
    const start = +bankroll > 0 ? +bankroll : ROBIN_DAYS;
    let balance = start;
    const rows = [];
    let w = 0, l = 0;
    const rec = { w: 0, l: 0, p: 0, legsW: 0, legsL: 0, legsV: 0 };   // every ticket and every leg graded
    const list = (bets || []).filter(b => b && b.status !== "noplay" && Array.isArray(b.legs))
      .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const b of list) {
      const unit = robinUnitOf(balance);
      const sizes = (b.graded && b.graded.sizes) || b.sizes || [];
      const tickets = sizes.reduce((a, z) => a + (z.tickets || 0), 0);
      const row = { date: b.date, unit, tickets, stake: r2(unit * tickets), status: "open", pl: 0, balance };
      if (b.graded) {
        row.pl = r2(sizes.reduce((a, z) => a + (z.pl || 0), 0) * unit);
        row.status = row.pl > 0 ? "won" : row.pl < 0 ? "lost" : "void";
        balance = r2(balance + row.pl); row.balance = balance;
        if (row.pl > 0) w++; else if (row.pl < 0) l++;
        const t = robinTickets(b);
        if (t) { row.tickets_ = t; for (const k in rec) rec[k] += t[k]; }
        row.run = Object.assign({}, rec, { w, l });            // the running totals after this night (w/l = days)
      }
      rows.push(row);
    }
    const unit = robinUnitOf(balance);
    return { start, balance, unit, rows, w, l, rec, pl: r2(balance - start), perDay: r2(unit * ROBIN_TICKETS) };
  }
  // The unit that rides on a given day: that day's row if it exists, else the
  // one the next Robin would be played at.
  function robinUnitFor(res, day) {
    const r = res.rows.find(x => x.date === day);
    return { unit: r ? r.unit : res.unit };
  }

  return { chain, stakeFor, robinChain, robinUnitFor, robinUnitOf, robinSize, robinTickets, PCT, MISS_GAIN, ROBIN_TICKETS };
});
