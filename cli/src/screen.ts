/**
 * Whether the owner sits at this machine's screen (#848): it is unlocked, and how long since its
 * last keyboard or mouse input, the number the OS keeps for its screensaver. Read here, reduced
 * to one bit by `isPresent`, and only the bit leaves the machine. Undefined where the machine
 * has no screen it can read, such as a headless box: no signal at all.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface Screen {
  locked: boolean;
  idleMs: number;
}

/** Runs a command and resolves to its stdout, or undefined when it fails or takes too long. */
export type Exec = (cmd: string, args: string[]) => Promise<string | undefined>;

const TIMEOUT_MS = 5_000;

export const exec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) =>
      resolve(err ? undefined : String(stdout)),
    );
  });

// --- macOS ------------------------------------------------------------------

/** `HIDIdleTime` of `ioreg -c IOHIDSystem`: nanoseconds since the last input. */
export function macIdleMs(ioreg: string): number | undefined {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg);
  return m ? Number(m[1]) / 1e6 : undefined;
}

/** `ioreg -n Root -d1`: the console session's `CGSSessionScreenIsLocked`, absent when unlocked. */
export function macLocked(ioreg: string): boolean {
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(ioreg);
}

async function readMac(run: Exec): Promise<Screen | undefined> {
  const [hid, root] = await Promise.all([
    run("ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"]),
    run("ioreg", ["-n", "Root", "-d1"]),
  ]);
  const idleMs = hid === undefined ? undefined : macIdleMs(hid);
  if (idleMs === undefined || root === undefined) return undefined;
  return { locked: macLocked(root), idleMs };
}

// --- Linux ------------------------------------------------------------------

/** `loginctl show-session` output as a map of its `Key=value` lines. */
function properties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** The user's active graphical sessions, from `loginctl show-session` of each. */
export function graphical(sessions: string[]): { locked: boolean }[] {
  return sessions
    .map(properties)
    .filter(
      (p) => p.Active === "yes" && (p.Type === "x11" || p.Type === "wayland") && p.Class === "user",
    )
    .map((p) => ({ locked: p.LockedHint === "yes" }));
}

/** GNOME's `GetIdletime` (`(uint64 1234,)`) or `xprintidle` (`1234`), in milliseconds. */
export function linuxIdleMs(text: string): number | undefined {
  const m = /^\(?(?:uint64\s+)?(\d+),?\)?\s*$/.exec(text.trim());
  return m ? Number(m[1]) : undefined;
}

async function readLinux(run: Exec): Promise<Screen | undefined> {
  const list = await run("loginctl", ["list-sessions", "--no-legend", "--no-pager"]);
  const ids = (list ?? "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((id): id is string => !!id);
  const shown = await Promise.all(
    ids.map((id) =>
      run("loginctl", [
        "show-session",
        id,
        "-p",
        "Type",
        "-p",
        "Active",
        "-p",
        "Class",
        "-p",
        "LockedHint",
      ]),
    ),
  );
  const screens = graphical(shown.filter((s): s is string => s !== undefined));
  if (screens.length === 0) return undefined;
  // GNOME's idle monitor, else X11's. logind's IdleHint flips only after the desktop's idle
  // delay, minutes, too late for "in the last minute".
  const idle =
    (await run("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.gnome.Mutter.IdleMonitor",
      "--object-path",
      "/org/gnome/Mutter/IdleMonitor/Core",
      "--method",
      "org.gnome.Mutter.IdleMonitor.GetIdletime",
    ])) ?? (await run("xprintidle", []));
  const idleMs = idle === undefined ? undefined : linuxIdleMs(idle);
  if (idleMs === undefined) return undefined;
  return { locked: screens.every((s) => s.locked), idleMs };
}

// --- Windows ----------------------------------------------------------------

/**
 * One PowerShell kept running, since starting one costs about a second of CPU: each line it
 * reads, it answers with the milliseconds since the last input (`GetLastInputInfo`) and whether
 * the lock screen (`LogonUI`) runs in this session.
 */
const WINDOWS_SCRIPT = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Idle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static long Ms() {
    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return -1;
    return (long)unchecked((uint)Environment.TickCount - i.dwTime);
  }
}
'@
$session = (Get-Process -Id $PID).SessionId
while ($null -ne [Console]::In.ReadLine()) {
  $locked = @(Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }).Count -gt 0
  [Console]::Out.WriteLine("$([Idle]::Ms()) $locked")
}
`;

/** A line the script answers: `<ms> True|False`. */
export function windowsScreen(line: string): Screen | undefined {
  const m = /^(-?\d+) (True|False)$/.exec(line.trim());
  if (!m || Number(m[1]) < 0) return undefined;
  return { idleMs: Number(m[1]), locked: m[2] === "True" };
}

class WindowsReader {
  private child: ChildProcess | undefined;
  private pending: ((line: string | undefined) => void)[] = [];

  read(): Promise<Screen | undefined> {
    const child = this.start();
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(undefined), TIMEOUT_MS);
      const done = (line: string | undefined) => {
        clearTimeout(timer);
        resolve(line === undefined ? undefined : windowsScreen(line));
      };
      this.pending.push(done);
      child.stdin?.write("\n");
    });
  }

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    child.stdin?.write(`${WINDOWS_SCRIPT}\n`);
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) =>
      this.pending.shift()?.(line),
    );
    // A spawn that fails emits only "error", never "exit": either way the next read starts anew.
    const gone = () => {
      if (this.child === child) this.child = undefined;
      for (const p of this.pending.splice(0)) p(undefined);
    };
    child.on("exit", gone);
    child.on("error", gone);
    this.child = child;
    return child;
  }

  stop() {
    this.child?.kill();
    this.child = undefined;
  }
}

/** Reads this machine's screen, or undefined where it has none it can read. */
export function screenReader(
  platform: NodeJS.Platform = process.platform,
  run: Exec = exec,
): { read: () => Promise<Screen | undefined>; stop: () => void } {
  if (platform === "darwin") return { read: () => readMac(run), stop: () => {} };
  if (platform === "linux") return { read: () => readLinux(run), stop: () => {} };
  if (platform === "win32") {
    const reader = new WindowsReader();
    return { read: () => reader.read(), stop: () => reader.stop() };
  }
  return { read: async () => undefined, stop: () => {} };
}
