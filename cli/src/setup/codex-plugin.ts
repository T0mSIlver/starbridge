/**
 * The Starbridge Codex plugin (#949): a `SessionStart` hook that adds the rule to each Codex
 * session, as the Claude Code plugin's does. Codex 0.160 installs plugins only from a
 * marketplace, so setup writes a local one under `$CODEX_HOME/starbridge` and installs the
 * plugin from it. The plugin's hook runs the script in that folder, not a copy in Codex's
 * plugin cache: a release then rewrites the script and the rule in place, and the hook Codex
 * trusted stays the same, so the owner is not asked to trust it again.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import rule from "../../../plugin/hooks/rule.md" with { type: "text" };
import sessionStart from "../../../plugin/hooks/session-start.sh" with { type: "text" };
import { marker, ours } from "./marker";
import { failure, run, type Sys } from "./sys";

type Home = Pick<Sys, "ctx" | "home">;

export const CODEX_MARKETPLACE = "starbridge-cli";
export const CODEX_PLUGIN = `starbridge@${CODEX_MARKETPLACE}`;
/**
 * The plugin's version, which names its folder in Codex's cache. Raise it when `hooks.json`
 * changes, so `codex plugin add` installs the new one.
 */
const PLUGIN_VERSION = "1.0.0";

function codexHome(sys: Home): string {
  return sys.ctx.env.CODEX_HOME || join(sys.home, ".codex");
}

/** The local marketplace setup writes, which holds the plugin, its script and the rule. */
export function codexPluginDir(sys: Home): string {
  return join(codexHome(sys), "starbridge");
}

const SCRIPT = "hooks/session-start.sh";
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Every file of the marketplace, by path inside it. */
function files(sys: Home): Record<string, string> {
  const dir = codexPluginDir(sys);
  const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
  return {
    ".agents/plugins/marketplace.json": json({
      name: CODEX_MARKETPLACE,
      plugins: [
        {
          name: "starbridge",
          source: { source: "local", path: "./plugins/starbridge" },
          policy: { installation: "AVAILABLE" },
          category: "Productivity",
        },
      ],
    }),
    "plugins/starbridge/.codex-plugin/plugin.json": json({
      name: "starbridge",
      version: PLUGIN_VERSION,
      description: "Reach your user through Starbridge. Written by `starbridge setup`.",
      hooks: "./hooks/hooks.json",
    }),
    "plugins/starbridge/hooks/hooks.json": hooksJson(dir),
    // The marker goes under the shebang; `ours` reads the first lines.
    [SCRIPT]: sessionStart.replace(/^(#!.*\n)/, `$1${marker("#")}\n`),
    "hooks/rule.md": rule,
  };
}

function hooksJson(dir: string): string {
  const command = `sh ${shellQuote(join(dir, SCRIPT))}`;
  return `${JSON.stringify(
    { hooks: { SessionStart: [{ hooks: [{ type: "command", command, timeout: 5 }] }] } },
    null,
    2,
  )}\n`;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether Codex's config enables the plugin: `[plugins."starbridge@starbridge-cli"]`. */
function enabled(sys: Home): boolean {
  const config = readText(join(codexHome(sys), "config.toml")) ?? "";
  return config.includes(`[plugins."${CODEX_PLUGIN}"]`);
}

/** The `hooks.json` Codex runs, in its plugin cache. */
function cachedHooks(sys: Home): string | undefined {
  return readText(
    join(
      codexHome(sys),
      "plugins/cache",
      CODEX_MARKETPLACE,
      "starbridge",
      PLUGIN_VERSION,
      "hooks/hooks.json",
    ),
  );
}

/**
 * "foreign" when the folder holds a script setup did not write, which it leaves alone;
 * "outdated" when a file differs or Codex has not installed this plugin version.
 */
export function codexPlugin(sys: Home): "missing" | "current" | "outdated" | "foreign" {
  const dir = codexPluginDir(sys);
  const script = readText(join(dir, SCRIPT));
  if (script !== undefined && !ours(script)) return "foreign";
  const want = files(sys);
  const same = Object.entries(want).every(([path, body]) => readText(join(dir, path)) === body);
  const installed = enabled(sys);
  if (script === undefined && !installed) return "missing";
  const hooks = want["plugins/starbridge/hooks/hooks.json"];
  return same && installed && cachedHooks(sys) === hooks ? "current" : "outdated";
}

function writeFiles(sys: Home) {
  const dir = codexPluginDir(sys);
  for (const [path, body] of Object.entries(files(sys))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

const codex = (sys: Sys, ...args: string[]) => run(sys, "codex", args, { timeoutMs: 60_000 });

/** Writes the marketplace and has Codex add it and install the plugin. */
export async function installCodexPlugin(sys: Sys) {
  writeFiles(sys);
  for (const args of [
    ["plugin", "marketplace", "add", codexPluginDir(sys)],
    ["plugin", "add", CODEX_PLUGIN],
  ]) {
    const r = await codex(sys, ...args);
    if (r?.code !== 0) throw new Error(`codex ${args.join(" ")}: ${failure(r)}`);
  }
}

/**
 * Rewrites the script and the rule where setup wrote them, which needs no Codex: the agent does
 * it when it starts. A changed `hooks.json` waits for `setup --refresh`, which reinstalls.
 */
export function refreshCodexPluginFiles(sys: Home): boolean {
  const dir = codexPluginDir(sys);
  if (!ours(readText(join(dir, SCRIPT)))) return false;
  const want = files(sys);
  const stale = Object.entries(want).filter(([path, body]) => readText(join(dir, path)) !== body);
  for (const [path, body] of stale) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return stale.length > 0;
}

/** Uninstalls the plugin and removes the marketplace, only when setup wrote it. */
export async function removeCodexPlugin(sys: Sys): Promise<string[]> {
  const dir = codexPluginDir(sys);
  if (!ours(readText(join(dir, SCRIPT)))) return [];
  const done: string[] = [];
  if (enabled(sys)) {
    const r = await codex(sys, "plugin", "remove", CODEX_PLUGIN);
    done.push(
      r?.code === 0
        ? `Removed the Codex plugin ${CODEX_PLUGIN}.`
        : `Could not remove the Codex plugin: ${failure(r)}. Run \`codex plugin remove ${CODEX_PLUGIN}\`.`,
    );
  }
  await codex(sys, "plugin", "marketplace", "remove", CODEX_MARKETPLACE);
  rmSync(dir, { recursive: true, force: true });
  done.push(`Removed ${dir}.`);
  return done;
}
