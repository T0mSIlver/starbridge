import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ProtocolError, ready, type SessionLink } from "@starbridge/protocol";
import { AgentError, Interrupted, withAgent } from "./agent/client";
import { answersVia, askVia, quotaVia, waitingVia, waitVia } from "./agent/commands";
import { runAgent } from "./agent/main";
import { ApiError, sandboxHint, Unreachable } from "./api";
import { type Ctx, UsageError } from "./context";
import { type AskInput, answers, ask, resolveSource, settle, setWaiting, wait } from "./decisions";
import { hookAskUser, hookPermission, hookQuestion, hookSettle } from "./hook";
import { pair } from "./pair";
import { pushOnce, quotaPush } from "./quota";
import { installKind, ReleaseError } from "./release";
import { runCommand } from "./run";
import { configCommand } from "./settings";
import { setup } from "./setup/setup";
import { status } from "./setup/status";
import { defaults, makeSys, type Prompt, terminalPrompt } from "./setup/sys";
import { uninstall } from "./setup/uninstall";
import { update } from "./update";
import { VERSION } from "./version";

const HELP = `starbridge: post decisions to your devices, report runs, upload quota windows

  starbridge setup [--yes] [--server <url>] [--name <name>] [--providers <a,b>]
                   [--no-quota] [--no-service] [--no-plugin]
      Set this machine up, or check and repair it: pair it, find or install CodexBar and pick
      the providers to upload, install the agent as a user service (systemd or launchd), install
      Starbridge in each agent found (the Claude Code plugins, the Codex skill, the Pi package;
      --no-plugin skips them), and upload a first quota snapshot. Each step asks first; --yes
      takes every default, which installs CodexBar when it is missing, the plugins, and replaces
      a hand-written \`starbridge quota push\` unit and manual mod or skill installs.

  starbridge status
      Print the versions, the pairing, the agent and its service, the server, each provider, the
      Claude Code plugins, the Codex skill, the Pi package and the sessions the agent sees.

  starbridge uninstall [--yes] [--purge]
      Remove the agent service, the Claude Code plugins and this binary, and ask your devices to revoke this
      machine. Asks before it deletes the keys and state (--purge: without asking). CodexBar stays.

  starbridge pair [--server <url>] [--name <name>] [--force]
      Make this machine's keys and print a pairing code to type on a device.
      --server <url>          a self-hosted server (default: $STARBRIDGE_SERVER, else
                              https://starbridge.run)

  starbridge ask --question <text> [--option <text>]... [options]
      Post a decision to every paired device and print its id. Devices show it as
      "Working on other things" until \`waiting\` marks it.
      --context <text>        why it is asked and what each option changes
      --context-file <path>   the same, from a file ("-" for stdin)
      --option <text>         2 to 4 times; none asks for a free-text answer
      --recommended <text>    one of the options (default: the first)
      --waiting               you have nothing else to do: post it as waiting for the owner
      --agent <name>          claude-code, codex, pi or opencode (default: the one that
                              runs the command)
      --project <name>        default: the current directory's name
      --session <id>          default: the agent's session ($CLAUDE_CODE_SESSION_ID,
                              $CODEX_THREAD_ID, $PI_SESSION_ID,
                              $STARBRIDGE_OPENCODE_SESSION)
      --session-title <text>  default: the Claude Code, Pi or opencode session's name
      --image <path>          a PNG or JPEG to show with the question, up to 4 times;
                              scaled down to fit the server's size cap
      --link <url>            an https page to open, such as a claude.ai artifact,
                              up to 4 times; context only, the answer still comes here
      --answer-in <url>       the https page where the owner answers instead, such as
                              an artifact whose button wakes you; takes no --option.
                              Close it with \`settle\` once you have the answer
      --session-link <kind>=<url>
                              where to open the session, up to 3 times; kind is
                              remote-control, desktop or web (default: what Claude
                              Code records for the session: Remote Control, Desktop)
      --input <path>          read these fields from a JSON file ("-" for stdin)
      --wait                  then wait for the answer, as \`wait\` does
      --timeout <duration>    with --wait: give up then, as \`wait\` does

  starbridge waiting <decision id>
  starbridge working <decision id>
      Show the owner that you are now blocked on the decision ("Waiting for you", which
      notifies them once more), or back to working on other things.

  starbridge settle <decision id> [--outcome elsewhere|withdrawn]
      Close a decision without a Starbridge answer: answered on its --answer-in page
      (elsewhere, the default for those) or no longer needed (withdrawn). Devices move it
      out of the inbox.

  starbridge wait [<decision id>] [--timeout <duration>] [--json]
      Print the answer, or with no id the next answer to a decision this session asked (any
      decision from this machine, outside an agent's session).
      With an id, marks the decision waiting first. Waits until --timeout, else forever;
      exits 2 when --timeout passed.

  starbridge answers --session <id> [--wait <seconds>]
      For the Claude Code mod: print, as JSON lines, the unconfirmed answers to decisions that
      session asked. With --wait (at most 25), poll the server once first when there are none.

  starbridge answers --session <id> --ack <ack>...
      For the Claude Code mod: confirm it submitted these lines (each line's "ack"), so they
      are not printed again.

  starbridge run --title <text> --reason <text> -- <command> [<arg>...]
      Run the command, its output passed through unchanged, and show it on every device:
      the title, the reason, the time elapsed and the progress its output prints (OSC 9;4,
      [3/7], 42%), then pass or fail. Exits with the command's own code. Wrap the whole
      command, chained or not: -- bash -c 'make && make e2e'.
      --title <text>          what it is, at most 100 characters, e.g. "Mac e2e"
      --reason <text>         why the owner hears of it, at most 200 characters,
                              e.g. "uses your session and keyboard"

  starbridge quota push [--provider <name>]... [--interval 5m] [--once] [--codexbar <path>]
      Run \`codexbar usage --format json\` for each provider (or for every enabled one),
      compute pace and alerts, and post a sealed snapshot every interval.

  starbridge agent [--provider <name>]... [--interval 5m] [--codexbar <path>] [--no-quota]
      Run the machine's agent (as a user service): it holds the keys and the server
      connection, uploads quota snapshots every interval, and hands each Claude Code session
      its answers over a unix socket. Flags override agent.json in the config directory.
      The commands above go through it when it runs, and to the server directly when not
      (or with STARBRIDGE_NO_AGENT=1).

  starbridge config [permissions on|off] [machine-kind server|desktop|laptop|cloud]
      Print this machine's settings, or change one. permissions: send its Claude Code
      permission prompts to your devices, where they can be allowed or denied; the prompt
      stays open at the keyboard and the first answer wins. Off by default; while off, the
      starbridge plugin's permission hook exits at once. machine-kind: the icon devices
      show, detected by setup.

  starbridge hook permission --agent claude-code|pi|opencode [--wait 570s]
  starbridge hook settle --agent claude-code
      For Claude Code's PermissionRequest hook, and for its PostToolUse, PermissionDenied,
      Stop and SessionEnd hooks: hook JSON on stdin; prints the hook's decision, or nothing
      to leave the prompt to the keyboard. The Starbridge Pi extension runs it with --agent pi
      for pi-permission-system's prompts, the opencode plugin with --agent opencode.

  starbridge hook ask-user
      For Claude Code's PreToolUse hook on AskUserQuestion: hook JSON on stdin; answers each
      question by telling the agent to use \`starbridge ask\`; prints nothing, which lets it
      through, when this machine is not paired or the server does not answer.

  starbridge hook question --agent opencode
      For the Starbridge opencode plugin, on each call of opencode's question tool: posts each
      question to your devices, already waiting, and once all are answered prints
      {"answers": [[label], ...]} for opencode; prints nothing on any error. SIGTERM (the
      terminal answered) settles the questions still open.

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

/** `--session-link remote-control=https://claude.ai/code/session_…`; the schema checks both. */
function parseSessionLink(text: string): SessionLink {
  const at = text.indexOf("=");
  if (at <= 0) throw new UsageError(`--session-link takes <kind>=<url>: ${text}`);
  return { kind: text.slice(0, at), url: text.slice(at + 1) } as SessionLink;
}

function readText(path: string): string {
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read ${path === "-" ? "stdin" : path}: ${(e as Error).message}`);
  }
}

function readJson(path: string): unknown {
  const text = readText(path);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${path === "-" ? "stdin" : path} is not JSON: ${(e as Error).message}`);
  }
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
            waiting: { type: "boolean" },
            agent: { type: "string" },
            project: { type: "string" },
            session: { type: "string" },
            "session-title": { type: "string" },
            "session-link": { type: "string", multiple: true },
            image: { type: "string", multiple: true },
            link: { type: "string", multiple: true },
            "answer-in": { type: "string" },
            input: { type: "string" },
            wait: { type: "boolean" },
            timeout: { type: "string" },
          },
        });
        const { default: jsonDefault, ...fromJson }: AskInput & { default?: unknown } = v.input
          ? (readJson(v.input) as AskInput & { default?: unknown })
          : {};
        const input: AskInput = {
          ...fromJson,
          ...(v.question !== undefined ? { question: v.question } : {}),
          ...(v.context !== undefined ? { context: v.context } : {}),
          ...(v["context-file"] !== undefined ? { context: readText(v["context-file"]) } : {}),
          ...(v.option !== undefined ? { options: v.option } : {}),
          ...(v.recommended !== undefined ? { recommended: v.recommended } : {}),
          ...(v.waiting ? { waiting: true } : {}),
          ...(v.agent !== undefined ? { agent: v.agent as AskInput["agent"] } : {}),
          ...(v.project !== undefined ? { project: v.project } : {}),
          ...(v.session !== undefined ? { session: v.session } : {}),
          ...(v["session-title"] !== undefined ? { sessionTitle: v["session-title"] } : {}),
          ...(v["session-link"] !== undefined
            ? { sessionLinks: v["session-link"].map(parseSessionLink) }
            : {}),
          ...(v.image !== undefined ? { images: v.image } : {}),
          ...(v.link !== undefined ? { links: v.link } : {}),
          ...(v["answer-in"] !== undefined ? { answerIn: v["answer-in"] } : {}),
        };
        // Accepted so older commands still post: decisions have no default (#122, #352).
        for (const [flag, given] of [
          ["--default", v.default ?? jsonDefault],
          ["--default-at", v["default-at"]],
        ] as const)
          if (given !== undefined)
            ctx.err(`starbridge: ${flag} is ignored: agents never answer for the owner`);
        if (v.wait && input.answerIn !== undefined)
          throw new UsageError("--answer-in takes no --wait: the answer comes from that page");
        const opts = { wait: v.wait, timeout: v.timeout };
        return await withAgent(
          ctx,
          (agent) => askVia(ctx, agent, input, opts),
          () => ask(ctx, input, opts),
        );
      }
      case "settle": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { outcome: { type: "string" } },
        });
        return await settle(ctx, { id: positionals[0], ...values });
      }
      case "waiting":
      case "working": {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
        const opts = { id: positionals[0], state: command };
        return await withAgent(
          ctx,
          (agent) => waitingVia(agent, opts),
          () => setWaiting(ctx, opts),
        );
      }
      case "config":
        return await configCommand(ctx, rest, process.stdin.isTTY ? terminalPrompt() : undefined);
      case "wait": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { timeout: { type: "string" }, json: { type: "boolean" } },
        });
        const id = positionals[0];
        // Without an id, in an agent's session, only that session's answers: the others are due
        // to their own sessions. A script or terminal outside one still takes any.
        const session = id
          ? undefined
          : resolveSource({}, ctx.env, process.cwd()).session || undefined;
        const opts = { id, ...(session !== undefined ? { session } : {}), ...values };
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
      case "run": {
        // Everything after `--` is the command, flags included.
        const end = rest.indexOf("--");
        if (end < 0)
          throw new UsageError("run needs the command after --: starbridge run ... -- <command>");
        const { values } = parseArgs({
          args: rest.slice(0, end),
          options: { title: { type: "string" }, reason: { type: "string" } },
        });
        return await runCommand(ctx, { ...values, command: rest.slice(end + 1) });
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
      case "hook": {
        const [sub, ...args] = rest;
        const { values } = parseArgs({
          args,
          options: { agent: { type: "string" }, wait: { type: "string" } },
        });
        if (sub === "permission") return await hookPermission(ctx, readText("-"), values);
        if (sub === "settle") return await hookSettle(ctx, readText("-"), values);
        if (sub === "ask-user") return await hookAskUser(ctx, readText("-"));
        if (sub === "question") return await hookQuestion(ctx, readText("-"), values);
        throw new UsageError(
          "usage: starbridge hook permission|settle --agent claude-code, starbridge hook ask-user, or starbridge hook question --agent opencode",
        );
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
    if (e instanceof Unreachable) {
      ctx.err(`starbridge: ${e.message}`);
      const hint = sandboxHint(ctx.env);
      if (hint) ctx.err(`starbridge: ${hint}`);
      return 1;
    }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      ctx.err(`starbridge: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
