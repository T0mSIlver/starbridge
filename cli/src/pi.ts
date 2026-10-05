/**
 * Pi sessions. Pi's bash tool gives every command the session's id in `PI_SESSION_ID` and its
 * JSONL file in `PI_SESSION_FILE`. The Starbridge Pi extension (`mod/pi/starbridge.ts`) sets
 * `STARBRIDGE_PI_ANSWERS` to the session's id while it submits answers into it, so `ask` can tell
 * an interactive session that gets its answers as prompts from `pi -p` or a Pi without it, even
 * a `pi -p` started from that session's shell, which inherits the variable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
