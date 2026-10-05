/**
 * Runs real agents through the scripted situations in scenarios.ts, once with the skill and rule
 * of `--before` (a git ref) and once with this checkout's, and records what each posted.
 *
 *   bun evals/skill/run.ts [--agent claude|codex] [--model sonnet] [--reps 2] [--jobs 4]
 *                          [--only merge-order,...] [--arms before,after] [--before origin/main]
 *                          [--out evals/skill/results/<agent>]
 *
 * Each run gets its own throwaway world: a home folder, a Claude Code config dir (or CODEX_HOME)
 * holding only a copy of the login, the real server app on a random port with the CLI paired to
 * it, a git project with a bare remote, and a `gh` that prints canned output. Nothing is written
 * to the owner's own config. Claude Code loads the plugin with `--plugin-dir`; Codex gets the
 * skill in `$CODEX_HOME/skills` and the SessionStart rule in `$CODEX_HOME/AGENTS.md`.
 *
 * Writes one JSON record per run to `--out`; grade.ts scores them.
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
import { homedir } from "node:os";
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

const agent = opt.agent as "claude" | "codex";
const model = opt.model ?? (agent === "claude" ? "sonnet" : "gpt-6.1-sol");
const repo = join(import.meta.dir, "..", "..");
const out = opt.out ?? join(import.meta.dir, "results", agent);
mkdirSync(out, { recursive: true });
// On disk rather than /tmp (a Codex home grows to 60 MB), and outside the repo and the
// scratchpad: a path naming Starbridge would hint the agent.
mkdirSync(join(homedir(), ".cache"), { recursive: true });
const work = mkdtempSync(join(homedir(), ".cache", "skill-eval-"));
const bun = process.execPath;
const which = (cmd: string) => {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} not on PATH`);
  return r.stdout.trim();
};
const agentBin = which(agent);

// The two plugins under test: the skill and hook at `--before`, and this checkout's.
const arms: Record<string, string> = {};
for (const arm of (opt.arms as string).split(",")) {
  const dir = join(work, "arms", arm);
  mkdirSync(dir, { recursive: true });
  if (arm === "after") cpSync(join(repo, "plugin"), dir, { recursive: true });
  else {
    const tar = spawnSync("git", ["-C", repo, "archive", opt.before as string, "plugin"], {
      maxBuffer: 1 << 26,
    });
    if (tar.status !== 0) throw new Error(`git archive ${opt.before}: ${tar.stderr}`);
    spawnSync("tar", ["-x", "--strip-components=1", "-C", dir], { input: tar.stdout });
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
  plugin: string,
  resume?: string,
): Promise<Turn & { session?: string }> {
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
      model,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(resume ? ["--resume", resume] : []),
    ];
  } else {
    const common = ["--json", "--skip-git-repo-check", "-m", model];
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
  const plugin = arms[arm] as string;
  if (agent === "claude") copyFileSync(join(homedir(), ".claude/.credentials.json"), join(cfg, ".credentials.json"));
  else {
    copyFileSync(join(homedir(), ".codex/auth.json"), join(cfg, "auth.json"));
    cpSync(join(plugin, "skills/starbridge"), join(cfg, "skills/starbridge"), { recursive: true });
    const hook = spawnSync("sh", [join(plugin, "hooks/session-start.sh")], {
      env: { STARBRIDGE_CONFIG_DIR: sb },
      encoding: "utf8",
    });
    writeFileSync(
      join(cfg, "AGENTS.md"),
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
    ...(agent === "claude" ? { CLAUDE_CONFIG_DIR: cfg } : { CODEX_HOME: cfg }),
  };

  const live = await LiveServer.start();
  const rec: RunRecord = {
    agent,
    model,
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

    const first = await turn(proj, env, s.prompt, plugin);
    rec.turns.push(first);
    const opened = s.unpaired ? [] : ((await live.opened("decision")) as Record<string, unknown>[]);
    rec.decisions = strip(opened);
    const card = opened[0] as { id: string; question: string; recommended?: string; options: string[] } | undefined;
    if (s.followUp && card && first.session) {
      const choice = card.recommended ?? card.options[0] ?? "Go ahead";
      rec.answered = `Answer to ${card.id} (${card.question}): ${choice}`;
      rec.turns.push(await turn(proj, env, rec.answered, plugin, first.session));
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
for (const s of scenarios.filter((x) => !only || only.has(x.name)))
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
