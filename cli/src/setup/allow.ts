/**
 * The allow entries setup writes into each harness's settings, so the commands that post a
 * question and read its answer skip the permission prompt (#1903): one table, and one way to add,
 * check and remove them.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { replaceFile } from "../replace";
import { cursorConfigPath } from "./cursor";
import { agySettingsPath } from "./harnesses";
import { settingsPath } from "./plugins";
import { withoutAllow, writeLeft } from "./remove";
import type { Sys } from "./sys";

type Home = Pick<Sys, "ctx" | "home">;

/**
 * The commands that post a question and read its answer. Each would otherwise stop at a
 * permission prompt before the question reaches the owner. `starbridge run` stays out: the
 * command it wraps is the agent's own.
 */
export const ALLOWED_COMMANDS = ["ask", "waiting", "working", "wait"] as const;

export type AllowList = {
  /** The JSON file whose `permissions.allow` holds the entries. */
  path: (sys: Home) => string;
  /** The entries setup adds. */
  rules: readonly string[];
  /** Entries of earlier releases that setup removes: they let `settle --all --yes` through (#1761). */
  stale: readonly string[];
};

export const ALLOW = {
  claude: {
    path: (sys) => settingsPath(sys),
    rules: [
      ...ALLOWED_COMMANDS.map((c) => `Bash(starbridge ${c}:*)`),
      // One decision by its id, never `settle --all` or `--session` (#1761).
      "Bash(starbridge settle d_*)",
    ],
    stale: ["Bash(starbridge settle:*)"],
  },
  /**
   * `Shell(starbridge ask)` matches `starbridge ask` and what starts with `starbridge ask `; a
   * compound command runs without a prompt only when each of its commands is allowed.
   */
  cursor: {
    path: (sys) => cursorConfigPath(sys),
    rules: ALLOWED_COMMANDS.map((c) => `Shell(starbridge ${c})`),
    stale: ["Shell(starbridge settle)"],
  },
  /**
   * `agy`'s settings; the app and the IDE keep their own, which setup does not know. A hook cannot
   * do it: `agy` 1.3.2 still prompts after a `PreToolUse` `allow`. An entry also passes the command
   * behind a variable assignment or `env`, so the plugin's hook makes such a line ask again
   * (`hook pre-tool`).
   */
  antigravity: {
    path: (sys) => agySettingsPath(sys),
    rules: [...ALLOWED_COMMANDS, "hello"].map((c) => `command(starbridge ${c})`),
    stale: ["command(starbridge settle)"],
  },
} satisfies Record<string, AllowList>;

type Settings = Record<string, unknown> & {
  permissions?: Record<string, unknown> & { allow?: unknown };
};

/** The file, `{}` when there is none, undefined when it cannot be read, does not parse or is no object. */
function read(list: AllowList, sys: Home): Settings | undefined {
  const path = list.path(sys);
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Settings) : undefined;
  } catch {
    return undefined;
  }
}

function entries(s: Settings): unknown[] {
  const allow = s.permissions?.allow;
  return Array.isArray(allow) ? allow : [];
}

/** The rules the file lacks, then the stale entries it holds: either means setup rewrites it. */
export function missingAllow(list: AllowList, sys: Home): string[] {
  const have = new Set(entries(read(list, sys) ?? {}));
  return [...list.rules.filter((r) => !have.has(r)), ...list.stale.filter((r) => have.has(r))];
}

/**
 * Adds the rules after the file's own entries, dropping stale ones. True when the file then holds
 * them; false, writing nothing, when it does not parse.
 */
export function addAllow(list: AllowList, sys: Home): boolean {
  const s = read(list, sys);
  if (!s) return false;
  if (missingAllow(list, sys).length === 0) return true;
  const allow = entries(s).filter((r) => !list.stale.includes(r as string));
  s.permissions = {
    ...s.permissions,
    allow: [...allow, ...list.rules.filter((r) => !allow.includes(r))],
  };
  const path = list.path(sys);
  mkdirSync(dirname(path), { recursive: true });
  replaceFile(path, `${JSON.stringify(s, null, 2)}\n`);
  return true;
}

/** Removes the rules and stale entries, or with `staleOnly` the stale ones; whether it removed any. */
export function removeAllow(list: AllowList, sys: Home, staleOnly = false): boolean {
  const s = read(list, sys);
  const left = s && withoutAllow(s, staleOnly ? list.stale : [...list.rules, ...list.stale]);
  if (!left) return false;
  writeLeft(list.path(sys), left);
  return true;
}
