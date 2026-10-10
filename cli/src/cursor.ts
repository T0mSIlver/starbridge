/**
 * Cursor sessions. Cursor gives every command its agent runs `CURSOR_AGENT=1`, and `cursor-agent`
 * also the conversation's id in `CURSOR_CONVERSATION_ID` (2026.10.01).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The conversation's id. */
export const CURSOR_CONVERSATION = "CURSOR_CONVERSATION_ID";

/**
 * The arguments of a hook's ancestors, nearest first: the hook runs under a shell or two below
 * `cursor-agent`. Empty where they cannot be read.
 */
export function ancestorArgs(pid = process.ppid, depth = 8): string[][] {
  const out: string[][] = [];
  try {
    for (let i = 0; i < depth && pid > 1; i++) {
      if (process.platform === "linux") {
        out.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean));
        // The parent's pid follows the command's name, which may hold spaces, in parentheses.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } else if (process.platform === "darwin") {
        const r = spawnSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], {
          encoding: "utf8",
          timeout: 2_000,
        });
        const m = /^\s*(\d+)\s+(.*)$/s.exec(r.stdout ?? "");
        if (r.status !== 0 || !m) break;
        out.push((m[2] as string).trim().split(/\s+/));
        pid = Number(m[1]);
      } else break;
    }
  } catch {}
  return out;
}

/** The arguments `cursor-agent` runs with, from the first ancestor that is it. */
export function cursorAgentArgs(ancestors = ancestorArgs()): string[] {
  return ancestors.find((args) => args.some((a) => /cursor-agent|[\\/]index\.js$/.test(a))) ?? [];
}
