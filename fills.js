// The prices you actually got, shared by the alerts and every page.
//
// Every bet amount after the first depends on what the last bet paid, and
// what a bet paid depends on the price you actually got — not the price the
// alert assumed. Kept only on a phone, that fill made the dashboard and the
// Telegram alerts drift apart the moment they differed. So fills live in one
// published file, data/fills.json, which the alerter and all three pages
// read. You set them by sending the bot a command:
//
//   /odds -300          the Ladder's latest rung was taken at -300
//   /paid 72.77         ...or it paid back $72.77, stake included (exact)
//   /dub +120           today's Dub parlay was taken at +120
//   /odds 9/22 -300     the same for a given day (month/day or YYYY-MM-DD)
//   /clear odds 9/22    forget one (odds, paid or dub)
//
// A value typed on a page still overrides it on that device, as before.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Fills = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const empty = () => ({ ladder: {}, dub: {} });

  // "9/22", "09-22", "2026-09-22" -> YYYY-MM-DD in the given year.
  function parseDay(tok, year) {
    if (!tok) return null;
    let m = String(tok).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = String(tok).match(/^(\d{1,2})[\/-](\d{1,2})$/);
    if (m) return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return null;
  }
  const price = t => { const v = parseFloat(String(t).replace(/^\+/, "")); return isFinite(v) && Math.abs(v) >= 100 ? v : null; };
  const amount = t => { const v = parseFloat(String(t).replace(/^\$/, "")); return isFinite(v) && v > 0 ? +v.toFixed(2) : null; };

  // A bot command, or null when the text is not one. year: for "9/22".
  function parse(text, year) {
    const w = String(text || "").trim().split(/\s+/);
    if (!w[0] || w[0][0] !== "/") return null;
    const cmd = w[0].slice(1).split("@")[0].toLowerCase();       // "/odds@PropShopBot" in a group
    const args = w.slice(1);
    const day = args.length > 1 ? parseDay(args[0], year) : null;
    const val = args.length > 1 ? args[1] : args[0];
    if (cmd === "odds" || cmd === "ladder") { const v = price(val); return v == null ? { error: "odds like -300 or +120" } : { kind: "odds", value: v, day }; }
    if (cmd === "paid")                     { const v = amount(val); return v == null ? { error: "a payout like 72.77" } : { kind: "paid", value: v, day }; }
    if (cmd === "dub")                      { const v = price(val); return v == null ? { error: "parlay odds like +120" } : { kind: "dub", value: v, day }; }
    if (cmd === "clear") {
      const what = (args[0] || "").toLowerCase();
      if (!["odds", "paid", "dub"].includes(what)) return { error: "/clear odds, /clear paid or /clear dub" };
      return { kind: "clear", what, day: parseDay(args[1], year) };
    }
    return null;
  }

  // Record one command. Returns a short description of what changed.
  function apply(f, c, day) {
    f = f || empty(); f.ladder = f.ladder || {}; f.dub = f.dub || {};
    // New odds replace an earlier payout (you are correcting the bet); a payout
    // sits alongside the odds and wins, because it is the exact number.
    if (c.kind === "odds") { f.ladder[day] = { price: c.value }; return `Ladder ${day}: odds ${c.value > 0 ? "+" : ""}${c.value}`; }
    if (c.kind === "paid") { const e = f.ladder[day] = f.ladder[day] || {}; e.paid = c.value; return `Ladder ${day}: paid back $${c.value.toFixed(2)}`; }
    if (c.kind === "dub")  { f.dub[day] = { price: c.value }; return `Dub ${day}: parlay ${c.value > 0 ? "+" : ""}${c.value}`; }
    if (c.kind === "clear") {
      if (c.what === "dub") delete f.dub[day]; else if (f.ladder[day]) delete f.ladder[day][c.what === "odds" ? "price" : "paid"];
      if (f.ladder[day] && !Object.keys(f.ladder[day]).length) delete f.ladder[day];
      return `cleared ${c.what} for ${day}`;
    }
    return "";
  }

  // Ladder rows with your fills folded in: a payout beats a price, as on the page.
  function ladderRows(bets, f) {
    const L = (f && f.ladder) || {};
    return (bets || []).map(b => {
      const e = L[b.date]; if (!e) return b;
      const o = Object.assign({}, b);
      if (e.price != null) o.price = e.price;
      if (e.paid != null) o.returnActual = e.paid;
      return o;
    });
  }
  const dubPrice = (f, b) => (f && f.dub && f.dub[b.date] && f.dub[b.date].price != null) ? f.dub[b.date].price : b.price;

  return { parse, apply, ladderRows, dubPrice, parseDay, empty };
});
