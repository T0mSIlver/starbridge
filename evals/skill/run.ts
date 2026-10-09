/**
 * Runs real agents through the scripted situations in scenarios.ts, once with the skill and rule
 * of `--before` (a git ref) and once with this checkout's, and records what each posted.
 *
 *   bun evals/skill/run.ts [--agent claude|codex|pi|opencode] [--model claude-haiku-5-5] [--reps 2] [--jobs 4]
 *                          [--only merge-order,...] [--arms before,after] [--before origin/main]
 *                          [--out evals/skill/results/<agent>]
 *
 * Each run gets its own throwaway world: a home folder, a Claude Code config dir (or CODEX_HOME,
 * or PI_CODING_AGENT_DIR) holding only the login, the real server app on a random port
 * with the CLI paired to it, a git project with a bare remote, and a `gh` that prints canned
 * output. Nothing is written to the owner's own config. Claude Code loads the plugin with
 * `--plugin-dir`; Codex gets the skill in `$CODEX_HOME/skills` and the SessionStart rule in
 * `$CODEX_HOME/AGENTS.md`, opencode the same in its XDG config folder; Pi loads the Starbridge Pi
 * extension and skill with `-e` and `--skill`.
 *
 * Models: Claude Code defaults to claude-haiku-5-5, Codex to its own default and Pi to
 * zai/glm-5.3-flash (`provider/id`, with the providers of `~/.pi/agent`). Haiku 5.5 costs more
 * past 100k tokens of context, so each Claude Code run records its largest request and the
 * progress line flags one over that.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LiveServer } from "../../server/test-support/index.ts";
import { claudeToken, codexKey, tmpOutsideHome } from "./login.ts";
import { type Scenario, scenarios } from "./scenarios.ts";

const { values: opt } = parseArgs({
  args: process.argv.slice(2),
  options: {
    agent: { type: "string", default: "claude" },
    model: { type: "string" },
    reps: { type: "string", default: "2" },
    jobs: { type: "string", default: "4" },
    only: { type: "string" },
    arms: { type: "string", default: "before,after" },
    before: { type: "string", default: "origin/main" },
    out: { type: "string" },
    keep: { type: "boolean" },
  },
});

const agent = opt.agent as "claude" | "codex" | "pi" | "opencode";
const model =
  opt.model ??
  {
    claude: "claude-haiku-5-5",
    codex: undefined,
    pi: "zai/glm-5.3-flash",
    opencode: "zai-coding-plan/glm-5.3-flash",
  }[agent];
const repo = join(import.meta.dir, "..", "..");
const out = opt.out ?? join(import.meta.dir, "results", agent);
mkdirSync(out, { recursive: true });
// Never under the owner's home: Claude Code walks up from the project and would load
// ~/.claude/CLAUDE.md as an ancestor's. Not in the scratchpad either: a path naming Starbridge
// would hint the agent. Set TMPDIR to put it off a small /tmp. Each run's folder goes once its
// record is written (a Codex home is 60 MB).
const work = mkdtempSync(join(tmpOutsideHome(), "skill-eval-"));
// Also when a run throws: the homes go even if the eval dies (#313).
process.on("exit", () => {
  if (!opt.keep) rmSync(work, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => process.exit(130));
const bun = process.execPath;
const which = (cmd: string) => {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} not on PATH`);
  return r.stdout.trim();
};
const agentBin = which(agent);

// The two versions under test, `plugin` (and `mod`, the Pi extension, for Pi) at `--before` and
// this checkout's.
const parts = ["plugin", "mod"];
const arms: Record<string, string> = {};
for (const arm of (opt.arms as string).split(",")) {
  const dir = join(work, "arms", arm);
  mkdirSync(dir, { recursive: true });
  if (arm === "after") {
    cpSync(join(repo, "plugin"), join(dir, "plugin"), { recursive: true });
    for (const d of [".claude-plugin", "hooks", "opencode", "pi"])
      cpSync(join(repo, "mod", d), join(dir, "mod", d), { recursive: true });
  }
  else {
    const tar = spawnSync("git", ["-C", repo, "archive", opt.before as string, ...parts], {
      maxBuffer: 1 << 26,
    });
    if (tar.status !== 0) throw new Error(`git archive ${opt.before}: ${tar.stderr}`);
    if (spawnSync("tar", ["-x", "-C", dir], { input: tar.stdout }).status !== 0)
      throw new Error(`tar -x of ${opt.before}`);
  }
  arms[arm] = dir;
}

const sh = (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

/** A `gh` that logs its arguments and prints `<dir>/<a>-<b>-<c>`, then `<a>-<b>`, if present. */
function ghShim(bin: string, dir: string, log: string) {
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "gh $*" >> '${log}'
set -- $(for a in "$@"; do case "$a" in -*) ;; *) printf '%s ' "$a" ;; esac; done)
for key in "$1-$2-$3" "$1-$2"; do
  if [ -f '${dir}'/"$key" ]; then cat '${dir}'/"$key"; exit 0; fi
done
exit 0
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
}

interface Turn {
  commands: string[];
  /** Each `AskUserQuestion` call, and whether a hook turned it away (plugins before #848). */
  askUser?: { denied: boolean }[];
  final: string;
  tokens?: number;
  costUsd?: number;
  exit: number | null;
  seconds: number;
  /** What `ask` printed about how the answer comes back (#589). */
  delivery?: string[];
  /** Commands run in the background (Claude Code's `run_in_background`). */
  background?: string[];
  /** Tools other than the shell, in order (opencode's `question`, `edit`). */
  tools?: string[];
}

export interface RunRecord {
  agent: string;
  model: string;
  arm: string;
  scenario: string;
  rep: number;
  turns: Turn[];
  /** Decisions posted, opened as the phone sees them; images replaced by their sizes. */
  decisions: Record<string, unknown>[];
  /** Decisions posted during the follow-up turn. */
  laterDecisions: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  /** The waiting notices the devices got (`--waiting`, `starbridge waiting`, `wait`). */
  waiting?: Record<string, unknown>[];
  /** Permission prompts that reached the devices. */
  permissions?: Record<string, unknown>[];
  /** For a live session, whether the answer came back as a prompt. */
  prompted?: boolean;
  gh: string[];
  answered?: string;
  /** When the owner snoozed the first card until (#571), for snooze situations. */
  snoozed?: string;
  /** Claude Code: the largest context one request sent, in tokens. */
  peakContext?: number;
  error?: string;
}

/** Runs one agent turn and returns the commands it ran and its last message. */
async function turn(
  dir: string,
  env: Record<string, string>,
  prompt: string,
  arm: string,
  resume?: string,
): Promise<Turn & { session?: string }> {
  const plugin = join(arm, "plugin");
  const t0 = Date.now();
  let args: string[];
  if (agent === "claude") {
    args = [
      "-p",
      prompt,
      "--plugin-dir",
      plugin,
      "--setting-sources",
      "project",
      "--allowedTools",
      "Bash Write Edit Read Glob Grep",
      "--model",
      model as string,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(resume ? ["--resume", resume] : []),
    ];
  } else if (agent === "pi") {
    args = [
      "--no-extensions",
      "-e",
      join(arm, "mod/pi/starbridge.ts"),
      "--no-skills",
      "--skill",
      join(plugin, "skills/starbridge"),
      "--model",
      model as string,
      "--mode",
      "json",
      ...(resume ? ["--session", resume] : []),
      "-p",
      prompt,
    ];
  } else if (agent === "opencode") {
    // `opencode run` rejects every permission prompt; `--auto` allows them, as Codex's bypass.
    args = [
      "run",
      "--pure",
      "--auto",
      "--format",
      "json",
      "-m",
      model as string,
      "--dir",
      dir,
      ...(resume ? ["--session", resume] : []),
      prompt,
    ];
  } else {
    const common = ["--json", "--skip-git-repo-check", ...(model ? ["-m", model] : [])];
    const bypass = "--dangerously-bypass-approvals-and-sandbox";
    args = resume
      ? ["exec", "resume", ...common, bypass, resume, prompt]
      : ["exec", ...common, bypass, "-C", dir, prompt];
  }
  const p = Bun.spawn([agentBin, ...args], {
    cwd: dir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), 12 * 60_000);
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const exit = await p.exited;
  clearTimeout(timer);
  const events = stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  const commands: string[] = [];
  const delivery: string[] = [];
  const background: string[] = [];
  let final = "";
  let session: string | undefined;
  let tokens: number | undefined;
  let costUsd: number | undefined;
  for (const e of events) {
    if (agent === "claude") {
      if (e.type === "assistant")
        for (const b of e.message?.content ?? [])
          if (b.type === "tool_use" && b.name === "Bash") {
            commands.push(b.input?.command ?? "");
            if (b.input?.run_in_background) background.push(b.input?.command ?? "");
          }
      if (e.type === "user")
        for (const b of Array.isArray(e.message?.content) ? e.message.content : [])
          if (b.type === "tool_result") delivery.push(...deliveryLines(JSON.stringify(b.content ?? "")));
      if (e.type === "result") {
        final = e.result ?? "";
        session = e.session_id;
        costUsd = e.total_cost_usd;
        const u = e.usage ?? {};
        tokens =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
      }
    } else if (agent === "pi") {
      if (e.type === "session") session = e.id;
      const m = e.message;
      if (e.type === "message_end" && m?.role === "assistant") {
        // A provider error Pi retried past is not the run's outcome.
        if (final.startsWith("(error) ")) final = "";
        for (const b of m.content ?? []) {
          if (b.type === "toolCall" && b.name === "bash") commands.push(b.arguments?.command ?? "");
          if (b.type === "text" && b.text) final = b.text;
        }
        if (m.errorMessage) final = `(error) ${m.errorMessage}`;
        const u = m.usage ?? {};
        tokens = (tokens ?? 0) + (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        costUsd = (costUsd ?? 0) + (u.cost?.total ?? 0);
      }
    } else if (agent === "opencode") {
      session ??= e.sessionID;
      const part = e.part;
      if (e.type === "tool_use" && part?.tool === "bash") {
        commands.push(part.state?.input?.command ?? "");
        delivery.push(...deliveryLines(String(part.state?.output ?? "")));
      }
      if (e.type === "text") final = part?.text ?? final;
      // A provider's error (a spent quota) ends `opencode run` with exit 1.
      if (e.type === "error") final = `(error) ${JSON.stringify(e.error ?? e).slice(0, 500)}`;
      if (e.type === "step_finish" && part?.tokens)
        tokens = (tokens ?? 0) + (part.tokens.input ?? 0) + (part.tokens.output ?? 0);
    } else {
      if (e.type === "thread.started") session = e.thread_id;
      const item = e.item;
      if (e.type === "item.completed" && item?.type === "command_execution")
        commands.push(item.command);
      if (e.type === "item.completed" && item?.type === "agent_message") final = item.text;
      if (e.type === "turn.completed" && e.usage)
        tokens = (e.usage.input_tokens ?? 0) + (e.usage.output_tokens ?? 0);
    }
  }
  if (!final && exit !== 0) final = `(exit ${exit}) ${stderr.slice(-2000)}`;
  return {
    commands,
    final,
    session,
    tokens,
    costUsd,
    exit,
    seconds: (Date.now() - t0) / 1000,
    delivery,
    ...(background.length ? { background } : {}),
  };
}

/** The lines of a command's output that say how the answer comes back. */
const deliveryLines = (text: string) =>
  (text.replaceAll("\\n", "\n").match(/(The answer will come back[^\n"]*|Nothing brings the answer[^\n"]*)/g) ?? []);

/**
 * One turn of an interactive Claude Code session in a detached tmux window, read from its
 * transcript: `claude -p` offers no `AskUserQuestion`. Ends when the session idles, or when an
 * `AskUserQuestion` dialog waits for the keyboard.
 */
async function interactiveTurn(
  dir: string,
  env: Record<string, string>,
  prompt: string,
  arm: string,
  cfg: string,
): Promise<Turn & { session?: string }> {
  const plugin = join(arm, "plugin");
  const t0 = Date.now();
  const id = crypto.randomUUID();
  const tmux = `skill-eval-${id.slice(0, 8)}`;
  // A fresh config dir would show onboarding and the folder-trust question first.
  writeFileSync(
    join(cfg, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: { [dir]: { hasTrustDialogAccepted: true } },
    }),
  );
  // The environment goes through a private file, not argv, where `ps` would show the token.
  const envFile = join(cfg, "env.sh");
  writeFileSync(
    envFile,
    Object.entries({ ...env, TERM: "xterm-256color" })
      .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'\n`)
      .join(""),
    { mode: 0o600 },
  );
  const cmd = [
    "env",
    "-i",
    "sh",
    "-c",
    `. '${envFile}'; exec "$0" "$@"`,
    agentBin,
    "--session-id",
    id,
    "--plugin-dir",
    plugin,
    "--setting-sources",
    "project",
    "--allowedTools",
    "Bash Write Edit Read Glob Grep",
    "--model",
    model as string,
    prompt,
  ];
  spawnSync("tmux", ["new-session", "-d", "-s", tmux, "-x", "200", "-y", "50", "-c", dir, ...cmd]);
  const file = join(cfg, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  const pane = () =>
    spawnSync("tmux", ["capture-pane", "-p", "-t", tmux], { encoding: "utf8" }).stdout ?? "";
  const entries = () =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .flatMap((l) => {
            try {
              return [JSON.parse(l)];
            } catch {
              return [];
            }
          })
      : [];
  // The pending call reaches the transcript only once answered, so its dialog is read off the
  // pane: "Enter to select" twice in a row means it waits for the keyboard.
  let quietSince = Date.now();
  let lastSize = -1;
  let dialog = 0;
  while (Date.now() - t0 < 12 * 60_000) {
    await Bun.sleep(2000);
    const es = entries();
    const p = pane();
    dialog = /Enter to select/.test(p) ? dialog + 1 : 0;
    if (dialog >= 2) break;
    if (/esc to interrupt/i.test(p) || es.length !== lastSize) {
      quietSince = Date.now();
      lastSize = es.length;
      continue;
    }
    if (es.some((e) => e.type === "assistant") && Date.now() - quietSince > 8000) break;
  }
  spawnSync("tmux", ["kill-session", "-t", tmux]);
  const es = entries();
  // Turned away: denied (an older hook), or answered by the hook with the Starbridge instruction.
  const results = new Map<string, boolean>();
  for (const e of es)
    if (e.type === "user" && Array.isArray(e.message?.content))
      for (const b of e.message.content)
        if (b.type === "tool_result")
          results.set(
            b.tool_use_id,
            !!b.is_error || JSON.stringify(b.content ?? "").includes("ask through Starbridge"),
          );
  const commands: string[] = [];
  const askUser: { denied: boolean }[] = [];
  let pending = 0;
  let final = "";
  for (const e of es) {
    if (e.type !== "assistant") continue;
    for (const b of e.message?.content ?? []) {
      if (b.type === "tool_use" && b.name === "Bash") commands.push(b.input?.command ?? "");
      if (b.type === "tool_use" && b.name === "AskUserQuestion") {
        askUser.push({ denied: results.get(b.id) === true });
        if (!results.has(b.id)) pending++;
      }
      if (b.type === "text" && b.text) final = b.text;
    }
  }
  // Older Claude Code wrote the pending call to the transcript only once answered.
  if (dialog >= 2 && pending === 0) askUser.push({ denied: false });
  return { commands, askUser, final, session: id, exit: 0, seconds: (Date.now() - t0) / 1000 };
}

/** One command a live session ran, with when it started. */
interface Ran {
  at: number;
  command?: string;
  tool?: string;
  output?: string;
  background?: boolean;
  text?: string;
}

/**
 * A session that lives across the answer, as in the TUI (#589, #345, #489): Claude Code in tmux,
 * or opencode under `opencode serve` with its Starbridge plugin, given the prompt through its API.
 * The owner answers the first card or permission prompt; the run ends once the session has been
 * quiet for 20 s after that, or 45 s with nothing to answer. What ran before the answer is the
 * first turn, the rest the second.
 */
async function liveRun(
  s: Scenario,
  root: string,
  proj: string,
  env: Record<string, string>,
  armDir: string,
  cfg: string,
  live: LiveServer,
  rec: RunRecord,
  answer: () => Promise<boolean>,
  answeredAt: () => number | undefined,
) {
  const t0 = Date.now();
  const sb = env.STARBRIDGE_CONFIG_DIR as string;
  const procs: { kill(): void }[] = [];
  let stop = () => {};
  try {
    if (s.live?.mod) {
      // Named outright: sessions run without XDG_RUNTIME_DIR, which the agent's default path reads.
      env.STARBRIDGE_AGENT_SOCKET = join(sb, "agent.sock");
      procs.push(
        Bun.spawn([join(root, "bin/starbridge"), "agent", "--no-quota"], {
          env,
          stdout: Bun.file(join(root, "agent.log")),
          stderr: Bun.file(join(root, "agent.err")),
        }),
      );
      for (let i = 0; i < 50 && !existsSync(env.STARBRIDGE_AGENT_SOCKET); i++) await Bun.sleep(200);
      if (!existsSync(env.STARBRIDGE_AGENT_SOCKET)) throw new Error("the agent did not start");
    }
    if (s.live?.permissions) sh(join(root, "bin/starbridge"), ["config", "permissions", "on"], proj, env);

    let poll: () => Promise<{ busy: boolean; ran: Ran[] }>;
    if (agent === "claude") {
      const id = crypto.randomUUID();
      const tmux = `skill-eval-${id.slice(0, 8)}`;
      writeFileSync(
        join(cfg, ".claude.json"),
        JSON.stringify({
          hasCompletedOnboarding: true,
          theme: "dark",
          projects: { [proj]: { hasTrustDialogAccepted: true } },
        }),
      );
      const envFile = join(cfg, "env.sh");
      writeFileSync(
        envFile,
        Object.entries({ ...env, TERM: "xterm-256color" })
          .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'\n`)
          .join(""),
        { mode: 0o600 },
      );
      const cmd = [
        "env", "-i", "sh", "-c", `. '${envFile}'; exec "$0" "$@"`, agentBin,
        "--session-id", id,
        "--plugin-dir", join(armDir, "plugin"),
        ...(s.live?.mod ? ["--plugin-dir", join(armDir, "mod")] : []),
        "--setting-sources", "project",
        "--allowedTools", "Bash Write Edit Read Glob Grep",
        "--model", model as string,
        s.prompt,
      ];
      spawnSync("tmux", ["new-session", "-d", "-s", tmux, "-x", "200", "-y", "50", "-c", proj, ...cmd]);
      stop = () => spawnSync("tmux", ["kill-session", "-t", tmux]);
      const file = join(cfg, "projects", proj.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
      rec.turns = [];
      poll = async () => {
        const pane = spawnSync("tmux", ["capture-pane", "-p", "-t", tmux], { encoding: "utf8" }).stdout ?? "";
        const es = existsSync(file)
          ? readFileSync(file, "utf8").split("\n").flatMap((l) => {
              try {
                return [JSON.parse(l)];
              } catch {
                return [];
              }
            })
          : [];
        const out = new Map<string, string>();
        for (const e of es)
          if (e.type === "user" && Array.isArray(e.message?.content))
            for (const b of e.message.content)
              if (b.type === "tool_result") out.set(b.tool_use_id, JSON.stringify(b.content ?? ""));
        const ran: Ran[] = [];
        for (const e of es) {
          const at = Date.parse(e.timestamp ?? "") || 0;
          // The mod's prompt, in whatever entry carries it; a `wait`'s output is a tool result.
          if (e.type !== "assistant") {
            const text = JSON.stringify(e);
            if (text.includes("Answer to d_") && !/tool_result|toolUseResult/.test(text)) rec.prompted = true;
          }
          if (e.type !== "assistant") continue;
          for (const b of e.message?.content ?? []) {
            if (b.type === "tool_use" && b.name === "Bash")
              ran.push({ at, command: b.input?.command ?? "", output: out.get(b.id), background: !!b.input?.run_in_background });
            else if (b.type === "tool_use") ran.push({ at, tool: b.name });
            if (b.type === "text" && b.text) ran.push({ at, text: b.text });
          }
        }
        return { busy: /esc to interrupt/i.test(pane), ran };
      };
    } else if (agent === "opencode") {
      // The plugin and skill as `starbridge setup` lays them out; the plugin adds the rule.
      const conf = join(cfg, "opencode");
      rmSync(join(conf, "AGENTS.md"), { force: true });
      mkdirSync(join(conf, "plugins"), { recursive: true });
      writeFileSync(
        join(conf, "plugins/starbridge.ts"),
        'export { default } from "../starbridge/mod/opencode/starbridge.ts";\n',
      );
      for (const d of ["opencode", "hooks"])
        cpSync(join(armDir, "mod", d), join(conf, "starbridge/mod", d), { recursive: true });
      mkdirSync(join(conf, "starbridge/plugin/hooks"), { recursive: true });
      copyFileSync(join(armDir, "plugin/hooks/rule.md"), join(conf, "starbridge/plugin/hooks/rule.md"));
      const allow = { bash: "allow", webfetch: "allow", external_directory: "allow" };
      writeFileSync(
        join(conf, "opencode.json"),
        JSON.stringify({ permission: { ...allow, edit: s.live?.permissions ? "ask" : "allow" } }),
      );
      let base = "";
      const api = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json", "x-opencode-directory": proj },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await r.text();
        return text ? JSON.parse(text) : undefined;
      };
      // Two servers starting at once can fail with a ServeError: start again on another port.
      for (let attempt = 0; attempt < 3 && !base; attempt++) {
        const port = 20000 + Math.floor(Math.random() * 20000);
        const serve = Bun.spawn([agentBin, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
          cwd: proj,
          env,
          stdout: Bun.file(join(root, `serve-${attempt}.log`)),
          stderr: Bun.file(join(root, `serve-${attempt}.err`)),
        });
        procs.push(serve);
        for (let i = 0; i < 100 && serve.exitCode === null; i++) {
          try {
            await fetch(`http://127.0.0.1:${port}/session`);
            base = `http://127.0.0.1:${port}`;
            break;
          } catch {
            await Bun.sleep(300);
          }
        }
        if (!base) await Bun.sleep(1000 + Math.random() * 3000);
      }
      if (!base) throw new Error("opencode serve did not start");
      const session = (await api("POST", "/session", {})) as { id: string };
      const [providerID, ...rest] = (model as string).split("/");
      await api("POST", `/session/${session.id}/prompt_async`, {
        parts: [{ type: "text", text: s.prompt }],
        model: { providerID, modelID: rest.join("/") },
      });
      poll = async () => {
        const status = ((await api("GET", "/session/status")) ?? {}) as Record<string, { type: string }>;
        const msgs = ((await api("GET", `/session/${session.id}/message`)) ?? []) as {
          info: { role: string; time: { created: number }; error?: { data?: { message?: string } } };
          parts: { type: string; text?: string; tool?: string; state?: { input?: { command?: string }; output?: string; time?: { start?: number } } }[];
        }[];
        const ran: Ran[] = [];
        for (const m of msgs) {
          if (m.info.role === "user" && m.parts.some((p) => /Answer to d_/.test(p.text ?? "")))
            rec.prompted = true;
          if (m.info.role !== "assistant") continue;
          // A provider's error (a spent quota): the run says nothing about the agent.
          if (m.info.error) throw new Error(`(error) ${m.info.error.data?.message ?? JSON.stringify(m.info.error)}`);
          for (const p of m.parts) {
            const at = p.state?.time?.start ?? m.info.time.created;
            if (p.type === "tool" && p.tool === "bash")
              ran.push({ at, command: p.state?.input?.command ?? "", output: p.state?.output });
            else if (p.type === "tool") ran.push({ at, tool: p.tool });
            if (p.type === "text" && p.text) ran.push({ at, text: p.text });
          }
        }
        const st = status[session.id]?.type;
        return { busy: !!st && st !== "idle", ran };
      };
    } else throw new Error(`no live session for ${agent}`);

    let quietSince = Date.now();
    let last = "";
    let ran: Ran[] = [];
    while (Date.now() - t0 < 12 * 60_000) {
      await Bun.sleep(2000);
      const now = await poll();
      ran = now.ran;
      const sig = JSON.stringify(ran);
      if (now.busy || sig !== last) {
        quietSince = Date.now();
        last = sig;
      }
      if (await answer()) quietSince = Date.now();
      const quiet = Date.now() - quietSince;
      if (answeredAt() ? quiet > 20_000 : quiet > 45_000 && ran.length > 0) break;
    }
    const split = answeredAt() ?? Number.POSITIVE_INFINITY;
    const turnOf = (xs: Ran[]): Turn => ({
      commands: xs.filter((x) => x.command !== undefined).map((x) => x.command as string),
      final: xs.filter((x) => x.text).at(-1)?.text ?? "",
      exit: 0,
      seconds: (Date.now() - t0) / 1000,
      delivery: xs.flatMap((x) => deliveryLines(x.output ?? "")),
      background: xs.filter((x) => x.background).map((x) => x.command as string),
      tools: xs.filter((x) => x.tool).map((x) => x.tool as string),
    });
    rec.turns = [turnOf(ran.filter((x) => x.at < split))];
    if (answeredAt()) rec.turns.push(turnOf(ran.filter((x) => x.at >= split)));
  } finally {
    stop();
    for (const p of procs) p.kill();
  }
}

const strip = (items: Record<string, unknown>[]) =>
  items.map((d) => ({
    ...d,
    images: (d.images as { type: string; width: number; height: number; alt?: string }[] | undefined)
      ?.map(({ type, width, height, alt }) => ({ type, width, height, alt })),
  }));

async function one(s: Scenario, arm: string, rep: number): Promise<RunRecord> {
  const id = `${arm}-${s.name}-${rep}`;
  const root = join(work, id);
  const [proj, gh, bin, home, sb, cfg] = ["proj", "gh", "bin", "home", "sb", "cfg"].map((d) => {
    mkdirSync(join(root, d), { recursive: true });
    return join(root, d);
  }) as [string, string, string, string, string, string];
  const ghLog = join(root, "gh.log");
  writeFileSync(ghLog, "");
  ghShim(bin, gh, ghLog);
  writeFileSync(
    join(bin, "starbridge"),
    `#!/bin/sh\nexec '${bun}' '${join(repo, "cli/src/main.ts")}' "$@"\n`,
  );
  chmodSync(join(bin, "starbridge"), 0o755);

  // The agent's login (Claude's long-lived token, else a copy in its throwaway config); the
  // plugin or skill under test.
  const armDir = arms[arm] as string;
  const plugin = join(armDir, "plugin");
  const login: Record<string, string> = {};
  if (agent === "claude") login.CLAUDE_CODE_OAUTH_TOKEN = claudeToken();
  else if (agent === "pi") {
    // Only the providers and their API keys: Pi's auth.json may hold OAuth logins that refresh.
    copyFileSync(join(homedir(), ".pi/agent/models.json"), join(cfg, "models.json"));
  } else {
    // opencode reads its config from `$XDG_CONFIG_HOME/opencode` and its login from
    // `$XDG_DATA_HOME/opencode/auth.json` (the Z.ai key).
    const conf = agent === "opencode" ? join(cfg, "opencode") : cfg;
    if (agent === "opencode") {
      mkdirSync(join(root, "data/opencode"), { recursive: true });
      copyFileSync(
        join(homedir(), ".local/share/opencode/auth.json"),
        join(root, "data/opencode/auth.json"),
      );
    } else {
      const r = spawnSync(agentBin, ["login", "--with-api-key"], {
        input: codexKey(),
        env: { ...process.env, CODEX_HOME: cfg },
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(`codex login --with-api-key: ${r.stderr}`);
    }
    cpSync(join(plugin, "skills/starbridge"), join(conf, "skills/starbridge"), { recursive: true });
    const hook = spawnSync("sh", [join(plugin, "hooks/session-start.sh")], {
      env: { STARBRIDGE_CONFIG_DIR: sb },
      encoding: "utf8",
    });
    writeFileSync(
      join(conf, "AGENTS.md"),
      `${JSON.parse(hook.stdout).hookSpecificOutput.additionalContext}\n`,
    );
  }

  const env: Record<string, string> = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    STARBRIDGE_CONFIG_DIR: sb,
    GIT_AUTHOR_NAME: "dev",
    GIT_AUTHOR_EMAIL: "dev@example.com",
    GIT_COMMITTER_NAME: "dev",
    GIT_COMMITTER_EMAIL: "dev@example.com",
    ...{ claude: { CLAUDE_CONFIG_DIR: cfg }, codex: { CODEX_HOME: cfg }, pi: { PI_CODING_AGENT_DIR: cfg },
      opencode: {
        XDG_CONFIG_HOME: cfg,
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        // Shared, so each run does not download the model list again.
        XDG_CACHE_HOME: join(work, "cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    }[agent],
    ...login,
  };

  const live = await LiveServer.start();
  const rec: RunRecord = {
    agent,
    model: model ?? "default",
    arm,
    scenario: s.name,
    rep,
    turns: [],
    decisions: [],
    laterDecisions: [],
    runs: [],
    gh: [],
  };
  try {
    if (!s.unpaired) {
      const pairing = Bun.spawn([join(bin, "starbridge"), "pair", "--server", live.url, "--name", "devbox"], {
        env,
        stdout: "pipe",
      });
      const reader = pairing.stdout.getReader();
      let text = "";
      while (!/Pairing code: (\S+)/.test(text)) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`starbridge pair exited without a code: ${text}`);
        text += new TextDecoder().decode(value);
      }
      await live.approve((/Pairing code: (\S+)/.exec(text) as RegExpExecArray)[1] as string);
      // The owner confirms the check code (#814); `pair` shows it once it sees the approval.
      for (let i = 0; i < 50; i++) {
        if (spawnSync(join(bin, "starbridge"), ["pair", "--confirm"], { env }).status === 0) break;
        await Bun.sleep(200);
      }
      if ((await pairing.exited) !== 0) throw new Error("pairing failed");
    }

    s.build(proj, gh);
    const remote = join(root, "origin.git");
    sh("git", ["init", "-q", "--bare", "-b", "main", remote], root);
    sh("git", ["init", "-q", "-b", "main"], proj, env);
    sh("git", ["add", "-A"], proj, env);
    sh("git", ["commit", "-q", "-m", "Initial commit"], proj, env);
    sh("git", ["remote", "add", "origin", remote], proj, env);
    sh("git", ["push", "-q", "-u", "origin", "main"], proj, env);
    for (const b of s.name === "design-pick" ? ["settings-roomy", "settings-compact"] : [])
      sh("git", ["branch", b], proj, env);

    type Card = {
      id: string;
      question: string;
      recommended?: string;
      options: string[];
      answerIn?: { url: string } | null;
    };
    const choiceFor = (c: Card) => c.recommended ?? c.options[0] ?? "Go ahead";
    // The owner's reply: the recommended option, or Done on an `--answer-in` card, after the
    // page took the pick (#539).
    const reply = async (c: Card) => {
      if (s.snooze) {
        // The owner puts it off until tomorrow morning instead of answering (#571).
        const until = new Date();
        until.setDate(until.getDate() + 1);
        until.setHours(9, 0, 0, 0);
        await live.snooze(c.id, until);
        rec.snoozed = until.toISOString();
      } else if (s.done) {
        writeFileSync(join(root, "page-pick"), "Picked: Starter, Plus, Studio\n");
        await live.answer(c.id, { done: true });
        rec.answered = `Answer to ${c.id} (${c.question}): answered on its page; read the answer there`;
      } else if (c.options.length === 0 && !c.answerIn) {
        // A card with no options takes a typed reply.
        await live.answer(c.id, { text: "Lantern" });
        rec.answered = `Answer to ${c.id} (${c.question}): Lantern`;
      } else {
        await live.answer(c.id, { choice: choiceFor(c) });
        rec.answered = `Answer to ${c.id} (${c.question}): ${choiceFor(c)}`;
      }
    };
    const delay = (s.answerAfter ?? 15) * 1000;
    // In `claude -p`, `codex exec`, `pi -p` and `opencode run` nothing brings an answer back as a
    // prompt: the agent waits within its turn (`starbridge wait`), so the owner answers the first
    // card while it runs, whether or not the situation checks what it does with the answer.
    let answeredFirst: Record<string, unknown>[] | undefined;
    const answering =
      !s.interactive && !s.unpaired && !s.live
        ? (async () => {
            while (!answeredFirst) {
              await Bun.sleep(2_000);
              if (answeredFirst) break;
              const now = (await live.opened("decision")) as Record<string, unknown>[];
              const c = now[0] as Card | undefined;
              if (!c) continue;
              await Bun.sleep(delay);
              if (answeredFirst) break;
              const latest = (await live.opened("decision")) as Record<string, unknown>[];
              await reply(c);
              answeredFirst = latest;
            }
          })().catch(() => {}) // the turn ended and the server stopped first
        : undefined;
    if (s.live) {
      let seen: number | undefined;
      let at: number | undefined;
      const answerFirst = async () => {
        if (at) return false;
        const d = ((await live.opened("decision")) as unknown as Card[])[0];
        const p = d ? undefined : ((await live.opened("permission")) as { id: string }[])[0];
        if (!d && !p) return false;
        seen ??= Date.now();
        if (Date.now() - seen < delay) return false;
        answeredFirst = (await live.opened("decision")) as Record<string, unknown>[];
        if (d) await reply(d);
        else if (p) {
          await live.answerPermission(p.id, { behavior: "allow", scope: "once" });
          rec.answered = `Allowed ${p.id}`;
        }
        at = Date.now();
        return true;
      };
      await liveRun(s, root, proj, env, armDir, cfg, live, rec, answerFirst, () => at);
      const opened = (await live.opened("decision")) as Record<string, unknown>[];
      const before = answeredFirst ?? opened;
      rec.decisions = strip(before);
      rec.laterDecisions = strip(opened.filter((d) => !before.some((o) => o.id === d.id)));
    }
    const first = s.live
      ? (rec.turns[0] as Turn & { session?: string })
      : s.interactive
      ? await interactiveTurn(proj, env, s.prompt, armDir, cfg)
      : await turn(proj, env, s.prompt, armDir);
    if (answering && !answeredFirst) answeredFirst = [];
    if (!s.live) rec.turns.push(first);
    // The model's provider failed (a rate limit): the run says nothing about the agent.
    if (first.final.startsWith("(error) ")) throw new Error(first.final);
    const opened = s.unpaired ? [] : ((await live.opened("decision")) as Record<string, unknown>[]);
    if (s.live) {
    } else if (answering) {
      // Split the turn where the agent got the answer: what it ran after its last wait on the
      // answered card is what a second turn would hold.
      const before = rec.answered ? (answeredFirst ?? []) : opened;
      rec.decisions = strip(before);
      rec.laterDecisions = strip(opened.filter((d) => !before.some((o) => o.id === d.id)));
      const id = /^Answer to (\S+)/.exec(rec.answered ?? "")?.[1] ?? "";
      const cmds = first.commands.map((c) => c.replace(/\\\n\s*/g, " "));
      let i = cmds.findLastIndex((c) => /starbridge\s+wait\b/.test(c) && c.includes(id));
      if (i < 0) i = cmds.findLastIndex((c) => /starbridge\s+(wait\b|ask\b[\s\S]*--wait\b)/.test(c));
      if (rec.answered && i >= 0)
        rec.turns = [
          { ...first, commands: first.commands.slice(0, i + 1) },
          { ...first, commands: first.commands.slice(i + 1) },
        ];
    } else rec.decisions = strip(opened);
    const card = answering || s.live ? undefined : (opened[0] as Card | undefined);
    if (s.followUp && card && first.session) {
      const choice = choiceFor(card);
      rec.answered = `Answer to ${card.id} (${card.question}): ${choice}`;
      rec.turns.push(await turn(proj, env, rec.answered, armDir, first.session));
      const all = (await live.opened("decision")) as Record<string, unknown>[];
      rec.laterDecisions = strip(all.filter((d) => !opened.some((o) => o.id === d.id)));
    }
    if (!s.unpaired) {
      rec.runs = (await live.opened("run")) as Record<string, unknown>[];
      rec.waiting = (await live.opened("waiting")) as Record<string, unknown>[];
      rec.permissions = (await live.opened("permission")) as Record<string, unknown>[];
    }
    // Images, for render.ts, opened from their blobs (#685).
    for (const [i, shown] of (s.unpaired ? [] : await live.images()).entries())
      for (const [j, img] of shown.entries())
        writeFileSync(
          join(out, `${agent}-${id}-d${i}-img${j}.${img.type === "image/png" ? "png" : "jpg"}`),
          Buffer.from(img.data, "base64"),
        );
  } catch (e) {
    rec.error = String(e);
  } finally {
    live.stop();
    rec.gh = readFileSync(ghLog, "utf8").split("\n").filter(Boolean);
    if (agent === "claude") rec.peakContext = peakContext(join(cfg, "projects"));
  }
  writeFileSync(join(out, `${id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  if (!opt.keep) rmSync(root, { recursive: true, force: true });
  return rec;
}

/** The largest context one request sent, read from the session transcripts under `dir`. */
function peakContext(dir: string): number | undefined {
  if (!existsSync(dir)) return undefined;
  let peak = 0;
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" }))
    if (f.endsWith(".jsonl"))
      for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!l.includes('"usage"')) continue;
        try {
          const u = JSON.parse(l).message?.usage ?? {};
          peak = Math.max(
            peak,
            (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          );
        } catch {}
      }
  return peak || undefined;
}

const only = opt.only ? new Set((opt.only as string).split(",")) : undefined;
const jobs: (() => Promise<RunRecord>)[] = [];
for (const s of scenarios.filter(
  (x) =>
    (!only || only.has(x.name)) &&
    (agent === "claude" || !x.interactive) &&
    (!x.agents || x.agents.includes(agent)),
))
  for (const arm of Object.keys(arms))
    for (let rep = 1; rep <= Number(opt.reps); rep++) jobs.push(() => one(s, arm, rep));

let next = 0;
let done = 0;
await Promise.all(
  Array.from({ length: Number(opt.jobs) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++] as () => Promise<RunRecord>;
      const r = await job();
      done++;
      console.log(
        `[${done}/${jobs.length}] ${r.arm} ${r.scenario} #${r.rep}: ${r.decisions.length} decision(s), ${r.runs.length} run(s)${(r.peakContext ?? 0) > 100_000 ? `, context over 100k: ${r.peakContext}` : ""}${r.error ? `, error: ${r.error}` : ""}`,
      );
    }
  }),
);
if (opt.keep) console.log(`kept ${work}`);
if (existsSync(out)) console.log(`records in ${out}`);
