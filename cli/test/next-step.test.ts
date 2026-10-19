import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { LiveServer } from "@starbridge/server/test-support";
import { NEXT_STEPS_OPEN } from "../src/config";
import { hookSettle } from "../src/hook";
import { hookNextStep, hookPrompt, NEXT_STEP_TOOL } from "../src/next-step";
import { bareEnv, paired, SYSTEM_PATH, sh, slashes } from "./helpers";

setDefaultTimeout(30_000);

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

const SESSION = "69bf4147-a8cb-4be1-9387-dd64a87925dd";
const OTHER = "11a021ff-830c-44cb-984e-328c53fadf77";

/** A next-step box as Claude desktop 2.42304.2 records its tool call (#2118). */
const BOX = {
  recap:
    "The avatar and banner are in your Downloads folder. Three bio drafts are below; the notes are pushed.",
  ask: "Which bio do you want to start from?",
  actions: [
    { label: "Bio A", message: "Bio A" },
    { label: "Bio B", message: "Bio B" },
  ],
};
const called = (input: unknown, session = SESSION) =>
  JSON.stringify({
    session_id: session,
    cwd: "/home/dev/work/website",
    hook_event_name: "PostToolUse",
    tool_name: NEXT_STEP_TOOL,
    tool_input: input,
    tool_response: [{ type: "text", text: "Shown in the next-step box." }],
  });
const prompt = (session = SESSION) =>
  JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit", prompt: "Bio A" });

test("Claude desktop's next-step box becomes a waiting card for its session, which the session's next prompt settles (#2118)", async () => {
  const ctx = await paired(server);
  expect(await hookNextStep(ctx, called(BOX))).toBe(0);
  expect(ctx.lines).toEqual([]);
  const [card] = await server.opened("decision");
  expect(card).toMatchObject({
    question: "Which bio do you want to start from?",
    context: `${BOX.recap}\n\n- Bio A\n- Bio B`,
    options: ["Bio A", "Bio B"],
    agent: "claude-code",
    source: { session: SESSION, project: "website" },
  });
  expect((await server.opened("waiting")).length).toBe(1);
  expect(readFileSync(join(ctx.store.dir, NEXT_STEPS_OPEN), "utf8")).toBe(`${SESSION}\n`);

  // The turn's end, which Stop settles, leaves it open: the box ended it on the question.
  expect(
    await hookSettle(ctx, JSON.stringify({ session_id: SESSION, hook_event_name: "Stop" }), {
      agent: "claude-code",
    }),
  ).toBe(0);
  // Another session's prompt leaves it open.
  expect(await hookPrompt(ctx, prompt(OTHER))).toBe(0);
  expect(await server.opened("settled")).toEqual([]);
  // A click in the box, or anything typed, is the session's next prompt.
  expect(await hookPrompt(ctx, prompt())).toBe(0);
  expect(ctx.lines).toEqual([]);
  expect((await server.opened("settled")).map((s) => s.outcome)).toEqual(["elsewhere"]);
  expect(readFileSync(join(ctx.store.dir, NEXT_STEPS_OPEN), "utf8")).toBe("");
});

test("a next-step box answered on a device stays answered when its answer starts the next prompt (#2118)", async () => {
  const ctx = await paired(server);
  await hookNextStep(ctx, called(BOX));
  const [card] = await server.opened("decision");
  await server.answer(card?.id as string, { choice: "Bio B" });
  // The session's answer loop takes it, as any card's.
  ctx.lines.length = 0;
  const { run } = await import("../src/cli");
  expect(await run(["wait", card?.id as string, "--timeout", "5s"], ctx)).toBe(0);
  expect(ctx.lines.join("\n")).toContain("Bio B");
  await hookPrompt(ctx, prompt());
  expect((await server.opened("settled")).map((s) => s.outcome)).not.toContain("elsewhere");
});

test("a box with no question, or another tool, posts nothing; one action takes a typed reply (#2118)", async () => {
  const ctx = await paired(server);
  await hookNextStep(ctx, called({ recap: "Merged #1894." }));
  await hookNextStep(ctx, called({ ...BOX, ask: "  " }));
  await hookNextStep(
    ctx,
    JSON.stringify({ ...JSON.parse(called(BOX)), tool_name: "mcp__ccd_turn__update_plan" }),
  );
  expect(await server.opened("decision")).toEqual([]);
  await hookNextStep(
    ctx,
    called({ ask: "Mark #1850 ready once build-test is green?", actions: [BOX.actions[0]] }),
  );
  const [card] = await server.opened("decision");
  expect(card?.options ?? []).toEqual([]);
  expect(card?.context).toBe("- Bio A");
});

test("the prompt hook starts the CLI only while its session has a next-step card open (#2118)", () => {
  const dir = mkdtempSync(join(tmpdir(), "starbridge-prompt-"));
  const cfg = join(dir, "cfg");
  const bin = join(dir, "bin");
  mkdirSync(cfg);
  mkdirSync(bin);
  writeFileSync(join(bin, "starbridge"), `#!/bin/sh\necho "$*" > "${slashes(dir)}/ran"\n`, {
    mode: 0o755,
  });
  const script = join(import.meta.dir, "../../plugin/hooks/prompt.sh");
  const started = (env: Record<string, string> = {}) => {
    rmSync(join(dir, "ran"), { force: true });
    const r = Bun.spawnSync([sh(), script], {
      env: bareEnv({
        PATH: [bin, SYSTEM_PATH].join(delimiter),
        HOME: dir,
        STARBRIDGE_CONFIG_DIR: cfg,
        ...env,
      }),
      stdin: new TextEncoder().encode(prompt()),
    });
    expect(r.exitCode).toBe(0);
    return existsSync(join(dir, "ran"));
  };
  expect(started({ CLAUDE_CODE_SESSION_ID: SESSION })).toBe(false);
  writeFileSync(join(cfg, NEXT_STEPS_OPEN), `${OTHER}\n`);
  expect(started({ CLAUDE_CODE_SESSION_ID: SESSION })).toBe(false);
  // A Claude Code that names no session starts it while any card is open.
  expect(started()).toBe(true);
  writeFileSync(join(cfg, NEXT_STEPS_OPEN), `${OTHER}\n${SESSION}\n`);
  expect(started({ CLAUDE_CODE_SESSION_ID: SESSION })).toBe(true);
  expect(readFileSync(join(dir, "ran"), "utf8")).toBe("hook prompt --agent claude-code\n");
});
