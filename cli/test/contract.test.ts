// Pins what agents and the plugins parse (cli/CONTRACT.md): stable from 0.1.0.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { run } from "../src/cli";
import { codexNotice } from "../src/codex";
import { paired, testCtx, until } from "./helpers";

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

const ID = /^d_[A-Za-z0-9_-]{16}$/;

test("ask --input reads the fields from a file; ask prints the id, then how the answer comes", async () => {
  const ctx = await paired(server);
  const input = join(mkdtempSync(join(tmpdir(), "starbridge-contract-")), "ask.json");
  writeFileSync(input, JSON.stringify({ question: "Merge #12 now?", options: ["Merge", "Wait"] }));
  expect(await run(["ask", "--input", input, "--session", "s"], ctx)).toBe(0);
  const id = ctx.lines[0] as string;
  expect(ctx.lines).toEqual([expect.stringMatching(ID)]);
  expect(ctx.errors.at(-1)).toBe(
    `Nothing brings the answer into this session: when only the answer is left, run \`starbridge wait ${id} --timeout 5m\` (again on exit 2).`,
  );
  expect((await server.opened("decision"))[0]?.options).toEqual(["Merge", "Wait"]);

  expect(await run(["wait", id, "--timeout", "1s"], ctx)).toBe(2);
  await server.answer(id, { choice: "Merge" });
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s", "--wait", "1"], ctx)).toBe(0);
  expect(ctx.lines.map((l) => JSON.parse(l))).toEqual([
    { decisionId: id, ack: id, line: `Answer to ${id} (Merge #12 now?): Merge` },
  ]);
  ctx.lines.length = 0;
  expect(await run(["wait", id], ctx)).toBe(0);
  expect(await run(["wait", id, "--json"], ctx)).toBe(0);
  expect(ctx.lines[0]).toBe(`Answer to ${id} (Merge #12 now?): Merge`);
  expect(JSON.parse(ctx.lines[1] as string)).toMatchObject({ decisionId: id, choice: "Merge" });

  const prompt = "The answer will come back into this session as a new prompt.";
  for (const env of [
    { CLAUDECODE: "1" },
    { PI_SESSION_ID: "p1", STARBRIDGE_PI_ANSWERS: "p1" },
    { STARBRIDGE_OPENCODE_SESSION: "o1", STARBRIDGE_OPENCODE_ANSWERS: "o1" },
  ]) {
    ctx.env = env;
    expect(await run(["ask", "--question", "Ship?"], ctx)).toBe(0);
    expect(ctx.errors.at(-1)).toBe(prompt);
  }
  expect(codexNotice(id)).toBe(
    `Starbridge has the owner's answer to ${id}: run \`starbridge wait ${id}\` to read it.`,
  );
});

test("pair prints its code first; errors start with starbridge:", async () => {
  const ctx = testCtx();
  const done = run(["pair", "--server", server.url], ctx);
  await until(() => ctx.lines.length > 0);
  expect(ctx.lines[0]).toMatch(/^Pairing code: \S+$/);
  await server.approve((ctx.lines[0] as string).slice("Pairing code: ".length));
  expect(await done).toBe(0);
  expect(await run(["ask", "--input", "/nonexistent.json"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toStartWith("starbridge: cannot read /nonexistent.json");
});

test("ask --json is an unknown flag: --input replaced it before the first release", async () => {
  const ctx = await paired(server);
  expect(await run(["ask", "--json", "-"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toStartWith("starbridge: ");
  expect(ctx.errors.at(-1)).toContain("--json");
});
