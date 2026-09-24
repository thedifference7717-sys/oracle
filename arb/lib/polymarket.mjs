// Polymarket: Gamma (market metadata) + CLOB (orderbooks, orders).
//
// Trading goes through Polymarket's official @polymarket/clob-client, which
// does the EIP-712 order signing. It is an optional dependency, loaded only
// when --live is used:  npm i --prefix arb
//
// Access: the international exchange (clob.polymarket.com) does not accept
// US persons, and marks many markets `restricted`. Polymarket US is a
// separate, CFTC-regulated venue with its own app and API that this module
// does not speak. Trade only where you are permitted to.
import { getJSON } from "./http.mjs";
import { polyFee } from "./math.mjs";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = process.env.POLY_CLOB_HOST || "https://clob.polymarket.com";
const parse = v => (typeof v === "string" ? JSON.parse(v) : v || []);

// Gamma caps a page at 100 whatever `limit` says, and refuses offsets past
// ~2000; /markets/keyset with after_cursor is the way through the lot.
export async function openMarkets({ maxPages = 400 } = {}) {
  const out = [];
  let cursor = "";
  for (let p = 0; p < maxPages; p++) {
    const d = await getJSON(`${GAMMA}/markets/keyset?active=true&closed=false&limit=100${cursor ? "&after_cursor=" + encodeURIComponent(cursor) : ""}`);
    out.push(...(d.markets || []));
    cursor = d.next_cursor;
    if (!cursor || !(d.markets || []).length) break;
  }
  return out.filter(m => m.enableOrderBook && m.acceptingOrders !== false);
}

export async function marketBySlug(slug) {
  const d = await getJSON(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  if (!d.length) throw new Error(`Polymarket market not found: ${slug}`);
  return d[0];
}

// The pieces of a Gamma market the bot needs, with outcome names tied to
// their token ids (outcomes[i] is paid by clobTokenIds[i]).
export function describe(m) {
  const outcomes = parse(m.outcomes), tokens = parse(m.clobTokenIds);
  const fs = m.feeSchedule || {};
  return {
    slug: m.slug, question: m.question, conditionId: m.conditionId,
    endDate: m.endDate, negRisk: !!m.negRisk, restricted: !!m.restricted,
    tickSize: String(m.orderPriceMinTickSize ?? "0.01"), minSize: +(m.orderMinSize ?? 5),
    feeRate: m.feesEnabled ? +(fs.rate ?? 0) : 0,
    outcomes: outcomes.map((name, i) => ({ name, token: tokens[i] })),
    description: m.description
  };
}

export async function book(token) {
  const d = await getJSON(`${CLOB}/book?token_id=${token}`);
  return {
    asks: (d.asks || []).map(l => [+l.price, +l.size]).sort((a, b) => a[0] - b[0]),
    bids: (d.bids || []).map(l => [+l.price, +l.size]).sort((a, b) => b[0] - a[0])
  };
}

export const feeFn = rate => (n, p) => polyFee(n, p, rate);

// ---- authenticated -------------------------------------------------------
let client, lib;
async function clob() {
  if (client) return { client, lib };
  const pk = process.env.POLY_PRIVATE_KEY;
  if (!pk) throw new Error("Polymarket trading needs POLY_PRIVATE_KEY (and POLY_FUNDER for a proxy wallet)");
  try {
    lib = await import("@polymarket/clob-client");
    var { createWalletClient, http } = await import("viem");
    var { polygon } = await import("viem/chains");
    var { privateKeyToAccount } = await import("viem/accounts");
  } catch {
    throw new Error("Polymarket trading needs its SDK: npm i --prefix arb");
  }
  const signer = createWalletClient({ account: privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk), chain: polygon, transport: http() });
  const sigType = +(process.env.POLY_SIGNATURE_TYPE ?? 0); // 0 EOA, 1 email/Magic proxy, 2 browser-wallet proxy
  const funder = process.env.POLY_FUNDER || undefined;
  const boot = new lib.ClobClient(CLOB, 137, signer);
  const creds = await boot.createOrDeriveApiKey();
  client = new lib.ClobClient(CLOB, 137, signer, creds, sigType, funder);
  return { client, lib };
}

// Fill-or-kill limit buy of exactly `count` shares at `limit` or better.
export async function buy({ token, count, limit, tickSize, negRisk }) {
  const { client, lib } = await clob();
  const order = await client.createOrder(
    { tokenID: token, price: limit, size: count, side: lib.Side.BUY },
    { tickSize, negRisk }
  );
  // Errors come back as { error, status } objects rather than throwing.
  const r = await client.postOrder(order, lib.OrderType.FOK);
  const ok = !!(r && r.success && !r.error && !r.errorMsg && String(r.status || "").toLowerCase() === "matched");
  return { ok, response: r };
}
