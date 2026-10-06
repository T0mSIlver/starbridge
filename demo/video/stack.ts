/**
 * The demo video's stack: a demo server on an empty database, its account, and two paired
 * machines, "workstation" and "build server", each with its agent. A phone joins by signing in
 * with the owner token; every join is approved. Runs until killed.
 *
 *   bun demo/video/stack.ts <dir>
 *
 * Env: PORT (8640), FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY (notifications on a real
 * phone or a Play emulator). The machines' homes are <dir>/workstation and <dir>/build-server;
 * scenario.ts runs the CLI in them.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DemoDevice } from "../src/device";

export const ROOT = resolve(import.meta.dir, "../..");
export const MACHINES = { workstation: "workstation", "build-server": "build server" } as const;
export const OWNER_TOKEN = "demo-video";

export function cli(dir: string, home: keyof typeof MACHINES, args: string[], cwd?: string) {
  const machineHome = join(dir, home);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: machineHome,
    XDG_RUNTIME_DIR: join(machineHome, "run"),
    STARBRIDGE_CONFIG_DIR: join(machineHome, "starbridge"),
  };
  // Whatever runs this script may hold the owner's real agent, server and session: none reach here.
  for (const name of [
    "STARBRIDGE_AGENT_SOCKET",
    "STARBRIDGE_SERVER",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_THREAD_ID",
    "PI_SESSION_ID",
    "PI_SESSION_FILE",
    "STARBRIDGE_OPENCODE_SESSION",
  ])
    delete env[name];
  return Bun.spawn(["bun", join(ROOT, "cli/src/main.ts"), ...args], {
    cwd: cwd ?? machineHome,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? "demo-video");
  const port = Number(process.env.PORT ?? 8640);
  const server = `http://127.0.0.1:${port}`;
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  // Starts over only in an earlier stack's directory, never in one that holds anything else.
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, "ready")))
    throw new Error(`${dir} is not empty and holds no earlier stack`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const sbd = Bun.spawn(["bun", join(ROOT, "server/src/main.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(dir, "starbridge.db"),
      PUBLIC_URL: server,
      OWNER_TOKEN,
      DEMO: "1",
      ALLOW_PRIVATE_PUSH_ENDPOINTS: "1",
    },
    stdout: Bun.file(join(dir, "server.log")),
    stderr: Bun.file(join(dir, "server.err")),
  });
  process.on("exit", () => sbd.kill());
  for (
    let i = 0;
    !(await fetch(`${server}/healthz`).then(
      (r) => r.ok,
      () => false,
    ));
    i++
  ) {
    if (i === 60) throw new Error(`${server} is not up`);
    await Bun.sleep(500);
  }

  const device = new DemoDevice(server, OWNER_TOKEN);
  await device.createAccount();
  const codexbar = join(dir, "codexbar");
  writeFileSync(codexbar, `#!/bin/sh\nexec bun ${join(ROOT, "demo/src/codexbar.ts")} "$@"\n`, {
    mode: 0o755,
  });

  for (const [home, name] of Object.entries(MACHINES) as [keyof typeof MACHINES, string][]) {
    mkdirSync(join(dir, home, "run"), { recursive: true });
    const pair = cli(dir, home, ["pair", "--server", server, "--name", name]);
    let out = "";
    let approved = false;
    for await (const chunk of pair.stdout) {
      out += new TextDecoder().decode(chunk);
      const code = /Pairing code: (\S+)/.exec(out)?.[1];
      if (code && !approved) {
        approved = true;
        await device.approvePairing(code);
      }
    }
    if ((await pair.exited) !== 0) throw new Error(`pair ${name} failed:\n${out}`);
    const kind = home === "workstation" ? "desktop" : "server";
    await cli(dir, home, ["config", "machine-kind", kind]).exited;
    const quota =
      home === "workstation"
        ? ["--codexbar", codexbar, "--provider", "claude", "--provider", "codex"]
        : ["--no-quota"];
    const agent = cli(dir, home, ["agent", ...quota, "--interval", "1m"]);
    process.on("exit", () => agent.kill());
  }
  console.log(`demo stack on ${server}, owner token ${OWNER_TOKEN}, account ${device.account}`);
  writeFileSync(join(dir, "ready"), server);
  await device.approveJoins(new AbortController().signal);
}
