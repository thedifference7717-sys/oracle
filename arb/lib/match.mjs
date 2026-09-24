// Finding the same question on both venues. This produces CANDIDATES for a
// human to read, never trades: two markets can share every word and still
// settle differently (a tie, an overtime rule, a different cut-off time, a
// different data source). The bot only trades pairs marked verified.
const STOP = new Set(("the a an of in on at to by for and or vs v will be is it this that with from " +
  "before after end yes no win wins winner who what which market game match than more less over under " +
  "2025 2026 2027 pro football basketball baseball hockey").split(" "));

export function tokens(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
}
const set = s => new Set(tokens(s));
const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
export const jaccard = (a, b) => { const n = overlap(a, b); return n ? n / (a.size + b.size - n) : 0; };

// Words that name Kalshi's YES side. "New Orleans" on a market whose ticker
// ends -NO inside "ATL Falcons vs NO Saints" also means "Saints".
export function kalshiYesWords(ev, m) {
  const w = set(m.yes_sub_title || m.title);
  const suffix = String(m.ticker || "").split("-").pop().toLowerCase();
  for (const side of String(ev.title || "").split(/\s+(?:vs\.?|at|@)\s+/i)) {
    const t = side.trim().split(/\s+/);
    if (t.length > 1 && t[0].toLowerCase() === suffix) for (const x of tokens(side)) w.add(x);
  }
  return w;
}

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const parse = v => (typeof v === "string" ? JSON.parse(v) : v || []);

// Which Polymarket outcome index is the same bet as Kalshi YES? null when it
// can't be told from the names — better unknown than backwards.
export function orient(ev, m, pm) {
  const outs = parse(pm.outcomes);
  if (outs.length !== 2) return null;
  if (/^yes$/i.test(outs[0]) && /^no$/i.test(outs[1])) return 0;
  const yw = kalshiYesWords(ev, m);
  const s = outs.map(o => overlap(set(o), yw));
  if (s[0] === s[1]) return null;
  return s[0] > s[1] ? 0 : 1;
}

export function matchMarkets(kalshiEvents, polyMarkets, { minScore = 0.35, maxDays = 3, maxDf = 400 } = {}) {
  // Inverted index on Polymarket words, ignoring words so common they only
  // add noise and time.
  const docs = polyMarkets.map(pm => ({ pm, w: set([pm.question, pm.groupItemTitle, pm.events?.[0]?.title].join(" ")) }));
  const idx = new Map();
  docs.forEach((d, i) => { for (const x of d.w) { if (!idx.has(x)) idx.set(x, []); idx.get(x).push(i); } });

  const out = [];
  for (const ev of kalshiEvents) {
    for (const m of ev.markets || []) {
      if (m.market_type && m.market_type !== "binary") continue;
      const kw = set([ev.title, ev.sub_title, m.yes_sub_title, m.title].join(" "));
      const hits = new Map();
      for (const x of kw) {
        const l = idx.get(x);
        if (!l || l.length > maxDf) continue;
        for (const i of l) hits.set(i, (hits.get(i) || 0) + 1);
      }
      const kEnd = new Date(m.expected_expiration_time || m.close_time).getTime();
      for (const [i, n] of hits) {
        if (n < 2) continue;
        const { pm, w } = docs[i];
        const pEnd = new Date(pm.endDate).getTime();
        if (isFinite(kEnd) && isFinite(pEnd) && Math.abs(kEnd - pEnd) > maxDays * 86400000) continue;
        const score = jaccard(kw, w);
        if (score < minScore) continue;
        out.push(candidate(ev, m, pm, score));
      }
    }
  }
  return out.sort((a, b) => (b.grossEdge ?? -9) - (a.grossEdge ?? -9) || b.score - a.score);
}

// Games. Kalshi names teams by city ("Atlanta vs Green Bay"), Polymarket by
// nickname ("Falcons vs. Packers"), so words never meet. Both use the same
// team codes: Kalshi's sub-title "ATL vs GB (Sep 24)" and ticker suffix -GB,
// Polymarket's slug nfl-atl-gb-2026-09-25 whose codes run in outcome order.
const LEAGUE = { KXNFLGAME: "nfl", KXMLBGAME: "mlb", KXNBAGAME: "nba", KXNHLGAME: "nhl", KXWNBAGAME: "wnba", KXNCAAFGAME: "cfb", KXMLSGAME: "mls" };
const SLUG = /^([a-z]+)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/; // bare winner market only, not -total-42pt5 etc.

export function gameKey(ev, m) {
  const league = LEAGUE[ev.series_ticker] || LEAGUE[String(m.ticker || "").split("-")[0]];
  const codes = String(ev.sub_title || "").split("(")[0].toLowerCase().split(/\s+(?:vs\.?|at|@)\s+/).map(s => s.trim()).filter(Boolean);
  if (!league || codes.length !== 2) return null;
  return { league, codes, yes: String(m.ticker).split("-").pop().toLowerCase() };
}

export function matchGames(kalshiEvents, polyMarkets, { maxDays = 2 } = {}) {
  const idx = new Map();
  for (const pm of polyMarkets) {
    const s = SLUG.exec(pm.slug || "");
    if (!s || parse(pm.outcomes).length !== 2) continue;
    const k = s[1] + ":" + [s[2], s[3]].sort().join("-");
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ pm, codes: [s[2], s[3]], date: s[4] });
  }
  const out = [];
  for (const ev of kalshiEvents) for (const m of ev.markets || []) {
    const g = gameKey(ev, m);
    if (!g) continue;
    const kEnd = new Date(m.occurrence_datetime || m.expected_expiration_time || m.close_time).getTime();
    for (const c of idx.get(g.league + ":" + [...g.codes].sort().join("-")) || []) {
      if (Math.abs(new Date(c.date + "T12:00:00Z").getTime() - kEnd) > maxDays * 86400000) continue;
      const o = c.codes.indexOf(g.yes);
      if (o < 0) continue;
      out.push(candidate(ev, m, c.pm, 1, o));
    }
  }
  return out;
}

// Top-of-book triage from the list endpoints. Real sizing uses live books.
function candidate(ev, m, pm, score, oriented) {
  const o = oriented ?? orient(ev, m, pm);
  const outs = parse(pm.outcomes);
  const kYes = num(m.yes_ask_dollars), kNo = num(m.no_ask_dollars);
  const bA = num(pm.bestAsk), bB = num(pm.bestBid);
  const pAsk = [bA, bB != null ? +(1 - bB).toFixed(4) : null]; // outcome0 ask, outcome1 ask
  let grossEdge = null, route = null;
  if (o != null && kYes && kNo && pAsk[0] && pAsk[1]) {
    const same = pAsk[o], opp = pAsk[1 - o];
    const e1 = 1 - (kYes + opp), e2 = 1 - (kNo + same);
    grossEdge = +Math.max(e1, e2).toFixed(4);
    route = e1 >= e2 ? `Kalshi YES @${kYes} + Poly "${outs[1 - o]}" @${opp}` : `Kalshi NO @${kNo} + Poly "${outs[o]}" @${same}`;
  }
  return {
    score: +score.toFixed(3), grossEdge, route,
    kalshi: { ticker: m.ticker, event: ev.title, yes: m.yes_sub_title, closes: m.expected_expiration_time || m.close_time, rules: m.rules_primary },
    poly: { slug: pm.slug, question: pm.question, outcomes: outs, ends: pm.endDate, restricted: !!pm.restricted },
    pair: o == null ? null : {
      name: `${ev.title} — ${m.yes_sub_title || m.title}`,
      kalshi: m.ticker,
      polySlug: pm.slug,
      polyOutcomeSameAsKalshiYes: outs[o],
      verified: false,
      notes: "Read BOTH rulebooks before setting verified: true — ties, postponements, cut-off times, data source."
    }
  };
}
