import { afterEach, beforeEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli";
import { FakeServer } from "./fake-server";
import { FAKE_CODEXBAR, paired, until } from "./helpers";

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
});
afterEach(() => server.stop());

const ASK = [
  "ask",
  "--question",
  "Merge #12 now?",
  "--context",
  "CI is green.",
  "--option",
  "Merge",
  "--option",
  "Wait",
  "--default",
  "Merge at 18:00",
];

test("pair joins the directory and keeps the keys private", async () => {
  const ctx = await paired(server);
  const machine = ctx.store.machine();
  expect(machine?.name).toBe("devbox");
  expect(server.directory().members.get(machine?.id as string)?.active).toBe(true);
  expect(statSync(ctx.store.dir).mode & 0o777).toBe(0o700);
  for (const f of ["machine.json", "directory.json", "state.json"])
    expect(statSync(join(ctx.store.dir, f)).mode & 0o777).toBe(0o600);
  expect(await run(["pair", "--server", server.url], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("already paired");
});

test("ask seals a decision the phone can open, recommended first", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--default-at", "30m", "--session", "s1"], ctx)).toBe(0);
  const [d] = server.opened("decision");
  expect(d?.id).toBe(ctx.lines[0] as string);
  expect(d?.options).toEqual(["Merge", "Wait"]);
  expect(d?.recommended).toBe("Merge");
  expect(d?.source).toMatchObject({ machine: "devbox", session: "s1" });
  const at = Date.parse(d?.default.at as string) - Date.now();
  expect(at).toBeGreaterThan(29 * 60_000);
  expect(at).toBeLessThanOrEqual(30 * 60_000);
});

test("ask refuses a decision that would not stand alone", async () => {
  const ctx = await paired(server);
  expect(await run(["ask", "--question", "Q?", "--option", "Only", "--default", "x"], ctx)).toBe(1);
  expect(await run([...ASK, "--recommended", "Neither"], ctx)).toBe(1);
  expect(await run(["ask", "--question", "Q?"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("--default");
  expect(server.items).toHaveLength(0);
});

test("ask --wait prints the answer the phone sends", async () => {
  const ctx = await paired(server);
  const done = run([...ASK, "--wait"], ctx);
  // The fake server holds the item before the CLI has its reply and prints the id; wait for the id.
  await until(() => ctx.lines.length === 1);
  server.answer(ctx.lines[0] as string, { choice: "Wait" });
  expect(await done).toBe(0);
  expect(ctx.lines[1]).toBe(`Answer to ${ctx.lines[0]} (Merge #12 now?): Wait`);
});

test("wait ignores forged or foreign answers and keeps the good one", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  const id = ctx.lines[0] as string;
  const done = run(["wait", id, "--json"], ctx);
  await until(() => server.log.includes("GET /answers"));
  // The open poll returns these answers, then the directory refresh and the next poll fail once.
  server.failures.push("/directory", "/answers");
  server.answer(id, { choice: "Ship it" });
  server.answer(id, { text: "free text to a decision with options" });
  server.answer(id, { choice: "Merge" }, { decisionId: "d_other" });
  server.answer(id, { choice: "Merge" });
  expect(await done).toBe(0);
  expect(JSON.parse(ctx.lines[1] as string)).toMatchObject({ decisionId: id, choice: "Merge" });
  expect(ctx.errors.filter((e) => e.includes("ignored an answer"))).toHaveLength(3);
  expect(ctx.errors.filter((e) => e.includes("retrying"))).toHaveLength(2);
});

test("wait with no id returns each answer once, then times out with exit 2", async () => {
  const ctx = await paired(server);
  await run(ASK, ctx);
  await run(["ask", "--question", "Name the branch?", "--default", "Use t/6"], ctx);
  const [first, second] = ctx.lines as [string, string];
  server.answer(second, { text: "t/6-cli" });
  server.answer(first, { choice: "Merge" });
  expect(await run(["wait"], ctx)).toBe(0);
  expect(await run(["wait"], ctx)).toBe(0);
  expect(ctx.lines.slice(2).sort()).toEqual(
    [
      `Answer to ${first} (Merge #12 now?): Merge`,
      `Answer to ${second} (Name the branch?): t/6-cli`,
    ].sort(),
  );
  expect(await run(["wait", "--timeout", "1s"], ctx)).toBe(2);
  expect(ctx.errors.at(-1)).toContain("apply the default");
  // An answer already received prints again for its own id.
  expect(await run(["wait", first], ctx)).toBe(0);
});

test("quota push --once posts a sealed snapshot and survives bad providers", async () => {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_CODEXBAR = FAKE_CODEXBAR;
  const providers = ["codex", "zai", "claude", "mistral", "broken", "garbage", "nosuch"];
  const args = providers.flatMap((p) => ["--provider", p]);
  expect(await run(["quota", "push", "--once", ...args], ctx)).toBe(0);
  const [snap] = server.opened("quota");
  const by = new Map(snap?.providers.map((p) => [p.provider, p]));
  expect([...by.keys()]).toEqual(providers);
  expect(by.get("claude")?.windows.map((w) => w.id)).toEqual([
    "primary",
    "secondary",
    "claude-weekly-scoped-fable",
  ]);
  expect(by.get("mistral")?.windows.map((w) => w.label)).toEqual(["Included API", "Monthly Plan"]);
  expect(by.get("broken")?.error).toContain("provider not configured");
  expect(by.get("garbage")?.error).toContain("unreadable output");
  expect(by.get("nosuch")?.error).toBe("missing from codexbar's output");
  expect(ctx.lines.at(-1)).toMatch(/^posted q_/);
});

test("quota push keeps going after a failed round", async () => {
  const ctx = await paired(server);
  ctx.env.STARBRIDGE_CODEXBAR = FAKE_CODEXBAR;
  server.failures.push("/items");
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const done = run(["quota", "push", "--provider", "claude", "--interval", "1s"], ctx);
  await until(() => server.items.length === 1);
  controller.abort();
  expect(await done).toBe(0);
  expect(ctx.errors[0]).toContain("503");
  expect(ctx.errors[1]).toMatch(/posted q_.*1 providers, 3 windows/);
});
