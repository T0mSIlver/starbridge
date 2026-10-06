import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import type { Ctx } from "../context";
import { inBunfs, killTree, resolveCommand, spawnable, which, whichAll } from "../platform";

export { which };

/** What setup, status and uninstall touch outside the config directory, so tests can fake it. */
export interface Sys {
  ctx: Ctx;
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  uid: number;
  prompt: Prompt;
  /** The command that runs this binary, for the service: absolute paths. */
  self: string[];
}

export interface Prompt {
  /** Yes or no; Enter takes `def`. */
  confirm(question: string, def: boolean): Promise<boolean>;
  /** A line of text; Enter takes `def`. */
  text(question: string, def: string): Promise<string>;
}

/** `--yes`: every question takes its default. */
export const defaults: Prompt = {
  confirm: async (_q, def) => def,
  text: async (_q, def) => def,
};

/** Questions on the terminal. */
export function terminalPrompt(): Prompt {
  const ask = async (q: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    async confirm(question, def) {
      while (true) {
        const a = (await ask(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
        if (a === "") return def;
        if (a === "y" || a === "yes") return true;
        if (a === "n" || a === "no") return false;
      }
    },
    async text(question, def) {
      const a = await ask(`${question}${def ? ` [${def}]` : ""} `);
      return a === "" ? def : a;
    },
  };
}

export function makeSys(ctx: Ctx, prompt: Prompt): Sys {
  return {
    ctx,
    home: ctx.env.HOME || homedir(),
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid?.() ?? 0,
    prompt,
    self: selfCommand(ctx.env),
  };
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * How a service runs this binary. The `starbridge` on the PATH when it is this one, since its
 * path survives updates (brew's versioned cellar path does not); else the running binary, or
 * the runtime and the script for the npm bundle and a checkout.
 */
export function selfCommand(env: Record<string, string | undefined>): string[] {
  const script = process.argv[1];
  // npm links the bundle as `bin/starbridge`, with no extension: any script but Bun's own.
  const scripted = script !== undefined && !inBunfs(script);
  const running = scripted ? [process.execPath, real(script)] : [process.execPath];
  const onPath = which(env, "starbridge");
  if (onPath && real(onPath) === real(running.at(-1) as string)) return [onPath];
  return running;
}

export interface RunOut {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command with the CLI's environment. Null when it is not installed. Never rejects: a
 * timeout kills it and reports code null.
 */
export function run(
  sys: Sys,
  cmd: string,
  args: string[],
  opts: {
    timeoutMs?: number;
    input?: string;
    inherit?: boolean;
    env?: Record<string, string>;
  } = {},
): Promise<RunOut | null> {
  const bin = resolveCommand(sys.ctx.env, cmd);
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let start: ReturnType<typeof spawnable>;
    try {
      start = spawnable(bin, args, sys.ctx.env);
    } catch (e) {
      return resolve({ code: null, stdout: "", stderr: (e as Error).message });
    }
    const child = spawn(start.file, start.args, {
      windowsVerbatimArguments: start.windowsVerbatimArguments,
      env: { ...sys.ctx.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: [
        opts.input === undefined ? "ignore" : "pipe",
        opts.inherit ? "inherit" : "pipe",
        opts.inherit ? "inherit" : "pipe",
      ],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => killTree(child), opts.timeoutMs ?? 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/**
 * Why a command failed, in one line: the first line of its stderr, else the last of its stdout.
 * `claude plugin` prints progress ("Adding marketplace…") on stdout and the reason first on stderr.
 */
export function failure(r: RunOut | null): string {
  if (!r) return "not installed";
  const lines = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  return lines(r.stderr)[0] ?? lines(r.stdout).pop() ?? `exited ${r.code ?? "on a signal"}`;
}

/**
 * When more than one `starbridge` is on the PATH, such as an npm or Homebrew copy and the
 * install script's, the lines that list them with their versions and how to remove each: the
 * other copy goes stale, since `starbridge update` updates only the one it runs from (#621).
 * Empty with one copy.
 */
export async function otherCopies(sys: Sys): Promise<string[]> {
  const all = whichAll(sys.ctx.env, "starbridge");
  if (all.length < 2) return [];
  const self = real(sys.self.at(-1) as string);
  const lines = [`${all.length} copies of starbridge are on the PATH; a terminal runs the first:`];
  for (const path of all) {
    const r = await run(sys, path, ["--version"], { timeoutMs: 10_000 });
    const version = r?.code === 0 ? r.stdout.trim().replace(/^starbridge /, "") : "version unknown";
    const target = real(path);
    const remove = target.includes("/Cellar/")
      ? "`brew uninstall starbridge` removes it"
      : target.includes("/node_modules/")
        ? "`npm rm -g starbridge` removes it"
        : "delete the file to remove it";
    lines.push(`  ${path}: ${version}, ${target === self ? "this one" : remove}`);
  }
  lines.push("Keep one: `starbridge update` updates only the copy it runs from.");
  return lines;
}
