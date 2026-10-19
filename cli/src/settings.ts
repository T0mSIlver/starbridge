/**
 * The machine's own settings in `agent.json` that `starbridge config` shows and changes:
 * whether permission prompts go to Starbridge, presence, the update check, and what kind of
 * machine it is.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { MachineKind } from "@starbridge/protocol";
import { type Ctx, UsageError } from "./context";
import { permissionsEnabled } from "./permissions";
import {
  allowPiRules,
  chainPiLink,
  PI_LINK,
  piAllow,
  piBashDenies,
  piChain,
  piRulesText,
} from "./pi";
import { installKind } from "./release";
import { type Prompt, which } from "./setup/sys";

/**
 * A guess at what this machine is: `cloud` in a cloud session or codespace, `laptop` with a
 * battery, `server` for Linux with no display, else `desktop`. `config machine-kind` corrects it.
 */
function detectMachineKind(
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

/**
 * Adds to what the state says Starbridge added to pi-permission-system's config. The first
 * record on a machine whose config named the Starbridge link already, set up by a release before
 * the record, also takes the rules that were there as Starbridge's, as uninstall did then.
 */
function recordPiAdded(ctx: Ctx, r: ReturnType<typeof allowPiRules>) {
  ctx.store.updateState((s) => {
    const legacy = s.piAdded === undefined && r.chained;
    const rules = { ...s.piAdded?.rules };
    for (const from of legacy ? [r.added, r.had] : [r.added])
      for (const [surface, patterns] of Object.entries(from.rules ?? {}))
        rules[surface] = [...new Set([...(rules[surface] ?? []), ...patterns])];
    s.piAdded = { rules };
  });
}

export function setPermissions(ctx: Ctx, enabled: boolean) {
  const config = ctx.store.agentConfig();
  ctx.store.saveAgentConfig({ ...config, permissions: { enabled } });
}

/**
 * Turns permission prompts on, for `config permissions on` and setup's question: says what Codex
 * does without presence, and offers to send Pi's and to let the starbridge commands through.
 */
export async function permissionsOn(ctx: Ctx, prompt: Prompt | undefined) {
  // The yes covers Pi too (#2130, card d_sound-jeans-argue): no question of its own. Without a
  // terminal, it says what to add instead.
  const write = prompt !== undefined;
  setPermissions(ctx, true);
  // Codex's dialog opens only once the hook lets go: without presence it waits for the devices.
  if (which(ctx.env, "codex") && !ctx.store.agentConfig().presence?.enabled)
    ctx.out(
      "Codex: its prompts wait up to 10 minutes for your devices before Codex asks in the terminal. `starbridge config presence on` sends them to the terminal while you're at this machine.",
    );
  // The rules first: they read whether the link was there before anything wrote it, which tells
  // an older release's rules from the owner's (recordPiAdded). pi-permission-system is often
  // installed after setup, which then had no rules to add.
  piAllowStep(ctx, write, true);
  piChainStep(ctx, write);
}

/**
 * With permission prompts on, offers to name the Starbridge link in pi-permission-system's
 * `authorizerChain`, which only its owner may do: the link decides nothing until named there.
 * Without a terminal to ask on, it says which line to add instead.
 */
export function piChainStep(ctx: Ctx, write: boolean) {
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
  if (state === "unreadable" || !write) {
    ctx.out(`Pi: to send pi-permission-system's prompts too, ${how}.`);
    return;
  }
  chainPiLink(file);
  ctx.out(
    `Pi: pi-permission-system now asks Starbridge first (${file}); \`starbridge uninstall\` takes out what it added.`,
  );
}

/**
 * With pi-permission-system, offers to let Pi read the Starbridge skill and run the starbridge
 * commands without a prompt, as Claude Code's allow rules and Codex's rule do: rules for the
 * skill, and the Starbridge link, which allows a lone starbridge command (#488). `quiet` skips
 * the line saying they are there already. Without a terminal to ask on, it says what to add
 * instead.
 */
export function piAllowStep(ctx: Ctx, write: boolean, quiet = false) {
  const { state, file, plain } = piAllow(ctx.env);
  if (state === "absent") return;
  const how = `add ${piRulesText(ctx.env)} to "permission" and "${PI_LINK}" to "authorizerChain" in ${file}`;
  for (const s of plain)
    ctx.out(
      `Pi: "permission.${s}" is a plain level, which Starbridge leaves to you; to let its calls through, make it a map that ends with ${piRulesText(ctx.env, [s])}.`,
    );
  const denied = state !== "unreadable" && piBashDenies(ctx.env);
  if (denied)
    ctx.out(
      `Pi: "permission.bash" denies by default in ${file}, so Pi cannot run the starbridge commands; add "starbridge *": "ask" to it, and the Starbridge link lets them through.`,
    );
  if (state === "allowed") {
    if (!quiet && plain.length === 0 && !denied)
      ctx.out(
        `Pi: pi-permission-system lets Pi read the skill and run the starbridge commands (${file}).`,
      );
    return;
  }
  if (state === "unreadable" || !write) {
    ctx.out(`Pi: to read the skill and run the starbridge commands without a prompt, ${how}.`);
    return;
  }
  try {
    recordPiAdded(ctx, allowPiRules(ctx.env));
    ctx.out(
      `Pi: allowed the starbridge commands and named Starbridge in "authorizerChain" in ${file}; \`starbridge uninstall\` takes out what it added.`,
    );
  } catch (e) {
    ctx.out(`Pi: could not write ${file}: ${(e as Error).message}`);
  }
}

const USAGE =
  "usage: starbridge config [permissions on|off] [presence on|off] [update-check on|off] [updates on|off] [machine-kind server|desktop|laptop|cloud]";

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
    if (value === "on") await permissionsOn(ctx, prompt);
    else setPermissions(ctx, false);
  } else if (key === "presence") {
    if (value !== "on" && value !== "off") throw new UsageError(USAGE);
    const config = ctx.store.agentConfig();
    ctx.store.saveAgentConfig({ ...config, presence: { enabled: value === "on" } });
  } else if (key === "update-check") {
    if (value !== "on" && value !== "off") throw new UsageError(USAGE);
    const config = ctx.store.agentConfig();
    ctx.store.saveAgentConfig({ ...config, updateCheck: { enabled: value === "on" } });
  } else if (key === "updates") {
    if (value !== "on" && value !== "off") throw new UsageError(USAGE);
    const config = ctx.store.agentConfig();
    ctx.store.saveAgentConfig({ ...config, updates: { auto: value === "on" } });
  } else if (key === "machine-kind") {
    const kind = MachineKind.safeParse(value);
    if (!kind.success) throw new UsageError(USAGE);
    ctx.store.saveAgentConfig({ ...ctx.store.agentConfig(), machineKind: kind.data });
  } else if (key !== undefined) {
    throw new UsageError(USAGE);
  }
  ctx.out(`permissions   ${permissionsEnabled(ctx) ? "on" : "off"}`);
  ctx.out(`presence      ${ctx.store.agentConfig().presence?.enabled ? "on" : "off"}`);
  ctx.out(`update-check  ${ctx.store.agentConfig().updateCheck?.enabled === false ? "off" : "on"}`);
  ctx.out(`updates       ${updatesSetting(ctx)}`);
  ctx.out(`machine-kind  ${ctx.store.agentConfig().machineKind ?? "not set"}`);
  return 0;
}

/** `config`'s `updates` value (#1266): Homebrew and npm installs update through their manager. */
function updatesSetting(ctx: Ctx): string {
  const install = installKind();
  if (install.kind !== "binary") return `through ${install.kind}`;
  return ctx.store.agentConfig().updates?.auto === false ? "off" : "on";
}
