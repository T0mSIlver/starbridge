/**
 * The install walk's `systemctl --user`: keeps whether the agent's unit is enabled in
 * $FAKE_STATE and runs its ExecStart as a detached process, its pid in $FAKE_STATE/agent.pid.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const state = process.env.FAKE_STATE as string;
const unit = join(process.env.HOME as string, ".config/systemd/user/starbridge-agent.service");
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

async function stop() {
  const pid = running();
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(pidFile, { force: true });
}

function start() {
  const text = readFileSync(unit, "utf8");
  const exec = words(/^ExecStart=(.*)$/m.exec(text)?.[1] ?? "");
  const env: Record<string, string> = {};
  // The manager's own environment, which holds XDG_RUNTIME_DIR, then the unit's lines.
  for (const k of ["HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "STARBRIDGE_RELEASES_URL"])
    if (process.env[k]) env[k] = process.env[k] as string;
  for (const m of text.matchAll(/^Environment=(.*)$/gm)) {
    const [kv] = words(m[1] as string);
    const i = (kv ?? "").indexOf("=");
    if (i > 0) env[(kv as string).slice(0, i)] = (kv as string).slice(i + 1);
  }
  const log = openSync(join(state, "agent.log"), "a");
  const child = spawn(exec[0] as string, exec.slice(1), {
    env,
    cwd: env.HOME,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}

const [cmd, ...args] = process.argv.slice(2);
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
    start();
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
    console.error(`walk-systemd: ${cmd} is not faked`);
    process.exit(1);
}
