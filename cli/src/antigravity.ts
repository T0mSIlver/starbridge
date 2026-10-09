/**
 * Antigravity sessions: the app, the IDE and the `agy` CLI. Each gives the commands its agent runs
 * the conversation's id in `ANTIGRAVITY_CONVERSATION_ID`, and keeps the title it generates for a
 * conversation in `~/.gemini/<product>/annotations/<id>.pbtxt`, a protobuf text file such as
 * `title:"Fix the build"`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownCommand } from "../../mod/hooks/own";
import { type Ctx, UsageError } from "./context";

/** The conversation's id, in every command the agent runs. */
export const ANTIGRAVITY_CONVERSATION = "ANTIGRAVITY_CONVERSATION_ID";

/** Each product's folder under `~/.gemini`: the CLI, the app, the IDE. */
const PRODUCTS = ["antigravity-cli", "antigravity", "antigravity-ide"];

/** The conversation's title, from whichever product's annotations hold it. */
export function antigravityTitle(env: Ctx["env"], conversation: string): string | undefined {
  const home = env.HOME || env.USERPROFILE;
  // The id names a file: never let it leave the annotations folder.
  if (!home || !/^[\w-]+$/.test(conversation)) return undefined;
  for (const product of PRODUCTS) {
    let text: string;
    try {
      text = readFileSync(
        join(home, ".gemini", product, "annotations", `${conversation}.pbtxt`),
        "utf8",
      );
    } catch {
      continue;
    }
    const title = pbtxtString(text, "title")?.trim();
    if (title) return title.slice(0, 200);
  }
  return undefined;
}

/**
 * Field `name`'s string in protobuf text format. Go's encoder puts any spacing after the colon,
 * escapes quotes and backslashes, and writes control bytes and invalid UTF-8 in hex or `\u`.
 */
export function pbtxtString(text: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!m) return undefined;
  const bytes: number[] = [];
  const raw = Buffer.from(m[1] as string, "utf8");
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as number;
    if (c !== 0x5c) {
      bytes.push(c);
      continue;
    }
    const e = String.fromCharCode(raw[++i] as number);
    if (e in simple) bytes.push(simple[e] as number);
    else if (e === "x") {
      const hex = raw.subarray(i + 1, i + 3).toString("latin1");
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (e === "u" || e === "U") {
      const n = e === "u" ? 4 : 8;
      const cp = Number.parseInt(raw.subarray(i + 1, i + 1 + n).toString("latin1"), 16);
      bytes.push(...Buffer.from(String.fromCodePoint(cp), "utf8"));
      i += n;
    } else if (/[0-7]/.test(e)) {
      const oct = raw.subarray(i, i + 3).toString("latin1");
      bytes.push(Number.parseInt(oct, 8));
      i += 2;
    } else bytes.push(e.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** What Antigravity's `PreToolUse` hook gets on stdin, the parts Starbridge reads. */
export interface PreToolInput {
  conversationId?: string;
  workspacePaths?: string[];
  toolCall?: { name?: string; args?: Record<string, unknown> };
}

/** A starbridge command an AGY_ALLOW entry lets through, wherever it sits on the line. */
const ALLOWED = /(^|[^\w-])starbridge\s+(ask|waiting|working|wait|settle)(?![\w-])/;

/**
 * `starbridge hook pre-tool --agent antigravity`, on the plugin's `PreToolUse` for
 * `run_command` (#959). The allow entries setup adds to `agy`'s settings skip the prompt; this
 * hook narrows them. A line that is one of those commands alone runs outside `--sandbox`, which
 * has no network and hides the home folder. A line they would pass but that runs more, such as
 * `LD_PRELOAD=… starbridge ask`, gets the prompt back (`force_ask`). `agy` ignores a hook's
 * `allow` otherwise. Prints nothing for any other call.
 */
export function hookPreTool(ctx: Ctx, text: string, opts: { agent?: string }): number {
  if (opts.agent !== "antigravity")
    throw new UsageError(`--agent: antigravity (got ${opts.agent ?? "nothing"})`);
  let input: PreToolInput;
  try {
    input = JSON.parse(text) as PreToolInput;
  } catch {
    return 0;
  }
  const line = input?.toolCall?.args?.CommandLine;
  if (input?.toolCall?.name !== "run_command" || typeof line !== "string") return 0;
  if (ownCommand(line))
    ctx.out(JSON.stringify({ decision: "allow", overwrite: { BypassSandbox: true } }));
  else if (ALLOWED.test(line))
    ctx.out(
      JSON.stringify({
        decision: "force_ask",
        reason: "Starbridge lets its commands skip the prompt only alone on their line.",
      }),
    );
  return 0;
}
