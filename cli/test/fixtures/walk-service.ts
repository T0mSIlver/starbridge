/**
 * The install walk's service manager: `systemctl --user` or `launchctl`, as the first argument
 * says. It keeps whether the agent's unit is enabled in $FAKE_STATE and runs the unit's
 * ExecStart, or the plist's ProgramArguments, as a detached process whose pid is in
 * $FAKE_STATE/agent.pid; launchd's job writes to the plist's StandardOutPath, as launchd does.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const state = process.env.FAKE_STATE as string;
const home = process.env.HOME as string;
const pidFile = join(state, "agent.pid");
const enabled = join(state, "enabled");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const running = () => {
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
  return pid > 0 && alive(pid) ? pid : undefined;
};

async function stop() {
  const pid = running();
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(pidFile, { force: true });
}

/** The manager's own environment, which holds XDG_RUNTIME_DIR, under the service's own. */
function managerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "STARBRIDGE_RELEASES_URL",
  ])
    if (process.env[k]) env[k] = process.env[k] as string;
  return env;
}

function start(exec: string[], env: Record<string, string>, log: string) {
  mkdirSync(dirname(log), { recursive: true });
  const out = openSync(log, "a");
  const child = spawn(exec[0] as string, exec.slice(1), {
    env,
    cwd: home,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}

/** One unit line's words, unquoted as systemd reads them: "…" with \ escapes, %% and $$. */
function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const w =
      m[1] !== undefined
        ? m[1].replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" })[c as "n"] ?? c)
        : (m[2] as string);
    out.push(w.replace(/%%/g, "%").replace(/\$\$/g, "$"));
  }
  return out;
}

function startUnit() {
  const text = readFileSync(join(home, ".config/systemd/user/starbridge-agent.service"), "utf8");
  const env = managerEnv();
  for (const m of text.matchAll(/^Environment=(.*)$/gm)) {
    const [kv = ""] = words(m[1] as string);
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  // journald keeps a unit's output, outside HOME.
  start(words(/^ExecStart=(.*)$/m.exec(text)?.[1] ?? ""), env, join(state, "agent.log"));
}

async function systemctl(cmd: string | undefined, args: string[]) {
  switch (cmd) {
    case "show-environment":
    case "daemon-reload":
      break;
    case "enable":
      writeFileSync(enabled, "");
      break;
    case "disable":
      rmSync(enabled, { force: true });
      if (args.includes("--now")) await stop();
      break;
    case "restart":
    case "start":
      await stop();
      startUnit();
      break;
    case "stop":
      await stop();
      break;
    case "is-active":
      console.log(running() ? "active" : "inactive");
      process.exit(running() ? 0 : 3);
      break;
    case "is-enabled":
      console.log(existsSync(enabled) ? "enabled" : "disabled");
      process.exit(existsSync(enabled) ? 0 : 1);
      break;
    default:
      console.error(`walk-service: systemctl ${cmd} is not faked`);
      process.exit(1);
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** A plist's job: its arguments, environment and log, as launchd reads them. */
function job(path: string) {
  const text = readFileSync(path, "utf8");
  const section = (key: string) =>
    new RegExp(`<key>${key}</key>\\s*<(array|dict)>([\\s\\S]*?)</\\1>`).exec(text)?.[2] ?? "";
  const strings = (s: string) =>
    [...s.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1] as string));
  const env = managerEnv();
  for (const m of section("EnvironmentVariables").matchAll(
    /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g,
  ))
    env[unxml(m[1] as string)] = unxml(m[2] as string);
  const log = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  return {
    exec: strings(section("ProgramArguments")),
    env,
    log: log ? unxml(log) : join(state, "agent.log"),
  };
}

async function launchctl(cmd: string | undefined, args: string[]) {
  switch (cmd) {
    case "enable":
      writeFileSync(enabled, "");
      break;
    case "bootstrap": {
      const { exec, env, log } = job(args[1] as string);
      await stop();
      start(exec, env, log);
      break;
    }
    case "bootout":
      if (!running()) {
        console.error("Boot-out failed: 3: No such process");
        process.exit(3);
      }
      await stop();
      break;
    case "print":
      if (!running()) {
        console.error(`Could not find service "${args[0]}"`);
        process.exit(113);
      }
      console.log("\tstate = running");
      break;
    default:
      console.error(`walk-service: launchctl ${cmd} is not faked`);
      process.exit(1);
  }
}

const [manager, cmd, ...args] = process.argv.slice(2);
if (manager === "launchctl") await launchctl(cmd, args);
else await systemctl(cmd, args);
