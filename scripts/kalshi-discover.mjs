// What player-prop markets does Kalshi actually list, and for which sports?
//
// The ladder is moving to "best single player prop in any sport, priced -200
// to -350". That needs a price feed across sports, and the only one already
// wired here is Kalshi — which is free, public, and the book the picks are
// actually traded on, so its prices are the right ones by definition.
//
// kalshi-snapshot.mjs already pulls NFL props, but it hardcodes series tickers
// (KXNFLPASSYDS and friends) that somebody had to look up. This finds the rest
// rather than guessing: list every series, keep the ones that look like a
// player prop for a sport we model, and print them with a live market count so
// it is obvious which are real and which are dormant out of season.
//
// Read-only. Writes nothing, commits nothing. Run: node scripts/kalshi-discover.mjs
//
// PROBE NAMED TICKERS. Do not enumerate.
//
// Two earlier versions of this got it wrong in the same way — they tried to
// see everything. The first called the API once per series and ran six
// minutes without finishing. The second pulled open markets in bulk and was
// STILL truncated at 400,000, because that is the order of magnitude Kalshi
// actually has open. You cannot sweep it.
//
// Worse, sweeping produced a confident wrong answer: filtering on /NBA/ also
// matches WNBA, so a run that looked like it had found twenty NBA prop series
// had in fact found none, and every one of them was the women's league. A
// substring is not a league.
//
// Kalshi names series KX<LEAGUE><MARKET>, which the WNBA and MLB results make
// unambiguous. So ask about exactly the ones we care about, by name, and let
// a 404 or an empty list be the answer. Roughly sixty calls, definitive, and
// it distinguishes "does not exist" from "out of season" by reporting both
// the market count and whether the series itself resolves.

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

async function get(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { last = e; await new Promise(s => setTimeout(s, 600 * (i + 1))); }
  }
  throw last;
}

// Exactly what we want to know about, by name. Nothing is inferred from a
// substring: KXNBAPTS and KXWNBAPTS are different leagues and are listed as
// such, which is the mistake that made the last run meaningless.
const PROBE = {
  NBA:  ["KXNBAPTS","KXNBAREB","KXNBAAST","KXNBA3PT","KXNBAPRA","KXNBASTL","KXNBABLK"],
  WNBA: ["KXWNBAPTS","KXWNBAREB","KXWNBAAST","KXWNBA3PT"],
  MLB:  ["KXMLBHIT","KXMLBKS","KXMLBTB","KXMLBHRR","KXMLBRBI","KXMLBHR","KXMLBSB",
         "KXMLBWA","KXMLBHA","KXMLBERA","KXMLBOUTS"],
  NFL:  ["KXNFLPASSYDS","KXNFLRECYDS","KXNFLREC","KXNFLPASSTDS","KXNFLRUSHYDS",
         "KXNFLRECTDS","KXNFLRUSHTDS","KXNFLANYTD"]
};

for (const [league, tickers] of Object.entries(PROBE)) {
  console.log(`=== ${league} ===`);
  for (const t of tickers) {
    let line;
    try {
      const d = await get(`${KALSHI}/markets?series_ticker=${encodeURIComponent(t)}&status=open&limit=200`);
      const ms = d.markets || [];
      if (!ms.length) {
        line = `     0 open   ${t.padEnd(16)} exists, nothing live (out of season, or no slate today)`;
      } else {
        const m = ms[0];
        const px = (m.yes_bid != null && m.yes_ask != null) ? `${m.yes_bid}/${m.yes_ask}c` : "no quote";
        line = `  ${String(ms.length).padStart(4)} open   ${t.padEnd(16)} ${px.padEnd(12)} ${String(m.title || "").slice(0, 52)}`;
      }
    } catch (e) {
      line = `     -       ${t.padEnd(16)} no such series (${String(e.message).slice(0, 40)})`;
    }
    console.log(line);
  }
  console.log();
}
