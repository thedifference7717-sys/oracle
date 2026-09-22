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

  // A published file: Pages first (cached up to ten minutes by the CDN), the
  // last good copy if that fails, and — only while today's pick is pending —
  // the repo itself, which is never stale.
  P.load = async function (path, { fresh } = {}) {
    const key = "pg.cache." + path;
    if (fresh) {
      try {
        const r = await fetch("https://api.github.com/repos/thedifference7717-sys/oracle/contents/" + path + "?ref=main",
          { headers: { Accept: "application/vnd.github.raw" }, cache: "no-store" });
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
    return `<div class="leg ${l.result || ""}">
      <div class="nm">${P.EMOJI[l.sport] || ""} ${l.player} ${res}</div>
      <div class="need">${l.need}${l.note && l.result ? ` <span style="color:var(--dim);font-weight:400">— ${l.note}</span>` : ""}</div>
      <div class="sub">${l.teams || ""}${when}${l.detail ? ` · ${l.detail}` : ""}</div>
      <div class="px">${P.odds(l.price)}<small>${P.pct(l.pAdj)} to win</small></div>
      ${extra || ""}</div>`;
  };

  let flashT = null;
  P.flashSaved = id => { const el = document.getElementById(id); if (!el) return; el.textContent = "✓ Saved"; el.classList.add("on");
    clearTimeout(flashT); flashT = setTimeout(() => el.classList.remove("on"), 1400); };

  window.Pages = P;
})();
