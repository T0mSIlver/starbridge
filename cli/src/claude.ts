import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionLink } from "@starbridge/protocol";

/**
 * What `ask` fills in about the Claude Code session that runs it, from the record Claude Code
 * keeps for each running session in `~/.claude/sessions/<pid>.json` (SPEC.md, research log,
 * 2026-10-05): its `name`, `bridgeSessionId` while Remote Control is on, and `hostSessionId`
 * when Claude Desktop runs it.
 */
export interface ClaudeSession {
  title?: string;
  links: SessionLink[];
}

interface SessionRecord {
  sessionId?: unknown;
  name?: unknown;
  bridgeSessionId?: unknown;
  hostSessionId?: unknown;
  updatedAt?: unknown;
}

/**
 * The first JSON object in `text`. Claude Code rewrites a record in place without truncating it,
 * so a shorter record can be followed by the tail of the longer one it replaced.
 */
function firstObject(text: string): SessionRecord | undefined {
  for (let end = text.indexOf("}"); end !== -1; end = text.indexOf("}", end + 1)) {
    try {
      const value = JSON.parse(text.slice(0, end + 1));
      return value && typeof value === "object" ? (value as SessionRecord) : undefined;
    } catch {}
  }
  return undefined;
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** The session `sessionId`'s title and links, or undefined when Claude Code has no record of it. */
export function claudeSession(
  env: { CLAUDE_CONFIG_DIR?: string; HOME?: string },
  sessionId: string,
): ClaudeSession | undefined {
  const base = env.CLAUDE_CONFIG_DIR || (env.HOME && join(env.HOME, ".claude"));
  if (!base) return undefined;
  const dir = join(base, "sessions");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return undefined;
  }
  // A resumed session can have an older record from the process that ran it before.
  let found: SessionRecord | undefined;
  for (const name of names) {
    let rec: SessionRecord | undefined;
    try {
      rec = firstObject(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (rec?.sessionId !== sessionId) continue;
    if (!found || Number(rec.updatedAt ?? 0) > Number(found.updatedAt ?? 0)) found = rec;
  }
  if (!found) return undefined;
  const links: SessionLink[] = [];
  const bridge = str(found.bridgeSessionId);
  if (bridge && SAFE_ID.test(bridge))
    links.push({
      kind: "remote-control",
      url: `https://claude.ai/code/${bridge.replace(/^cse_/, "session_")}`,
    });
  const host = str(found.hostSessionId);
  if (host && SAFE_ID.test(host))
    links.push({ kind: "desktop", url: `claude://claude.ai/epitaxy/${host}` });
  const title = str(found.name)?.trim().slice(0, 200);
  return { ...(title ? { title } : {}), links };
}
