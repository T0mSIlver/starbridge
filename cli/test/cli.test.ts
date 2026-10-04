import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import jsQR from "jsqr";
import { run } from "../src/cli";
import { FAKE_CODEXBAR, paired, testCtx, until } from "./helpers";

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
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
  expect((await server.directory()).members.get(machine?.id as string)?.active).toBe(true);
  expect(statSync(ctx.store.dir).mode & 0o777).toBe(0o700);
  for (const f of ["machine.json", "directory.json", "state.json"])
    expect(statSync(join(ctx.store.dir, f)).mode & 0o777).toBe(0o600);
  expect(await run(["pair", "--server", server.url], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("already paired");
});

/** Reads a terminal QR back: each character is two modules, upper and lower, 4 px square. */
function scan(lines: string[]): string | undefined {
  const rows = lines.map((l) => [...l.replace(/\x1b\[[0-9;]*m/g, "")]);
  const width = (rows[0]?.length ?? 0) * 4;
  const height = rows.length * 8;
  const px = new Uint8ClampedArray(width * height * 4).fill(255);
  rows.forEach((row, y) =>
    row.forEach((ch, x) => {
      const dark = [ch === "█" || ch === "▀", ch === "█" || ch === "▄"];
      for (let dy = 0; dy < 8; dy++)
        for (let dx = 0; dx < 4; dx++) {
          if (!dark[dy < 4 ? 0 : 1]) continue;
          const i = ((y * 8 + dy) * width + x * 4 + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
    }),
  );
  return jsQR(px, width, height)?.data;
}

test("pair prints a link and a QR code that carry the code", async () => {
  const ctx = testCtx();
  const done = run(["pair", "--server", `${server.url}/`, "--name", "devbox"], ctx);
  await until(() => ctx.lines.some((l) => l.startsWith("Or type the code")));
  const code = ctx.lines[0]?.replace("Pairing code: ", "") as string;
  const link = `${server.url}/pair#${code}`;
  expect(ctx.lines[1]).toEndWith(link);
  expect(scan(ctx.lines.slice(2, -1))).toBe(link);
  await server.approve(code);
  expect(await done).toBe(0);
});

test("ask seals a decision the phone can open, recommended first", async () => {
  const ctx = await paired(server);
  expect(await run([...ASK, "--default-at", "30m", "--session", "s1"], ctx)).toBe(0);
  const [d] = await server.opened("decision");
  expect(d?.id).toBe(ctx.lines[0] as string);
  expect(d?.options).toEqual(["Merge", "Wait"]);
  expect(d?.recommended).toBe("Merge");
  expect(d?.source).toMatchObject({ machine: "devbox", session: "s1" });
  const at = Date.parse(d?.default.at as string) - Date.now();
  expect(at).toBeGreaterThan(29 * 60_000);
  expect(at).toBeLessThanOrEqual(30 * 60_000);
});

test("ask names the session and links to it from Claude Code's record, unless flags say otherwise", async () => {
  const ctx = await paired(server);
  const dir = mkdtempSync(join(tmpdir(), "starbridge-claude-"));
  mkdirSync(join(dir, "sessions"));
  const record = (pid: number, fields: object) =>
    writeFileSync(join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, ...fields }));
  // An older process that ran the same session, before a resume.
  record(1, { sessionId: "s1", name: "Old name", updatedAt: 1, bridgeSessionId: null });
  record(2, {
    sessionId: "s1",
    name: "Merge the uploader",
    updatedAt: 2,
    hostSessionId: "local_dbf54d69-f2ac-4a14-b298-d7bb6ecf0e3f",
    bridgeSessionId: "session_01UZCLSHk7GjaUdtNBsLAvvt",
  });
  // Rewritten in place without truncating: the tail of a longer record follows.
  writeFileSync(
    join(dir, "sessions", "3.json"),
    `${JSON.stringify({ sessionId: "s2", name: "Short" })}ion_01DRfkYrUXFy"}`,
  );
  ctx.env.CLAUDE_CONFIG_DIR = dir;
  ctx.env.CLAUDE_CODE_SESSION_ID = "s1";

  expect(await run(ASK, ctx)).toBe(0);
  expect(await run([...ASK, "--session", "s2"], ctx)).toBe(0);
  const flags = ["--session-title", "Mine", "--link", "web=https://claude.ai/code/session_9"];
  expect(await run([...ASK, ...flags], ctx)).toBe(0);
  const sources = (await server.opened("decision")).map((d) => d.source);
  expect(sources[0]).toMatchObject({
    session: "s1",
    sessionTitle: "Merge the uploader",
    links: [
      { kind: "remote-control", url: "https://claude.ai/code/session_01UZCLSHk7GjaUdtNBsLAvvt" },
      {
        kind: "desktop",
        url: "claude://claude.ai/epitaxy/local_dbf54d69-f2ac-4a14-b298-d7bb6ecf0e3f",
      },
    ],
  });
  expect(sources[1]).toMatchObject({ session: "s2", sessionTitle: "Short" });
  expect(sources[1]?.links).toBeUndefined();
  expect(sources[2]).toMatchObject({
    sessionTitle: "Mine",
    links: [{ kind: "web", url: "https://claude.ai/code/session_9" }],
  });

  expect(await run([...ASK, "--link", "desktop=https://evil.example"], ctx)).toBe(1);
  expect(await run([...ASK, "--link", "nokind"], ctx)).toBe(1);
  expect(await server.opened("decision")).toHaveLength(3);
});

test("ask refuses a decision that would not stand alone", async () => {
  const ctx = await paired(server);
  expect(await run(["ask", "--question", "Q?", "--option", "Only", "--default", "x"], ctx)).toBe(1);
  expect(await run([...ASK, "--recommended", "Neither"], ctx)).toBe(1);
  expect(await run(["ask", "--question", "Q?"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("--default");
  expect(await server.opened("decision")).toEqual([]);
});

test("ask --wait prints the answer the phone sends", async () => {
  const ctx = await paired(server);
  const done = run([...ASK, "--wait"], ctx);
  await until(() => ctx.lines.length === 1);
  await server.answer(ctx.lines[0] as string, { choice: "Wait" });
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
  // The real server takes one answer per decision; these three need a compromised one.
  await server.forge(
    { decisionId: id, reply: { choice: "Ship it" } },
    { decisionId: id, reply: { text: "free text to a decision with options" } },
    { decisionId: id, reply: { choice: "Merge" }, tamper: { decisionId: "d_other" } },
  );
  await server.answer(id, { choice: "Merge" });
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
  await server.answer(second, { text: "t/6-cli" });
  await server.answer(first, { choice: "Merge" });
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
  const [snap] = await server.opened("quota");
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
  await until(async () => (await server.opened("quota")).length === 1);
  controller.abort();
  expect(await done).toBe(0);
  expect(ctx.errors[0]).toContain("503");
  expect(ctx.errors[1]).toMatch(/posted q_.*1 providers, 3 windows/);
});

test("answers hands each session only its own answers, until it confirms them", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s1"], ctx);
  ctx.env.CLAUDE_CODE_SESSION_ID = "s2";
  await run(["ask", "--question", "Name the branch?", "--default", "Use t/6"], ctx);
  const [mine, theirs] = ctx.lines as [string, string];
  expect(ctx.store.state().asked[theirs]?.session).toBe("s2");
  ctx.lines.length = 0;

  // Nothing yet: one short poll, nothing printed.
  expect(await run(["answers", "--session", "s1", "--wait", "1"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);

  await server.answer(theirs, { text: "multi\nline" });
  await server.answer(mine, { choice: "Wait" });
  expect(await run(["answers", "--session", "s1", "--wait", "5"], ctx)).toBe(0);
  const handed = { decisionId: mine, ack: mine, line: `Answer to ${mine} (Merge #12 now?): Wait` };
  expect(ctx.lines.map((l) => JSON.parse(l))).toEqual([handed]);
  // Unconfirmed, it is handed over again; another session cannot confirm it.
  expect(await run(["answers", "--session", "s2", "--ack", mine], ctx)).toBe(0);
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[1] as string)).toEqual(handed);
  expect(await run(["answers", "--session", "s1", "--ack", mine], ctx)).toBe(0);
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines).toHaveLength(2);

  // s2's answer was stored by s1's poll; s2 takes it without touching the server.
  const polls = server.log.length;
  expect(await run(["answers", "--session", "s2"], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[2] as string).line).toBe(
    `Answer to ${theirs} (Name the branch?): multi\nline`,
  );
  expect(server.log.length).toBe(polls);
  expect(await run(["answers", "--session", "s3"], ctx)).toBe(0);
  expect(ctx.lines).toHaveLength(3);
});

test("answers says once when a default time passed, and still hands over a late answer", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s1", "--default-at", "1m"], ctx);
  const id = ctx.lines[0] as string;
  ctx.lines.length = 0;
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);

  const later = new Date(Date.now() + 61_000);
  ctx.now = () => later;
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  const notice = JSON.parse(ctx.lines[0] as string);
  expect(notice.ack).toBe(`${id}:default`);
  expect(notice.line).toMatch(
    new RegExp(
      `^No answer to ${id} \\(Merge #12 now\\?\\) by its default time .+: apply your default: Merge at 18:00$`,
    ),
  );
  // Another session cannot confirm it, and confirming it leaves the answer to come.
  expect(await run(["answers", "--session", "s2", "--ack", notice.ack], ctx)).toBe(0);
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines).toHaveLength(2);
  expect(await run(["answers", "--session", "s1", "--ack", notice.ack], ctx)).toBe(0);
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines).toHaveLength(2);

  await server.answer(id, { choice: "Wait" });
  expect(await run(["answers", "--session", "s1", "--wait", "5"], ctx)).toBe(0);
  expect(JSON.parse(ctx.lines[2] as string).line).toBe(`Answer to ${id} (Merge #12 now?): Wait`);
});

test("answers fetches an answer the owner gave while nothing polled before saying nobody answered", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s1", "--default-at", "1m"], ctx);
  const id = ctx.lines[0] as string;
  ctx.lines.length = 0;
  await server.answer(id, { choice: "Wait" });
  const later = new Date(Date.now() + 61_000);
  ctx.now = () => later;

  // The server cannot be reached: no notice yet, since an answer may be waiting there.
  server.failures.push("/answers");
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines).toEqual([]);
  expect(await run(["answers", "--session", "s1"], ctx)).toBe(0);
  expect(ctx.lines.map((l) => JSON.parse(l).line)).toEqual([
    `Answer to ${id} (Merge #12 now?): Wait`,
  ]);
});

test("answers --wait wakes at the session's next default time", async () => {
  const ctx = await paired(server);
  const at = new Date(Date.now() + 1_500).toISOString();
  await run([...ASK, "--session", "s1", "--default-at", at], ctx);
  const id = ctx.lines[0] as string;
  ctx.lines.length = 0;
  const started = Date.now();
  expect(await run(["answers", "--session", "s1", "--wait", "20"], ctx)).toBe(0);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(JSON.parse(ctx.lines[0] as string).ack).toBe(`${id}:default`);
});

test("answers exits 1 on a server error and keeps the cursor", async () => {
  const ctx = await paired(server);
  await run([...ASK, "--session", "s1"], ctx);
  server.failures.push("/answers");
  expect(await run(["answers", "--session", "s1", "--wait", "1"], ctx)).toBe(1);
  expect(ctx.errors.at(-1)).toContain("503");
  expect(ctx.store.state().cursor).toBeUndefined();
  expect(await run(["answers", "--session", "s1", "--wait", "30"], ctx)).toBe(1);
  expect(await run(["answers", "--wait", "1"], ctx)).toBe(1);
});

test("a lock left by a dead process is broken, and the command goes on", async () => {
  const ctx = await paired(server);
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(join(ctx.store.dir, ".lock"), `${dead} left-by-a-crash`);
  expect(await run(ASK, ctx)).toBe(0);
  expect(existsSync(join(ctx.store.dir, ".lock"))).toBe(false);
});
