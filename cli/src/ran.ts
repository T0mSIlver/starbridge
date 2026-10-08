/**
 * When the keyboard allows a call, Claude Code tells the `PermissionRequest` hook racing its
 * dialog nothing (#866): no signal, its pipes stay open, and no hook or mod event fires until
 * the tool ends (probe of Claude Code 2.1.294, terminal and SDK). The one sign is the call itself
 * starting. A Bash call is a shell that Claude Code starts, whose arguments carry the command as
 * `eval '<command>'`, so the hook watches for one that starts after the prompt was posted.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface Proc {
  pid: number;
  ppid: number;
  /** Its arguments, each whole; `ps` gives one string, which stands for all. */
  argv: string[];
}

/** How often the hook looks for the call's process. */
export const RUN_CHECK_MS = 500;

/** Shells that stand between Claude Code and the hook: `sh -c <hook>`, then `sh cli.sh`. */
const SHELLS = new Set(["sh", "dash", "bash", "zsh", "ash", "busybox"]);

/** The command as Claude Code's Bash tool hands it to the shell: `eval '…'`, quotes escaped. */
export function evalForm(command: string): string {
  return `eval '${command.replaceAll("'", `'"'"'`)}'`;
}

/** Whether `p` is the shell running `command`: the eval form, or the command as one argument. */
export function runs(p: Proc, command: string): boolean {
  const quoted = evalForm(command);
  return p.argv.some((a) => a === command || a.includes(quoted));
}

/** Whether `pid` descends from `root`, by the parents in `byPid`. */
function descends(pid: number, root: number, byPid: Map<number, Proc>): boolean {
  const seen = new Set<number>();
  for (let p = byPid.get(pid); p && !seen.has(p.pid); p = byPid.get(p.ppid)) {
    if (p.ppid === root) return true;
    seen.add(p.pid);
  }
  return false;
}

/** Linux: every process from /proc. One that ends mid-read is left out. */
function procLinux(): Proc[] {
  const out: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The name in parentheses may hold spaces and parentheses: the fields follow the last one.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      out.push({ pid, ppid, argv });
    } catch {}
  }
  return out;
}

/** macOS and the BSDs: `ps`, its arguments at full width. */
function procPs(): Promise<Proc[]> {
  return new Promise((resolve) =>
    execFile(
      "ps",
      ["-A", "-ww", "-o", "pid=,ppid=,args="],
      { maxBuffer: 16 * 1024 * 1024, timeout: 5_000 },
      (e, stdout) => {
        if (e) return resolve([]);
        resolve(
          stdout.split("\n").flatMap((line) => {
            const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
            return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), argv: [m[3] as string] }] : [];
          }),
        );
      },
    ),
  );
}

/** The machine's processes; none on Windows, where the hook keeps settling after the call. */
export async function processes(platform = process.platform): Promise<Proc[]> {
  if (platform === "linux") return procLinux();
  if (platform === "win32") return [];
  return procPs();
}

/** Claude Code's pid: the hook's nearest ancestor that is not a shell. */
export function agentPid(procs: Proc[], from = process.ppid): number | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (let pid = from, hops = 0; hops < 4; hops++) {
    const p = byPid.get(pid);
    if (!p) return undefined;
    const exe = (p.argv[0] ?? "").split(/\s/)[0]?.split("/").pop() ?? "";
    if (!SHELLS.has(exe)) return pid;
    pid = p.ppid;
  }
  return undefined;
}

/**
 * `signal`, also aborted once a process running `command` starts under the hook's Claude Code:
 * the keyboard allowed the call. Processes there before the watch count for nothing, so an
 * earlier run of the same command does not settle this prompt.
 */
export function untilRan(
  signal: AbortSignal | undefined,
  command: string,
  list: () => Promise<Proc[]> = processes,
  from = process.ppid,
): { signal: AbortSignal; stop: () => void } {
  const ran = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const watch = async () => {
    const first = await list().catch(() => []);
    const root = agentPid(first, from);
    if (root === undefined) return;
    const before = new Set(first.map((p) => p.pid));
    const tick = async () => {
      if (stopped) return;
      const now = await list().catch(() => []);
      const byPid = new Map(now.map((p) => [p.pid, p]));
      if (now.some((p) => !before.has(p.pid) && runs(p, command) && descends(p.pid, root, byPid)))
        return ran.abort();
      timer = setTimeout(tick, RUN_CHECK_MS);
      timer.unref?.();
    };
    await tick();
  };
  void watch();
  return {
    signal: signal ? AbortSignal.any([signal, ran.signal]) : ran.signal,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
