import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ProtocolError, ready, type SessionLink } from "@starbridge/protocol";
import { AgentError, Interrupted, withAgent } from "./agent/client";
import { answersVia, askVia, quotaVia, waitVia } from "./agent/commands";
import { runAgent } from "./agent/main";
import { ApiError } from "./api";
import { type Ctx, UsageError } from "./context";
import { type AskInput, answers, ask, wait } from "./decisions";
import { hookPermission, hookSettle, permissionsCommand } from "./hook";
import { pair } from "./pair";
import { pushOnce, quotaPush } from "./quota";
import { installKind, ReleaseError } from "./release";
import { setup } from "./setup/setup";
import { status } from "./setup/status";
import { defaults, makeSys, type Prompt, terminalPrompt } from "./setup/sys";
import { uninstall } from "./setup/uninstall";
import { update } from "./update";
import { VERSION } from "./version";

const HELP = `starbridge: post decisions to your devices, upload quota windows

  starbridge setup [--yes] [--server <url>] [--name <name>] [--providers <a,b>]
                   [--no-quota] [--no-service] [--no-plugin]
      Set this machine up, or check and repair it: pair it, find or install CodexBar and pick
      the providers to upload, install the agent as a user service (systemd or launchd), install
      the Claude Code plugins, and upload a first quota snapshot. Each step asks first; --yes
      takes every default, which installs CodexBar when it is missing, the plugins, and replaces
      a hand-written \`starbridge quota push\` unit and manual mod or skill installs.

  starbridge status
      Print the versions, the pairing, the agent and its service, the server, each provider, the
      Claude Code plugins and the sessions the agent sees.

  starbridge uninstall [--yes] [--purge]
      Remove the agent service, the Claude Code plugins and this binary, and ask your devices to revoke this
      machine. Asks before it deletes the keys and state (--purge: without asking). CodexBar stays.

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
      --session-title <text>  default: the Claude Code session's name
      --link <kind>=<url>     where to open the session, up to 3 times; kind is
                              remote-control, desktop or web (default: what Claude
                              Code records for the session: Remote Control, Desktop)
      --json <path>           read these fields from a JSON file ("-" for stdin)
      --wait                  then wait for the answer, as \`wait\` does

  starbridge wait [<decision id>] [--timeout <duration>] [--json]
      Print the answer, or with no id the next answer to any decision from this machine.
      Waits until --timeout, else the decision's default time, else forever.
      Exits 2 when nobody answered in time: apply the default.

  starbridge answers --session <id> [--wait <seconds>]
      For the Claude Code mod: print, as JSON lines, the unconfirmed answers to decisions that
      session asked, and a line for each of them whose default time passed with no answer.
      With --wait (at most 25), poll the server once first when there are none.

  starbridge answers --session <id> --ack <ack>...
      For the Claude Code mod: confirm it submitted these lines (each line's "ack"), so they
      are not printed again.

  starbridge quota push [--provider <name>]... [--interval 5m] [--once] [--codexbar <path>]
      Run \`codexbar usage --format json\` for each provider (or for every enabled one),
      compute pace and alerts, and post a sealed snapshot every interval.

  starbridge agent [--provider <name>]... [--interval 5m] [--codexbar <path>] [--no-quota]
      Run the machine's agent (as a user service): it holds the keys and the server
      connection, uploads quota snapshots every interval, and hands each Claude Code session
      its answers over a unix socket. Flags override agent.json in the config directory.
      The commands above go through it when it runs, and to the server directly when not
      (or with STARBRIDGE_NO_AGENT=1).

  starbridge permissions enable|disable|status
      Send this machine's Claude Code permission prompts to your devices, where they can be
      allowed or denied; the prompt stays open at the keyboard and the first answer wins.
      Off by default. The starbridge plugin's hooks do nothing while it is off.

  starbridge hook permission --agent claude-code [--wait 570s]
  starbridge hook settle --agent claude-code
      For Claude Code's PermissionRequest hook, and for its PostToolUse, PermissionDenied,
      Stop and SessionEnd hooks: hook JSON on stdin; prints the hook's decision, or nothing
      to leave the prompt to the keyboard.

  starbridge update
      Install the latest release once its signature checks out (brew and npm installs: use
      their manager).

  starbridge --version

Keys and state live in $STARBRIDGE_CONFIG_DIR, else $XDG_CONFIG_HOME/starbridge, else
~/.config/starbridge.`;

/** Questions on the terminal; without one, setup needs --yes. */
function interactive(): Prompt {
  if (!process.stdin.isTTY)
    throw new UsageError("no terminal to ask on: pass --yes to take every default");
  return terminalPrompt();
}

/** `--link remote-control=https://claude.ai/code/session_…`; the schema checks kind and URL. */
function parseLink(text: string): SessionLink {
  const at = text.indexOf("=");
  if (at <= 0) throw new UsageError(`--link takes <kind>=<url>: ${text}`);
  return { kind: text.slice(0, at), url: text.slice(at + 1) } as SessionLink;
}

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
            "session-title": { type: "string" },
            link: { type: "string", multiple: true },
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
          ...(v["session-title"] !== undefined ? { sessionTitle: v["session-title"] } : {}),
          ...(v.link !== undefined ? { links: v.link.map(parseLink) } : {}),
        };
        const opts = { wait: v.wait, timeout: v.timeout };
        return await withAgent(
          ctx,
          (agent) => askVia(ctx, agent, input, opts),
          () => ask(ctx, input, opts),
        );
      }
      case "wait": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { timeout: { type: "string" }, json: { type: "boolean" } },
        });
        const opts = { id: positionals[0], ...values };
        return await withAgent(
          ctx,
          (agent) => waitVia(ctx, agent, opts),
          () => wait(ctx, opts),
        );
      }
      case "answers": {
        const { values } = parseArgs({
          args: rest,
          options: {
            session: { type: "string" },
            wait: { type: "string" },
            ack: { type: "string", multiple: true },
          },
        });
        const target = values.session;
        if (!target) throw new UsageError("answers needs --session");
        if (values.ack && values.wait !== undefined) throw new UsageError("--ack takes no --wait");
        return await withAgent(
          ctx,
          (agent) => answersVia(ctx, agent, target, values),
          () => answers(ctx, values),
        );
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
        const opts = { ...values, providers: values.provider ?? [] };
        // A CodexBar path of the caller's choosing runs here, never in the agent.
        if (opts.codexbar !== undefined) return await quotaPush(ctx, opts);
        return await quotaPush(ctx, opts, () =>
          withAgent(
            ctx,
            (agent) => quotaVia(agent, opts.providers),
            () => pushOnce(ctx, opts),
          ),
        );
      }
      case "setup": {
        const { values: v } = parseArgs({
          args: rest,
          options: {
            yes: { type: "boolean", short: "y" },
            server: { type: "string" },
            name: { type: "string" },
            providers: { type: "string" },
            "no-quota": { type: "boolean" },
            "no-service": { type: "boolean" },
            "no-plugin": { type: "boolean" },
          },
        });
        const sys = makeSys(ctx, v.yes ? defaults : interactive());
        return await setup(sys, {
          ...(v.yes ? { yes: true } : {}),
          ...(v.server ? { server: v.server } : {}),
          ...(v.name ? { name: v.name } : {}),
          ...(v.providers !== undefined
            ? {
                providers: v.providers
                  .split(",")
                  .map((p) => p.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(v["no-quota"] ? { noQuota: true } : {}),
          ...(v["no-service"] ? { noService: true } : {}),
          ...(v["no-plugin"] ? { noPlugin: true } : {}),
        });
      }
      case "status":
        parseArgs({ args: rest, options: {} });
        return await status(makeSys(ctx, defaults));
      case "uninstall": {
        const { values: v } = parseArgs({
          args: rest,
          options: { yes: { type: "boolean", short: "y" }, purge: { type: "boolean" } },
        });
        return await uninstall(makeSys(ctx, v.yes ? defaults : interactive()), {
          purge: v.purge,
          install: installKind(),
        });
      }
      case "agent": {
        const { values } = parseArgs({
          args: rest,
          options: {
            provider: { type: "string", multiple: true },
            interval: { type: "string" },
            codexbar: { type: "string" },
            "no-quota": { type: "boolean" },
          },
        });
        return await runAgent(ctx, {
          ...(values.provider ? { providers: values.provider } : {}),
          ...(values.interval ? { interval: values.interval } : {}),
          ...(values.codexbar ? { codexbar: values.codexbar } : {}),
          ...(values["no-quota"] ? { noQuota: true } : {}),
        });
      }
      case "permissions":
        return permissionsCommand(ctx, rest[0]);
      case "hook": {
        const [sub, ...args] = rest;
        const { values } = parseArgs({
          args,
          options: { agent: { type: "string" }, wait: { type: "string" } },
        });
        if (sub === "permission") return await hookPermission(ctx, readText("-"), values);
        if (sub === "settle") return await hookSettle(ctx, readText("-"), values);
        throw new UsageError("usage: starbridge hook permission|settle --agent claude-code");
      }
      case "update":
        parseArgs({ args: rest, options: {} });
        return await update(ctx, installKind());
      case "--version":
      case "-v":
        ctx.out(`starbridge ${VERSION}`);
        return 0;
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
    // Ctrl-C during a call held at the agent, as a shell reports SIGINT.
    if (e instanceof Interrupted) return 130;
    if (
      e instanceof UsageError ||
      e instanceof ApiError ||
      e instanceof ProtocolError ||
      e instanceof ReleaseError ||
      e instanceof AgentError
    ) {
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
