// Sealed picks — the Ladder, Dub and Robin published without giving them away.
//
// The record's worth is that every pick is committed to this public repo
// before its game starts. Committing the pick itself also hands it to anyone
// who reads the repo, which is fine for a free product and fatal for a paid
// one. So a pick is committed SEALED:
//
//   sealed:   { v, hash, iv, ct }
//     hash  = sha256 of canon({ ctx, fields, salt }) — the fingerprint
//     ct    = those same bytes, AES-256-GCM encrypted with PICKS_KEY, so any
//             runner holding the key can read the pick back out of the repo
//
// and REVEALED once its game starts — every field back in the clear, plus
//
//   revealed: { v, hash, salt, keys, ctx }
//
// from which anyone can recompute the hash and find the commit that carried it
// before first pitch. Each Dub and Robin leg is sealed and revealed on its own
// clock: revealing a card at its first game would give away the later legs.
//
// Sealing is deterministic — the salt and IV are derived from the key and the
// fields — so writing the same pick twice publishes the same bytes, and no
// seal ever has to be remembered anywhere but the file it is in.
//
// Only rows marked `seal: 1` (set at placement while a key is configured) are
// touched. With no PICKS_KEY the whole module is a pass-through.
import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Stable JSON: sorted keys, undefined dropped. Mirrored in pages.js — the two
// must agree byte for byte or no browser can verify a reveal.
export const canon = v => Array.isArray(v) ? "[" + v.map(x => canon(x === undefined ? null : x)).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v);

// What stays public while sealed, and what is sealed. Anything in neither list
// (a lineup note, a result) is left out until the reveal, so a field added in
// future can never leak by default.
export const RULES = {
  ladder: {
    pub: ["id", "date", "status", "published", "cycle", "rung", "seed", "stake", "games", "seal", "reason", "account"],
    priv: ["sport", "start", "firstPitch", "price", "priceSource", "kalshi", "p", "pAdj", "edge", "pick", "playerId",
           "market", "line", "need", "eventId", "teams", "detail", "fromProps", "runnersUp", "gk", "slot", "posted",
           "startProb", "sp"]
  },
  dub: { pub: ["id", "date", "published", "status", "games", "seal", "reason"], priv: ["prob", "price", "fair", "excludes"] },
  robin: { pub: ["id", "date", "published", "status", "games", "seal", "reason", "sizes"], priv: [] },
  leg: { pub: [], priv: ["sport", "player", "playerId", "market", "line", "need", "eventId", "gk", "teams", "start",
                         "price", "priceSource", "kalshi", "p", "pAdj", "detail"] }
};

export function keyFrom(b64) {
  if (!b64) return null;
  const k = Buffer.from(String(b64).trim(), "base64");
  if (k.length !== 32) throw new Error("PICKS_KEY must be 32 bytes, base64 — generate one with: openssl rand -base64 32");
  return k;
}

const hmac = (key, s) => createHmac("sha256", key).update(s).digest();
const sha = s => createHash("sha256").update(s).digest("hex");
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };

function sealFields(key, ctx, fields) {
  const salt = hmac(key, "salt|" + ctx + "|" + canon(fields)).toString("hex").slice(0, 32);
  const payload = canon({ ctx, fields, salt });
  const iv = hmac(key, "iv|" + payload).subarray(0, 12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(payload, "utf8"), c.final(), c.getAuthTag()]);
  return { sealed: { v: 1, hash: sha(payload), iv: iv.toString("base64"), ct: ct.toString("base64") }, salt };
}

// The fields inside a seal, checked against its own fingerprint. Throws on a
// wrong key or a tampered seal rather than returning something plausible.
export function openSeal(key, s) {
  const buf = Buffer.from(s.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  const payload = Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8");
  if (sha(payload) !== s.hash) throw new Error("seal does not match its fingerprint");
  return JSON.parse(payload).fields;
}

// Anyone can run this: does a revealed row carry the fields its fingerprint
// was taken over?
export function checkReveal(o) {
  const r = o && o.revealed;
  if (!r) return null;
  return sha(canon({ ctx: r.ctx, fields: pick(o, r.keys), salt: r.salt })) === r.hash;
}

export function sealer(key, { now = () => Date.now() } = {}) {
  const on = !!key;

  // One object (a ladder row, a card, a leg) as it should be published.
  function publish(o, rule, ctx, hidden) {
    const fields = pick(o, rule.priv);
    const keys = Object.keys(fields).sort();
    if (hidden) {
      const out = pick(o, rule.pub);
      if (keys.length) out.sealed = sealFields(key, ctx, fields).sealed;
      return out;
    }
    const out = Object.assign({}, o);
    delete out.sealed; delete out.revealed;
    if (keys.length) {
      const { sealed, salt } = sealFields(key, ctx, fields);
      out.revealed = { v: 1, hash: sealed.hash, salt, keys, ctx };
    }
    return out;
  }
  // The same object read back: a seal opened into its fields, a reveal's proof
  // dropped (it is recomputed on every write). A seal that will not open is
  // left as it is — never guessed at.
  function open(o) {
    if (!o || typeof o !== "object") return o;
    const out = Object.assign({}, o);
    delete out.revealed;
    if (out.sealed && on) {
      try { Object.assign(out, openSeal(key, out.sealed)); delete out.sealed; }
      catch (e) { console.log(`seal: cannot open ${o.id || "a leg"} (${e.message}) — left sealed`); }
    }
    return out;
  }

  const t = s => { const x = Date.parse(s); return isNaN(x) ? Infinity : x; };
  const legHidden = (card, l) => card.status === "open" && !l.result && now() < t(l.start);

  return {
    on,
    // Whether a row still has anything to hide — the alerter leaves those
    // rows alone rather than write a change nobody could see.
    ladderHidden: b => on && !!b && b.seal === 1 && b.status === "open" && now() < t(b.start),
    legHidden: (card, l) => on && !!card && card.seal === 1 && legHidden(card, l),
    ladderOut(b) {
      if (!on || !b || b.seal !== 1 || b.sealed) return b;
      return publish(b, RULES.ladder, b.id, b.status === "open" && now() < t(b.start));
    },
    ladderIn: b => (b && b.seal === 1 ? open(b) : b),
    cardOut(b, kind) {
      if (!on || !b || b.seal !== 1 || !Array.isArray(b.legs)) return b;
      const legs = b.legs.map((l, i) => l.sealed ? l : publish(l, RULES.leg, `${b.id}#${i}`, legHidden(b, l)));
      // The card's own numbers go last: when every leg is out, and not before
      // the ladder's own game if the card names the ladder's pick.
      const ex = b.excludes && b.excludes.start ? t(b.excludes.start) : -Infinity;
      const hidden = b.status === "open" && (legs.some(l => l.sealed) || now() < ex);
      const card = b.sealed ? b : publish(Object.assign({}, b, { legs: undefined }), RULES[kind], b.id, hidden);
      return Object.assign(card, { legs });
    },
    cardIn(b) {
      if (!b || b.seal !== 1) return b;
      const out = open(Object.assign({}, b, { legs: undefined }));
      out.legs = (b.legs || []).map(open);
      return out;
    }
  };
}

// ── The alerter's own state (state.json) ────────────────────────────────────
// It holds every open pick in the clear — the rows it has placed, the client
// messages it has queued — and lives in the Actions cache, which anything that
// can run a workflow in this repo can restore. With a key it is written
// encrypted (a fresh IV every write; nothing here needs to be deterministic).
export function stateEncode(key, obj) {
  const json = JSON.stringify(obj);
  if (!key) return json;
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(json, "utf8"), c.final(), c.getAuthTag()]);
  return JSON.stringify({ enc: 1, iv: iv.toString("base64"), ct: ct.toString("base64") });
}
// Plain state (from before the key existed) still reads. Encrypted state
// without the key throws — starting again from nothing would forget which
// alerts were already sent.
export function stateDecode(key, raw) {
  const o = JSON.parse(raw);
  if (!o || o.enc !== 1) return o || {};
  if (!key) throw new Error("state.json is encrypted but PICKS_KEY is not set");
  const buf = Buffer.from(o.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8"));
}
