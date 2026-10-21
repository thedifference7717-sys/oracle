// ─────────────────────────────────────────────────────────────────────────────
// Prop Shop — the ladder's arithmetic, and nothing of the model.
//
// The public pages need to replay the published ledger into stakes, returns
// and risk. They must not need the model that picks the bets, which is not
// published. So these functions are carried here, copied verbatim from
// dd-model.js, and scripts/ladder-math-parity.test.mjs checks the two give
// identical answers on the real ledger.
//
// Browser: window.LadderMath. Node: module.exports.
// ─────────────────────────────────────────────────────────────────────────────
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LadderMath = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const API = "https://statsapi.mlb.com/api/v1";

function amOdds(p) { if (!(p > 0 && p < 1)) return "—"; const d = 1 / p; return d >= 2 ? "+" + Math.round((d - 1) * 100) : "-" + Math.round(100 / (d - 1)); }

function americanFromDec(d) {
  if (!(d > 1)) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
}

function decFromAmerican(a) { a = +a; if (!a) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }

const LADDER = {
  account: 100,    // default only; every viewer sets their own
  // The owner's plan from 10/21: a series seeds at the share of the account
  // that covers `series` straight busts, each missGain bigger than the last
  // (1/25.96 = 3.85% for ten at +20%). After that many busts in a row the
  // next series starts fresh at that share of what is left.
  basePct: 1 / ((Math.pow(1.2, 10) - 1) / 0.2),
  rungs: 5,        // wins needed to close a cycle
  missGain: 0.20,  // a busted cycle restarts this much bigger
  series: 10,      // straight busts the seed is sized to survive
  // Series that began before this date ran on the old plan (10% seeds, +25%
  // after a bust), and replay that way so the published record never moves.
  // The first series to begin on or after it seeds fresh on the new plan.
  before: { until: "2026-10-21", basePct: 0.10, missGain: 0.25 },
  maxStreak: 2,    // a player cannot be the rung more than this many days running
  // The price a "to record a hit" leg is assumed to be offered at, used ONLY
  // when a rung has no price of its own. It is a starting assumption, not a
  // claim about the market: the real number moves every day and every book,
  // so any rung can override it — with the price, or with what it actually
  // paid, which is usually the number a bettor has to hand. Rows that fall
  // back to this are flagged so the page can say the price was assumed.
  price: -275
};

const round2 = v => Math.round(v * 100) / 100;

const seedFor = C => round2(Math.max(0, C.account) * C.basePct);
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));

const pickKey = b => b && (b.playerId != null ? String(b.playerId)
                        : (b.pick ? String(b.pick).toLowerCase() : null));

function ladderBlocked(history, maxStreak) {
  const n = maxStreak == null ? LADDER.maxStreak : maxStreak;
  if (!(n > 0)) return new Set();
  const placed = (history || [])
    .filter(b => pickKey(b) && (b.status === "won" || b.status === "lost" || b.status === "open"))
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const last = placed.slice(-n);
  if (last.length < n) return new Set();
  const k = pickKey(last[0]);
  return last.every(b => pickKey(b) === k) ? new Set([k]) : new Set();
}

function ladder(history, cfg) {
  const C = Object.assign({}, LADDER, cfg || {});
  // Old plan until the first series that begins on or after before.until.
  const old = C.before && C.before.until ? C.before : null;
  let early = !!old, streak = 0;
  const pct = () => early ? old.basePct : C.basePct, gain = () => early ? old.missGain : C.missGain;
  const seed0 = C.seed != null ? C.seed : round2(Math.max(0, C.account) * pct());
  let account = C.account, base = seed0, stake = seed0, rung = 1, cycle = 1;
  // Cash actually committed to the live cycle. Equal to the seed until a
  // hand-recorded top-up says otherwise.
  let cashIn = seed0;
  let peak = account, maxDD = 0, staked = 0, cycles = { done: 0, busted: 0 };
  const rows = [];
  // Money taken out (negative) or put in (positive), each { date, amount },
  // applied after that day's rung. Taken between cycles — after one completed,
  // before the next has bet — the next seed is re-sized to the account that is
  // left; mid-cycle, or after a bust (whose seed escalates on its own), the
  // stakes already in play are not touched.
  const moves = (C.moves || []).filter(m => m && m.date && isFinite(+m.amount) && +m.amount !== 0)
    .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let mi = 0, moved = 0, lastClose = null;
  const applyMoves = before => {
    while (mi < moves.length && (before == null || String(moves[mi].date) < String(before))) {
      const amt = +moves[mi].amount; mi++;
      account = round2(account + amt); moved = round2(moved + amt);
      if (rung === 1 && lastClose !== "busted") { base = round2(Math.max(0, account) * pct()); stake = base; cashIn = base; }
    }
  };
  // A series beginning on or after the switch: the new plan, seeded fresh.
  const switchTo = day => {
    if (!early || rung !== 1 || !isDay(day) || String(day) < old.until) return;
    early = false; streak = 0;
    if (C.seed == null || rows.length) { base = round2(Math.max(0, account) * pct()); stake = base; cashIn = base; }
  };
  for (const b of history || []) {
    applyMoves(b.date);
    switchTo(b.date);
    // A missing price used to fall through `decFromAmerican(null) || 1` to
    // EVEN MONEY, so a winning rung returned exactly its stake and the ladder
    // quietly stopped compounding on it — a wrong number, not a cosmetic one.
    // It also rendered as the literal string "null" wherever the price was
    // shown. Fall back to the configured leg price and mark the row, so the
    // maths is right and the page can say the price was assumed rather than
    // recorded.
    const hasPrice = b.price != null && isFinite(+b.price) && Math.abs(+b.price) >= 100;
    const price = hasPrice ? +b.price : C.price;
    const dec = decFromAmerican(price) || 1;
    // Derived, never read back from the row — the published ledger records the
    // publisher's own stake, and replaying that would show every viewer
    // somebody else's bankroll.
    //
    // The exception is a rung that was actually traded differently: on an
    // exchange a position can be sold before settlement and re-entered at a
    // size of the bettor's choosing. `stakeActual` is that real number, and
    // `realisedBefore` is money already banked on the same day (a partial exit)
    // that the settlement below must not double-count. Both are only ever set
    // by a hand-recorded adjustment; the ordinary path is untouched.
    const banked = +b.realisedBefore || 0;
    // Money put in beyond the cycle's seed. Once this is non-zero the ladder's
    // "only the seed is ever yours" property no longer holds, and the card has
    // to say so rather than keep quoting the seed as the exposure.
    // `topUp` is an absolute dollar figure and therefore only true for the
    // bankroll it was recorded against. `topUpPct` is the same thing as a
    // share of the cycle's seed, so it scales: a rung mis-sized at 1.12x the
    // seed was mis-sized by 12% for every follower, whatever their account.
    // Prefer the proportional form; the absolute one stays for exchange
    // adjustments, which really are one bettor's own cash.
    const topUp = b.topUp != null ? +b.topUp
                : b.topUpPct != null ? round2(base * +b.topUpPct) : 0;
    // What actually rode. An exchange adjustment states it outright; otherwise
    // it is the derived stake plus anything topped up, because a row that
    // charges the cycle for $14 must not print $12.50 in the stake column.
    const at = b.stakeActual != null ? +b.stakeActual
             : topUp ? round2(stake + topUp) : stake;
    const row = { date: b.date, cycle, rung, stake: at, price: price, assumedPrice: !hasPrice, pick: b.pick || null,
                  p: b.p != null ? b.p : null, status: b.status, pl: 0, closed: null };
    // cashIn is the whole truth for the cycle: seed plus anything added later.
    // A partial exit is already inside it — recovering $7 of a $14 rung and
    // re-staking $18.50 means $11.50 of NEW money, so cashIn goes 10 -> 21.50
    // and the $7 loss is accounted for by construction. Banking it separately
    // as well would charge it twice.
    if (topUp) { cashIn = round2(cashIn + topUp); row.topUp = topUp; }
    if (banked) row.banked = banked;          // shown, not re-applied
    if (b.status === "won") {
      // What it actually paid beats what the price says it should have paid.
      // Odds differ by book and by day, and a bettor knows the payout more
      // reliably than the American number behind it — so a recorded return is
      // taken as given and the price is back-solved from it for display.
      const paid = b.returnActual != null && isFinite(+b.returnActual) && +b.returnActual > 0
        ? round2(+b.returnActual) : null;
      const ret = paid != null ? paid : round2(at * dec);
      if (paid != null && at > 0) {
        row.retActual = true;
        const impliedDec = paid / at;
        row.price = impliedDec > 1 ? +americanFromDec(impliedDec) : row.price;
        row.assumedPrice = false;
      }
      row.ret = ret;
      if (rung >= C.rungs) {                                 // cycle complete
        row.pl = round2(ret - cashIn); row.closed = "complete"; lastClose = "complete";
        account = round2(account + row.pl); staked += cashIn; cycles.done++; streak = 0;
        cycle++; rung = 1; base = round2(Math.max(0, account) * pct()); stake = base; cashIn = base;
      } else {                                               // let it ride
        rung++; stake = ret;
      }
    } else if (b.status === "lost") {
      // Everything put in this cycle is gone, not just the seed.
      row.pl = round2(-cashIn); row.closed = "busted"; lastClose = "busted";
      account = round2(account - cashIn); staked += cashIn; cycles.busted++; streak++;
      // The plan covers `series` busts in a row; the one after starts over.
      const fresh = !early && C.series > 0 && streak >= C.series;
      if (fresh) streak = 0;
      cycle++; rung = 1; base = round2(fresh ? Math.max(0, account) * pct() : base * (1 + gain())); stake = base; cashIn = base;
    } else { rows.push(row); continue; }                     // open — state is frozen here
    peak = Math.max(peak, account);
    maxDD = Math.max(maxDD, peak - account);
    rows.push(row);
  }
  applyMoves(null);
  // The next series, if it begins today or later, is on the new plan.
  if (!(history || []).some(b => b.status === "open")) switchTo(C.today || slateYmd());
  // What the next series seeds at, for a card that shows both outcomes: a
  // series still on the old plan hands over to the new one when it closes.
  const today = C.today || slateYmd();
  const handover = early && isDay(today) && String(today) >= old.until;
  const nextPct = handover ? C.basePct : pct();
  const lastOfPlan = !early && C.series > 0 && streak + 1 >= C.series;
  const next = { pct: nextPct, lose: round2(handover || lastOfPlan ? Math.max(0, account - cashIn) * nextPct : base * (1 + gain())) };
  const open = (history || []).some(b => b.status === "open");
  return { cfg: Object.assign({}, C, { basePct: pct(), missGain: gain() }), streak, next, rows, account, base, stake: round2(stake), rung, cycle, open,
           cashIn: round2(cashIn), toppedUp: round2(cashIn - base),
           atRisk: round2(cashIn), onTable: round2(Math.max(0, stake - cashIn)),
           staked: round2(staked), pl: round2(account - C.account - moved), moved, peak, maxDD: round2(maxDD),
           // What the account must cover is what the cycle has taken from it
           // (the seed, plus any top-up), not the whole riding stake: from
           // rung 2 on that is the cycle's own winnings. Comparing the stake
           // stopped Strike Zone at rung 4 on 10/13 ($70.37 riding on a $61.87
           // account, of which the cycle had taken about $17).
           cycles, canFund: cashIn <= account + 1e-9 };
}

function ladderRisk(p, american, state) {
  const C = (state && state.cfg) || LADDER;
  const dec = decFromAmerican(american);
  if (!dec || !(p > 0 && p < 1)) return null;
  const base = (state && state.base) || (C.seed != null ? C.seed : seedFor(C));
  const account = (state && state.account) || C.account;
  const cycleWin = Math.pow(p, C.rungs);
  const fullReturn = base * Math.pow(dec, C.rungs);
  const cycleProfit = fullReturn - base;
  // Only the seed is ever at risk, whichever rung the miss lands on.
  const cycleEv = cycleWin * cycleProfit - (1 - cycleWin) * base;
  const legEv = p * (dec - 1) - (1 - p);
  // Consecutive busts the account survives: seeds escalate by missGain each
  // time, so the running cost is a geometric series against the balance.
  let bal = account, b = base, n = 0;
  while (b <= bal && n < 40) { bal -= b; b = b * (1 + C.missGain); n++; }
  return { dec, cycleWin, fullReturn, cycleProfit, cycleEv, legEv,
           bustsSurvived: n, pBust: Math.pow(1 - cycleWin, n + 1),
           rungStakes: Array.from({ length: C.rungs }, (_, i) => round2(base * Math.pow(dec, i))) };
}

function etNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })); }

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function slateYmd() { const d = etNow(); d.setHours(d.getHours() - 6); return ymd(d); }

return { API, amOdds, americanFromDec, decFromAmerican, LADDER, seedFor, pickKey, ladderBlocked, ladder, ladderRisk, etNow, ymd, slateYmd };
});
