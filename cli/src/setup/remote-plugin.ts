/**
 * The starbridge-remote plugin (#2107). Claude desktop starts a session on another machine over
 * SSH with `--plugin-dir` copies of the plugins installed on the computer it runs on, synced
 * without `hooks/`, and a `--plugin-dir` plugin replaces the installed one of its name, its hooks
 * module included. So where both computers have Starbridge, that session would run none of its
 * hooks and no mod. On a machine Claude desktop reaches, setup builds this plugin from the two
 * installed ones, under a name no copy takes, and loads it through `CLAUDE_CODE_PLUGIN_DIRS` in
 * the user settings; its hooks and mod act only where a hookless copy replaced the installed
 * plugin (`plugin/hooks/remote.sh`, `mod/hooks/register.ts`).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { VERSION } from "../version";
import {
  claudeDir,
  type Home,
  type PluginState,
  pluginState,
  readSettings,
  writeSettings,
} from "./plugins";
import { removedLine, removeWritten } from "./remove";
import type { Sys } from "./sys";

export const REMOTE_PLUGIN = "starbridge-remote";
/** The plugin's files setup wrote, relative to its folder: what a refresh or uninstall removes. */
const INVENTORY = join(".claude-plugin", "written.json");
const DIRS_VAR = "CLAUDE_CODE_PLUGIN_DIRS";
/** Every command of the starbridge plugin's hooks starts so; the remote plugin's go through remote.sh. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it in the hook's command.
const HOOK_PREFIX = 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/';

export function remotePluginDir(sys: Home): string {
  return resolve(claudeDir(sys), REMOTE_PLUGIN);
}

/**
 * Whether Claude desktop has run sessions on this machine over SSH: it keeps its server, runs and
 * plugin copies under `remote/` in Claude Code's folder.
 */
export function desktopReaches(sys: Home): boolean {
  return existsSync(join(claudeDir(sys), "remote"));
}

interface HooksFile {
  hooks?: Record<string, { matcher?: string; hooks: { command?: string }[] }[]>;
  modules?: string[];
}

/**
 * The remote plugin's `hooks/hooks.json`: the starbridge plugin's hooks, each run through
 * `remote.sh starbridge`, and the mod's module, which reads the plugin's name.
 */
export function remoteHooks(starbridge: HooksFile): HooksFile {
  const hooks: NonNullable<HooksFile["hooks"]> = {};
  for (const [event, groups] of Object.entries(starbridge.hooks ?? {}))
    hooks[event] = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => {
        if (!h.command?.startsWith(HOOK_PREFIX))
          throw new Error(`a starbridge hook does not start with ${HOOK_PREFIX}: ${h.command}`);
        return {
          ...h,
          command: `${HOOK_PREFIX}remote.sh" starbridge "\${CLAUDE_PLUGIN_ROOT}/hooks/${h.command.slice(HOOK_PREFIX.length)}`,
        };
      }),
    }));
  return { hooks, modules: ["./register.ts"] };
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/**
 * What a plugin built without the inventory holds: the files the build before it wrote (#2115),
 * the hooks of the two plugins at the time included.
 */
const BEFORE_INVENTORY = [
  join(".claude-plugin", "plugin.json"),
  ...[
    ...["hooks.json", "cli.sh", "prompt.sh", "remote.sh", "rule.md", "session-start.sh"],
    ...["settle.sh", "agent.ts", "handover.ts", "node.ts", "own.ts", "poller.ts", "register.ts"],
    ...["sent.ts", "state.d.ts", "subagent.ts", "switch.ts"],
  ].map((f) => join("hooks", f)),
];

/** What setup wrote into `dir` last time; a plugin built before the inventory has `BEFORE_INVENTORY`. */
function written(dir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(join(dir, INVENTORY), "utf8")) as unknown;
    if (Array.isArray(v) && v.every((f) => typeof f === "string")) return [...v, INVENTORY];
  } catch {}
  return [...BEFORE_INVENTORY, INVENTORY];
}

/**
 * Builds the plugin from the installed plugins' folders, replacing the one there: their `hooks/`
 * files in one folder, which neither shares a name in but `hooks.json`. Throws when either lacks
 * what it needs, as a plugin older than #2107 does.
 */
export function writeRemotePlugin(sys: Home, roots: { starbridge: string; mod: string }) {
  const dir = remotePluginDir(sys);
  const parts = [join(roots.starbridge, "hooks"), join(roots.mod, "hooks")];
  for (const need of [
    join(parts[0] as string, "remote.sh"),
    join(parts[1] as string, "register.ts"),
  ])
    if (!existsSync(need)) throw new Error(`${need} is missing`);
  const starbridge = JSON.parse(
    readFileSync(join(parts[0] as string, "hooks.json"), "utf8"),
  ) as HooksFile;
  const next = `${dir}.new`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(join(next, ".claude-plugin"), { recursive: true });
  const seen = new Set<string>();
  for (const from of parts)
    for (const name of readdirSync(from)) {
      if (name === "hooks.json") continue;
      if (seen.has(name)) throw new Error(`both plugins have hooks/${name}`);
      seen.add(name);
      cpSync(join(from, name), join(next, "hooks", name), { recursive: true });
    }
  writeFileSync(
    join(next, "hooks", "hooks.json"),
    `${JSON.stringify(remoteHooks(starbridge), null, 2)}\n`,
  );
  writeFileSync(
    join(next, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: REMOTE_PLUGIN,
        version: VERSION,
        description:
          "Starbridge's hooks and mod for sessions Claude desktop starts here over SSH, whose starbridge plugins are copies without hooks from its own computer. Built by `starbridge setup`.",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(next, INVENTORY), `${JSON.stringify(filesUnder(next), null, 2)}\n`);
  // Only the files setup wrote last time go: a file the owner put in the folder stays.
  removeWritten(dir, written(dir));
  // The manifest goes last: `remotePluginCurrent` reads its version, so an interrupted copy
  // leaves a plugin the next setup rebuilds.
  const manifest = join(".claude-plugin", "plugin.json");
  cpSync(next, dir, {
    recursive: true,
    force: true,
    filter: (from) => relative(next, from) !== manifest,
  });
  cpSync(join(next, manifest), join(dir, manifest), { force: true });
  rmSync(next, { recursive: true, force: true });
}

/** Whether the plugin is loaded and was built by this release, with its inventory. */
export function remotePluginCurrent(sys: Home): boolean {
  try {
    const m = JSON.parse(
      readFileSync(join(remotePluginDir(sys), ".claude-plugin", "plugin.json"), "utf8"),
    ) as { version?: unknown };
    // A plugin built without the inventory is rebuilt once, so uninstall knows its files.
    return (
      m.version === VERSION &&
      existsSync(join(remotePluginDir(sys), INVENTORY)) &&
      remotePluginLoaded(sys)
    );
  } catch {
    return false;
  }
}

/**
 * Builds and loads the plugin from the installed ones, on a machine Claude desktop reaches.
 * Returns a note when it could not.
 */
export async function installRemotePlugin(sys: Sys): Promise<string | undefined> {
  const state = await pluginState(sys);
  if (typeof state === "string") return `Could not build the ${REMOTE_PLUGIN} plugin: ${state}.`;
  const root = (id: string) => (state as PluginState).plugins[`${id}@starbridge`]?.installPath;
  const starbridge = root("starbridge");
  const mod = root("starbridge-mod");
  if (!starbridge || !mod)
    return `Could not build the ${REMOTE_PLUGIN} plugin: \`claude plugin list --json\` names no folder for the starbridge plugins.`;
  try {
    writeRemotePlugin(sys, { starbridge, mod });
  } catch (e) {
    return `Could not build the ${REMOTE_PLUGIN} plugin: ${(e as Error).message}.`;
  }
  return loadRemotePlugin(sys)
    ? undefined
    : `Could not load the ${REMOTE_PLUGIN} plugin: add ${remotePluginDir(sys)} to ${DIRS_VAR} in the env of ${claudeDir(sys)}/settings.json.`;
}

/** The folders `CLAUDE_CODE_PLUGIN_DIRS` names in the user settings. */
function pluginDirs(env: Record<string, unknown> | undefined): string[] {
  const v = env?.[DIRS_VAR];
  return typeof v === "string" ? v.split(delimiter).filter((d) => d.length > 0) : [];
}

/** Whether the user settings load the plugin, and its folder holds one. */
export function remotePluginLoaded(sys: Home): boolean {
  const dir = remotePluginDir(sys);
  return (
    pluginDirs(readSettings(sys)?.env).some((d) => resolve(d) === dir) &&
    existsSync(join(dir, ".claude-plugin", "plugin.json"))
  );
}

/**
 * Adds the plugin's folder to `CLAUDE_CODE_PLUGIN_DIRS` in the user settings, after the folders
 * already there. False when the settings do not parse.
 */
export function loadRemotePlugin(sys: Home): boolean {
  const s = readSettings(sys);
  if (!s) return false;
  const dir = remotePluginDir(sys);
  const dirs = pluginDirs(s.env);
  if (dirs.some((d) => resolve(d) === dir)) return true;
  s.env = { ...s.env, [DIRS_VAR]: [...dirs, dir].join(delimiter) };
  writeSettings(sys, s);
  return true;
}

/**
 * Takes the plugin's folder out of `CLAUDE_CODE_PLUGIN_DIRS`, leaving the others, and deletes the
 * files setup wrote in it.
 * Returns what it did, one line each.
 */
export function removeRemotePlugin(sys: Home): string[] {
  const done: string[] = [];
  const dir = remotePluginDir(sys);
  const s = readSettings(sys);
  const dirs = pluginDirs(s?.env);
  if (s && dirs.some((d) => resolve(d) === dir)) {
    const left = dirs.filter((d) => resolve(d) !== dir);
    const { [DIRS_VAR]: _, ...env } = s.env ?? {};
    s.env = left.length > 0 ? { ...env, [DIRS_VAR]: left.join(delimiter) } : env;
    if (Object.keys(s.env).length === 0) delete s.env;
    writeSettings(sys, s);
    done.push(`Took ${dir} out of ${DIRS_VAR}.`);
  }
  if (existsSync(dir)) {
    const kept = removeWritten(dir, written(dir));
    done.push(kept.length === 0 ? `Removed the ${REMOTE_PLUGIN} plugin.` : removedLine(dir, kept));
  }
  return done;
}
