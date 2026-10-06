/**
 * The machine's own settings in `agent.json` that `starbridge config` shows and changes:
 * whether permission prompts go to Starbridge, and what kind of machine it is.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { MachineKind } from "@starbridge/protocol";
import { type Ctx, UsageError } from "./context";
import { permissionsEnabled } from "./permissions";
import { allowPiRules, chainPiLink, PI_LINK, piAllow, piChain, piRulesText } from "./pi";
import { type Prompt, which } from "./setup/sys";

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

/**
 * With permission prompts on, offers to name the Starbridge link in pi-permission-system's
 * `authorizerChain`, which only its owner may do: the link decides nothing until named there.
 * Without a terminal to ask on, it says which line to add instead.
 */
export async function offerPiChain(ctx: Ctx, prompt: Prompt | undefined) {
  const { state, file } = piChain(ctx.env);
  if (state === "chained") return;
  if (state === "absent") {
    if (which(ctx.env, "pi"))
      ctx.out(
        "Pi: its permission prompts reach your devices through pi-permission-system (`pi install npm:@gotgenes/pi-permission-system`), then `starbridge config permissions on`.",
      );
    return;
  }
  const how = `add "${PI_LINK}" to "authorizerChain" in ${file}`;
  if (state === "unreadable" || !prompt) {
    ctx.out(`Pi: to send pi-permission-system's prompts too, ${how}.`);
    return;
  }
  if (
    await prompt.confirm(
      `Also send Pi's permission prompts (pi-permission-system)? This adds "${PI_LINK}" to "authorizerChain" in ${file}.`,
      true,
    )
  ) {
    chainPiLink(file);
    ctx.out(`Pi: pi-permission-system now asks Starbridge first (${file}).`);
  } else ctx.out(`Pi: its prompts stay in Pi; to send them later, ${how}.`);
}

/**
 * With pi-permission-system, offers to let Pi read the Starbridge skill and run the starbridge
 * commands without a prompt, as Claude Code's allow rules and Codex's rule do. `quiet` skips the
 * line saying they are there already. Without a terminal to ask on, it says what to add instead.
 */
export async function offerPiAllow(ctx: Ctx, prompt: Prompt | undefined, quiet = false) {
  const { state, file, plain } = piAllow(ctx.env);
  if (state === "absent") return;
  const how = `add ${piRulesText(ctx.env)} to "permission" in ${file}`;
  for (const s of plain)
    ctx.out(
      `Pi: "permission.${s}" is a plain level, which Starbridge leaves to you; to let its calls through, make it a map that ends with ${piRulesText(ctx.env, [s])}.`,
    );
  if (state === "allowed") {
    if (!quiet && plain.length === 0)
      ctx.out(
        `Pi: pi-permission-system lets Pi read the skill and run the starbridge commands (${file}).`,
      );
    return;
  }
  if (state === "unreadable" || !prompt) {
    ctx.out(`Pi: to read the skill and run the starbridge commands without a prompt, ${how}.`);
    return;
  }
  if (
    await prompt.confirm(
      `Let Pi read the Starbridge skill and run \`starbridge ask\`, \`waiting\`, \`working\`, \`wait\` and \`settle\` without a pi-permission-system prompt? This adds them to "permission" in ${file}.`,
      true,
    )
  ) {
    try {
      allowPiRules(ctx.env);
      ctx.out(`Pi: allowed them in ${file}.`);
    } catch (e) {
      ctx.out(`Pi: could not write ${file}: ${(e as Error).message}`);
    }
  } else
    ctx.out(
      `Pi: pi-permission-system will ask before each \`starbridge ask\`; to allow them later, ${how}.`,
    );
}

const USAGE =
  "usage: starbridge config [permissions on|off] [machine-kind server|desktop|laptop|cloud]";

/**
 * `starbridge config [<key> <value>]`: sets one setting, then prints them all. Turning permission
 * prompts on also offers to send Pi's and to let the starbridge commands through, asking on
 * `prompt` when there is a terminal.
 */
export async function configCommand(ctx: Ctx, args: string[], prompt?: Prompt): Promise<number> {
  const [key, value, ...extra] = args;
  if (extra.length > 0 || (key !== undefined && value === undefined)) throw new UsageError(USAGE);
  if (key === "permissions") {
    if (value !== "on" && value !== "off") throw new UsageError(USAGE);
    setPermissions(ctx, value === "on");
    if (value === "on") {
      await offerPiChain(ctx, prompt);
      // pi-permission-system is often installed after setup, which then had no rules to add.
      await offerPiAllow(ctx, prompt, true);
    }
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
