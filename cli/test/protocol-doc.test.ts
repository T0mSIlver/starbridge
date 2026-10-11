import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeAgent } from "../src/agent/main";
import { testCtx } from "./helpers";

// A client written from PROTOCOL.md's local agent table must find every route the agent serves
// (#1224).
test("PROTOCOL.md's local agent table lists every route the agent serves", () => {
  const doc = readFileSync(join(import.meta.dir, "../../PROTOCOL.md"), "utf8");
  const listed = new Set(
    [...doc.matchAll(/^\| `(GET|POST|PUT|DELETE) (\/[^`?]*)/gm)].map((m) => `${m[1]} /v1${m[2]}`),
  );
  const ctx = testCtx();
  const agent = makeAgent(ctx, { socket: join(ctx.store.dir, "agent.sock"), noQuota: true });
  const served = (agent as unknown as { routes: { method: string; path: string }[] }).routes.map(
    (r) => `${r.method} ${r.path}`,
  );
  expect(served.filter((r) => !listed.has(r))).toEqual([]);
});
