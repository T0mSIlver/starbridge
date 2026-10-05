/**
 * The machine's own settings in `agent.json` that `starbridge config` shows and changes:
 * whether permission prompts go to Starbridge, and what kind of machine it is.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { MachineKind } from "@starbridge/protocol";
import { type Ctx, UsageError } from "./context";
import { permissionsEnabled } from "./permissions";

/**
 * A guess at what this machine is: `cloud` in a cloud session or codespace, `laptop` with a
 * battery, `server` for Linux with no display, else `desktop`. `config machine-kind` corrects it.
 */
export function detectMachineKind(
  env: Ctx["env"],
  platform: NodeJS.Platform = process.platform,
): MachineKind {
  if (env.CLAUDE_CODE_REMOTE === "true" || env.CODESPACES === "true" || env.GITPOD_WORKSPACE_ID)
    return "cloud";
  if (hasBattery(platform)) return "laptop";
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return "server";
  return "desktop";
}

function hasBattery(platform: NodeJS.Platform): boolean {
  try {
    if (platform === "linux") {
      const dir = "/sys/class/power_supply";
      return existsSync(dir) && readdirSync(dir).some((n) => n.startsWith("BAT"));
    }
    if (platform === "darwin")
      return spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" }).stdout.includes(
        "InternalBattery",
      );
  } catch {}
  return false;
}

/** Records the detected kind unless one is set already. */
export function rememberMachineKind(ctx: Ctx): MachineKind {
  const config = ctx.store.agentConfig();
  if (config.machineKind) return config.machineKind;
  const kind = detectMachineKind(ctx.env);
  ctx.store.saveAgentConfig({ ...config, machineKind: kind });
  return kind;
}

export function setPermissions(ctx: Ctx, enabled: boolean) {
  const config = ctx.store.agentConfig();
  ctx.store.saveAgentConfig({ ...config, permissions: { enabled } });
}

const USAGE =
  "usage: starbridge config [permissions on|off] [machine-kind server|desktop|laptop|cloud]";

/** `starbridge config [<key> <value>]`: sets one setting, then prints them all. */
export function configCommand(ctx: Ctx, args: string[]): number {
  const [key, value, ...extra] = args;
  if (extra.length > 0 || (key !== undefined && value === undefined)) throw new UsageError(USAGE);
  if (key === "permissions") {
    if (value !== "on" && value !== "off") throw new UsageError(USAGE);
    setPermissions(ctx, value === "on");
  } else if (key === "machine-kind") {
    const kind = MachineKind.safeParse(value);
    if (!kind.success) throw new UsageError(USAGE);
    ctx.store.saveAgentConfig({ ...ctx.store.agentConfig(), machineKind: kind.data });
  } else if (key !== undefined) {
    throw new UsageError(USAGE);
  }
  ctx.out(`permissions   ${permissionsEnabled(ctx) ? "on" : "off"}`);
  ctx.out(`machine-kind  ${ctx.store.agentConfig().machineKind ?? "not set"}`);
  return 0;
}
