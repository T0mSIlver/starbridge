/**
 * The agent's user service: a systemd user unit on Linux, a launchd agent on macOS. Also finds
 * the hand-written `starbridge quota push` units that the agent replaces.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { failure, run, type Sys } from "./sys";

export const UNIT = "starbridge-agent.service";
export const LABEL = "run.starbridge.agent";

export type Kind = "systemd" | "launchd";

export function kind(sys: Sys): Kind | undefined {
  return sys.platform === "linux" ? "systemd" : sys.platform === "darwin" ? "launchd" : undefined;
}

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

/** Environment the agent needs to find the same config directory and socket as the CLI. */
function serviceEnv(sys: Sys): Record<string, string> {
  const env: Record<string, string> = { PATH: servicePathVar(sys) };
  for (const k of ["STARBRIDGE_CONFIG_DIR", "XDG_CONFIG_HOME", "STARBRIDGE_AGENT_SOCKET"]) {
    const v = sys.ctx.env[k];
    if (v) env[k] = v;
  }
  return env;
}

/** systemd quotes arguments with spaces in double quotes. */
const sdQuote = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function unitText(sys: Sys): string {
  const env = Object.entries(serviceEnv(sys))
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `# Written by \`starbridge setup\`; \`starbridge uninstall\` removes it.
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
  const log = join(sys.home, "Library/Logs/starbridge-agent.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by \`starbridge setup\`; \`starbridge uninstall\` removes it. -->
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

const systemctl = (sys: Sys, ...args: string[]) =>
  run(sys, "systemctl", ["--user", ...args], { timeoutMs: 30_000 });
const launchctl = (sys: Sys, ...args: string[]) =>
  run(sys, "launchctl", args, { timeoutMs: 30_000 });

/** Why the service cannot be installed here, or undefined when it can. */
export async function unavailable(sys: Sys): Promise<string | undefined> {
  const k = kind(sys);
  if (!k) return `no user service manager on ${sys.platform}`;
  if (k === "systemd") {
    const r = await systemctl(sys, "show-environment");
    if (r === null) return "systemctl is not installed";
    if (r.code !== 0) return `no systemd user manager (${failure(r)})`;
  }
  return undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
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
  mkdirSync(dirname(path), { recursive: true });
  const text = kind(sys) === "systemd" ? unitText(sys) : plistText(sys);
  const changed = readText(path) !== text;
  if (changed) writeFileSync(path, text);
  const running = /^(active|running)$/.test((await serviceState(sys)).state);
  const go = changed || restart || !running;
  if (kind(sys) === "systemd") {
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
  if (kind(sys) === "systemd") {
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

/** A unit someone wrote by hand to run `starbridge quota push`, which the agent replaces. */
export interface LegacyUnit {
  name: string;
  path: string;
  providers: string[];
  interval?: string;
  codexbar?: string;
}

export function legacyUnits(sys: Sys): LegacyUnit[] {
  if (kind(sys) !== "systemd") return [];
  const dir = unitDir(sys);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".service") && f !== UNIT);
  } catch {
    return [];
  }
  return files.flatMap((name) => {
    const path = join(dir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const exec = /^ExecStart=(.*)$/m.exec(text)?.[1];
    if (!exec || !/starbridge(\.js)?\s+quota\s+push/.test(exec)) return [];
    const words = exec.split(/\s+/);
    const flag = (f: string) =>
      words.flatMap((w, i) => (w === f && words[i + 1] ? [words[i + 1] as string] : []));
    const interval = flag("--interval")[0];
    const codexbar = flag("--codexbar")[0];
    return [
      {
        name,
        path,
        providers: flag("--provider"),
        ...(interval ? { interval } : {}),
        ...(codexbar ? { codexbar: codexbar.replace(/^%h/, sys.home) } : {}),
      },
    ];
  });
}

/** Stops, disables and removes a legacy unit. */
export async function removeLegacy(sys: Sys, unit: LegacyUnit): Promise<void> {
  await stopUnit(sys, unit.name);
  rmSync(unit.path, { force: true });
  await systemctl(sys, "daemon-reload");
}
