// Kalshi: public market data plus (optionally) signed order placement.
//
// The orderbook only lists BIDS, per side. A YES ask is somebody's NO bid:
// a NO bid at 0.36 for 607 means you can buy 607 YES at 0.64. So:
//   yesAsks = noBids mapped p -> 1-p,  noAsks = yesBids mapped p -> 1-p.
import { createSign, constants, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getJSON } from "./http.mjs";
import { kalshiFee } from "./math.mjs";

const HOST = process.env.KALSHI_HOST || "https://api.elections.kalshi.com";
const BASE = "/trade-api/v2";
const q = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString();

export const pub = (path, params = {}) => getJSON(`${HOST}${BASE}${path}${Object.keys(params).length ? "?" + q(params) : ""}`);

// Every open event with its markets. Events carry the human title
// ("ATL Falcons vs NO Saints") the matcher needs; markets alone don't.
// `series` may be a comma list: "KXNFLGAME,KXMLBGAME".
export async function openEvents({ maxPages = 50, series } = {}) {
  const out = [];
  for (const s of series ? String(series).split(",") : [undefined]) {
    let cursor;
    for (let p = 0; p < maxPages; p++) {
      const d = await pub("/events", { status: "open", with_nested_markets: true, limit: 200, cursor, series_ticker: s });
      out.push(...(d.events || []));
      cursor = d.cursor;
      if (!cursor || !(d.events || []).length) break;
    }
  }
  return out;
}

export async function market(ticker) { return (await pub(`/markets/${ticker}`)).market; }

const flip = lv => (lv || []).map(([p, s]) => [+(1 - +p).toFixed(4), +s]);
export function normaliseBook(raw) {
  const ob = raw.orderbook_fp || raw.orderbook || {};
  // Current shape: yes_dollars/no_dollars as [["0.62","1218.00"], ...].
  // Legacy shape: yes/no as [[62, 1218], ...] in cents.
  const yes = ob.yes_dollars || (ob.yes || []).map(([c, s]) => [c / 100, s]);
  const no = ob.no_dollars || (ob.no || []).map(([c, s]) => [c / 100, s]);
  return { yesAsks: flip(no), noAsks: flip(yes), yesBids: yes.map(([p, s]) => [+p, +s]), noBids: no.map(([p, s]) => [+p, +s]) };
}
export async function book(ticker, depth = 20) { return normaliseBook(await pub(`/markets/${ticker}/orderbook`, { depth })); }

const seriesCache = new Map();
export async function feeMultiplier(seriesTicker) {
  if (!seriesTicker) return 1;
  if (!seriesCache.has(seriesTicker)) {
    const s = (await pub(`/series/${seriesTicker}`)).series || {};
    seriesCache.set(seriesTicker, s.fee_multiplier ?? 1);
  }
  return seriesCache.get(seriesTicker);
}
export const feeFn = mult => (n, p) => kalshiFee(n, p, mult);

// ---- authenticated -------------------------------------------------------
// Key: create one at kalshi.com → Account → API Keys. You get a key id and an
// RSA private key file. Requests are signed with RSA-PSS/SHA-256 over
// timestamp + METHOD + path (path without the query string).

let key;
function creds() {
  if (key) return key;
  const id = process.env.KALSHI_API_KEY_ID;
  const pem = process.env.KALSHI_PRIVATE_KEY || (process.env.KALSHI_PRIVATE_KEY_PATH && readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH, "utf8"));
  if (!id || !pem) throw new Error("Kalshi trading needs KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH (or KALSHI_PRIVATE_KEY)");
  return (key = { id, pem });
}

export function signHeaders(method, path, { id, pem } = creds(), ts = Date.now().toString()) {
  const s = createSign("RSA-SHA256");
  s.update(ts + method.toUpperCase() + path.split("?")[0]);
  const sig = s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, "base64");
  return { "KALSHI-ACCESS-KEY": id, "KALSHI-ACCESS-TIMESTAMP": ts, "KALSHI-ACCESS-SIGNATURE": sig };
}

async function authed(method, path, body) {
  const full = BASE + path;
  const r = await fetch(HOST + full, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...signHeaders(method, full) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`Kalshi ${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return data;
}

export async function balance() { const d = await authed("GET", "/portfolio/balance"); return (d.balance ?? 0) / 100; }

// Fill-or-kill: the whole count at `limit` or better, or nothing at all. That
// is what keeps a leg from half-filling and leaving an unhedged remainder.
export async function buy({ ticker, side, count, limit }) {
  const cents = Math.round(limit * 100);
  const d = await authed("POST", "/portfolio/orders", {
    ticker, side, action: "buy", count, type: "limit",
    [side === "yes" ? "yes_price" : "no_price"]: cents,
    time_in_force: "fill_or_kill", client_order_id: randomUUID()
  });
  const o = d.order || {};
  const filled = +(o.fill_count ?? o.fill_count_fp ?? (o.status === "executed" ? count : 0));
  return { ok: filled >= count, filled, order: o };
}

// Emergency unwind: sell what we hold, immediately, at no worse than `floor`.
export async function sell({ ticker, side, count, floor = 0.01 }) {
  const cents = Math.max(1, Math.round(floor * 100));
  const d = await authed("POST", "/portfolio/orders", {
    ticker, side, action: "sell", count, type: "limit",
    [side === "yes" ? "yes_price" : "no_price"]: cents,
    time_in_force: "immediate_or_cancel", client_order_id: randomUUID()
  });
  return d.order || {};
}
