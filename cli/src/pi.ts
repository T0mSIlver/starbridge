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
  const dir = env.PI_CODING_AGENT_DIR || join(env.HOME ?? "", ".pi", "agent");
  return join(dir, "extensions", "pi-permission-system", "config.json");
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

/**
 * The `permission.bash` patterns that let an agent reach the owner without a prompt: the
 * commands setup lets run in Claude Code (allow rules) and Codex (`starbridge.rules`).
 */
export const PI_ALLOW = ["ask", "waiting", "working", "wait", "settle"].map(
  (c) => `starbridge ${c} *`,
);

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
 * Whether pi-permission-system lets the starbridge commands run: `absent` and `unreadable` as
 * for `piChain`, also `unreadable` when `permission` or its `bash` has a shape this command
 * does not rewrite.
 */
export function piAllow(env: Ctx["env"]): {
  state: "absent" | "allowed" | "missing" | "unreadable";
  file: string;
} {
  const { state, file } = piChain(env);
  if (state === "absent" || state === "unreadable") return { state, file };
  const bash = bashRules(readConfig(file));
  if (bash === undefined) return { state: "unreadable", file };
  const allowed = PI_ALLOW.every((p) => bash[p] === "allow");
  return { state: allowed ? "allowed" : "missing", file };
}

/** `permission.bash` as a pattern map, a plain level `L` read as `{"*": L}`; undefined when odd. */
function bashRules(config: Config | undefined): Config | undefined {
  if (!config) return undefined;
  const permission = config.permission ?? {};
  if (!isObject(permission)) return undefined;
  const bash = permission.bash ?? {};
  if (typeof bash === "string") return { "*": bash };
  return isObject(bash) ? bash : undefined;
}

/**
 * Adds PI_ALLOW to `permission.bash`, after the owner's own patterns since the last match wins,
 * keeping the rest of the file. A plain level becomes the `"*"` pattern, which means the same.
 */
export function allowPiCommands(file: string) {
  const config = readConfig(file) ?? {};
  const bash = { ...bashRules(config) };
  for (const p of PI_ALLOW) delete bash[p];
  for (const p of PI_ALLOW) bash[p] = "allow";
  const permission = isObject(config.permission) ? config.permission : {};
  writeConfig(file, { ...config, permission: { ...permission, bash } });
}

/**
 * Takes out what setup and `config permissions on` added to pi-permission-system's config: the
 * Starbridge link in `authorizerChain` and the PI_ALLOW patterns, dropping a list, map or file
 * they leave empty. Returns whether it changed the file.
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
  const bash = isObject(permission) ? permission.bash : undefined;
  if (isObject(permission) && isObject(bash)) {
    for (const p of PI_ALLOW)
      if (bash[p] === "allow") {
        delete bash[p];
        changed = true;
      }
    if (Object.keys(bash).length === 0) delete permission.bash;
    if (Object.keys(permission).length === 0) delete config.permission;
  }
  // Left empty, it is the file setup created: an empty config and none mean the same.
  if (changed && Object.keys(config).length === 0) rmSync(file, { force: true });
  else if (changed) writeConfig(file, config);
  return changed;
}
