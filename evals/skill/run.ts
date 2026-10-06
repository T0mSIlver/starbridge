/**
 * Runs real agents through the scripted situations in scenarios.ts, once with the skill and rule
 * of `--before` (a git ref) and once with this checkout's, and records what each posted.
 *
 *   bun evals/skill/run.ts [--agent claude|codex|pi|opencode] [--model claude-sonnet-5-5] [--reps 2] [--jobs 4]
 *                          [--only merge-order,...] [--arms before,after] [--before origin/main]
 *                          [--out evals/skill/results/<agent>]
 *
 * Each run gets its own throwaway world: a home folder, a Claude Code config dir (or CODEX_HOME,
 * or PI_CODING_AGENT_DIR) holding only a copy of the login, the real server app on a random port
 * with the CLI paired to it, a git project with a bare remote, and a `gh` that prints canned
 * output. Nothing is written to the owner's own config. Claude Code loads the plugin with
 * `--plugin-dir`; Codex gets the skill in `$CODEX_HOME/skills` and the SessionStart rule in
 * `$CODEX_HOME/AGENTS.md`, opencode the same in its XDG config folder; Pi loads the Starbridge Pi
 * extension and skill with `-e` and `--skill`.
 *
 * Models: Claude Code defaults to claude-sonnet-5-5, Codex to its own default and Pi to
 * zai/glm-5.3-flash (`provider/id`, with the providers of `~/.pi/agent`).
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LiveServer } from "../../server/test-support/index.ts";
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
    claude: "claude-sonnet-5-5",
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
if (`${tmpdir()}/`.startsWith(`${homedir()}/`)) throw new Error("TMPDIR must be outside your home");
const work = mkdtempSync(join(tmpdir(), "skill-eval-"));
const bun = process.execPath;
const which = (cmd: string) => {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} not on PATH`);
  return r.stdout.trim();
};
const agentBin = which(agent);

// The two versions under test, `plugin` (and `mod`, the Pi extension, for Pi) at `--before` and
// this checkout's.
const parts = agent === "pi" ? ["plugin", "mod"] : ["plugin"];
const arms: Record<string, string> = {};
for (const arm of (opt.arms as string).split(",")) {
  const dir = join(work, "arms", arm);
  mkdirSync(dir, { recursive: true });
  if (arm === "after")
    for (const d of parts) cpSync(join(repo, d), join(dir, d), { recursive: true });
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
  /** Each `AskUserQuestion` call, and whether a hook turned it away (else its dialog showed). */
  askUser?: { denied: boolean }[];
  final: string;
  tokens?: number;
  costUsd?: number;
  exit: number | null;
  seconds: number;
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
  gh: string[];
  answered?: string;
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
  let final = "";
  let session: string | undefined;
  let tokens: number | undefined;
  let costUsd: number | undefined;
  for (const e of events) {
    if (agent === "claude") {
      if (e.type === "assistant")
        for (const b of e.message?.content ?? [])
          if (b.type === "tool_use" && b.name === "Bash") commands.push(b.input?.command ?? "");
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
      if (e.type === "tool_use" && part?.tool === "bash")
        commands.push(part.state?.input?.command ?? "");
      if (e.type === "text") final = part?.text ?? final;
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
  return { commands, final, session, tokens, costUsd, exit, seconds: (Date.now() - t0) / 1000 };
}

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
  const cmd = [
    "env",
    "-i",
    ...Object.entries({ ...env, TERM: "xterm-256color" }).map(([k, v]) => `${k}=${v}`),
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
  let final = "";
  for (const e of es) {
    if (e.type !== "assistant") continue;
    for (const b of e.message?.content ?? []) {
      if (b.type === "tool_use" && b.name === "Bash") commands.push(b.input?.command ?? "");
      if (b.type === "tool_use" && b.name === "AskUserQuestion")
        askUser.push({ denied: results.get(b.id) === true });
      if (b.type === "text" && b.text) final = b.text;
    }
  }
  if (dialog >= 2) askUser.push({ denied: false });
  return { commands, askUser, final, session: id, exit: 0, seconds: (Date.now() - t0) / 1000 };
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

  // The agent's login, copied into its throwaway config; the plugin or skill under test.
  const armDir = arms[arm] as string;
  const plugin = join(armDir, "plugin");
  if (agent === "claude") copyFileSync(join(homedir(), ".claude/.credentials.json"), join(cfg, ".credentials.json"));
  else if (agent === "pi") {
    for (const f of ["models.json", "auth.json"])
      if (existsSync(join(homedir(), ".pi/agent", f)))
        copyFileSync(join(homedir(), ".pi/agent", f), join(cfg, f));
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
    } else copyFileSync(join(homedir(), ".codex/auth.json"), join(cfg, "auth.json"));
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

    type Card = { id: string; question: string; recommended?: string; options: string[] };
    const choiceFor = (c: Card) => c.recommended ?? c.options[0] ?? "Go ahead";
    // In `claude -p`, `codex exec`, `pi -p` and `opencode run` nothing brings an answer back as a
    // prompt: the agent waits within its turn (`starbridge wait`), so the owner answers the first
    // card while it runs.
    let answeredFirst: Record<string, unknown>[] | undefined;
    const answering =
      !s.interactive && s.followUp && !s.unpaired
        ? (async () => {
            while (!answeredFirst) {
              await Bun.sleep(2_000);
              if (answeredFirst) break;
              const now = (await live.opened("decision")) as Record<string, unknown>[];
              const c = now[0] as Card | undefined;
              if (!c) continue;
              await Bun.sleep(15_000);
              if (answeredFirst) break;
              await live.answer(c.id, { choice: choiceFor(c) });
              rec.answered = `Answer to ${c.id} (${c.question}): ${choiceFor(c)}`;
              answeredFirst = now;
            }
          })().catch(() => {}) // the turn ended and the server stopped first
        : undefined;
    const first = s.interactive
      ? await interactiveTurn(proj, env, s.prompt, armDir, cfg)
      : await turn(proj, env, s.prompt, armDir);
    if (answering && !answeredFirst) answeredFirst = [];
    rec.turns.push(first);
    // The model's provider failed (a rate limit): the run says nothing about the agent.
    if (first.final.startsWith("(error) ")) throw new Error(first.final);
    const opened = s.unpaired ? [] : ((await live.opened("decision")) as Record<string, unknown>[]);
    if (answering) {
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
    const card = answering ? undefined : (opened[0] as Card | undefined);
    if (s.followUp && card && first.session) {
      const choice = choiceFor(card);
      rec.answered = `Answer to ${card.id} (${card.question}): ${choice}`;
      rec.turns.push(await turn(proj, env, rec.answered, armDir, first.session));
      const all = (await live.opened("decision")) as Record<string, unknown>[];
      rec.laterDecisions = strip(all.filter((d) => !opened.some((o) => o.id === d.id)));
    }
    if (!s.unpaired) rec.runs = (await live.opened("run")) as Record<string, unknown>[];
    // Images, for render.ts.
    for (const [i, d] of opened.entries())
      for (const [j, img] of ((d.images as { type: string; data: string }[]) ?? []).entries())
        writeFileSync(
          join(out, `${agent}-${id}-d${i}-img${j}.${img.type === "image/png" ? "png" : "jpg"}`),
          Buffer.from(img.data, "base64"),
        );
  } catch (e) {
    rec.error = String(e);
  } finally {
    live.stop();
    rec.gh = readFileSync(ghLog, "utf8").split("\n").filter(Boolean);
  }
  writeFileSync(join(out, `${id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  if (!opt.keep) rmSync(root, { recursive: true, force: true });
  return rec;
}

const only = opt.only ? new Set((opt.only as string).split(",")) : undefined;
const jobs: (() => Promise<RunRecord>)[] = [];
for (const s of scenarios.filter(
  (x) => (!only || only.has(x.name)) && (agent === "claude" || !x.interactive),
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
        `[${done}/${jobs.length}] ${r.arm} ${r.scenario} #${r.rep}: ${r.decisions.length} decision(s), ${r.runs.length} run(s)${r.error ? `, error: ${r.error}` : ""}`,
      );
    }
  }),
);
if (!opt.keep) rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
if (existsSync(out)) console.log(`records in ${out}`);
