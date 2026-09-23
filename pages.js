// Shared by dub.html and robin.html: formatting, the published files, and
// today's lock clock. The pages only READ what the alerter published — the
// picks are made where the sports feeds and Kalshi prices are reachable, and
// the repo commit before the first game is the record.
(function () {
  const P = {};
  P.EMOJI = { MLB: "⚾", NBA: "🏀", NFL: "🏈" };
  P.money = v => (v < 0 ? "-$" : "$") + Math.abs(+v || 0).toFixed(2);
  P.pct = v => v == null ? "—" : Math.round(v * 100) + "%";
  P.odds = a => { a = +a; if (!isFinite(a) || !a) return "—"; const r = Math.round(a); return (r > 0 ? "+" : "") + r; };
  P.dec = a => { a = +a; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); };
  P.amer = d => d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
  P.etTime = ms => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  P.prettyDate = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short", timeZone: "UTC" });
  // The slate day, Eastern time less six hours — the rule every script uses,
  // so a 10:30pm tip still belongs to the day it was bet on.
  P.slateDay = () => {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    d.setHours(d.getHours() - 6);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };
  P.store = {
    get(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  // ── Live: the repo itself, not the ten-minute Pages cache ────────────────
  // The alerter grades every leg within a minute or two of it happening and
  // commits the result, but GitHub Pages can hold the old file for up to ten
  // minutes after that. So while a bet is live the pages read the file at the
  // repo's newest commit instead: one small API call for the commit id, shared
  // by every open tab and made at most every 75 seconds (the API allows 60 an
  // hour without a login), then the file at that commit from
  // raw.githubusercontent.com, which is not rate-limited and never stale,
  // because a commit's files never change.
  const REPO = "thedifference7717-sys/oracle";
  P.head = async function () {
    const c = P.store.get("pg.head", null);
    if (c && Date.now() < c.until) return c.sha;
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/commits/main`,
        { headers: { Accept: "application/vnd.github.sha" }, cache: "no-store" });
      if (r.ok) {
        const sha = (await r.text()).trim();
        if (/^[0-9a-f]{40}$/.test(sha)) { P.store.set("pg.head", { sha, until: Date.now() + 75000 }); return sha; }
      }
      // Out of calls for the hour: keep the last id and back off five minutes.
      if (r.status === 403 || r.status === 429) P.store.set("pg.head", { sha: c && c.sha, until: Date.now() + 300000 });
    } catch (e) {}
    return c && c.sha;
  };
  P.hasOpen = j => !!(j && Array.isArray(j.bets) && j.bets.some(b => b && b.status === "open"));

  // A published file, always from the repo at its newest commit first; then
  // the Pages copy, then the last good copy.
  //
  // The Pages copy cannot be the first choice. The site is redeployed only by
  // pushes GitHub counts as real, and the alerter's automated data commits are
  // not among them — so data/*.json on Pages stays frozen at the last code
  // push, sometimes for a day. That is how the Dub and Robin pages showed no
  // bet on 2026-09-23 while the alerts had gone out: the frozen ladder.json
  // carried no lock for the day, so the pages never knew to look further.
  P.load = async function (path) {
    const key = "pg.cache." + path;
    {
      try {
        const sha = await P.head();
        if (sha) {
          const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${path}`, { cache: "no-store" });
          if (r.ok) { const j = await r.json(); P.store.set(key, j); return j; }
        }
      } catch (e) {}
      // No commit id (the API is out of calls): the branch copy on raw is at
      // most a few minutes old, which still beats the Pages copy by hours.
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`, { cache: "no-store" });
        if (r.ok) { const j = await r.json(); P.store.set(key, j); return j; }
      } catch (e) {}
    }
    try {
      const r = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
      if (r.ok) { const j = await r.json(); P.store.set(key, j); return j; }
    } catch (e) {}
    return P.store.get(key, null);
  };

  // Today's lock, as the alerter published it with the ladder.
  P.lockOf = ladder => {
    const nx = ladder && ladder.next, today = P.slateDay();
    if (!nx || nx.date !== today || !nx.lockAt) return null;
    const lockAt = Date.parse(nx.lockAt);
    return { lockAt, first: Date.parse(nx.first), open: Date.now() >= lockAt, games: nx.games || {} };
  };
  P.gamesLine = g => Object.entries(g || {}).filter(([, n]) => n > 0).map(([s, n]) => `${P.EMOJI[s] || ""} ${n} ${s}`).join(" · ");
  P.clock = ms => { if (ms <= 0) return "LOCKING NOW"; const t = Math.floor(ms / 1000), p2 = n => String(n).padStart(2, "0");
    return `${Math.floor(t / 3600)}:${p2(Math.floor(t / 60) % 60)}:${p2(t % 60)}`; };

  P.leg = (l, extra) => {
    const res = l.result === "won" ? '<span class="tag ok">✓ WON</span>' : l.result === "lost" ? '<span class="tag bad">✗ LOST</span>'
              : l.result === "void" ? '<span class="tag dim">VOID</span>' : "";
    const when = l.start ? ` · ${P.etTime(Date.parse(l.start))} ET` : "";
    // A leg locked on a projected lineup carries `lineup` once the real one posts.
    const detail = l.detail && l.lineup
      ? l.detail.replace(/^#\d+ · /, "").replace(/ · projected, \d+% to start$/, "") + (l.lineup.in ? ` · lineup out — batting #${l.lineup.slot}` : " · lineup out — not in it")
      : l.detail;
    return `<div class="leg ${l.result || ""}">
      <div class="nm">${P.EMOJI[l.sport] || ""} ${l.player} ${res}</div>
      <div class="need">${l.need}${l.note && l.result ? ` <span style="color:var(--dim);font-weight:400">— ${l.note}</span>` : ""}</div>
      <div class="sub">${l.teams || ""}${when}${detail ? ` · ${detail}` : ""}</div>
      <div class="px">${P.odds(l.price)}<small>${P.pct(l.pAdj)} to win</small></div>
      ${extra || ""}</div>`;
  };

  let flashT = null;
  P.flashSaved = id => { const el = document.getElementById(id); if (!el) return; el.textContent = "✓ Saved"; el.classList.add("on");
    clearTimeout(flashT); flashT = setTimeout(() => el.classList.remove("on"), 1400); };

  window.Pages = P;
})();
