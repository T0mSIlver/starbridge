import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { SessionLink } from "@starbridge/protocol";

/**
 * What `ask` fills in about the Claude Code session that runs it, from the record Claude Code
 * keeps for each running session in `~/.claude/sessions/<pid>.json` (spec/platform-facts.md): its `name`,
 * `bridgeSessionId` while Remote Control is on, and `hostSessionId` when Claude Desktop runs it. A
 * name Claude Code derived or cut short gives way to the first sentence of the session's first prompt.
 */
export interface ClaudeSession {
  title?: string;
  links: SessionLink[];
}

interface SessionRecord {
  sessionId?: unknown;
  name?: unknown;
  /**
   * "derived" for a name Claude Code made up from the directory, "auto" for the first prompt cut at
   * about 50 characters, "user" for one the owner gave; absent for Claude Desktop's.
   */
  nameSource?: unknown;
  cwd?: unknown;
  bridgeSessionId?: unknown;
  hostSessionId?: unknown;
  updatedAt?: unknown;
  pid?: unknown;
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

type ClaudeEnv = { CLAUDE_CONFIG_DIR?: string; HOME?: string };

/** Claude Code's newest record of session `sessionId`, and the directory it keeps them under. */
function sessionRecord(
  env: ClaudeEnv,
  sessionId: string,
): { base: string; found: SessionRecord } | undefined {
  const base = env.CLAUDE_CONFIG_DIR || (env.HOME && join(env.HOME, ".claude"));
  if (!base || !sessionId) return undefined;
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
  return found ? { base, found } : undefined;
}

/** The session `sessionId`'s title and links, or undefined when Claude Code has no record of it. */
export function claudeSession(env: ClaudeEnv, sessionId: string): ClaudeSession | undefined {
  const r = sessionRecord(env, sessionId);
  if (!r) return undefined;
  const { base, found } = r;
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
  const name = str(found.name)?.trim().slice(0, 200);
  // A made-up name ("starbridge-4c", "bridge-cse-01ab…") repeats the project and says nothing
  // more (#970), and an auto one stops mid-word (#1181).
  const title =
    !name || found.nameSource === "derived" || (found.nameSource === "auto" && name.endsWith("..."))
      ? (promptTitle(base, found) ?? (found.nameSource === "derived" ? undefined : name))
      : name;
  return { ...(title ? { title } : {}), links };
}

const MAX_TITLE = 60;
/** How far into a transcript to look for its first prompt; attachments come first. */
const MAX_SCAN = 4 * 1024 * 1024;

/**
 * The first sentence of the session's first prompt, cut on a word boundary to 60 characters, from
 * its transcript `<base>/projects/<cwd with every other character a dash>/<sessionId>.jsonl`.
 * Reads up to the first prompt and keeps nothing else from it.
 */
function promptTitle(base: string, rec: SessionRecord): string | undefined {
  const id = str(rec.sessionId);
  const cwd = str(rec.cwd);
  if (!id || !cwd || !SAFE_ID.test(id)) return undefined;
  const path = join(base, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  const prompt = firstPrompt(path);
  return prompt === undefined ? undefined : titleOf(prompt);
}

/** The text of the transcript's first user line that a person typed. */
function firstPrompt(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    for (let read = 0; read < MAX_SCAN; ) {
      const n = readSync(fd, chunk, 0, chunk.length, read);
      if (n === 0) return undefined;
      read += n;
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      for (let nl = pending.indexOf(10); nl !== -1; nl = pending.indexOf(10)) {
        const line = pending.subarray(0, nl).toString("utf8");
        pending = pending.subarray(nl + 1);
        const text = promptText(line);
        if (text !== undefined) return text;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * A user line's prompt, or undefined for every other line: tool results, skill and command
 * output (`isMeta`, `<command-name>`, `<local-command-stdout>`), the summary that continues a
 * compacted conversation, messages from another session or a plugin (`origin.kind`), and text that
 * is all system blocks such as `<system-reminder>`, which Claude Code puts before the prompt.
 */
function promptText(line: string): string | undefined {
  if (!line.includes('"user"')) return undefined;
  let entry: {
    type?: unknown;
    isMeta?: unknown;
    isCompactSummary?: unknown;
    origin?: { kind?: unknown };
    message?: { content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (entry?.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true)
    return undefined;
  const kind = entry.origin?.kind;
  if (kind !== undefined && kind !== "human") return undefined;
  const content = entry.message?.content;
  const parts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
        : [];
  for (const part of parts) {
    const text = part.trim();
    if (text && !text.startsWith("<")) return text;
  }
  return undefined;
}

/** `prompt`'s first sentence, cut on a word boundary to at most 60 characters. */
function titleOf(prompt: string): string | undefined {
  // The first paragraph, past code fences and the @-mentions of attached files, without
  // Markdown's heading, quote and list marks. A heading or list item is a paragraph of its own.
  const lines: string[] = [];
  for (const raw of prompt.split("\n")) {
    const l = raw.trim().replace(/^(@("[^"]*"|\S+)\s*)+/, "");
    if (l.startsWith("```")) continue;
    const marked = /^(#+|[*-]|\d+[.)])\s/.test(l);
    if (marked && lines.length) break;
    const text = l.replace(/^([#>*-]+\s*|\d+[.)]\s+)/, "");
    if (text) lines.push(text);
    else if (lines.length) break;
    if (marked && lines.length) break;
  }
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  // A period before a lowercase word ends an abbreviation ("e.g. the"), not the sentence, as
  // does one after a common abbreviation ("e.g. GLM").
  const end = text.search(/(?<!\b([eE]\.g|[iI]\.e|etc|vs|cf))[.!?](\s+[^\sa-z]|$)/);
  let title = end === -1 ? text : text.slice(0, end + 1);
  if (title.length > MAX_TITLE) {
    const cut = title.slice(0, MAX_TITLE + 1);
    const space = cut.lastIndexOf(" ");
    title = space > 0 ? cut.slice(0, space) : title.slice(0, MAX_TITLE);
  }
  title = title.replace(/(\.{2,}|…)$/, "").replace(/[\s,;:(\-–—]+$/, "");
  return title || undefined;
}

/** Starbridge's Claude Code plugins, by the name in their manifest. */
const OUR_PLUGINS = ["starbridge", "starbridge-mod"];

/** A Starbridge plugin that a Claude Code session loads from a `--plugin-dir` with no hooks. */
export interface HooklessCopy {
  name: string;
  dir: string;
}

/** The arguments process `pid` runs with; empty where they cannot be read. */
export function processArgs(pid: number): string[] {
  try {
    if (process.platform === "linux")
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2_000,
      });
      return r.status === 0 ? (r.stdout ?? "").trim().split(/\s+/) : [];
    }
  } catch {}
  return [];
}

/**
 * The Starbridge plugins that the process running Claude Code session `sessionId` loads from a
 * `--plugin-dir` without `hooks/hooks.json` (#1428). Claude desktop starts a session on another
 * machine with copies of the plugins installed on the computer it runs on, synced without their
 * hooks, and a `--plugin-dir` plugin replaces the installed one of its name: no mod runs in that
 * session, and none of the starbridge plugin's hooks.
 */
export function hooklessCopies(
  env: ClaudeEnv,
  sessionId: string,
  argsOf: (pid: number) => string[] = processArgs,
): HooklessCopy[] {
  const pid = sessionRecord(env, sessionId)?.found.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 1) return [];
  const args = argsOf(pid as number);
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--plugin-dir" && args[i + 1] !== undefined) dirs.push(args[++i] as string);
    else if (a.startsWith("--plugin-dir=")) dirs.push(a.slice("--plugin-dir=".length));
  }
  const out: HooklessCopy[] = [];
  for (const dir of dirs) {
    let name: unknown;
    try {
      name = (
        JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")) as {
          name?: unknown;
        }
      ).name;
    } catch {
      continue;
    }
    if (
      typeof name === "string" &&
      OUR_PLUGINS.includes(name) &&
      !existsSync(join(dir, "hooks", "hooks.json"))
    )
      out.push({ name, dir });
  }
  return out;
}
