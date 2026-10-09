/**
 * Starbridge in each coding agent (#750): setup installs it in every agent it finds, without
 * asking, and prints one line per agent; `uninstall --agent <name>` removes it from one, and a
 * later setup or refresh leaves that agent alone until `setup --agent <name>` brings it back.
 */
import type { Ctx } from "../context";
import { permissionsEnabled } from "../permissions";
import { piPermissionConfig, removePiEntries } from "../pi";
import { offerPiAllow, offerPiChain } from "../settings";
import {
  CODEX_PLUGIN,
  codexHookTrusted,
  codexPlugin,
  codexPluginDir,
  installCodexPlugin,
  removeCodexPlugin,
} from "./codex-plugin";
import {
  codexRule,
  codexRulePath,
  codexSkill,
  codexSkillDir,
  hasCodex,
  hasOpencode,
  hasPi,
  installCodexRule,
  installCodexSkill,
  installOpencode,
  installPiPackage,
  opencodeState,
  PI_PACKAGE,
  piPackage,
  removeCodexRule,
  removeCodexSkill,
  removeOpencode,
  removePiPackage,
} from "./harnesses";
import {
  ALLOW_RULES,
  addAllowRules,
  autoUpdate,
  claudeTooOld,
  enableAutoUpdate,
  foreignMarketplace,
  hasClaude,
  installPlugins,
  missingAllowRules,
  PLUGINS,
  pluginState,
  removeAllowRules,
  removePlugins,
  settingsPath,
} from "./plugins";
import { defaults, type Sys } from "./sys";

/** Each agent by the name `--agent` takes, with the name it goes by. */
export const AGENTS = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "opencode",
} as const;
export type AgentId = keyof typeof AGENTS;
export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

export function isAgentId(name: string): name is AgentId {
  return Object.hasOwn(AGENTS, name);
}

const NAME_WIDTH = Math.max(...Object.values(AGENTS).map((n) => n.length));
/** Where an agent's line puts its text, for the lines under it. */
export const UNDER = " ".repeat(2 + NAME_WIDTH + 2);

export type Mark = "✓" | "✗" | "–";

/** `✓ Claude Code  plugins installed`: the mark, the agent's name in a column, then the text. */
export function agentLine(mark: Mark, id: AgentId, text: string): string {
  return `${mark} ${AGENTS[id].padEnd(NAME_WIDTH)}  ${text}`;
}

export function found(sys: Sys, id: AgentId): boolean {
  switch (id) {
    case "claude":
      return hasClaude(sys);
    case "codex":
      return hasCodex(sys);
    case "pi":
      return hasPi(sys);
    case "opencode":
      return hasOpencode(sys);
  }
}

/** The agents `uninstall --agent` removed, which setup and refresh leave alone. */
export function removedAgents(ctx: Ctx): AgentId[] {
  return (ctx.store.agentConfig().removedAgents ?? []).filter(isAgentId);
}

export function setRemoved(ctx: Ctx, id: AgentId, removed: boolean) {
  ctx.store.locked(() => {
    const cfg = ctx.store.agentConfig();
    const rest = (cfg.removedAgents ?? []).filter((x) => x !== id);
    const removedAgents = removed ? [...rest, id] : rest;
    const { removedAgents: _, ...others } = cfg;
    ctx.store.saveAgentConfig(removedAgents.length > 0 ? { ...others, removedAgents } : others);
  });
}

/** Whether Starbridge is in the agent at all; an outdated copy counts, which refresh updates. */
export async function installed(sys: Sys, id: AgentId): Promise<boolean> {
  switch (id) {
    case "claude": {
      const state = await pluginState(sys);
      return typeof state !== "string" && PLUGINS.every((p) => state.plugins[p]);
    }
    case "codex":
      return codexSkill(sys) !== "missing";
    case "pi":
      return piPackage(sys) !== undefined;
    case "opencode":
      return opencodeState(sys) !== "missing";
  }
}

/**
 * `  Claude Code  installing…`, before an agent whose install runs other programs for seconds,
 * so the pause does not read as a prompt (#773).
 */
export function progressLine(id: AgentId): string | undefined {
  return id === "claude" || id === "pi"
    ? `  ${AGENTS[id].padEnd(NAME_WIDTH)}  installing…`
    : undefined;
}

export interface Outcome {
  mark: Mark;
  text: string;
  /** Lines under the agent's, aligned with its text. */
  notes: string[];
  /** What is left for the user to do, which setup prints at its end (#773). */
  next?: string[];
}

/** Installs Starbridge in one agent, or brings it up to date. Never throws. */
export async function installAgent(sys: Sys, id: AgentId): Promise<Outcome> {
  try {
    switch (id) {
      case "claude":
        return await installClaude(sys);
      case "codex":
        return await installCodex(sys);
      case "pi":
        return await installPi(sys);
      case "opencode":
        return installOpencodeAgent(sys);
    }
  } catch (e) {
    return {
      mark: "✗",
      text: oneLine((e as Error).message),
      notes: ["Retry with:", `  starbridge setup --agent ${id}`],
    };
  }
}

function oneLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

async function installClaude(sys: Sys): Promise<Outcome> {
  const state = await pluginState(sys);
  if (typeof state === "string") throw new Error(state);
  const notes: string[] = [];
  const old = await claudeTooOld(sys);
  if (old) notes.push(`${old}.`);
  const foreign = foreignMarketplace(state);
  if (foreign)
    return { mark: "–", text: "skipped", notes: [...notes, `Not installed: ${foreign}.`] };
  if (!state.marketplace || PLUGINS.some((p) => !state.plugins[p]))
    await installPlugins(sys, state);
  if (autoUpdate(sys) === false && !enableAutoUpdate(sys))
    notes.push("Could not turn on the plugins' auto-update.");
  let allowed = missingAllowRules(sys).length === 0;
  if (!allowed) {
    allowed = addAllowRules(sys);
    if (!allowed)
      notes.push(
        `${settingsPath(sys)} is not valid JSON: add ${ALLOW_RULES.join(", ")} to permissions.allow there.`,
      );
  }
  const text = allowed
    ? `plugins installed, ${ALLOW_RULES.length} starbridge commands allowed`
    : "plugins installed";
  return { mark: "✓", text, notes };
}

async function installCodex(sys: Sys): Promise<Outcome> {
  const notes: string[] = [];
  const dir = codexSkillDir(sys);
  const skill = codexSkill(sys);
  if (skill === "foreign") notes.push(`${dir}/SKILL.md is another skill: left alone.`);
  else if (skill !== "current") installCodexSkill(sys);
  const rule = codexRule(sys);
  if (rule === "foreign") notes.push(`${codexRulePath(sys)} is not setup's: left alone.`);
  else if (rule !== "current") installCodexRule(sys);
  const plugin = codexPlugin(sys);
  let hooked = plugin === "current";
  if (plugin === "foreign") notes.push(`${codexPluginDir(sys)} is not setup's: left alone.`);
  else if (!hooked)
    try {
      await installCodexPlugin(sys);
      hooked = true;
    } catch (e) {
      notes.push(`Could not install the plugin ${CODEX_PLUGIN}: ${oneLine((e as Error).message)}`);
    }
  // Codex runs a new hook only once the owner trusts it, which it asks at the next launch.
  const next =
    hooked && !codexHookTrusted(sys)
      ? ["Codex asks once to trust Starbridge's session hook: trust it, so sessions get the rules."]
      : undefined;
  if (skill === "foreign" && rule === "foreign" && !hooked)
    return { mark: "–", text: "skipped", notes };
  return {
    mark: "✓",
    text: hooked ? "skill, sandbox rule and plugin installed" : "skill and sandbox rule installed",
    notes,
    ...(next ? { next } : {}),
  };
}

async function installPi(sys: Sys): Promise<Outcome> {
  if (piPackage(sys) !== PI_PACKAGE) await installPiPackage(sys);
  // pi-permission-system's rules for the skill and the commands, when it is installed.
  const notes: string[] = [];
  const quiet: Ctx = { ...sys.ctx, out: (line) => notes.push(line.replace(/^Pi: /, "")) };
  await offerPiAllow(quiet, defaults, true);
  // With permission prompts on, pi-permission-system asks Starbridge first.
  if (permissionsEnabled(sys.ctx)) await offerPiChain(quiet, defaults);
  return { mark: "✓", text: "package installed", notes };
}

function installOpencodeAgent(sys: Sys): Outcome {
  const kept = opencodeState(sys) === "current" ? [] : installOpencode(sys);
  return {
    mark: "✓",
    text: "skill and plugin installed",
    notes: kept.map((path) => `Kept ${path}: setup did not write it.`),
  };
}

/** Removes Starbridge from one agent. Returns one line per thing done. */
export async function removeAgent(sys: Sys, id: AgentId): Promise<string[]> {
  const done: string[] = [];
  switch (id) {
    case "claude": {
      if (!hasClaude(sys)) break;
      const state = await pluginState(sys);
      if (typeof state !== "string") done.push(...(await removePlugins(sys, state)));
      else done.push(`${state}. Remove the Starbridge plugins with \`claude plugin uninstall\`.`);
      if (removeAllowRules(sys))
        done.push(`Removed the starbridge allow rules from ${settingsPath(sys)}.`);
      break;
    }
    case "codex":
      if (removeCodexSkill(sys)) done.push(`Removed ${codexSkillDir(sys)}.`);
      if (removeCodexRule(sys)) done.push(`Removed ${codexRulePath(sys)}.`);
      done.push(...(await removeCodexPlugin(sys)));
      break;
    case "opencode":
      for (const path of removeOpencode(sys)) done.push(`Removed ${path}.`);
      break;
    case "pi": {
      const source = hasPi(sys) ? piPackage(sys) : undefined;
      if (source)
        try {
          await removePiPackage(sys, source);
          done.push("Removed the Starbridge Pi package.");
        } catch (e) {
          done.push(`Could not remove the Pi package: ${(e as Error).message}`);
        }
      const config = piPermissionConfig(sys.ctx.env);
      try {
        if (removePiEntries(sys.ctx.env)) done.push(`Removed Starbridge's entries from ${config}.`);
      } catch (e) {
        done.push(`Could not remove Starbridge's entries from ${config}: ${(e as Error).message}`);
      }
      break;
    }
  }
  return done;
}
