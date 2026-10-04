/**
 * End-to-end run of the answer path with real Claude Code sessions (issue #48): agents post
 * decisions through the skill and keep working; a device answers through the server; the mod
 * submits each answer into the session that asked. Prints one row per case with its timings.
 *
 *   bun e2e/run.ts --local                     the real server app on a random port
 *   bun e2e/run.ts --device <file>             the device's server (see device.ts); this
 *                                              machine's CLI config must be paired with it
 *   bun e2e/run.ts --by-hand --only owner      this machine's server; the owner answers on
 *                                              a phone, in a session under Remote Control
 * Options: --only <case,...>, --model <alias> (default sonnet), --out <file.md>, --bin <dir>
 * (put its `starbridge` first on PATH), --keep (leave the scratch folder), --agent (run
 * `starbridge agent` for the run, so the mod answers through it; a last row checks it did).
 *
 * Needs `claude`, `tmux` and `starbridge` on PATH. Sessions run in tmux windows `sb-e2e-*`, in a
 * scratch folder, with Bash allowed, `--plugin-dir` set to copies of the starbridge plugin (the
 * skill and its rule) and of this mod, only project settings and a clean environment, so the
 * owner's own sessions and mods stay out.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LiveServer } from "@starbridge/server/test-support";
import { $ } from "bun";
import { configDir as cliConfigDir } from "../../cli/src/config";
import { bashCommands, Claude, until } from "./claude.ts";
import { TestDevice } from "./device.ts";
import { Relay } from "./proxy.ts";

const { values: opt } = parseArgs({
  args: process.argv.slice(2),
  options: {
    local: { type: "boolean" },
    device: { type: "string" },
    "by-hand": { type: "boolean" },
    only: { type: "string" },
    model: { type: "string", default: "sonnet" },
    out: { type: "string" },
    keep: { type: "boolean" },
    bin: { type: "string" },
    agent: { type: "boolean" },
  },
});

const repo = join(import.meta.dir, "..", "..");
const work = mkdtempSync(join(tmpdir(), "sb-e2e-"));
const log: string[] = [];
const t0 = Date.now();
const say = (line: string) => {
  const stamp = ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
  const text = `${stamp}s  ${line}`;
  log.push(text);
  console.log(text);
};

// The server: the real app locally, or the device's server through a CONNECT proxy. Either way
// every CLI call goes through `relay`, which plays the outage.
let owner: { answer(id: string, choice: string): Promise<void> };
let configDir: string;
let relay: Relay;
let local: LiveServer | undefined;
const env: Record<string, string> = {};
// `--bin <dir>`: a `starbridge` other than the one on PATH, for the sessions and this script.
if (opt.bin) process.env.PATH = env.PATH = `${opt.bin}:${process.env.PATH}`;
if (opt.local) {
  local = await LiveServer.start();
  relay = new Relay({ host: "127.0.0.1", port: Number(new URL(local.url).port) }).start();
  configDir = join(work, "config");
  const pairing = Bun.spawn(["starbridge", "pair", "--server", relay.url, "--name", "e2e"], {
    env: { ...process.env, STARBRIDGE_CONFIG_DIR: configDir },
    stdout: "pipe",
  });
  const reader = pairing.stdout.getReader();
  let out = "";
  while (!/Pairing code: (\S+)/.test(out)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`starbridge pair exited without a code: ${out}`);
    out += new TextDecoder().decode(value);
  }
  await local.approve((/Pairing code: (\S+)/.exec(out) as RegExpExecArray)[1] as string);
  if ((await pairing.exited) !== 0) throw new Error("pairing failed");
  const server = local;
  owner = { answer: (id, choice) => server.answer(id, { choice }) };
} else {
  if (opt["by-hand"]) {
    owner = {
      answer: async () => {
        throw new Error("--by-hand runs only the `owner` case");
      },
    };
  } else {
    if (!opt.device) throw new Error("pass --local, --device <file> or --by-hand");
    owner = TestDevice.load(opt.device);
  }
  relay = new Relay().start();
  configDir = cliConfigDir(process.env);
  env.HTTPS_PROXY = relay.url;
}
env.STARBRIDGE_CONFIG_DIR = configDir;

// The test folder: nothing inherited from a repo above it.
const proj = join(work, "proj");
mkdirSync(join(proj, ".claude"), { recursive: true });
// Remote Control off, so test sessions stay off the owner's phone; the Remote Control case asks.
writeFileSync(
  join(proj, ".claude", "settings.json"),
  JSON.stringify({ remoteControlAtStartup: false }),
);
const pluginDir = join(work, "plugin");
cpSync(join(repo, "plugin"), pluginDir, { recursive: true });
const modDir = join(work, "mod");
for (const part of [".claude-plugin", "hooks"])
  cpSync(join(import.meta.dir, "..", part), join(modDir, part), { recursive: true });

// `--agent`: the machine's agent, between the sessions and the server for the whole run.
let agent: ReturnType<typeof Bun.spawn> | undefined;
if (opt.agent) {
  agent = Bun.spawn(["starbridge", "agent", "--no-quota"], {
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const socket = join(configDir, "agent.sock");
  await until("the agent's socket", () => existsSync(socket) || undefined, 10_000);
}

const sessions: Claude[] = [];
function sessionArgs(name: string): string[] {
  return [
    "--plugin-dir",
    pluginDir,
    "--plugin-dir",
    modDir,
    "--setting-sources",
    "project",
    "--allowedTools",
    "Bash Write Edit Read",
    "--model",
    opt.model as string,
    "--debug-file",
    join(work, `${name}.debug.log`),
  ];
}

function claude(name: string): Claude {
  const c = new Claude(name, proj, env, sessionArgs(name));
  sessions.push(c);
  return c;
}

interface State {
  asked: Record<string, { question: string; session?: string }>;
}
const state = (): State => JSON.parse(readFileSync(join(configDir, "state.json"), "utf8"));
const askedBy = (session: string, question: string) =>
  Object.entries(state().asked).find(
    ([, a]) => a.session === session && a.question.includes(question),
  )?.[0];

/** Posts a decision for `session` with the CLI, as an agent's `starbridge ask` does. */
async function ask(session: string, question: string, extra: string[] = []): Promise<string> {
  const r =
    await $`starbridge ask --session ${session} --question ${question} --option Alpha --option Beta --default Alpha --default-at 2h ${extra}`
      .env({ ...process.env, ...env })
      .quiet();
  return r.stdout.toString().trim();
}

async function answered(c: Claude, id: string, timeoutMs = 120_000, session = () => c.sessionId) {
  return until(
    `answer to ${id} in ${c.name}`,
    () => c.prompt(`Answer to ${id}`, session()),
    timeoutMs,
  );
}

const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
interface Row {
  name: string;
  result: "pass" | "FAIL";
  timing: string;
  note: string;
}
const rows: Row[] = [];

/** Checks that an agent never waited: no `--wait` on ask, no `starbridge wait`. */
function noWaiting(c: Claude, id = c.sessionId): string | undefined {
  const bad = bashCommands(c.transcript(id)).filter((cmd) =>
    /starbridge\s+wait|ask[^\n]*--wait/.test(cmd),
  );
  return bad.length > 0 ? `waited: ${bad.join(" | ")}` : undefined;
}

const TASK =
  "Use the starbridge skill to ask the owner which file name to use for the release notes: " +
  "options `alpha.md` and `beta.md`, default `alpha.md` in 2h, context: a test of Starbridge. " +
  'Question: "{q}". After posting, create `progress-{n}.txt` containing the word started, ' +
  "then end your turn. When the answer arrives, create the chosen file with the line chosen.";

const cases: Record<string, () => Promise<Row>> = {
  /** An agent asks through the skill, keeps working, ends its turn; the answer comes while idle. */
  async idle() {
    const a = claude("idle");
    await a.start();
    const q = `Name the release notes (idle ${Date.now() % 10000})?`;
    await a.send(TASK.replace("{q}", q).replace("{n}", "idle"));
    const id = await until(
      "the decision",
      () => askedBy(a.sessionId, "release notes (idle"),
      180_000,
    );
    say(`idle: ${a.sessionId} asked ${id}`);
    await a.idle();
    const kept = existsSync(join(proj, "progress-idle.txt"));
    const waited = noWaiting(a);
    await Bun.sleep(3_000);
    const posted = Date.now();
    await owner.answer(id, "beta.md");
    const got = await answered(a, id);
    say(`idle: answer submitted ${secs(got.at - posted)} after the device posted it`);
    await a.idle();
    const acted = existsSync(join(proj, "beta.md"));
    const ok = kept && !waited && acted;
    await a.stop();
    return {
      name: "idle",
      result: ok ? "pass" : "FAIL",
      timing: `post → prompt ${secs(got.at - posted)}`,
      note: [
        kept ? "kept working after asking" : "did not keep working",
        waited ?? "never waited",
        acted ? "acted on the answer" : "did not act",
      ].join("; "),
    };
  },

  /**
   * The owner answers by hand, on a phone or the web page, in a session under Remote Control.
   * Timed from the answer's signed `answeredAt` (whole seconds, the device's clock).
   */
  async owner() {
    const a = new Claude("owner", proj, env, [
      ...sessionArgs("owner"),
      "--remote-control",
      "Starbridge #48 live check",
    ]);
    sessions.push(a);
    await a.start();
    const q = `Live check (#48): did this reach your phone? (${new Date().toISOString().slice(11, 16)} UTC)`;
    await a.send(
      "Use the starbridge skill to ask the owner this question, with options `Yes` and `No`, " +
        `default \`Yes\` in 1h, context: a live end-to-end test of Starbridge answers. Question: "${q}". ` +
        "After posting, create `progress-owner.txt` containing the word started, then end your turn. " +
        "When the answer arrives, create `owner-answer.txt` with the chosen option.",
    );
    const id = await until("the decision", () => askedBy(a.sessionId, "Live check (#48)"), 180_000);
    say(`owner: ${a.sessionId} asked ${id}: "${q}". Waiting for the owner to tap Yes.`);
    await a.idle();
    const waited = noWaiting(a);
    const got = await answered(a, id, 3_600_000);
    const answeredAt = Date.parse(
      (
        JSON.parse(readFileSync(join(configDir, "state.json"), "utf8")) as {
          answers: Record<string, { answer: { answeredAt: string } }>;
        }
      ).answers[id]?.answer.answeredAt ?? "",
    );
    await a.idle();
    const acted = existsSync(join(proj, "owner-answer.txt"));
    await a.stop();
    return {
      name: "owner by hand (Remote Control)",
      result: !waited && acted ? "pass" : "FAIL",
      timing: `answeredAt → prompt ${secs(got.at - answeredAt)} (answeredAt has 1 s resolution)`,
      note: `${got.text.split("\n").find((l) => l.startsWith("Answer to")) ?? ""}; ${waited ?? "never waited"}; ${acted ? "acted on it" : "did not act"}`,
    };
  },

  /** The answer arrives while a turn runs: it waits for that turn, then starts its own. */
  async midturn() {
    const a = claude("midturn");
    await a.start();
    const id = await ask(a.sessionId, "Mid-turn check?");
    // Not `sleep`, which Claude Code moves to the background.
    const busy = `python3 -c "import time; time.sleep(30); print('done')"`;
    await a.send(
      `Run exactly this with the Bash tool in the foreground: ${busy}. Then reply with the word finished.`,
    );
    await until(
      "the busy command",
      () => bashCommands(a.transcript()).some((c) => c.includes("time.sleep(30)")),
      60_000,
    );
    await Bun.sleep(3_000);
    const posted = Date.now();
    await owner.answer(id, "Beta");
    const got = await answered(a, id, 120_000);
    // The running turn ended with the last assistant entry before the answer's prompt.
    const turnEnd = a
      .transcript()
      .filter((e) => e.type === "assistant" && Date.parse(e.timestamp ?? "") <= got.at)
      .map((e) => Date.parse(e.timestamp ?? ""))
      .at(-1);
    const queued = turnEnd !== undefined && turnEnd > posted + 10_000;
    await a.idle();
    await a.stop();
    return {
      name: "mid-turn",
      result: queued ? "pass" : "FAIL",
      timing: `post → prompt ${secs(got.at - posted)}; turn end → prompt ${turnEnd ? secs(got.at - turnEnd) : "?"}`,
      note: queued
        ? "posted during a 30 s command; waited for the turn to end, then started its own"
        : "the turn ended before the answer could queue behind it",
    };
  },

  /** A /clear: the old session's answer waits for it; the new session gets its own answers. */
  async clear() {
    const a = claude("clear");
    await a.start();
    const old = a.sessionId;
    const id = await ask(old, "Asked before the clear?");
    await a.send("Reply with the word ready.");
    await a.idle();
    await a.send("/clear");
    await Bun.sleep(2_000);
    await owner.answer(id, "Beta");
    // The new session gets a transcript, and so an id we can see, with its first prompt.
    const marker = `Reply with the word cleared (${Date.now()}).`;
    await a.send(marker);
    const newId = await until("the new session", () => a.sessionsWith(marker)[0], 60_000);
    a.sessionId = newId;
    await a.idle();
    await Bun.sleep(15_000);
    const leaked = a.sessionsWith(`Answer to ${id}`);
    const id2 = await ask(newId, "Asked after the clear?");
    const posted = Date.now();
    await owner.answer(id2, "Alpha");
    const got = await answered(a, id2, 120_000).catch(() => undefined);
    await a.idle();
    // Resuming the old session delivers its held answer there.
    await a.send(`/resume ${old}`);
    a.sessionId = old;
    const resumed = Date.now();
    const back = await answered(a, id, 120_000).catch(() => undefined);
    await a.idle();
    await a.stop();
    const ok = leaked.length === 0 && got !== undefined && back !== undefined;
    return {
      name: "/clear",
      result: ok ? "pass" : "FAIL",
      timing: `new session: post → prompt ${got ? secs(got.at - posted) : "never"}; old answer after /resume ${back ? secs(back.at - resumed) : "never"}`,
      note: `${leaked.length === 0 ? "the old session's answer, posted after /clear, stayed out of the new session" : `old answer leaked into ${leaked}`}; ${back ? "it reached the old session on /resume" : "it never reached the old session"}`,
    };
  },

  /** A hot reload of the mod: the new module polls on, and the answer posted meanwhile arrives. */
  async reload() {
    const a = claude("reload");
    await a.start();
    const id = await ask(a.sessionId, "Asked across a reload?");
    await Bun.sleep(5_000);
    const reg = join(modDir, "hooks", "register.ts");
    const debug = join(work, "reload.debug.log");
    const reloads = () =>
      (readFileSync(debug, "utf8").match(/starbridge-mod@inline reloaded/g) ?? []).length;
    const before = reloads();
    const touched = Date.now();
    writeFileSync(reg, `${readFileSync(reg, "utf8")}\n`);
    await until("the reload", () => reloads() > before, 60_000);
    const reloaded = Date.now();
    say(`reload: the mod reloaded ${secs(reloaded - touched)} after it changed on disk`);
    const posted = Date.now();
    await owner.answer(id, "Beta");
    const got = await answered(a, id, 120_000);
    await a.idle();
    await a.stop();
    return {
      name: "hot reload",
      result: "pass",
      timing: `post → prompt ${secs(got.at - posted)}`,
      note: `answer posted right after the engine reloaded the mod (${secs(reloaded - touched)} after the edit)`,
    };
  },

  /** The server is unreachable for a while; the answer posted meanwhile arrives after. */
  async outage() {
    const a = claude("outage");
    await a.start();
    const id = await ask(a.sessionId, "Asked before the outage?");
    await Bun.sleep(3_000);
    relay.block();
    const blocked = Date.now();
    say("outage: blocked the server");
    await owner.answer(id, "Beta");
    await Bun.sleep(60_000);
    const early = a.prompt(`Answer to ${id}`);
    relay.unblock();
    const restored = Date.now();
    say(`outage: restored after ${secs(restored - blocked)}, ${relay.refused} connections refused`);
    const got = await answered(a, id, 400_000);
    await a.idle();
    await a.stop();
    return {
      name: "server unreachable",
      result: early ? "FAIL" : "pass",
      timing: `blocked 60 s; restore → prompt ${secs(got.at - restored)}`,
      note: `answer posted while blocked; ${relay.refused} connections refused`,
    };
  },

  /** Two agents ask at once; each gets only its own answer. */
  async two() {
    const b = claude("two-b");
    const c = claude("two-c");
    await Promise.all([b.start(), c.start()]);
    const qb = "Name the release notes (two, b)?";
    const qc = "Name the release notes (two, c)?";
    await Promise.all([
      b.send(TASK.replace("{q}", qb).replace("{n}", "b")),
      c.send(TASK.replace("{q}", qc).replace("{n}", "c")),
    ]);
    const [ib, ic] = await Promise.all([
      until("b's decision", () => askedBy(b.sessionId, "(two, b)"), 180_000),
      until("c's decision", () => askedBy(c.sessionId, "(two, c)"), 180_000),
    ]);
    say(`two: ${ib} from ${b.sessionId}, ${ic} from ${c.sessionId}`);
    const posted = Date.now();
    await Promise.all([owner.answer(ib, "alpha.md"), owner.answer(ic, "beta.md")]);
    const [gb, gc] = await Promise.all([answered(b, ib), answered(c, ic)]);
    await Promise.all([b.idle(), c.idle()]);
    await Bun.sleep(5_000);
    const crossed = b.prompt(`Answer to ${ic}`) ?? c.prompt(`Answer to ${ib}`);
    const waited = noWaiting(b) ?? noWaiting(c);
    await Promise.all([b.stop(), c.stop()]);
    return {
      name: "two sessions at once",
      result: !crossed && !waited ? "pass" : "FAIL",
      timing: `post → prompt ${secs(gb.at - posted)} (b), ${secs(gc.at - posted)} (c)`,
      note: `${crossed ? "an answer reached the other session" : "each got only its own answer"}; ${waited ?? "neither waited"}`,
    };
  },

  /** Nobody answers: at the default time the mod tells the session to apply its default. */
  async default() {
    const a = claude("default");
    await a.start();
    const at = new Date(Date.now() + 45_000);
    const id = await ask(a.sessionId, "Default after 45 s?", ["--default-at", at.toISOString()]);
    const got = await until("the default notice", () => a.prompt(`No answer to ${id}`), 180_000);
    await a.idle();
    await a.stop();
    return {
      name: "default time",
      result: "pass",
      timing: `default time → prompt ${secs(got.at - at.getTime())}`,
      note: "no answer posted; the notice arrived as its own prompt",
    };
  },
};

const only = opt.only?.split(",");
try {
  for (const [name, run] of Object.entries(cases)) {
    // `owner` waits for a person; it runs only when named.
    if (only ? !only.includes(name) : name === "owner") continue;
    say(`${name}: start`);
    try {
      const row = await run();
      rows.push(row);
      say(`${name}: ${row.result}  ${row.timing}  ${row.note}`);
    } catch (e) {
      rows.push({ name, result: "FAIL", timing: "", note: (e as Error).message });
      say(`${name}: FAIL ${(e as Error).message}`);
    }
    for (const s of sessions.splice(0)) await s.stop();
  }
  if (opt.agent) {
    // Every session the mod ran in went through the agent and never fell back to the CLI.
    const logs = readdirSync(work).filter((f) => f.endsWith(".debug.log"));
    const read = (f: string) => readFileSync(join(work, f), "utf8");
    const fell = logs.filter((f) => read(f).includes("answers through the CLI"));
    const used = logs.filter((f) => read(f).includes("answers through the agent"));
    rows.push({
      name: "through the agent",
      result: fell.length === 0 && used.length === logs.length ? "pass" : "FAIL",
      timing: "",
      note: `${used.length} of ${logs.length} sessions answered through the agent; ${fell.length} fell back to the CLI`,
    });
  }
} finally {
  for (const s of sessions) await s.stop();
  agent?.kill();
  await agent?.exited;
  relay.stop();
  local?.stop();
  if (!opt.keep) rmSync(work, { recursive: true, force: true });
}

const table = [
  "| Case | Result | Timing | Note |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.name} | ${r.result} | ${r.timing} | ${r.note} |`),
].join("\n");
console.log(`\n${table}`);
if (opt.out) writeFileSync(opt.out, `${table}\n\n\`\`\`\n${log.join("\n")}\n\`\`\`\n`);
process.exit(rows.every((r) => r.result === "pass") ? 0 : 1);
