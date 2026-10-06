/**
 * What differs on Windows (#552): the environment's spelling, how a command is found on the
 * PATH, and how a `.cmd` shim, which npm installs for every global package, is started.
 */
import { accessSync, constants } from "node:fs";
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

/** The first executable `name` on `$PATH`. */
export function which(env: Record<string, string | undefined>, name: string): string | undefined {
  for (const c of candidates(env, name)) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {}
  }
  return undefined;
}

/** `cmd` itself when it is a path, else the executable of that name on the PATH. */
export function resolveCommand(
  env: Record<string, string | undefined>,
  cmd: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return pathFor(platform).isAbsolute(cmd) ? cmd : which(env, cmd);
}

// cmd.exe's special characters, escaped with a caret (from cross-spawn, MIT).
const META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for cmd.exe, through to the program a `.cmd` shim passes `%*` on to. */
function cmdArg(arg: string): string {
  if (/[\r\n\0]/.test(arg))
    throw new Error("an argument with a line break cannot go through cmd.exe");
  // Backslashes before a quote and at the end double, as the C runtime reads them back.
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`.replace(META, "^$1");
  // The shim's `%*` goes through cmd.exe a second time.
  return a.replace(META, "^$1");
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
  const line = [bin.replace(META, "^$1"), ...args.map(cmdArg)].join(" ");
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
