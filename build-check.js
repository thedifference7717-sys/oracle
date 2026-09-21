// Is this page the build that is actually deployed? — one copy, four pages.
//
// index.html, gridiron.html, hairdwood.html and record.html each had (or, in
// record.html's case, lacked) their own version of this. They drifted, exactly
// as the scoring engine did before dd-model.js: index.html got the cache-bypass
// fix, the other two kept the broken reload, and record.html — the page whose
// entire job is showing the record — had no check at all, so a cached copy of
// it could sit there indefinitely with nothing to say so.
//
// HOW A PAGE GOES STALE, AND WHY THE OBVIOUS FIX DOES NOT WORK.
//
// GitHub Pages serves HTML with a ten-minute max-age through a CDN that keys
// on the PATH, and WebKit does the same for a page launched from the iOS home
// screen. build.json is fetched no-store so it is always current; the document
// is not. Navigating to the same path with a fresh query token — the old
// approach — is answered with the identical cached copy, so the page reloads,
// comes back byte-for-byte the same, and puts the bar straight back up. That
// is why pressing UPDATE NOW appeared to do nothing.
//
// `fetch(path, {cache:"reload"})` is the part that bites: it forces a
// revalidation against the origin and rewrites the stored entry, so the
// navigation that follows is served the new document.
//
// And when even that cannot win, this says so rather than offering the same
// button again — including the thing that actually matters: a stale PAGE is
// not stale NUMBERS. Every page here fetches its data no-store on load, so the
// figures are current whatever build is drawing them.
(function () {
  var BUILD = (document.getElementById("buildsha") || { textContent: "_dev" }).textContent.trim();
  var liveSha = null;

  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  // Attempts live in localStorage, not sessionStorage: a page launched from the
  // iOS home screen starts a fresh session every time, which would reset the
  // count and retry the same doomed reload forever.
  var SS = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };

  function bar() {
    var el = document.getElementById("update-bar");
    if (el) return el;
    el = document.createElement("div");
    el.id = "update-bar";
    el.style.cssText = "display:none;align-items:center;gap:12px;flex-wrap:wrap;" +
      "padding:12px 20px;background:#3A2E00;border-bottom:.5px solid #FFD60A55;" +
      "color:#FFD60A;font-size:13px;line-height:1.5";
    el.innerHTML = '<span id="update-msg"></span>' +
      '<button style="margin-left:auto;padding:7px 15px;background:#FFD60A;border:none;' +
      'border-radius:980px;font:inherit;font-weight:700;color:#000;cursor:pointer">UPDATE NOW</button>';
    el.querySelector("button").addEventListener("click", function () { hardReload(); });
    document.body.insertBefore(el, document.body.firstChild);
    return el;
  }

  async function hardReload() {
    var el = bar(), btn = el.querySelector("button");
    if (btn) { btn.textContent = "UPDATING…"; btn.disabled = true; }
    var base = location.pathname.replace(/[?#].*$/, "");
    if (liveSha) LS.set("bc.tried." + liveSha, String(Date.now()));
    try { await fetch(base, { cache: "reload" }); } catch (e) {}
    location.replace(base + "?b=" + (liveSha || "new") + "."
      + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  }

  async function checkBuild() {
    // An unstamped page cannot tell whether it is stale, so it must not claim
    // to be current either. Local checkouts and branch previews land here.
    if (BUILD.charAt(0) === "_") return;
    try {
      var r = await fetch("build.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      var j = await r.json();
      if (!j || !j.sha) return;
      if (j.sha === BUILD) {                       // caught up
        var cur = document.getElementById("update-bar");
        if (cur) cur.style.display = "none";
        LS.del("bc.tried." + BUILD);
        return;
      }
      liveSha = j.sha;
      var tried = +LS.get("bc.tried." + j.sha) || 0;
      // One silent attempt per build. With a real cache bypass this fixes the
      // ordinary case, so most of the time nobody sees a banner at all.
      if (!tried && !SS.get("bc.auto." + j.sha)) { SS.set("bc.auto." + j.sha, "1"); hardReload(); return; }
      var el = bar(), btn = el.querySelector("button"), msg = el.querySelector("#update-msg");
      if (tried) {
        if (msg) msg.innerHTML = "⏳ This device is still being served the previous build (<code>" + BUILD
          + "</code> rather than <code>" + j.sha + "</code>). That clears on its own within about ten minutes. "
          + "<b>It does not change what you are looking at</b> — every figure on this page is fetched fresh on "
          + "each load, so the numbers are current whatever build is drawing them.";
        if (btn) { btn.disabled = false; btn.textContent = "TRY AGAIN"; }
      } else {
        if (msg) msg.textContent = "⬆ A newer build is deployed — this page is stale.";
        if (btn) { btn.disabled = false; btn.textContent = "UPDATE NOW"; }
      }
      el.style.display = "flex";
    } catch (e) { /* offline or no build.json — nothing to do */ }
  }

  window.hardReload = hardReload;
  window.checkBuild = checkBuild;          // pages that call it in their own load()
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", checkBuild);
  else checkBuild();
})();
