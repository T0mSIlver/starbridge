import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { CLI_PATH } from "../config";
import { pathFor } from "../platform";
import type { Sys } from "./sys";

/**
 * Records where this CLI is, in the config folder, for the hooks and plugins that start it
 * from an agent whose PATH may lack it: Claude Code opened from the Dock has no
 * `~/.local/bin` on macOS (#612). An npm bundle starts through `#!/usr/bin/env node`, which
 * needs the PATH anyway: it records nothing, and the hooks use the PATH.
 */
export function recordSelf(sys: Sys): void {
  const file = join(sys.ctx.store.dir, CLI_PATH);
  if (sys.self.length !== 1 || script(sys.self[0] as string)) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Forward slashes, which Git Bash's sh and Node both take on Windows.
  const self = sys.self[0] as string;
  writeFileSync(file, `${sys.platform === "win32" ? self.replace(/\\/g, "/") : self}\n`);
}

/** Whether `path` is a script (npm's bundle, a checkout's entry), not a compiled binary. */
function script(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    const head = Buffer.alloc(2);
    readSync(fd, head, 0, 2, 0);
    closeSync(fd);
    return head.toString() === "#!";
  } catch {
    return false;
  }
}

/** The folder of the installed binary when the PATH does not hold it. */
function missingDir(sys: Sys): string | undefined {
  if (sys.self.length !== 1) return undefined;
  const { dirname } = pathFor(sys.platform);
  const dir = dirname(sys.self[0] as string);
  // Windows paths ignore case.
  const norm = (p: string) => {
    const bare = p.replace(/[/\\]+$/, "");
    return sys.platform === "win32" ? bare.toLowerCase() : bare;
  };
  // The PATH is this process's, in its host's spelling.
  const path = (sys.ctx.env.PATH ?? "").split(delimiter).map(norm);
  return path.includes(norm(dir)) ? undefined : dir;
}

/** The startup file of the owner's shell, and the line there that puts `dir` on the PATH. */
export function shellProfile(sys: Sys, dir: string): { file: string; line: string } {
  const { basename, join } = pathFor(sys.platform);
  const shell = basename(sys.ctx.env.SHELL ?? "");
  const shown = dir.startsWith(`${sys.home}/`) ? `$HOME${dir.slice(sys.home.length)}` : dir;
  const exported = `export PATH="${shown}:$PATH"`;
  if (shell === "fish")
    return { file: join(sys.home, ".config", "fish", "config.fish"), line: `fish_add_path ${dir}` };
  if (shell === "zsh")
    return { file: join(sys.ctx.env.ZDOTDIR || sys.home, ".zshrc"), line: exported };
  if (shell === "bash") {
    if (sys.platform !== "darwin") return { file: join(sys.home, ".bashrc"), line: exported };
    // Terminal on macOS starts login shells, which read the first of these that exists; creating
    // .bash_profile would hide a .profile that other tools write to.
    const login = [".bash_profile", ".bash_login"].map((f) => join(sys.home, f)).find(existsSync);
    return { file: login ?? join(sys.home, ".profile"), line: exported };
  }
  return { file: join(sys.home, ".profile"), line: exported };
}

/**
 * When the binary's folder is not on the PATH, offers to add it to the shell's startup file.
 * Returns the lines setup ends with, after everything else, so they stay on screen: what to run
 * in this terminal, or what to add by hand.
 */
export async function pathStep(sys: Sys): Promise<string[]> {
  const dir = missingDir(sys);
  if (!dir) return [];
  const { ctx, prompt } = sys;
  ctx.out("");
  ctx.out("PATH");
  if (sys.platform === "win32") {
    ctx.out(`${dir} is not on this terminal's PATH.`);
    return [
      `One more step: add ${dir} to your PATH (Settings → System → About → Advanced system settings → Environment Variables), then open a new terminal.`,
    ];
  }
  const { file, line } = shellProfile(sys, dir);
  const { dirname } = pathFor(sys.platform);
  const shown = file.startsWith(`${sys.home}/`) ? `~${file.slice(sys.home.length)}` : file;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const rest = dir.startsWith(`${sys.home}/`) ? dir.slice(sys.home.length) : undefined;
  const has = [dir, line, ...(rest ? [`$HOME${rest}`, `\${HOME}${rest}`, `~${rest}`] : [])].some(
    (spelled) => text.includes(spelled),
  );
  if (!has && (await prompt.confirm(`Add ${dir} to your PATH in ${shown}?`, true))) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${text === "" || text.endsWith("\n") ? "" : "\n"}\n# Added by starbridge setup\n${line}\n`,
    );
    ctx.out(`Added \`${line}\` to ${shown}.`);
  } else if (!has) {
    return [
      `One more step: \`starbridge\` is not on your PATH. Add this line to ${shown}:`,
      `  ${line}`,
    ];
  }
  return [
    "One more step: `starbridge` is not on this terminal's PATH yet. Open a new terminal, or run:",
    `  ${line.startsWith("fish_add_path") ? line : `export PATH="${dir}:$PATH"`}`,
  ];
}
