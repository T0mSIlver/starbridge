/**
 * The agent's user service: a systemd user unit on Linux, a launchd agent on macOS, a Scheduled
 * Task at logon on Windows.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { dropPortFile, readPortFile, type Status, socketPath } from "../agent/api";
import { AgentClient } from "../agent/client";
import { processAlive } from "../platform";
import { marker, ours } from "./marker";
import { failure, run, type Sys } from "./sys";

export const UNIT = "starbridge-agent.service";
export const LABEL = "run.starbridge.agent";
export const TASK = "starbridge-agent";

export type Kind = "systemd" | "launchd" | "task";

export function kind(sys: Sys): Kind | undefined {
  return { linux: "systemd", darwin: "launchd", win32: "task" }[sys.platform as string] as
    | Kind
    | undefined;
}

/** `%LOCALAPPDATA%\starbridge`: the task's XML and the agent's log on Windows. */
function localDir(sys: Sys) {
  return join(sys.ctx.env.LOCALAPPDATA || join(sys.home, "AppData", "Local"), "starbridge");
}

export const agentLog = (sys: Sys) =>
  kind(sys) === "task"
    ? join(localDir(sys), "agent.log")
    : join(sys.home, "Library/Logs/starbridge-agent.log");

/**
 * Where the systemd user manager looks. Not `$XDG_CONFIG_HOME`: a shell often exports it
 * where the manager, started before any shell, does not have it.
 */
function unitDir(sys: Sys) {
  return join(sys.home, ".config/systemd/user");
}

export function servicePath(sys: Sys): string | undefined {
  const k = kind(sys);
  if (k === "systemd") return join(unitDir(sys), UNIT);
  if (k === "launchd") return join(sys.home, "Library/LaunchAgents", `${LABEL}.plist`);
  if (k === "task") return join(localDir(sys), `${TASK}.xml`);
  return undefined;
}

/**
 * The PATH the service runs with: setup's own, so CodexBar finds the `claude` and `codex` it
 * shells out to, plus the usual binary folders; never a relative, temporary or node_modules folder.
 */
export function servicePathVar(sys: Sys): string {
  const extra = [
    join(sys.home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const dirs = [...(sys.ctx.env.PATH ?? "").split(delimiter), ...extra].filter(
    (d) => d.startsWith("/") && !d.startsWith("/tmp/") && !d.includes("/node_modules/"),
  );
  return [...new Set(dirs)].join(delimiter);
}

/**
 * Environment the agent needs to find the same config directory and socket as the CLI, and the
 * Codex home whose skill it keeps current.
 */
export const PLACES = [
  "STARBRIDGE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "STARBRIDGE_AGENT_SOCKET",
  "CODEX_HOME",
];

function serviceEnv(sys: Sys): Record<string, string> {
  const env: Record<string, string> = { PATH: servicePathVar(sys) };
  for (const k of PLACES) {
    const v = sys.ctx.env[k];
    if (v) env[k] = v;
  }
  return env;
}

/**
 * `env` with the places an installed unit or plist (`text`) points the agent at, in place of the
 * current shell's: a refresh from another shell must not move the agent to another config folder.
 */
export function withInstalledPlaces(
  env: Record<string, string | undefined>,
  text: string,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of PLACES) {
    delete out[k];
    const unit = new RegExp(`^Environment="?${k}=((?:[^"\\\\\\n]|\\\\.)*)"?$`, "m").exec(text);
    const plist = new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(text);
    const v =
      unit?.[1]?.replace(/\\(.)/g, "$1") ??
      plist?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    if (v) out[k] = v;
  }
  return out;
}

/** systemd quotes arguments with spaces in double quotes. */
const sdQuote = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function unitText(sys: Sys): string {
  const env = Object.entries(serviceEnv(sys))
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `${marker("#")}
[Unit]
Description=Starbridge agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[...sys.self, "agent"].map(sdQuote).join(" ")}
${env}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function plistText(sys: Sys): string {
  const args = [...sys.self, "agent"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(serviceEnv(sys))
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const log = agentLog(sys);
  return `<?xml version="1.0" encoding="UTF-8"?>
${marker("<!--", "-->")}
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** A Windows command-line argument: quoted when it has a space; a path holds no quote. */
const winArg = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/**
 * The Scheduled Task: at this user's logon, as this user without elevation, so setup needs no
 * administrator; no time limit, since the default stops a task after 3 days; started again every
 * 5 minutes when it is not running, since conhost may not pass a crash on as a failure. A console program opens a window, so conhost runs it headless, and the log
 * goes to a file. A task carries no environment of its own: the agent gets the user's.
 */
export function taskXml(sys: Sys): string {
  const env = sys.ctx.env;
  const name = env.USERNAME || userInfo().username;
  const user = env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name;
  const conhost = join(
    env.SystemRoot || env.SYSTEMROOT || "C:\\Windows",
    "System32",
    "conhost.exe",
  );
  const args = ["--headless", ...sys.self, "agent", "--log", agentLog(sys)].map(winArg).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
${marker("<!--", "-->")}
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starbridge agent</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(conhost)}</Command>
      <Arguments>${xml(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Windows PowerShell's ScheduledTasks cmdlets, from System32 rather than the PATH. They name
 * task states in English whatever the system's language, unlike schtasks.
 */
const powershell = (sys: Sys, script: string, env: Record<string, string> = {}) =>
  run(
    sys,
    join(
      sys.ctx.env.SystemRoot || sys.ctx.env.SYSTEMROOT || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs: 60_000, env },
  );

/**
 * Stops the task and the agent it started: stopping the task ends conhost, which may leave the
 * agent running, so the agent's own pid, from its port file, ends too.
 */
async function stopTask(sys: Sys) {
  // The pid as the agent itself reports it, through a call that proves who answers: a stale
  // port file's pid may be anyone's by now.
  let pid: number | undefined;
  const socket = socketPath(sys.ctx.env, sys.ctx.store.dir, sys.platform);
  const token = readPortFile(socket)?.token;
  try {
    pid = (await new AgentClient(socket).call<Status>("GET", "/v1/status", undefined, 5_000)).pid;
  } catch {}
  const r = await powershell(
    sys,
    `Stop-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue`,
  );
  if (pid !== undefined && pid !== process.pid && processAlive(pid))
    try {
      process.kill(pid);
    } catch {}
  // A kill on Windows ends the agent before it can remove its port file (#570).
  if (pid !== undefined && token) dropPortFile(socket, token);
  return r;
}

/** Restarts the agent's task, for `starbridge update` when the new binary's refresh failed. */
export async function restartTask(sys: Sys): Promise<string | undefined> {
  await stopTask(sys);
  const r = await powershell(sys, `Start-ScheduledTask -TaskName ${TASK}`);
  return r?.code === 0 ? undefined : failure(r);
}

const systemctl = (sys: Sys, ...args: string[]) =>
  run(sys, "systemctl", ["--user", ...args], { timeoutMs: 30_000 });
const launchctl = (sys: Sys, ...args: string[]) =>
  run(sys, "launchctl", args, { timeoutMs: 30_000 });

/** Why the service cannot be installed here, or undefined when it can. */
export async function unavailable(sys: Sys): Promise<string | undefined> {
  const k = kind(sys);
  if (!k) return `no user service manager on ${sys.platform}`;
  if (k === "task") {
    const r = await powershell(sys, "Get-Command Register-ScheduledTask | Out-Null");
    if (r === null) return "Windows PowerShell is not installed";
    if (r.code !== 0) return `no Task Scheduler cmdlets (${failure(r)})`;
  }
  if (k === "systemd") {
    const r = await systemctl(sys, "show-environment");
    if (r === null) return "systemctl is not installed";
    if (r.code !== 0) return `no systemd user manager (${failure(r)})`;
  }
  return undefined;
}

function readText(path: string): string | undefined {
  try {
    const bytes = readFileSync(path);
    // The task's XML is UTF-16, with its byte order mark.
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le").slice(1);
    return bytes.toString("utf8");
  } catch {
    return undefined;
  }
}

/** The installed unit, plist or task XML, or undefined when there is none. */
export function installedService(sys: Sys): { path: string; text: string } | undefined {
  const path = servicePath(sys);
  const text = path ? readText(path) : undefined;
  return path && text !== undefined ? { path, text } : undefined;
}

/**
 * Writes the unit or plist and enables it. Restarts the agent when the file changed, when
 * `restart` says its config did, or when it is not running; otherwise leaves it running.
 */
export async function installService(
  sys: Sys,
  restart: boolean,
): Promise<{ path: string; restarted: boolean }> {
  const path = servicePath(sys) as string;
  const before = readText(path);
  if (before !== undefined && !ours(before))
    throw new Error(`${path} was not written by setup: remove it to install the agent`);
  mkdirSync(dirname(path), { recursive: true });
  const k = kind(sys);
  const text = k === "systemd" ? unitText(sys) : k === "launchd" ? plistText(sys) : taskXml(sys);
  const changed = readText(path) !== text;
  // Task Scheduler reads a file in the encoding its XML declaration names.
  if (changed)
    writeFileSync(path, k === "task" ? `\ufeff${text}` : text, k === "task" ? "utf16le" : "utf8");
  const running = /^(active|running)$/i.test((await serviceState(sys)).state);
  const go = changed || restart || !running;
  if (k === "task") {
    const steps = [
      `Register-ScheduledTask -TaskName ${TASK} -Xml (Get-Content -Raw -LiteralPath $env:STARBRIDGE_TASK_XML) -Force | Out-Null`,
      ...(go ? ["stop", `Start-ScheduledTask -TaskName ${TASK}`] : []),
    ];
    for (const step of steps) {
      const r =
        step === "stop"
          ? await stopTask(sys)
          : await powershell(sys, step, { STARBRIDGE_TASK_XML: path });
      if (r?.code !== 0) throw new Error(`${step.split(" ")[0]}: ${failure(r)}`);
    }
  } else if (k === "systemd") {
    const steps = [
      ...(changed ? [["daemon-reload"]] : []),
      ["enable", UNIT],
      ...(go ? [["restart", UNIT]] : []),
    ];
    for (const args of steps) {
      const r = await systemctl(sys, ...args);
      if (r?.code !== 0) throw new Error(`systemctl --user ${args.join(" ")}: ${failure(r)}`);
    }
  } else if (go) {
    await launchctl(sys, "bootout", `gui/${sys.uid}/${LABEL}`);
    const r = await launchctl(sys, "bootstrap", `gui/${sys.uid}`, path);
    if (r?.code !== 0) throw new Error(`launchctl bootstrap: ${failure(r)}`);
  }
  return { path, restarted: go };
}

/**
 * Stops and removes the service. False when none was installed. Throws, and leaves the file,
 * when the manager could not stop it: the agent may still run.
 */
export async function removeService(sys: Sys): Promise<boolean> {
  const path = servicePath(sys);
  if (!path || !existsSync(path)) return false;
  if (!ours(readText(path))) throw new Error(`${path} was not written by setup`);
  if (kind(sys) === "task") {
    await stopTask(sys);
    const r = await powershell(
      sys,
      `Unregister-ScheduledTask -TaskName ${TASK} -Confirm:$false -ErrorAction SilentlyContinue; if (Get-ScheduledTask -TaskName ${TASK} -ErrorAction SilentlyContinue) { exit 1 }`,
    );
    if (r?.code !== 0) throw new Error(`Unregister-ScheduledTask: ${failure(r)}`);
    rmSync(path, { force: true });
  } else if (kind(sys) === "systemd") {
    await stopUnit(sys, UNIT);
    rmSync(path, { force: true });
    await systemctl(sys, "daemon-reload");
  } else {
    const r = await launchctl(sys, "bootout", `gui/${sys.uid}/${LABEL}`);
    // 3 and 113: not loaded, so nothing runs.
    if (r?.code !== 0 && r?.code !== 3 && r?.code !== 113)
      throw new Error(`launchctl bootout: ${failure(r)}`);
    rmSync(path, { force: true });
  }
  return true;
}

async function stopUnit(sys: Sys, unit: string) {
  const r = await systemctl(sys, "disable", "--now", unit);
  if (r?.code !== 0) throw new Error(`systemctl --user disable --now ${unit}: ${failure(r)}`);
}

export interface ServiceState {
  installed: boolean;
  /** "active", "inactive", "failed", "running", "not loaded", … in the manager's words. */
  state: string;
  enabled?: boolean;
}

export async function serviceState(sys: Sys): Promise<ServiceState> {
  const path = servicePath(sys);
  const installed = path !== undefined && existsSync(path);
  if (kind(sys) === "systemd") {
    const active = await systemctl(sys, "is-active", UNIT);
    const enabled = await systemctl(sys, "is-enabled", UNIT);
    return {
      installed,
      state: active?.stdout.trim() || failure(active),
      enabled: enabled?.stdout.trim() === "enabled",
    };
  }
  if (kind(sys) === "task") {
    const r = await powershell(
      sys,
      `(Get-ScheduledTask -TaskName ${TASK} -ErrorAction Stop).State`,
    );
    return { installed, state: r?.code === 0 ? r.stdout.trim() : "not registered" };
  }
  if (kind(sys) === "launchd") {
    const r = await launchctl(sys, "print", `gui/${sys.uid}/${LABEL}`);
    const state =
      r?.code === 0 ? (/^\s*state = (.+)$/m.exec(r.stdout)?.[1] ?? "loaded") : "not loaded";
    return { installed, state };
  }
  return { installed, state: "unsupported" };
}

/**
 * systemd stops user services at logout unless lingering is on. Undefined when that does not
 * apply or cannot be read.
 */
export async function lingering(sys: Sys): Promise<boolean | undefined> {
  if (kind(sys) !== "systemd") return undefined;
  const user = sys.ctx.env.USER ?? sys.ctx.env.LOGNAME;
  if (!user) return undefined;
  const r = await run(sys, "loginctl", ["show-user", user, "-p", "Linger"], { timeoutMs: 10_000 });
  if (r?.code !== 0) return undefined;
  return r.stdout.trim() === "Linger=yes";
}

export async function enableLinger(sys: Sys): Promise<string | undefined> {
  const r = await run(sys, "loginctl", ["enable-linger"], { timeoutMs: 30_000 });
  return r?.code === 0 ? undefined : failure(r);
}
