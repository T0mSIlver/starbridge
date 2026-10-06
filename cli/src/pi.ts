/**
 * Pi sessions. Pi's bash tool gives every command the session's id in `PI_SESSION_ID` and its
 * JSONL file in `PI_SESSION_FILE`. The Starbridge Pi extension (`mod/pi/starbridge.ts`) sets
 * `STARBRIDGE_PI_ANSWERS` to the session's id while it submits answers into it, so `ask` can tell
 * an interactive session that gets its answers as prompts from `pi -p` or a Pi without it, even
 * a `pi -p` started from that session's shell, which inherits the variable.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "./context";

/** The env var the extension sets, to its session's id, while it brings answers back. */
export const PI_ANSWERS = "STARBRIDGE_PI_ANSWERS";

/** The session's name, the last `session_info` entry with one in its file. */
export function piSessionTitle(env: Ctx["env"]): string | undefined {
  const file = env.PI_SESSION_FILE;
  if (!file) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let name: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"session_info"')) continue;
    try {
      const e = JSON.parse(line) as { type?: unknown; name?: unknown };
      if (e.type === "session_info" && typeof e.name === "string") name = e.name.trim();
    } catch {}
  }
  return name ? name.slice(0, 200) : undefined;
}

/** pi-permission-system's config file, which holds the `authorizerChain` that names links. */
export function piPermissionConfig(env: Ctx["env"]): string {
  return join(piAgentDir(env), "extensions", "pi-permission-system", "config.json");
}

/** The name of the Starbridge Pi extension's link (mod/pi/permissions.ts). */
export const PI_LINK = "starbridge";

/**
 * Whether pi-permission-system is set up here and its chain names the Starbridge link:
 * `absent` when neither its config folder nor Pi's settings mention it, `unreadable` when its
 * config is not plain JSON this command can rewrite.
 */
export function piChain(env: Ctx["env"]): {
  state: "absent" | "chained" | "unchained" | "unreadable";
  file: string;
} {
  const file = piPermissionConfig(env);
  let settings = "";
  try {
    settings = readFileSync(join(dirname(dirname(dirname(file))), "settings.json"), "utf8");
  } catch {}
  if (!existsSync(dirname(file)) && !settings.includes("pi-permission-system"))
    return { state: "absent", file };
  if (!existsSync(file)) return { state: "unchained", file };
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as { authorizerChain?: unknown };
    if (config === null || typeof config !== "object" || Array.isArray(config))
      return { state: "unreadable", file };
    const chain = config.authorizerChain;
    if (chain !== undefined && !Array.isArray(chain)) return { state: "unreadable", file };
    return { state: chain?.includes(PI_LINK) ? "chained" : "unchained", file };
  } catch {
    return { state: "unreadable", file };
  }
}

/** Appends the Starbridge link to pi-permission-system's `authorizerChain`, keeping the rest. */
export function chainPiLink(file: string) {
  let config: Record<string, unknown> = {};
  if (existsSync(file)) config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const chain = Array.isArray(config.authorizerChain) ? config.authorizerChain : [];
  if (chain.includes(PI_LINK)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ ...config, authorizerChain: [...chain, PI_LINK] }, null, 2)}\n`,
  );
}
/** Pi's agent folder: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
function piAgentDir(env: Ctx["env"]): string {
  return env.PI_CODING_AGENT_DIR || join(env.HOME ?? "", ".pi", "agent");
}

/** Where `pi install git:github.com/T0mSIlver/starbridge@<tag>` puts the Starbridge skill. */
export function piSkillDir(env: Ctx["env"]): string {
  return join(
    piAgentDir(env),
    "git",
    "github.com",
    "T0mSIlver",
    "starbridge",
    "plugin",
    "skills",
    "starbridge",
  );
}

/**
 * The `permission` rules that let an agent reach the owner without a prompt, by surface: the
 * commands setup lets run in Claude Code (allow rules) and Codex (`starbridge.rules`), and the
 * Starbridge skill, whose file pi-permission-system gates twice, as the `starbridge` skill and
 * as a `read` (#443).
 */
export function piRules(env: Ctx["env"]): Record<string, string[]> {
  return {
    bash: ["ask", "waiting", "working", "wait", "settle"].map((c) => `starbridge ${c} *`),
    skill: ["starbridge"],
    read: [`${piSkillDir(env)}/*`],
  };
}

/** The rules of `surfaces` (all by default) as the JSON to add under `permission`, to paste. */
export function piRulesText(env: Ctx["env"], surfaces?: string[]): string {
  return Object.entries(piRules(env))
    .filter(([s]) => !surfaces || surfaces.includes(s))
    .map(([s, ps]) => `"${s}": {${ps.map((p) => `"${p}": "allow"`).join(", ")}}`)
    .join(", ");
}

type Config = Record<string, unknown>;
const isObject = (v: unknown): v is Config =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** pi-permission-system's config, `{}` when there is none; undefined when it is not plain JSON. */
function readConfig(file: string): Config | undefined {
  if (!existsSync(file)) return {};
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObject(config) ? config : undefined;
  } catch {
    return undefined;
  }
}

function writeConfig(file: string, config: Config) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A surface this command leaves to the owner: a plain level other than `allow`. As
 * `{"*": level}` it would merge with a project's map for that surface instead of giving way.
 */
const plainLevel = (rules: unknown) => rules !== undefined && rules !== "allow" && !isObject(rules);

/**
 * Whether pi-permission-system lets the agent reach the owner, on the surfaces this command may
 * rewrite: `absent` and `unreadable` as for `piChain`, also `unreadable` when `permission` is
 * not a map. `plain` names the surfaces left to the owner (plainLevel).
 */
export function piAllow(env: Ctx["env"]): {
  state: "absent" | "allowed" | "missing" | "unreadable";
  file: string;
  plain: string[];
} {
  const { state, file } = piChain(env);
  if (state === "absent" || state === "unreadable") return { state, file, plain: [] };
  const config = readConfig(file);
  const permission = config?.permission ?? {};
  if (!isObject(permission)) return { state: "unreadable", file, plain: [] };
  let allowed = true;
  const plain: string[] = [];
  for (const [surface, patterns] of Object.entries(piRules(env))) {
    const rules = permission[surface] ?? {};
    if (rules === "allow") continue;
    if (!isObject(rules)) {
      plain.push(surface);
      continue;
    }
    // Last, since the last match wins: a later pattern of the owner's could shadow them.
    const tail = Object.entries(rules).slice(-patterns.length);
    if (!patterns.every((p, i) => tail[i]?.[0] === p && tail[i]?.[1] === "allow")) allowed = false;
  }
  return { state: allowed ? "allowed" : "missing", file, plain };
}

/**
 * Adds piRules to `permission`, each after the owner's own patterns for its surface since the
 * last match wins, keeping the rest of the file. A surface set to a plain `allow` needs none,
 * and one set to another plain level stays as it is (plainLevel).
 */
export function allowPiRules(env: Ctx["env"]) {
  const file = piPermissionConfig(env);
  const config = readConfig(file) ?? {};
  const permission = isObject(config.permission) ? { ...config.permission } : {};
  for (const [surface, patterns] of Object.entries(piRules(env))) {
    if (permission[surface] === "allow" || plainLevel(permission[surface])) continue;
    const rules = isObject(permission[surface]) ? { ...permission[surface] } : {};
    for (const p of patterns) delete rules[p];
    for (const p of patterns) rules[p] = "allow";
    permission[surface] = rules;
  }
  writeConfig(file, { ...config, permission });
}

/**
 * Takes out what setup and `config permissions on` added to pi-permission-system's config: the
 * Starbridge link in `authorizerChain` and the piRules, dropping a list, map or file they leave
 * empty. Returns whether it changed the file.
 */
export function removePiEntries(env: Ctx["env"]): boolean {
  const file = piPermissionConfig(env);
  if (!existsSync(file)) return false;
  const config = readConfig(file);
  if (!config) return false;
  let changed = false;
  const chain = config.authorizerChain;
  if (Array.isArray(chain) && chain.includes(PI_LINK)) {
    const rest = chain.filter((l) => l !== PI_LINK);
    if (rest.length > 0) config.authorizerChain = rest;
    else delete config.authorizerChain;
    changed = true;
  }
  const permission = config.permission;
  if (isObject(permission)) {
    for (const [surface, patterns] of Object.entries(piRules(env))) {
      const rules = permission[surface];
      if (!isObject(rules)) continue;
      for (const p of patterns)
        if (rules[p] === "allow") {
          delete rules[p];
          changed = true;
        }
      if (Object.keys(rules).length === 0) delete permission[surface];
    }
    if (Object.keys(permission).length === 0) delete config.permission;
  }
  // Left empty, it is the file setup created: an empty config and none mean the same.
  if (changed && Object.keys(config).length === 0) rmSync(file, { force: true });
  else if (changed) writeConfig(file, config);
  return changed;
}
