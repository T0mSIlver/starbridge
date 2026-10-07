import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Decision, type SealedItem, seal } from "@starbridge/protocol";
import { applyOverrides, parseValue, writeOverrides } from "../src/overrides";
import {
  type Actor,
  at,
  DEFAULT_LIMITS,
  makeServer,
  pair,
  setupAccount,
} from "../test-support/app";

let n = 0;
function decision(from: Actor, to: Actor): SealedItem {
  const body: Decision = {
    v: 1,
    id: `d${++n}`,
    to: [to.id],
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    source: { machine: from.id, project: "starbridge", session: "s1" },
  };
  return seal("decision", body, { id: from.id, signKey: from.keys.sign.privateKey }, [to.member]);
}

test("runtime limits apply to the running server and go back to its own when unset (#786)", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "sb-limits-")), "sb.db");
  const s = await makeServer({ dbPath });
  const config = s.deps.config;
  const base = { limits: DEFAULT_LIMITS, maxMachines: 5 };
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  const post = () =>
    s.call("POST", "/v1/items", { token: devbox.token, body: decision(devbox, acct.device) });

  writeOverrides(config, { machineItems: parseValue("machineItems", "1/60"), maxMachines: 2 });
  expect(applyOverrides(config, base, "")).toBe("machineItems 1/60s, maxMachines 2");
  expect(config.maxMachines).toBe(2);
  expect((await post()).status).toBe(201);
  expect((await post()).status).toBe(429);

  // A broken file keeps the limits as they were.
  for (const broken of ["{", "[]", "42", '{"items":[1,0]}']) {
    writeFileSync(join(dbPath, "../limits.json"), broken);
    expect(applyOverrides(config, base, "same")).toBe("same");
  }
  expect(config.limits.machineItems).toEqual([1, 60_000]);

  writeOverrides(config, {});
  applyOverrides(config, base, "");
  expect(config.limits).toEqual(DEFAULT_LIMITS);
  expect(config.maxMachines).toBe(5);
});

test("only rate windows and caps change at runtime, never retention", () => {
  expect(parseValue("items", "60/60")).toEqual([60, 60_000]);
  expect(parseValue("storedBytes", "1048576")).toBe(1_048_576);
  expect(() => parseValue("answeredRetention", "1")).toThrow("not a limit");
  expect(() => parseValue("items", "60")).toThrow("CALLS/SECONDS");
  expect(() => parseValue("nonsense", "1")).toThrow("not a limit");
  expect(() => parseValue("items", "1/0")).toThrow("at least a second");
});
