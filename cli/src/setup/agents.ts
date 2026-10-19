/**
 * Starbridge in each coding agent (#750): setup installs it in every agent it finds, without
 * asking, and prints one line per agent; `uninstall --agent <name>` removes it from one, and a
 * later setup or refresh leaves that agent alone until `setup --agent <name>` brings it back.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "../context";
import { permissionsEnabled } from "../permissions";
import { piChain, piPermissionConfig, removePiEntries } from "../pi";
import { which } from "../platform";
import { piAllowStep, piChainStep } from "../settings";
import { ALLOW, type AllowList, addAllow, missingAllow, removeAllow } from "./allow";
import {
  CODEX_PLUGIN,
  codexHookTrusted,
  codexPlugin,
  codexPluginDir,
  installCodexPlugin,
  removeCodexPlugin,
} from "./codex-plugin";
import {
  cursorConfigPath,
  cursorHooksPath,
  cursorSkillDir,
  cursorState,
  hasCursor,
  hooksToAdd,
  installCursorFiles,
  removeCursorFiles,
} from "./cursor";
import {
  agySettingsPath,
  antigravityDir,
  antigravityDisabled,
  antigravityState,
  codexRule,
  codexRulePath,
  codexSkill,
  codexSkillDir,
  hasAgy,
  hasAntigravity,
  hasCodex,
  hasOpencode,
  hasPi,
  installAntigravity,
  installCodexRule,
  installCodexSkill,
  installOpencode,
  installPiPackage,
  opencodeState,
  PI_PACKAGE,
  piPackage,
  removeAntigravity,
  removeCodexRule,
  removeCodexSkill,
  removeOpencode,
  removePiPackage,
} from "./harnesses";
import {
  autoUpdate,
  claudeTooOld,
  enableAutoUpdate,
  foreignMarketplace,
  hasClaude,
  installPlugins,
  PLUGINS,
  pluginState,
  pluginsStale,
  removePlugins,
  settingsPath,
} from "./plugins";
import { desktopReaches, installRemotePlugin, removeRemotePlugin } from "./remote-plugin";
import type { Sys } from "./sys";

/** Each agent by the name `--agent` takes, with the name it goes by. */
export const AGENTS = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "opencode",
  cursor: "Cursor",
  antigravity: "Antigravity",
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
    case "cursor":
      return hasCursor(sys);
    case "antigravity":
      return hasAntigravity(sys);
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
    case "cursor":
      return cursorState(sys) !== "missing";
    case "antigravity":
      return antigravityState(sys) !== "missing";
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
      case "cursor":
        return installCursor(sys);
      case "antigravity":
        return installAntigravityAgent(sys);
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

/**
 * Replaces the allow entries of earlier releases that let `settle --all` through (#1761), in
 * settings that already hold them: an update must not leave them, whatever else it skips.
 */
export function migrateAllowEntries(sys: Sys): string[] {
  const done: string[] = [];
  const stale = (list: AllowList) => missingAllow(list, sys).some((r) => list.stale.includes(r));
  // Claude Code's rules go back with the narrow settle rule; the others' only lose the old entry.
  if (stale(ALLOW.claude) && addAllow(ALLOW.claude, sys))
    done.push(`Replaced the broad settle allow rule in ${settingsPath(sys)}.`);
  if (stale(ALLOW.cursor) && removeAllow(ALLOW.cursor, sys, true))
    done.push(`Removed the broad settle allow entry from ${cursorConfigPath(sys)}.`);
  if (stale(ALLOW.antigravity) && removeAllow(ALLOW.antigravity, sys, true))
    done.push(`Removed the broad settle allow entry from ${agySettingsPath(sys)}.`);
  return done;
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
  if (pluginsStale(sys, state)) await installPlugins(sys, state);
  // Claude desktop's sessions here over SSH may get hookless copies of its computer's plugins.
  if (desktopReaches(sys)) {
    const note = await installRemotePlugin(sys);
    if (note) notes.push(note);
  }
  if (autoUpdate(sys) === false && !enableAutoUpdate(sys))
    notes.push("Could not turn on the plugins' auto-update.");
  let allowed = missingAllow(ALLOW.claude, sys).length === 0;
  if (!allowed) {
    allowed = addAllow(ALLOW.claude, sys);
    if (!allowed)
      notes.push(
        `${settingsPath(sys)} is not valid JSON: add ${ALLOW.claude.rules.join(", ")} to permissions.allow there.`,
      );
  }
  const text = allowed
    ? `plugins installed, ${ALLOW.claude.rules.length} starbridge commands allowed`
    : "plugins installed";
  return { mark: "✓", text, notes };
}

/**
 * Records the `codex` on the PATH and the `CODEX_HOME` setup runs with: the agent hands Codex
 * sessions their answers with these, never with a binary or folder an `ask` names. Forgotten
 * with `forget`, or when the recorded binary is gone; kept when only this PATH lacks it, as the
 * agent's service PATH may when an automatic update refreshes.
 */
export function recordCodex(sys: Sys, forget = false): void {
  const bin = forget ? undefined : which(sys.ctx.env, "codex");
  const { codex: old, ...rest } = sys.ctx.store.agentConfig();
  if (!bin) {
    if (old && (forget || !existsSync(old.bin))) sys.ctx.store.saveAgentConfig(rest);
    return;
  }
  const codex = {
    bin: resolve(bin),
    home: resolve(sys.ctx.env.CODEX_HOME || join(sys.home, ".codex")),
  };
  if (old?.bin !== codex.bin || old?.home !== codex.home)
    sys.ctx.store.saveAgentConfig({ ...rest, codex });
}

async function installCodex(sys: Sys): Promise<Outcome> {
  recordCodex(sys);
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
      ? ["Codex asks once to trust Starbridge's hooks: trust them, so sessions get the rules."]
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
  piAllowStep(quiet, true, true);
  // With permission prompts on, pi-permission-system asks Starbridge first.
  if (permissionsEnabled(sys.ctx)) piChainStep(quiet, true);
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

function installCursor(sys: Sys): Outcome {
  const notes: string[] = [];
  const plugin = cursorState(sys);
  if (plugin === "foreign") notes.push(`${cursorSkillDir(sys)} is another skill: left alone.`);
  else if (plugin !== "current" && !installCursorFiles(sys))
    notes.push(
      `${cursorHooksPath(sys)} is not valid JSON or not Cursor's hooks file: add to its "hooks" ${hooksToAdd(sys)}.`,
    );
  const allowed = missingAllow(ALLOW.cursor, sys).length === 0 || addAllow(ALLOW.cursor, sys);
  if (!allowed)
    notes.push(
      `${cursorConfigPath(sys)} is not valid JSON: add ${ALLOW.cursor.rules.join(", ")} to permissions.allow there.`,
    );
  if (plugin === "foreign" && !allowed) return { mark: "–", text: "skipped", notes };
  const text = [
    ...(plugin === "foreign" ? [] : ["skill installed"]),
    ...(allowed ? [`${ALLOW.cursor.rules.length} starbridge commands allowed`] : []),
  ].join(", ");
  return { mark: "✓", text, notes };
}

/**
 * The plugin, then the allow entries for `agy`, which only the plugin's hook keeps from passing
 * more than the commands themselves: without it, setup takes them out.
 */
function installAntigravityAgent(sys: Sys): Outcome {
  const state = antigravityState(sys);
  if (state === "foreign") {
    removeAllow(ALLOW.antigravity, sys);
    return {
      mark: "–",
      text: "skipped",
      notes: [`${antigravityDir(sys)} is another plugin named starbridge: left alone.`],
    };
  }
  if (state !== "current") installAntigravity(sys);
  const notes: string[] = [];
  if (antigravityDisabled(sys)) {
    removeAllow(ALLOW.antigravity, sys);
    notes.push(
      "The plugin is turned off in Antigravity: `agy plugin enable starbridge`, then `starbridge setup --agent antigravity`.",
    );
    return { mark: "✓", text: "plugin installed, turned off", notes };
  }
  if (!hasAgy(sys)) return { mark: "✓", text: "plugin installed", notes };
  const allowed =
    missingAllow(ALLOW.antigravity, sys).length === 0 || addAllow(ALLOW.antigravity, sys);
  if (!allowed)
    notes.push(
      `${agySettingsPath(sys)} is not valid JSON: add ${ALLOW.antigravity.rules.join(", ")} to permissions.allow there.`,
    );
  const text = allowed
    ? `plugin installed, ${ALLOW.antigravity.rules.length} starbridge commands allowed`
    : "plugin installed";
  return { mark: "✓", text, notes };
}

/** Removes Starbridge from one agent. Returns one line per thing done. */
export async function removeAgent(sys: Sys, id: AgentId): Promise<string[]> {
  const done: string[] = [];
  switch (id) {
    case "claude": {
      done.push(...removeRemotePlugin(sys));
      if (!hasClaude(sys)) break;
      const state = await pluginState(sys);
      if (typeof state !== "string") done.push(...(await removePlugins(sys, state)));
      else done.push(`${state}. Remove the Starbridge plugins with \`claude plugin uninstall\`.`);
      if (removeAllow(ALLOW.claude, sys))
        done.push(`Removed the starbridge allow rules from ${settingsPath(sys)}.`);
      break;
    }
    case "codex":
      recordCodex(sys, true);
      done.push(...[removeCodexSkill(sys)].filter((l) => l !== undefined));
      if (removeCodexRule(sys)) done.push(`Removed ${codexRulePath(sys)}.`);
      done.push(...(await removeCodexPlugin(sys)));
      break;
    case "opencode":
      done.push(...removeOpencode(sys));
      break;
    case "cursor":
      done.push(...removeCursorFiles(sys));
      if (removeAllow(ALLOW.cursor, sys))
        done.push(`Removed the starbridge allow rules from ${cursorConfigPath(sys)}.`);
      break;
    case "antigravity":
      done.push(...[removeAntigravity(sys)].filter((l) => l !== undefined));
      if (removeAllow(ALLOW.antigravity, sys))
        done.push(`Removed the starbridge allow entries from ${agySettingsPath(sys)}.`);
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
        if (removePiEntries(sys.ctx.env, sys.ctx.store.state().piAdded))
          done.push(`Removed Starbridge's entries from ${config}.`);
        // Taken out: an empty record, so a later uninstall removes nothing more. One without a
        // record would take the owner's own rules for Starbridge's (#2130). A config it could not
        // read keeps the record for the next try.
        if (piChain(sys.ctx.env).state !== "unreadable")
          sys.ctx.store.updateState((s) => {
            s.piAdded = {};
          });
      } catch (e) {
        done.push(`Could not remove Starbridge's entries from ${config}: ${(e as Error).message}`);
      }
      break;
    }
  }
  return done;
}
