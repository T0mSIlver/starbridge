/**
 * Starbridge in each coding agent (#750): setup installs it in every agent it finds, without
 * asking, and prints one line per agent; `uninstall --agent <name>` removes it from one, and a
 * later setup or refresh leaves that agent alone until `setup --agent <name>` brings it back.
 *
 * `HARNESSES` holds, for each agent, everything setup, refresh, status and uninstall do there, and
 * every file they write: the commands read it and name no agent themselves.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Ctx } from "../context";
import { permissionsEnabled } from "../permissions";
import { piAgentDir, piChain, piPermissionConfig, removePiEntries } from "../pi";
import { which } from "../platform";
import { piAllowStep, piChainStep } from "../settings";
import { VERSION } from "../version";
import { ALLOW, type AllowList, addAllow, missingAllow, removeAllow } from "./allow";
import {
  CODEX_PLUGIN,
  codexHookTrusted,
  codexPlugin,
  codexPluginDir,
  installCodexPlugin,
  refreshCodexPluginFiles,
  removeCodexPlugin,
} from "./codex-plugin";
import {
  cursorConfigPath,
  cursorHooksPath,
  cursorScriptsDir,
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
  codexHome,
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
  opencodeDir,
  opencodeSnapshot,
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
  claudeDir,
  claudeTooOld,
  enableAutoUpdate,
  foreignMarketplace,
  hasClaude,
  installPlugins,
  marketplaceDir,
  PLUGINS,
  pluginState,
  pluginsStale,
  removePlugins,
  settingsPath,
} from "./plugins";
import {
  desktopReaches,
  installRemotePlugin,
  linkAdvice,
  REMOTE_PLUGIN,
  remotePluginCurrent,
  remotePluginDir,
  remotePluginLink,
  remotePluginLoaded,
  removeRemotePlugin,
} from "./remote-plugin";
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

/**
 * `  Claude Code  installing…`, before an agent whose install runs other programs for seconds,
 * so the pause does not read as a prompt (#773).
 */
export function progressLine(id: AgentId): string | undefined {
  return HARNESSES[id].slow ? `  ${AGENTS[id].padEnd(NAME_WIDTH)}  installing…` : undefined;
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
    return await HARNESSES[id].install(sys);
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

/** What the Codex skill steps and the agent's own refresh need: no prompt. */
type Home = Pick<Sys, "ctx" | "home">;

/**
 * Starbridge in one coding agent: how setup finds it and installs Starbridge there, what refresh
 * brings up to date, what status says, what uninstall removes, and every file all of it writes.
 */
export interface Harness {
  found(sys: Sys): boolean;
  /** Whether Starbridge is in the agent at all; an outdated copy counts, which refresh updates. */
  installed(sys: Sys): Promise<boolean>;
  /** An install that runs other programs for seconds, so setup says it is installing (#773). */
  slow?: boolean;
  /** Installs Starbridge in the agent, or brings it up to date. */
  install(sys: Sys): Promise<Outcome>;
  /**
   * Brings the files setup wrote to this release's version, found or not, and adds none: the
   * agent runs it at start, refresh first. One line per thing done.
   */
  refreshFiles?(sys: Home): string[];
  /** Replaces allow entries of earlier releases that let `settle --all` through (#1761). */
  migrate?(sys: Sys): string[];
  /** What refresh records about the agent, found or not, unless `uninstall --agent` took it out. */
  record?(sys: Sys): void;
  /**
   * Refresh's own step for an agent found and not left out: its lines, after which refresh does
   * not install; undefined to go on.
   */
  update?(sys: Sys): Promise<string[] | undefined>;
  /** Whether a copy that is installed still needs `install` at refresh. */
  stale?(sys: Sys): Promise<boolean>;
  /** Status's lines for the agent, found and not left out. */
  status(sys: Sys): Promise<string[]>;
  /** Status's line when the agent is not here. */
  absent?(sys: Sys): string[];
  /** Removes Starbridge from the agent. One line per thing done. */
  remove(sys: Sys): Promise<string[]>;
  /**
   * Every file and folder setup writes for the agent, its own CLI's included: uninstall must
   * leave none of them as setup left it (cli/test/integrations.test.ts).
   */
  paths(sys: Sys): string[];
}

/** Status's line for an agent installed after setup: nothing installs in the background (#750). */
const notIn = (id: AgentId) =>
  `${AGENTS[id]} found, Starbridge not installed: run \`starbridge setup --refresh\``;

/** A status word for a file setup writes, with what brings an outdated one up to date. */
function fileWord(state: string, foreign: string, them = "it"): string {
  return state === "current"
    ? "installed"
    : state === "outdated"
      ? `outdated (\`starbridge setup --refresh\` updates ${them})`
      : foreign;
}

/** Runs one refresh write: "Updated <what>." or why it could not. */
function step(done: string[], what: string, fn: () => unknown) {
  try {
    fn();
    done.push(`Updated ${what}.`);
  } catch (e) {
    done.push(`Could not update ${what}: ${(e as Error).message}`);
  }
}

/** Whether `list` holds an entry of an earlier release that let `settle --all` through. */
const staleAllow = (list: AllowList, sys: Sys) =>
  missingAllow(list, sys).some((r) => list.stale.includes(r));

/**
 * Whether Claude Code's plugins are ours but not at this release's commit, or Claude desktop
 * reaches this machine and the starbridge-remote plugin is missing or older (#2107).
 */
async function claudeStale(sys: Sys): Promise<boolean> {
  const state = await pluginState(sys);
  return (
    typeof state !== "string" &&
    !state.foreign &&
    PLUGINS.some((p) => state.plugins[p]) &&
    (pluginsStale(sys, state) || (desktopReaches(sys) && !remotePluginCurrent(sys)))
  );
}

const claude: Harness = {
  found: hasClaude,
  async installed(sys) {
    const state = await pluginState(sys);
    return typeof state !== "string" && PLUGINS.every((p) => state.plugins[p]);
  },
  slow: true,
  install: installClaude,
  migrate(sys) {
    // Claude Code's rules go back with the narrow settle rule.
    return staleAllow(ALLOW.claude, sys) && addAllow(ALLOW.claude, sys)
      ? [`Replaced the broad settle allow rule in ${settingsPath(sys)}.`]
      : [];
  },
  // The plugins move to this release's commit (#1768).
  stale: claudeStale,
  async status(sys) {
    // Claude Code's state costs two `claude` runs: read once, and its own error shown as is.
    const state = await pluginState(sys);
    if (typeof state === "string") return [`Claude Code: ${state}`];
    if (!PLUGINS.every((pid) => state.plugins[pid])) return [notIn("claude")];
    const lines = [
      `Claude Code marketplace: ${state.marketplace ? "added" : "not added"}${autoUpdate(sys) ? ", auto-update on" : ""}`,
    ];
    for (const pid of PLUGINS) {
      const x = state.plugins[pid];
      lines.push(
        `  ${pid}: ${x ? `${x.version ?? "installed"}${x.enabled ? "" : ", disabled"}` : "not installed"}`,
      );
    }
    if (desktopReaches(sys) || remotePluginLoaded(sys))
      lines.push(
        `  ${REMOTE_PLUGIN}: ${remotePluginLink(sys) ? linkAdvice(remotePluginLink(sys) as string) : remotePluginCurrent(sys) ? `loaded from ${remotePluginDir(sys)}` : remotePluginLoaded(sys) ? "outdated (`starbridge setup --refresh` rebuilds it)" : "not loaded (`starbridge setup --refresh` adds it)"}`,
      );
    return lines;
  },
  absent: () => ["Claude Code: not on the PATH"],
  async remove(sys) {
    const done = removeRemotePlugin(sys);
    if (!hasClaude(sys)) return done;
    const state = await pluginState(sys);
    if (typeof state !== "string") done.push(...(await removePlugins(sys, state)));
    else done.push(`${state}. Remove the Starbridge plugins with \`claude plugin uninstall\`.`);
    if (removeAllow(ALLOW.claude, sys))
      done.push(`Removed the starbridge allow rules from ${settingsPath(sys)}.`);
    return done;
  },
  paths: (sys) => [
    settingsPath(sys),
    marketplaceDir(sys),
    remotePluginDir(sys),
    join(claudeDir(sys), "plugins"),
  ],
};

const codex: Harness = {
  found: hasCodex,
  installed: async (sys) => codexSkill(sys) !== "missing",
  install: installCodex,
  refreshFiles(sys) {
    const done: string[] = [];
    const skillFile = join(codexSkillDir(sys), "SKILL.md");
    if (codexSkill(sys) === "outdated") step(done, skillFile, () => installCodexSkill(sys));
    if (codexRule(sys) === "outdated") step(done, codexRulePath(sys), () => installCodexRule(sys));
    try {
      if (refreshCodexPluginFiles(sys)) done.push(`Updated ${codexPluginDir(sys)}.`);
    } catch (e) {
      done.push(`Could not update ${codexPluginDir(sys)}: ${(e as Error).message}`);
    }
    return done;
  },
  // Codex installed before setup recorded its binary gets it here, as each update moves it.
  record: (sys) => recordCodex(sys),
  // Codex installed before its plugin (#949), or with an older one, gets it here.
  stale: async (sys) => ["missing", "outdated"].includes(codexPlugin(sys)),
  async status(sys) {
    if (codexSkill(sys) === "missing") return [notIn("codex")];
    const plugin = codexPlugin(sys);
    return [
      `Codex skill: ${fileWord(codexSkill(sys), "another skill named starbridge")}`,
      `Codex plugin: ${plugin === "current" ? "installed" : plugin === "foreign" ? `not managed by starbridge (${codexPluginDir(sys)})` : `${plugin} (\`starbridge setup --refresh\` installs it)`}`,
    ];
  },
  async remove(sys) {
    recordCodex(sys, true);
    const done = [removeCodexSkill(sys)].filter((l) => l !== undefined);
    if (removeCodexRule(sys)) done.push(`Removed ${codexRulePath(sys)}.`);
    done.push(...(await removeCodexPlugin(sys)));
    return done;
  },
  paths: (sys) => [
    codexSkillDir(sys),
    codexRulePath(sys),
    codexPluginDir(sys),
    // Codex's own, where `codex plugin` keeps the plugin it installed and what it turned on.
    join(codexHome(sys), "plugins"),
    join(codexHome(sys), "config.toml"),
  ],
};

const pi: Harness = {
  found: hasPi,
  installed: async (sys) => piPackage(sys) !== undefined,
  slow: true,
  install: installPi,
  // The Pi package is pinned to a release tag, so an installed one at another tag moves (#1417).
  async update(sys) {
    const source = piPackage(sys);
    if (source === undefined || source === PI_PACKAGE) return undefined;
    try {
      await installPiPackage(sys);
      return [`Updated the Pi package to v${VERSION}.`];
    } catch (e) {
      return [`Could not update the Pi package to v${VERSION}: ${(e as Error).message}`];
    }
  },
  async status(sys) {
    const source = piPackage(sys);
    if (source === undefined) return [notIn("pi")];
    return [
      `Pi package: ${source === PI_PACKAGE ? "installed" : `${source} (\`starbridge setup --refresh\` moves it to v${VERSION})`}`,
    ];
  },
  async remove(sys) {
    const done: string[] = [];
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
    return done;
  },
  paths(sys) {
    const dir = piAgentDir({ ...sys.ctx.env, HOME: sys.home });
    // Pi's own settings and checkout, which `pi install` writes; pi-permission-system's config.
    return [
      join(dir, "settings.json"),
      join(dir, "git"),
      piPermissionConfig({ ...sys.ctx.env, HOME: sys.home }),
    ];
  },
};

const opencode: Harness = {
  found: hasOpencode,
  installed: async (sys) => opencodeState(sys) !== "missing",
  install: async (sys) => installOpencodeAgent(sys),
  refreshFiles(sys) {
    const done: string[] = [];
    // Files someone else wrote keep it outdated: only a write that changed something counts.
    if (opencodeState(sys) === "outdated") {
      const before = opencodeSnapshot(sys);
      step(done, `the opencode skill and plugin in ${opencodeDir(sys)}`, () =>
        installOpencode(sys, true),
      );
      if (opencodeSnapshot(sys) === before && done.at(-1)?.startsWith("Updated")) done.pop();
    }
    return done;
  },
  async status(sys) {
    if (opencodeState(sys) === "missing") return [notIn("opencode")];
    return [
      `opencode skill and plugin: ${fileWord(opencodeState(sys), "not managed by starbridge (another skill or plugin named starbridge)", "them")}`,
    ];
  },
  remove: async (sys) => removeOpencode(sys),
  paths: (sys) =>
    ["skills/starbridge", "plugins/starbridge.ts", "starbridge"].map((p) =>
      join(opencodeDir(sys), p),
    ),
};

const cursor: Harness = {
  found: hasCursor,
  installed: async (sys) => cursorState(sys) !== "missing",
  install: async (sys) => installCursor(sys),
  refreshFiles(sys) {
    const done: string[] = [];
    if (cursorState(sys) === "outdated")
      step(done, `the Cursor skill and hooks in ${dirname(dirname(cursorSkillDir(sys)))}`, () => {
        if (!installCursorFiles(sys)) throw new Error(`${cursorHooksPath(sys)} cannot be read`);
      });
    return done;
  },
  migrate(sys) {
    // The others' only lose the old entry.
    return staleAllow(ALLOW.cursor, sys) && removeAllow(ALLOW.cursor, sys, true)
      ? [`Removed the broad settle allow entry from ${cursorConfigPath(sys)}.`]
      : [];
  },
  async status(sys) {
    if (cursorState(sys) === "missing") return [notIn("cursor")];
    return [`Cursor skill: ${fileWord(cursorState(sys), "another skill named starbridge")}`];
  },
  async remove(sys) {
    const done = removeCursorFiles(sys);
    if (removeAllow(ALLOW.cursor, sys))
      done.push(`Removed the starbridge allow rules from ${cursorConfigPath(sys)}.`);
    return done;
  },
  paths: (sys) => [
    cursorSkillDir(sys),
    cursorScriptsDir(sys),
    cursorHooksPath(sys),
    cursorConfigPath(sys),
  ],
};

const antigravity: Harness = {
  found: hasAntigravity,
  installed: async (sys) => antigravityState(sys) !== "missing",
  install: async (sys) => installAntigravityAgent(sys),
  refreshFiles(sys) {
    const done: string[] = [];
    if (antigravityState(sys) === "outdated")
      step(done, antigravityDir(sys), () => installAntigravity(sys));
    // The entries pass more than the commands once no hook of ours narrows them.
    const agy = antigravityState(sys);
    if (
      (agy === "foreign" || (agy !== "missing" && antigravityDisabled(sys))) &&
      removeAllow(ALLOW.antigravity, sys)
    )
      done.push(`Removed the starbridge allow entries from ${agySettingsPath(sys)}.`);
    return done;
  },
  migrate(sys) {
    return staleAllow(ALLOW.antigravity, sys) && removeAllow(ALLOW.antigravity, sys, true)
      ? [`Removed the broad settle allow entry from ${agySettingsPath(sys)}.`]
      : [];
  },
  async status(sys) {
    if (antigravityState(sys) === "missing") return [notIn("antigravity")];
    return [
      `Antigravity plugin: ${fileWord(antigravityState(sys), "another plugin named starbridge")}`,
    ];
  },
  async remove(sys) {
    const done = [removeAntigravity(sys)].filter((l) => l !== undefined);
    if (removeAllow(ALLOW.antigravity, sys))
      done.push(`Removed the starbridge allow entries from ${agySettingsPath(sys)}.`);
    return done;
  },
  paths: (sys) => [antigravityDir(sys), agySettingsPath(sys)],
};

/** Every agent Starbridge goes into, in the order setup, status and uninstall take them. */
export const HARNESSES: Record<AgentId, Harness> = {
  claude,
  codex,
  pi,
  opencode,
  cursor,
  antigravity,
};

export const found = (sys: Sys, id: AgentId) => HARNESSES[id].found(sys);
export const installed = (sys: Sys, id: AgentId) => HARNESSES[id].installed(sys);
/** Removes Starbridge from one agent. Returns one line per thing done. */
export const removeAgent = (sys: Sys, id: AgentId) => HARNESSES[id].remove(sys);

/**
 * Brings every file setup wrote into an agent to this release's version, where setup wrote them
 * (they carry its marker); it adds nothing. Returns what it did.
 */
export function refreshFiles(sys: Home): string[] {
  return AGENT_IDS.flatMap((id) => HARNESSES[id].refreshFiles?.(sys) ?? []);
}

/**
 * Replaces the allow entries of earlier releases that let `settle --all` through (#1761), in
 * settings that already hold them: an update must not leave them, whatever else it skips.
 */
export function migrateAllowEntries(sys: Sys): string[] {
  return AGENT_IDS.flatMap((id) => HARNESSES[id].migrate?.(sys) ?? []);
}
