// 9:00 am New York: today's Daily 2:1 trade, to Telegram.
//
// Pulls fresh hourly candles for the five pairs (Kraken FX spot; Twelve Data
// when TWELVE_DATA_KEY is set), runs fx-daily.js with the published settings
// (data/fx-daily.json) and the CFTC positioning (data/fx-cot.json), and sends
// what to place: each pair's working order with entry, stop, target and lots
// for DAILY_RISK (default $500, target 2x), or the trade already filled today.
//
// The workflow fires every 15 minutes from 8:45 to ~10:00 New York (in both
// summer and winter time) so a late or skipped GitHub run is covered; this
// script sends when New York reads 8:45–10:30 (or always, with FORCE=1), and
// the workflow stops after the first send of the day (SENT_MARK).
//
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   without them the message is printed
//   FX_ALERT_BARS=file.json                 test with candles from a file
import { createRequire } from "module";
import { existsSync, readFileSync } from "fs";
const require = createRequire(import.meta.url);
const E = require("../fx-engine.js"), F = require("../fx-daily.js");

const RISK = +(process.env.DAILY_RISK || 500);
const TD = { EURUSD: "EUR/USD", GBPUSD: "GBP/USD", AUDUSD: "AUD/USD", USDCHF: "USD/CHF", USDJPY: "USD/JPY" };
const PAGE = "https://thedifference7717-sys.github.io/oracle/forex.html";

function nyClock(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { h: +p.hour, m: +p.minute, wd: p.weekday };
}

async function getJSON(url) {
  for (let a = 1; a <= 3; a++) {
    try { const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }); if (r.ok) return await r.json(); throw new Error(url.split("/")[2] + " " + r.status); }
    catch (e) { if (a === 3) throw e; await new Promise(r => setTimeout(r, 3000 * a)); }
  }
}
async function hourly(sym) {
  if (process.env.TWELVE_DATA_KEY) {
    try {
      const j = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(TD[sym])}&interval=1h&outputsize=1000&timezone=UTC&apikey=${process.env.TWELVE_DATA_KEY}`);
      if (j.values) return j.values.map(v => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z") / 1000, o: +v.open, h: +v.high, l: +v.low, c: +v.close })).sort((a, b) => a.t - b.t);
    } catch (e) { console.log(`${sym}: Twelve Data failed (${e.message}), trying Kraken`); }
  }
  const j = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${sym}&interval=60`);
  if (j.error && j.error.length) throw new Error("kraken " + j.error[0]);
  const k = Object.keys(j.result).find(x => x !== "last");
  return j.result[k].map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4] })).sort((a, b) => a.t - b.t);
}

async function send(text) {
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!tok || !chat) { console.log("[dry run — no Telegram secrets]\n" + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error("telegram " + r.status + " " + await r.text());
  console.log("sent");
  // Tell the workflow today's alert is out, so the later retries stay quiet.
  if (process.env.SENT_MARK) { const fs = await import("fs"); fs.mkdirSync(process.env.SENT_MARK, { recursive: true }); fs.writeFileSync(process.env.SENT_MARK + "/ok", new Date().toISOString()); }
}

const clk = nyClock();
if (!process.env.FORCE && !((clk.h === 8 && clk.m >= 45) || clk.h === 9 || (clk.h === 10 && clk.m < 30))) {
  console.log(`New York is ${clk.h}:${String(clk.m).padStart(2, "0")} — not the 9 am run, nothing to send.`);
  process.exit(0);
}

const daily = existsSync("data/fx-daily.json") ? JSON.parse(readFileSync("data/fx-daily.json", "utf8")) : null;
// The every-day trade (9:00 New York, at market) when the tuner has one; else the setup-based orders.
const every = daily && daily.everyday;
const rules = every ? (every.params || every.candidate) : daily && (daily.params || daily.candidate);
const tested = every ? !!every.params : !!(daily && daily.params);
if (!rules) { await send("⚠️ <b>FX daily 2:1</b>: no tuned settings yet (data/fx-daily.json)."); process.exit(0); }
const cot = existsSync("data/fx-cot.json") ? JSON.parse(readFileSync("data/fx-cot.json", "utf8")).pairs : null;

const now = Date.now() / 1000, h1 = {}, errs = [];
const fromFile = process.env.FX_ALERT_BARS ? JSON.parse(readFileSync(process.env.FX_ALERT_BARS, "utf8")) : null;
for (const s of E.SYMS) {
  try { h1[s] = (fromFile ? fromFile[s] : await hourly(s)).filter(b => b.t + 3600 <= (fromFile ? Infinity : now)); }
  catch (e) { errs.push(`${s}: ${e.message}`); }
}
// No prices: fail the run — the workflow warns on Telegram and retries in 15 minutes.
if (errs.length) { console.error("could not load prices — " + errs.join("; ")); process.exit(1); }

const h4 = {};
E.SYMS.forEach(s => h4[s] = E.aggregate(h1[s], E.H4, "oanda"));
const usd = E.usdStructure(h4, { tf: E.H4, usdTf: E.H8, usdLen: 20 }, "oanda");
const preps = E.SYMS.map(s => F.prepare(s, h1[s], { usd, cot: cot && cot[s] }));
const T = F.today(preps, rules);

const fmt = (s, v) => v.toFixed(E.PAIRS[s].dp);
const lotsFor = (s, o) => {
  const perLot = E.LOT * E.usdPer(s, o.dist, o.stop), lots = Math.floor(RISK / perLot * 100 + 1e-9) / 100;
  return { lots, loss: lots * perLot, win: lots * E.LOT * E.usdPer(s, Math.abs(o.tp - o.entry), o.tp) };
};
const $ = v => "$" + Math.round(v).toLocaleString("en-US");
// 1 lot = 100,000 units = $10 a pip on EURUSD/GBPUSD/AUDUSD; USDCHF/USDJPY pay
// in CHF/JPY, so their dollar pip value moves with the rate.
const pipUsd = (s, at) => E.LOT * E.usdPer(s, E.PAIRS[s].pip, at);
const pipsOf = (s, d) => (d / E.PAIRS[s].pip).toFixed(1);
const nyTime = t => new Date(t * 1000).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";
const arrow = d => d === "long" ? "🟢 BUY" : "🔴 SELL";
const orderLine = (s, o) => {
  const L = lotsFor(s, o), kind = o.kind === "stop" ? "STOP" : o.kind === "market" ? "AT MARKET ~" : "LIMIT";
  return `${arrow(o.dir)} ${kind} <b>${s}</b> ${fmt(s, o.entry)} · <b>${L.lots.toFixed(2)} lots</b>\n` +
         `   SL ${fmt(s, o.stop)} (−${$(L.loss)}) · TP ${fmt(s, o.tp)} (+${$(L.win)})`;
};

const BIAS = { prevday: "yesterday's candle", d1s3: "daily structure", d1s5: "daily structure", h4s10: "4h structure", usd: "USD trend", ema50: "4h EMA 50", cot: "hedge funds (CFTC)" };
const why = b => b.split("+").map(x => BIAS[x] || x).join(" + ");
const lines = [`📈 <b>FX — today's trade · ${clk.wd} ${clk.h}:${String(clk.m).padStart(2, "0")} ET</b>`, `Risk ${$(RISK)} to make ${$(2 * RISK)} · settles within 24h`];
if (!tested) lines.push(`⚠️ <i>Untested — it did not make money on the unseen test period. Information, not a signal.</i>`);
lines.push("");
if (rules.entry === "ny9") {
  const t = T.trade || T.next;
  if (!t) lines.push(clk.h >= 2 && clk.h <= 9
    ? `No trade today — no pair has a clear direction (${why(rules.bias)}).`
    : `Today's trade is set at 9:00 am ET — the levels come from the prices just before. (This run is at ${clk.h}:${String(clk.m).padStart(2, "0")} ET.)`);
  else {
    const L = lotsFor(t.sym, t);
    lines.push(`${arrow(t.dir)} <b>${t.sym}</b> at market ${T.trade ? "(on since 9:00)" : "at 9:00 ET"} ~${fmt(t.sym, t.entry)} · <b>${L.lots.toFixed(2)} lots</b>`);
    lines.push(`   SL ${fmt(t.sym, t.stop)} (−${$(L.loss)}) · TP ${fmt(t.sym, t.tp)} (+${$(L.win)})`);
    lines.push(`   ${pipsOf(t.sym, t.dist)} pip stop × ${pipUsd(t.sym, t.entry).toFixed(2)} $/pip per lot × ${L.lots.toFixed(2)} lots`);
    lines.push(`⏱ If neither hits, close at market by ${rules.exit === "eod" ? "5:00 pm ET today" : T.trade ? nyTime(t.closeBy) : "9:00 am ET tomorrow"}.`);
    if (T.trade && t.how) lines.push(`It has closed: ${t.how} (${t.R >= 0 ? "+" : "−"}${$(Math.abs(t.R) * RISK)}).`);
    lines.push(`Why: ${why(rules.bias)} points ${t.dir === "long" ? "up" : "down"}${rules.pick === "adx" ? `; strongest 4h trend of the five (ADX ${Math.round(t.score || 0)})` : ""}.`);
  }
  const rec = every.best && every.best.oos;
  if (rec) lines.push("", `Record, unseen ${daily.split.oosLabel}: ${rec.n} trades, ${Math.round(100 * rec.tgt)}% hit the full target, ${rec.R >= 0 ? "+" : ""}${rec.R.toFixed(1)}R (${rec.R >= 0 ? "+" : "−"}${$(Math.abs(rec.R) * RISK)}).`);
  lines.push(`<a href="${PAGE}">Chart and levels</a> · confirm on your OANDA chart first.`);
  await send(lines.join("\n"));
  process.exit(0);
}
lines.length = 0;
lines.push(`📈 <b>FX daily 2:1 — ${clk.wd} ${clk.h}:${String(clk.m).padStart(2, "0")} ET</b>`, `Risk ${$(RISK)} to make ${$(2 * RISK)} · one trade a day`);
if (!tested) lines.push(`⚠️ <i>Untested — no daily setup held up on unseen data. Treat as information, not a signal.</i>`);
lines.push("");
if (T.trade) {
  const t = T.trade, L = lotsFor(t.sym, t);
  lines.push(`✅ <b>Today's trade is already on</b> (filled ${new Date(t.fillT * 1000).toISOString().slice(11, 16)} UTC):`);
  lines.push(orderLine(t.sym, t));
  lines.push(t.how ? `It has closed: ${t.how} (${t.R >= 0 ? "+" : "−"}${$(Math.abs(t.R) * RISK)}).`
                    : `Cancel any other orders for today. <b>If neither SL nor TP hits, close it at market by ${nyTime(t.closeBy)}.</b>`);
} else {
  const working = E.SYMS.map(s => [s, T.pairs[s] && T.pairs[s].trade]).filter(([, t]) => t && t.pending && !t.forming);
  if (!working.length) lines.push(`No setup yet today. Orders arm ${rules.win[0]}:00–${rules.win[1]}:00 UTC — check the page later.`);
  else {
    lines.push(`<b>Place these orders</b> — the first one to fill is the day's trade; cancel the rest when it does.`);
    lines.push(`⏱ Settle within 24h: if neither SL nor TP hits, close at market ${rules.exit === "eod" ? "at the New York close (5 pm ET)" : "24 hours after it fills"}.`);
    for (const [s, t] of working) for (const o of (t.both || [t])) lines.push(orderLine(s, o));
  }
}
const dirs = E.SYMS.map(s => { const b = T.pairs[s] && T.pairs[s].bias; return `${s} ${b === "both" ? "either" : b || "—"}`; });
lines.push("", `Direction (${rules.bias}): ${dirs.join(" · ")}`);
if (daily.best && daily.best.oos) lines.push(`Record, unseen ${daily.split.oosLabel}: ${daily.best.oos.n} trades, ${Math.round(100 * daily.best.oos.hit)}% hit, ${daily.best.oos.R >= 0 ? "+" : ""}${daily.best.oos.R.toFixed(1)}R.`);
lines.push(`<a href="${PAGE}">Chart and levels</a> · confirm on your OANDA chart first.`);
await send(lines.join("\n"));
