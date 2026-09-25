// Sealed picks: nothing readable before its game, everything checkable after.
import { randomBytes } from "crypto";
import { sealer, keyFrom, openSeal, checkReveal, canon, stateEncode, stateDecode } from "./seal.mjs";

let failures = 0;
const ok = (name, cond, detail) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || detail == null ? "" : " — " + detail}`); if (!cond) failures++; };

const key = randomBytes(32);
let clock = Date.parse("2026-09-25T15:00:00Z");
const S = sealer(key, { now: () => clock });
const start = "2026-09-25T23:05:00Z", later = "2026-09-26T01:40:00Z";

console.log("the ladder");
{
  const row = { id: "2026-09-25:ladder", date: "2026-09-25", seal: 1, status: "open", published: "2026-09-25T14:00:00Z",
    cycle: 5, rung: 2, seed: 16.58, stake: 23.03, games: { MLB: 12 }, sport: "MLB", start, pick: "Corbin Carroll",
    playerId: 682998, price: -257, p: 0.7218, kalshi: { ticker: "KXMLBHIT-X-CARROLL" }, runnersUp: [{ pick: "Nolan Arenado" }],
    lineup: { in: true, slot: 7 } };
  const out = S.ladderOut(row), txt = JSON.stringify(out);
  ok("before first pitch nothing names the pick", !/Carroll|Arenado|682998|-257|0\.7218|MLB"|KXMLBHIT/.test(txt.replace('"MLB":12', "")), txt);
  ok("the stake and the rung stay public", out.stake === 23.03 && out.rung === 2 && out.status === "open");
  ok("a late field (the lineup) waits for the reveal", out.lineup === undefined);
  ok("sealing is deterministic", canon(S.ladderOut(row)) === canon(out));
  const back = S.ladderIn(JSON.parse(txt));
  ok("the key opens it back into the pick", back.pick === "Corbin Carroll" && back.price === -257 && !back.sealed);
  ok("and re-sealing what was read gives the same bytes", canon(S.ladderOut(back)) === canon(out));
  ok("a wrong key cannot open it", (() => { try { openSeal(randomBytes(32), out.sealed); return false; } catch (e) { return true; } })());
  ok("a key that is not 32 bytes is refused", (() => { try { keyFrom("c2hvcnQ="); return false; } catch (e) { return true; } })());

  clock = Date.parse(start);
  const rev = S.ladderOut(row);
  ok("at first pitch it is revealed in full", rev.pick === "Corbin Carroll" && rev.lineup.slot === 7 && !rev.sealed);
  ok("the reveal matches the fingerprint published before the game", rev.revealed.hash === out.sealed.hash && checkReveal(rev) === true);
  ok("anyone can catch an edited reveal", checkReveal(Object.assign({}, rev, { pick: "Somebody Else" })) === false);
  const readBack = S.ladderIn(JSON.parse(JSON.stringify(rev)));
  ok("a revealed row reads back plain", readBack.pick === "Corbin Carroll" && !readBack.revealed);
  clock = Date.parse("2026-09-25T15:00:00Z");
  const settled = S.ladderOut(Object.assign({}, row, { status: "won", hits: 1 }));
  ok("a settled row is never sealed, whatever the clock says", settled.pick === "Corbin Carroll" && settled.revealed);
  const plain = { id: "2026-09-20:ladder", status: "open", pick: "Old Row", start };
  ok("a row from before sealing is published exactly as it was", S.ladderOut(plain) === plain);
}

console.log("the Dub and the Robin, leg by leg");
{
  clock = Date.parse("2026-09-25T15:00:00Z");
  const leg = (player, st) => ({ sport: "MLB", player, playerId: player.length, need: "to record a hit", start: st, price: -210, p: 0.7, detail: "#3" });
  const dub = { id: "2026-09-25:dub", date: "2026-09-25", seal: 1, status: "open", published: "x", games: { MLB: 12 },
    prob: 0.55, price: -130, fair: -125, excludes: { sport: "MLB", pick: "Corbin Carroll", start },
    legs: [leg("Early Man", start), leg("Late Man", later)] };
  let out = S.cardOut(dub, "dub"), txt = JSON.stringify(out);
  ok("before either game: no names, no prices, no ladder pick", !/Early|Late|Carroll|-130|-210/.test(txt), txt);
  ok("but the card is still a card", Array.isArray(out.legs) && out.legs.length === 2 && out.status === "open");
  clock = Date.parse(start) + 60000;
  out = S.cardOut(dub, "dub"); txt = JSON.stringify(out);
  ok("the first game starts: its leg is revealed", out.legs[0].player === "Early Man" && checkReveal(out.legs[0]));
  ok("the later leg stays sealed", !!out.legs[1].sealed && !/Late Man/.test(txt));
  ok("and so do the card's prices", out.price === undefined && !!out.sealed);
  const back = S.cardIn(JSON.parse(txt));
  ok("the key reads the whole card back", back.legs[1].player === "Late Man" && back.price === -130 && back.excludes.pick === "Corbin Carroll");
  clock = Date.parse(later);
  out = S.cardOut(dub, "dub");
  ok("once every leg is out the card's numbers follow", out.price === -130 && checkReveal(out) && out.legs.every(l => checkReveal(l)));
  clock = Date.parse("2026-09-25T15:00:00Z");
  const early = S.cardOut(Object.assign({}, dub, { legs: [Object.assign(leg("Early Man", start), { result: "won" })] }), "dub");
  ok("a graded leg is out even before its listed start", early.legs[0].player === "Early Man");
  ok("the card holds its numbers until the ladder's own game", !!early.sealed);
  const robin = { id: "2026-09-25:robin", date: "2026-09-25", seal: 1, status: "open", sizes: [{ m: 2, tickets: 15 }], legs: [leg("A", start)] };
  const r = S.cardOut(robin, "robin");
  ok("a Robin keeps its ticket counts public (the stake needs them)", r.sizes[0].tickets === 15 && !!r.legs[0].sealed);
}

console.log("no key, no change");
{
  const off = sealer(null);
  const row = { id: "x", seal: 1, status: "open", pick: "Someone", start: "2999-01-01T00:00:00Z" };
  ok("without PICKS_KEY rows are published untouched", off.ladderOut(row) === row && off.cardOut(row, "dub") === row);
  const sealedRow = { id: "x", seal: 1, status: "open", sealed: { v: 1, hash: "h", iv: "i", ct: "c" } };
  ok("and a sealed row it cannot open is passed through, never guessed at", off.ladderOut(off.ladderIn(sealedRow)).sealed.hash === "h");
}

console.log("the alerter's state file");
{
  const st = { dd: { ladderRows: [{ pick: "Corbin Carroll" }], clientQueue: [{ text: "Carroll to record a hit" }] } };
  const enc = stateEncode(key, st);
  ok("with a key, no pick is readable in it", !/Carroll/.test(enc) && JSON.parse(enc).enc === 1);
  ok("the key reads it back", stateDecode(key, enc).dd.ladderRows[0].pick === "Corbin Carroll");
  ok("state from before the key still reads", stateDecode(key, JSON.stringify(st)).dd.clientQueue.length === 1);
  ok("without a key it stays plain JSON, as before", stateEncode(null, st) === JSON.stringify(st));
  ok("encrypted state without the key refuses, never starts empty", (() => { try { stateDecode(null, enc); return false; } catch (e) { return /PICKS_KEY/.test(e.message); } })());
  ok("and a wrong key fails loudly", (() => { try { stateDecode(randomBytes(32), enc); return false; } catch (e) { return true; } })());
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
