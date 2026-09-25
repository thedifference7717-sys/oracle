// Who gets which message: the owner everything, first; each tier its products.
import { tierConfig, routes, forClients, enqueue, flush } from "./tiers.mjs";

let failures = 0;
const ok = (name, cond, detail) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond || detail == null ? "" : " — " + detail}`); if (!cond) failures++; };

console.log("routing");
{
  const cfg = tierConfig({ TG_TIER1: "-1001", TG_TIER2: "-1002", TG_TIER3: " -1003 " });
  ok("the Ladder goes to every tier", routes(cfg, "ladder").join() === "-1001,-1002,-1003");
  ok("the Dub to tiers 2 and 3", routes(cfg, "dub").join() === "-1002,-1003");
  ok("the Robin to tier 3 only", routes(cfg, "robin").join() === "-1003");
  ok("anything else to no client", routes(cfg, "stopped").length === 0);
  ok("nothing configured, nobody sent to", !tierConfig({}).any && routes(tierConfig({}), "ladder").length === 0);
  ok("a channel shared by two tiers gets one copy", routes(tierConfig({ TG_TIER2: "-9", TG_TIER3: "-9" }), "dub").join() === "-9");
  ok("the head start is in minutes", tierConfig({ TG_CLIENT_DELAY_MIN: "5" }).delayMs === 300000 && tierConfig({ TG_CLIENT_DELAY_MIN: "x" }).delayMs === 0);
}

console.log("the client copy");
{
  const owner = "🪜 RUNG 2 IN\n📊 Record: 7–3\n<i>Got a different price? Send /odds -300 (or /paid 72.77) and every amount updates.</i>";
  const c = forClients(owner);
  ok("drops the owner-only command hint", !/\/odds|\/paid/.test(c) && /RUNG 2 IN/.test(c) && /Record/.test(c), c);
}

console.log("the outbox");
{
  const q = enqueue([], ["-1", "-2"], "pick", 1000);
  const sent = [];
  await flush(q, async (ch, t) => sent.push(ch), 500);
  ok("nothing goes before its time", sent.length === 0 && q.length === 2);
  await flush(q, async (ch, t) => { if (ch === "-2") throw new Error("403"); sent.push(ch); }, 1000);
  ok("what is due goes; a failure stays for a retry", sent.join() === "-1" && q.length === 1 && q[0].tries === 1);
  await flush(q, async (ch) => sent.push(ch), 2000);
  ok("and goes on the next pass", sent.join() === "-1,-2" && q.length === 0);
  const old = enqueue([], ["-3"], "stale", 0);
  await flush(old, async () => { throw new Error("gone"); }, 2 * 86400000);
  ok("a message failing for over a day is dropped", old.length === 0);
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
