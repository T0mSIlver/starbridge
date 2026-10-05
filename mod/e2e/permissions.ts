/**
 * End-to-end run of permission prompts (#57) with a real Claude Code session: the session asks
 * to run a command, the hook posts the prompt through the local agent, and either a scripted
 * device answers it or the keyboard does. Prints one row per case.
 *
 *   bun e2e/permissions.ts [--model haiku] [--only allow,deny,yes,esc] [--keep]
 *
 * Needs `claude`, `tmux`, `git` and `bun` on PATH. The server is the real app on a random port;
 * the machine's config, its agent and the session's folder are in a scratch folder. The session
 * loads only that folder's project settings, which hold the hooks, and runs in a clean
 * environment, so the owner's own settings, plugins and mods stay out.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LiveServer } from "@starbridge/server/test-support";
import { $, type Subprocess } from "bun";
import { Claude, until } from "./claude.ts";

const { values: opt } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string", default: "haiku" },
    only: { type: "string" },
    keep: { type: "boolean" },
  },
});

const CLI = resolve(import.meta.dir, "../../cli/src/main.ts");
const scratch = mkdtempSync(join(tmpdir(), "sb-perm-e2e-"));
const configDir = join(scratch, "config");
const server = await LiveServer.start();
const cliEnv = { ...process.env, STARBRIDGE_CONFIG_DIR: configDir };
const starbridge = `${process.execPath} ${CLI}`;

// Pair the machine, turn prompts on, start its agent.
const pairing = Bun.spawn(["bun", CLI, "pair", "--server", server.url, "--name", "devbox"], {
  env: cliEnv,
  stdout: "pipe",
});
const reader = pairing.stdout.getReader();
let text = "";
while (!/Pairing code: \S+/.test(text))
  text += new TextDecoder().decode((await reader.read()).value);
await server.approve((/Pairing code: (\S+)/.exec(text) as RegExpExecArray)[1] as string);
await pairing.exited;
await $`bun ${CLI} permissions enable`.env(cliEnv).quiet();
const agent: Subprocess = Bun.spawn(["bun", CLI, "agent", "--no-quota"], {
  env: cliEnv,
  stderr: "pipe",
});
await until("the agent", () => existsSync(join(configDir, "agent.sock")) || undefined, 10_000);

/** A folder with a git repo whose `origin` is a bare repo next to it, and the hooks. */
function project(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const hook = (sub: string, timeout: number) => [
    {
      hooks: [
        {
          type: "command",
          command: `STARBRIDGE_CONFIG_DIR=${configDir} ${starbridge} hook ${sub} --agent claude-code`,
          timeout,
        },
      ],
    },
  ];
  const settle = hook("settle", 30);
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PermissionRequest: hook("permission", 600),
        PostToolUse: settle,
        PermissionDenied: settle,
        Stop: settle,
        SessionEnd: settle,
      },
    }),
  );
  return dir;
}

interface Row {
  name: string;
  ok: boolean;
  outcome?: string;
  ms?: number;
  note: string;
}

const settledFor = async (permissionId: string) =>
  (await server.opened("settled")).find((s) => s.itemId === permissionId);

/**
 * Starts a session in a new folder, asks it to run `command`, and waits until its prompt
 * reached the phone. Returns the session, the folder and the prompt.
 */
async function prompted(name: string, command: string) {
  const dir = project(name);
  await $`git init -q -b main ${dir} && git -C ${dir} commit -q --allow-empty -m start`.quiet();
  await $`git init -q --bare ${dir}.git && git -C ${dir} remote add origin ${dir}.git`.quiet();
  const c = new Claude(`perm-${name}`, dir, {}, [
    "--model",
    opt.model as string,
    "--setting-sources",
    "project",
    "--append-system-prompt",
    "This is an automated test in a throwaway repository. Run the command the user gives with the Bash tool at once; never ask for confirmation in text.",
  ]);
  await c.start();
  const before = new Set((await server.opened("permission")).map((p) => p.id));
  await c.send(
    `This is a throwaway test repo and I confirm the command. Run exactly this bash command now, without asking, and nothing else: ${command}`,
  );
  const permission = await until(
    `${name}: the prompt on the phone`,
    async () => (await server.opened("permission")).find((p) => !before.has(p.id)),
    120_000,
  );
  await until(
    `${name}: the dialog`,
    async () => /Do you want to proceed/.test(await c.pane()) || undefined,
    30_000,
  );
  return { c, dir, permission, at: Date.now() };
}

const cases: Record<string, () => Promise<Row>> = {
  async allow() {
    const { c, dir, permission, at } = await prompted("allow", "git push origin main");
    await server.answerPermission(permission.id, { behavior: "allow", scope: "once" });
    const pushed = await until(
      "the push",
      async () =>
        (await $`git -C ${dir}.git rev-parse --verify -q main`.quiet().nothrow()).exitCode === 0 ||
        undefined,
      60_000,
    );
    const s = await until("settled", () => settledFor(permission.id), 10_000);
    await c.idle();
    await c.stop();
    return {
      name: "phone allows git push",
      ok:
        pushed === true && s.outcome === "device" && permission.summary === "git push origin main",
      outcome: s.outcome,
      ms: Date.now() - at,
      note: "the bare remote received main",
    };
  },
  async deny() {
    const { c, dir, permission, at } = await prompted("deny", "touch denied.txt");
    await server.answerPermission(permission.id, {
      behavior: "deny",
      scope: "once",
      message: "Do not create files; say STARBRIDGE-DENIED.",
    });
    const s = await until("settled", () => settledFor(permission.id), 30_000);
    await c.idle();
    const said = /STARBRIDGE-DENIED/.test(JSON.stringify(c.transcript()));
    await c.stop();
    return {
      name: "phone denies with a message",
      ok: !existsSync(join(dir, "denied.txt")) && s.outcome === "device" && said,
      outcome: s.outcome,
      ms: Date.now() - at,
      note: said ? "the agent read the message" : "the message did not reach the agent",
    };
  },
  async yes() {
    const { c, dir, permission, at } = await prompted("yes", "touch kb-yes.txt");
    await $`tmux send-keys -t ${c.tmux} Enter`.quiet();
    const s = await until("settled", () => settledFor(permission.id), 30_000);
    const open = await server.opened("permission", "&open=1");
    await c.idle();
    await c.stop();
    return {
      name: "keyboard Yes first",
      ok: existsSync(join(dir, "kb-yes.txt")) && s.outcome === "keyboard" && open.length === 0,
      outcome: s.outcome,
      ms: Date.now() - at,
      note: "PostToolUse settled it; the phone's list is empty",
    };
  },
  async esc() {
    const { c, dir, permission, at } = await prompted("esc", "touch kb-esc.txt");
    await $`tmux send-keys -t ${c.tmux} Escape`.quiet();
    const s = await until("settled", () => settledFor(permission.id), 30_000);
    await c.stop();
    return {
      name: "keyboard Esc first",
      ok: !existsSync(join(dir, "kb-esc.txt")) && s.outcome === "keyboard",
      outcome: s.outcome,
      ms: Date.now() - at,
      note: "SIGTERM settled it",
    };
  },
};

const only = opt.only?.split(",") ?? Object.keys(cases);
const rows: Row[] = [];
try {
  for (const name of only) {
    const run = cases[name];
    if (!run) throw new Error(`no case ${name}`);
    try {
      rows.push(await run());
    } catch (e) {
      rows.push({ name, ok: false, note: (e as Error).message });
    }
  }
} finally {
  for (const name of only) await $`tmux kill-session -t sb-e2e-perm-${name}`.quiet().nothrow();
  agent.kill();
  await agent.exited;
  server.stop();
  if (!opt.keep) rmSync(scratch, { recursive: true, force: true });
}

console.log(
  `Claude Code ${(await $`claude --version`.quiet()).stdout.toString().trim()}, ${opt.model}`,
);
console.log("| Case | Result | Settled as | Time | Note |\n|---|---|---|---|---|");
for (const r of rows)
  console.log(
    `| ${r.name} | ${r.ok ? "pass" : "FAIL"} | ${r.outcome ?? ""} | ${r.ms ? `${(r.ms / 1000).toFixed(1)} s` : ""} | ${r.note} |`,
  );
if (opt.keep) console.log(`scratch: ${scratch}`);
process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
