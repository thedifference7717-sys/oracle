// The live ticker across the top of a page: today's games in all four sports
// (ESPN's public scoreboards, refreshed every minute), our revealed picks
// marked on their games, and a breaking-news banner when one of them hits.
//
// Nothing sealed is ever shown: a pick appears only once its game has
// started and the record carries it in the clear. Include with
//   <div id="psTicker"></div><script src="ticker.js" defer></script>
(function () {
  const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
  const SPORTS = [["baseball/mlb", "MLB", "⚾"], ["basketball/nba", "NBA", "🏀"], ["football/nfl", "NFL", "🏈"], ["hockey/nhl", "NHL", "🏒"]];
  const RAW = "https://raw.githubusercontent.com/thedifference7717-sys/oracle/main/data/";
  const EVERY = 60e3;
  const etDay = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const css = `
#psTicker{position:sticky;top:0;z-index:40;height:36px;background:#050810;border-bottom:1px solid #1E2A44;overflow:hidden;font:600 13px Inter,system-ui,-apple-system,sans-serif;color:#C9D3E6}
#psTicker .tk{display:flex;align-items:center;height:36px}
#psTicker .tag{flex:none;height:36px;display:flex;align-items:center;gap:7px;padding:0 14px;background:#F7931A;color:#120A00;font-weight:900;letter-spacing:1.5px;font-size:11px;z-index:2}
#psTicker .tag i{width:7px;height:7px;border-radius:50%;background:#120A00;animation:psBlink 1.2s infinite}
#psTicker .vp{overflow:hidden;flex:1;height:36px;mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent);-webkit-mask-image:linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)}
#psTicker .run{display:flex;align-items:center;height:36px;width:max-content;animation:psRun var(--dur,80s) linear infinite}
#psTicker .run:hover{animation-play-state:paused}
#psTicker .psg{display:flex;align-items:center;gap:8px;padding:0 18px;white-space:nowrap;border-right:1px solid #1E2A44}
#psTicker .psg b{color:#fff;font-weight:800}
#psTicker .psg .st{color:#7E8BA6;font-weight:700;font-size:12px}
#psTicker .psg.live .st{color:#FF5A5A}
#psTicker .psg.live .st:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#FF5A5A;margin-right:5px;vertical-align:1px;animation:psBlink 1.2s infinite}
#psTicker .psg.ours{background:rgba(43,123,255,.12);box-shadow:inset 0 -2px 0 #2B7BFF}
#psTicker .psg .pk{color:#6FA6FF;font-weight:800}
#psTicker .psg.hit{background:rgba(247,147,26,.16);box-shadow:inset 0 -2px 0 #F7931A}
#psTicker .psg.hit .pk{color:#F7931A}
@keyframes psRun{to{transform:translateX(-50%)}}
@keyframes psBlink{50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){#psTicker .run{animation:none}}
#psBreaking{position:fixed;left:50%;top:48px;transform:translate(-50%,-140%);z-index:60;max-width:min(680px,calc(100vw - 24px));width:max-content;
  background:linear-gradient(90deg,#F7931A,#FFB04D);color:#120A00;border-radius:14px;padding:12px 18px 12px 14px;display:flex;align-items:center;gap:12px;
  box-shadow:0 20px 50px rgba(247,147,26,.45),0 0 0 4px rgba(247,147,26,.18);font:700 15px Inter,system-ui,sans-serif;transition:transform .45s cubic-bezier(.2,.9,.3,1.2)}
#psBreaking.on{transform:translate(-50%,0)}
#psBreaking .k{flex:none;background:#120A00;color:#F7931A;font-weight:900;font-size:11px;letter-spacing:1.6px;border-radius:8px;padding:6px 9px}
#psBreaking .m b{font-weight:900}
#psBreaking .x{flex:none;margin-left:6px;cursor:pointer;opacity:.6;font-size:18px;line-height:1}`;

  let root, games = [], picks = [], first = true;
  const seen = (() => { try { return JSON.parse(localStorage.getItem("ps.hits") || "{}"); } catch (e) { return {}; } })();
  const remember = () => { try { localStorage.setItem("ps.hits", JSON.stringify(seen)); } catch (e) {} };

  async function getJ(u) { try { const r = await fetch(u, { cache: "no-store" }); return r.ok ? r.json() : null; } catch (e) { return null; } }

  // Today's games, all four sports.
  async function loadGames() {
    const out = [];
    const day = etDay(), now = Date.now(), ymd = day.replace(/-/g, "");
    await Promise.all(SPORTS.map(async ([path, sport, em]) => {
      // ESPN's own "current" board (a whole NFL week, or last night's MLB
      // finals at 1 AM) plus today's: kept are today's games, anything live,
      // and finals from the last 14 hours.
      const [cur, tod] = await Promise.all([getJ(ESPN + path + "/scoreboard"), getJ(ESPN + path + "/scoreboard?dates=" + ymd)]);
      const evs = new Map();
      for (const ev of [...((cur && cur.events) || []), ...((tod && tod.events) || [])]) evs.set(ev.id, ev);
      for (const ev of evs.values()) {
        const st0 = ((ev.status || {}).type || {}).state, t0 = Date.parse(ev.date);
        if (!(etDay(t0) === day || st0 === "in" || (st0 === "post" && now - t0 < 14 * 3600e3))) continue;
        const c = (ev.competitions || [])[0] || {}, st = (ev.status || c.status || {}).type || {};
        const team = side => (c.competitors || []).find(x => x.homeAway === side) || {};
        const h = team("home"), a = team("away");
        const pre = st.state === "pre";
        out.push({ sport, em, t: Date.parse(ev.date), state: st.state,
                   detail: pre ? new Date(ev.date).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : (st.shortDetail || st.detail || ""),
                   away: (a.team || {}).abbreviation || "", home: (h.team || {}).abbreviation || "",
                   as: a.score, hs: h.score, names: [a.team, h.team].filter(Boolean).flatMap(t => [t.abbreviation, t.shortDisplayName, t.displayName, t.name].filter(Boolean)) });
      }
    }));
    // Live first, then upcoming by start, then finals.
    const rank = g => g.state === "in" ? 0 : g.state === "pre" ? 1 : 2;
    return out.sort((x, y) => rank(x) - rank(y) || x.t - y.t);
  }

  // Today's picks that are already in the clear (their game has started).
  async function loadPicks() {
    const day = etDay(), out = [];
    const [L, D, R] = await Promise.all(["ladder", "dub", "robin"].map(f => getJ(RAW + f + ".json")));
    const add = (prod, x, res, extra) => { if (!x || !x.pick && !x.player) return;
      out.push(Object.assign({ prod, sport: x.sport || "MLB", who: x.pick || x.player, need: x.need || "", teams: x.teams || "", res,
                               note: x.note || (typeof x.result === "string" && !/^(won|lost|open|void)$/.test(x.result) ? x.result : "") }, extra || {})); };
    for (const b of (L && L.bets) || []) if (b.date === day && b.pick) add("Ladder", b, b.status);
    // Every leg of every bet, and the bet itself once it cashes.
    for (const [prod, J] of [["Dub", D], ["Robin", R]]) for (const b of (J && J.bets) || []) {
      if (b.date !== day) continue;
      const legs = (b.legs || []).filter(l => l && l.player), n = legs.length;
      for (const l of legs) add(prod, l, l.result || "open", { of: n, hits: legs.filter(x => x.result === "won").length });
      if (prod === "Dub" && b.status === "won" && n) out.push({ prod, cashed: true, who: legs.map(l => l.player).join(" + "), need: "", sport: legs[0].sport, teams: "", res: "won" });
    }
    return out;
  }

  // A pick's game: its sport, and both team codes in its "NYY vs BOS" line.
  const pickGame = p => games.find(g => g.sport === p.sport && [g.away, g.home].every(abbr => abbr && new RegExp(`\\b${abbr}\\b`, "i").test(p.teams)));

  function draw() {
    if (!root) return;
    const byGame = new Map();
    for (const p of picks) { if (p.cashed) continue; const g = pickGame(p); if (g) (byGame.get(g) || byGame.set(g, []).get(g)).push(p); }
    const items = games.map(g => {
      const ps = byGame.get(g) || [], hit = ps.some(p => p.res === "won");
      const sc = g.state === "pre" ? "" : ` <b>${g.as ?? ""}</b>–<b>${g.hs ?? ""}</b>`;
      const mine = ps.length ? ` <span class="pk">🎯 ${ps.map(p => `${p.who.split(" ").slice(-1)[0]}${p.res === "won" ? " ✅" : p.res === "lost" ? " ❌" : ""}`).join(", ")}</span>` : "";
      return `<span class="psg${g.state === "in" ? " live" : ""}${ps.length ? " ours" : ""}${hit ? " hit" : ""}">${g.em} ${g.away}${g.state === "pre" ? "" : ""} @ ${g.home}${sc} <span class="st">${g.detail}</span>${mine}</span>`;
    });
    if (!items.length) items.push(`<span class="psg">No games on the board right now — today's picks lock an hour before the first game.</span>`);
    const run = items.join("");
    root.innerHTML = `<div class="tk"><span class="tag"><i></i>LIVE</span><div class="vp"><div class="run" style="--dur:${Math.max(40, items.length * 6)}s">${run}${run}</div></div></div>`;
  }

  // Breaking news: a pick that hit, announced once per device. On first load
  // the latest one not yet seen here flashes; after that, every new one.
  function breaking(p) {
    let el = document.getElementById("psBreaking");
    if (!el) { el = document.createElement("div"); el.id = "psBreaking"; document.body.appendChild(el); }
    const what = p.cashed ? `<b>THE DUB CASHES</b> — ${p.who} ✅✅`
      : p.prod === "Ladder" ? `<b>${p.who}</b> ${p.need}${p.note ? ` (${p.note})` : ""} — the Ladder rung is in ✅`
      : `<b>${p.who}</b> ${p.need}${p.note ? ` (${p.note})` : ""} — ${p.prod} leg hits ✅ ${p.hits} of ${p.of}`;
    el.innerHTML = `<span class="k">🚨 ${p.cashed ? "CASHED" : "HIT"}</span><span class="m">${what}</span><span class="x" aria-label="close">×</span>`;
    el.querySelector(".x").onclick = () => el.classList.remove("on");
    requestAnimationFrame(() => el.classList.add("on"));
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("on"), 12000);
  }

  async function tick() {
    const [g, p] = await Promise.all([loadGames(), loadPicks()]);
    games = g; picks = p; draw();
    const day = etDay();
    const key = x => `${day}:${x.prod}:${x.cashed ? "cashed" : x.who}`;
    const fresh = picks.filter(x => x.res === "won" && !seen[key(x)]);
    fresh.forEach(x => { seen[key(x)] = 1; });
    if (fresh.length) remember();
    if (!first || fresh.length) { const show = first ? fresh.slice(-1) : fresh; show.forEach((x, i) => setTimeout(() => breaking(x), i * 13000)); }
    first = false;
  }

  function start() {
    root = document.getElementById("psTicker");
    if (!root) { root = document.createElement("div"); root.id = "psTicker"; document.body.prepend(root); }
    const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    root.innerHTML = `<div class="tk"><span class="tag"><i></i>LIVE</span><div class="vp"></div></div>`;
    tick(); setInterval(tick, EVERY);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
