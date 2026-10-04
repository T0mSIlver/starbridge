import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ProtocolError, ready } from "@starbridge/protocol";
import { ApiError } from "./api";
import { type Ctx, UsageError } from "./context";
import { type AskInput, ask, wait } from "./decisions";
import { pair } from "./pair";
import { quotaPush } from "./quota";

const HELP = `starbridge: post decisions to your devices, upload quota windows

  starbridge pair --server <url> [--name <name>] [--force]
      Make this machine's keys and print a pairing code to type on a device.

  starbridge ask --question <text> --default <text> [--option <text>]... [options]
      Post a decision to every paired device and print its id.
      --context <text>        why it is asked and what each option changes
      --context-file <path>   the same, from a file ("-" for stdin)
      --option <text>         2 to 4 times; none asks for a free-text answer
      --recommended <text>    one of the options (default: the first)
      --default <text>        what you do if nobody answers
      --default-at <when>     when: an ISO time or a duration such as 30m
      --project <name>        default: the current directory's name
      --session <id>          default: $CLAUDE_CODE_SESSION_ID
      --json <path>           read these fields from a JSON file ("-" for stdin)
      --wait                  then wait for the answer, as \`wait\` does

  starbridge wait [<decision id>] [--timeout <duration>] [--json]
      Print the answer, or with no id the next answer to any decision from this machine.
      Waits until --timeout, else the decision's default time, else forever.
      Exits 2 when nobody answered in time: apply the default.

  starbridge quota push [--provider <name>]... [--interval 5m] [--once] [--codexbar <path>]
      Run \`codexbar usage --format json\` for each provider (or for every enabled one),
      compute pace and alerts, and post a sealed snapshot every interval.

Keys and state live in $STARBRIDGE_CONFIG_DIR, else $XDG_CONFIG_HOME/starbridge, else
~/.config/starbridge.`;

function readText(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const [command, ...rest] = argv;
  try {
    await ready;
    switch (command) {
      case "pair": {
        const { values } = parseArgs({
          args: rest,
          options: {
            server: { type: "string" },
            name: { type: "string" },
            force: { type: "boolean" },
          },
        });
        return await pair(ctx, values);
      }
      case "ask": {
        const { values: v } = parseArgs({
          args: rest,
          options: {
            question: { type: "string" },
            context: { type: "string" },
            "context-file": { type: "string" },
            option: { type: "string", multiple: true },
            recommended: { type: "string" },
            default: { type: "string" },
            "default-at": { type: "string" },
            project: { type: "string" },
            session: { type: "string" },
            json: { type: "string" },
            wait: { type: "boolean" },
            timeout: { type: "string" },
          },
        });
        const fromJson: AskInput = v.json ? (JSON.parse(readText(v.json)) as AskInput) : {};
        const input: AskInput = {
          ...fromJson,
          ...(v.question !== undefined ? { question: v.question } : {}),
          ...(v.context !== undefined ? { context: v.context } : {}),
          ...(v["context-file"] !== undefined ? { context: readText(v["context-file"]) } : {}),
          ...(v.option !== undefined ? { options: v.option } : {}),
          ...(v.recommended !== undefined ? { recommended: v.recommended } : {}),
          ...(v.default !== undefined ? { default: v.default } : {}),
          ...(v["default-at"] !== undefined ? { defaultAt: v["default-at"] } : {}),
          ...(v.project !== undefined ? { project: v.project } : {}),
          ...(v.session !== undefined ? { session: v.session } : {}),
        };
        return await ask(ctx, input, { wait: v.wait, timeout: v.timeout });
      }
      case "wait": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { timeout: { type: "string" }, json: { type: "boolean" } },
        });
        return await wait(ctx, { id: positionals[0], ...values });
      }
      case "quota": {
        const [sub, ...args] = rest;
        if (sub !== "push") throw new UsageError("usage: starbridge quota push [options]");
        const { values } = parseArgs({
          args,
          options: {
            provider: { type: "string", multiple: true },
            interval: { type: "string" },
            once: { type: "boolean" },
            codexbar: { type: "string" },
          },
        });
        return await quotaPush(ctx, { ...values, providers: values.provider ?? [] });
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        ctx.out(HELP);
        return 0;
      default:
        throw new UsageError(`unknown command: ${command} (try starbridge --help)`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ApiError || e instanceof ProtocolError) {
      ctx.err(`starbridge: ${e.message}`);
      return 1;
    }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      ctx.err(`starbridge: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
