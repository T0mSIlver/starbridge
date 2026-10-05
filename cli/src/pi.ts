/**
 * Pi sessions. Pi's bash tool gives every command the session's id in `PI_SESSION_ID` and its
 * JSONL file in `PI_SESSION_FILE`. The Starbridge Pi extension (`pi/starbridge.ts`) sets
 * `STARBRIDGE_PI_ANSWERS=1` while it submits answers into the session, so `ask` can tell an
 * interactive session that gets its answers as prompts from `pi -p` or a Pi without it.
 */
import { readFileSync } from "node:fs";
import type { Ctx } from "./context";

/** The env var the extension sets while it brings answers back. */
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
