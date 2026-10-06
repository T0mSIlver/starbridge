/**
 * What differs on Windows (#552): the environment's spelling, how a command is found on the
 * PATH, and how a `.cmd` shim, which npm installs for every global package, is started.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/**
 * The process environment as the CLI reads it. Windows spells the search path `Path` and leaves
 * `HOME` unset, and a copy of `process.env` loses its case-insensitive lookup: the copy holds
 * `PATH` and `HOME` under those names, so every reader and every copy agree.
 */
export function normalEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): Record<string, string | undefined> {
  if (platform !== "win32") return env;
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    out[upper === "PATH" || upper === "HOME" ? upper : k] = v;
  }
  out.HOME ||= out.USERPROFILE || home;
  return out;
}

/**
 * The files `which` tries for `name`, in order. On Windows, only names with a PATHEXT extension
 * run, so an npm package's extensionless shell shim beside its `.cmd` is never picked.
 */
export function candidates(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const p = pathFor(platform);
  const sep = platform === "win32" ? ";" : ":";
  const exts =
    platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const hasExt = exts.some((e) => e && name.toLowerCase().endsWith(e.toLowerCase()));
  const names =
    hasExt || platform !== "win32" ? [name] : exts.map((e) => `${name}${e.toLowerCase()}`);
  const dirs = (env.PATH ?? "")
    .split(sep)
    .map((d) => d.replace(/^"(.*)"$/, "$1"))
    .filter((d) => p.isAbsolute(d));
  return dirs.flatMap((d) => names.map((n) => p.join(d, n)));
}

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The first executable `name` on `$PATH`. */
export function which(env: Record<string, string | undefined>, name: string): string | undefined {
  return candidates(env, name).find(executable);
}

/** Every executable `name` on `$PATH`, in order, each file once however many links reach it. */
export function whichAll(env: Record<string, string | undefined>, name: string): string[] {
  const seen = new Set<string>();
  return candidates(env, name).filter((c) => {
    if (!executable(c)) return false;
    const target = realpathSync(c);
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  });
}

/**
 * `cmd` itself when it is a path, relative ones included, else the executable of that name on
 * the PATH.
 */
export function resolveCommand(
  env: Record<string, string | undefined>,
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const isPath = platform === "win32" ? /[\\/]/.test(cmd) : cmd.includes("/");
  return isPath ? cmd : which(env, cmd);
}

// cmd.exe's special characters, escaped with a caret (from cross-spawn, MIT).
const META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for cmd.exe. A script that passes `%*` on, as npm's shims do, has cmd.exe read
 * the arguments a second time, so they are escaped twice.
 */
function cmdArg(arg: string, twice: boolean): string {
  if (/[\r\n\0]/.test(arg))
    throw new Error("an argument with a line break cannot go through cmd.exe");
  // Backslashes before a quote and at the end double, as the C runtime reads them back.
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`.replace(META, "^$1");
  return twice ? a.replace(META, "^$1") : a;
}

/**
 * How to start `bin` with `args`. Windows starts a `.cmd` or `.bat` file only through cmd.exe,
 * with every argument escaped for it, so no argument runs as a command.
 */
export function spawnable(
  bin: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args };
  let twice = true;
  try {
    twice = readFileSync(bin, "utf8").includes("%*");
  } catch {}
  const line = [bin.replace(META, "^$1"), ...args.map((a) => cmdArg(a, twice))].join(" ");
  return {
    file: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Whether a script path is inside a binary `bun build --compile` made: `/$bunfs/` on Unix,
 * `B:\~BUN\` on Windows.
 */
export function inBunfs(path: string | undefined): boolean {
  return (
    path !== undefined && (path.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(path))
  );
}

/**
 * Stops a child and what it started. On Windows a `.cmd` runs as cmd.exe, which `kill` ends
 * alone, leaving the program it started holding the pipes; taskkill ends the whole tree.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (process.platform !== "win32" || child.pid === undefined) return void child.kill(signal);
  spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  }).on("error", () => child.kill(signal));
}

/** Whether process `pid` runs; one of another user's counts. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
