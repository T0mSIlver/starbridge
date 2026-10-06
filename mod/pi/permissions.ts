/**
 * Permission prompts from Pi (#232). Pi has no approval step of its own; most Pi users run
 * `@gotgenes/pi-permission-system`, whose authorizer chain asks each registered link before its
 * own dialog when a rule says `ask`. The Starbridge link sends the prompt to the owner's devices
 * with `starbridge hook permission --agent pi`, the same command Claude Code's hook runs, and
 * maps its answer: allow (this call only, as the chain grants a link), deny with the owner's
 * message, or defer, which brings up pi-permission-system's own dialog. The CLI defers by
 * printing nothing: Starbridge off (`starbridge config permissions`), the machine unpaired, the
 * server out of reach, or nobody answered in time.
 *
 * While the devices have it, the keyboard can still take it: a small dialog offers "Answer
 * here", which takes the prompt back from the devices and opens pi-permission-system's dialog.
 */
import { STOP_MS, type Verdict, verdictOf } from "../hooks/node.ts";

export { STOP_MS, verdictOf };

/** The fields of pi-permission-system's `PromptPermissionDetails` this link reads. */
export interface AskDetails {
  requestId?: string;
  toolName?: string;
  command?: string;
  path?: string;
  /** What a non-bash, non-path ask is about, such as the file a `read` gate checks. */
  target?: string;
  /** pi-permission-system's own one-line rendering of the call's input. */
  toolInputPreview?: string;
  payload?: { request?: { surface?: string; toolName?: string; value?: string } };
}

/** pi-permission-system's `AuthorizerVerdict`, which is the CLI's. */
export type { Verdict };

/** The link's name, which the owner adds to pi-permission-system's `authorizerChain`. */
export const LINK = "starbridge";

/** The service pi-permission-system publishes for each session, on `globalThis`. */
const SERVICES = Symbol.for("@gotgenes/pi-permission-system:session-services");

export interface PermissionsService {
  registerAuthorizer(
    name: string,
    authorize: (details: AskDetails) => Promise<Verdict>,
  ): () => void;
}

/** pi-permission-system's service for session `id`, when it runs in this process. */
export function permissionsService(id: string): PermissionsService | undefined {
  const map = (globalThis as Record<symbol, unknown>)[SERVICES];
  const service = map instanceof Map ? map.get(id) : undefined;
  return typeof service?.registerAuthorizer === "function" ? service : undefined;
}

/** The hook input `starbridge hook permission` reads, in Claude Code's shape. */
export function hookInput(details: AskDetails, session: string, cwd: string) {
  const req = details.payload?.request;
  const tool = details.toolName ?? req?.toolName ?? req?.surface ?? "tool";
  const input =
    details.command !== undefined
      ? { command: details.command }
      : details.path !== undefined
        ? { path: details.path }
        : details.target !== undefined
          ? { path: details.target }
          : details.toolInputPreview !== undefined
            ? { preview: details.toolInputPreview }
            : { value: req?.value ?? "" };
  return { session_id: session, cwd, tool_name: tool, tool_input: input };
}

export interface LinkDeps {
  /** Runs the CLI's hook with `stdin`; an abort ends it as the keyboard answering. */
  hook(stdin: string, signal: AbortSignal): Promise<string>;
  /** Resolves when the keyboard takes the prompt back; never while `signal` aborts it. */
  keyboard?(signal: AbortSignal): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Aborts when the session ends: the CLI settles the prompt on the devices, and the link defers. */
  ended?: AbortSignal;
}

/** How long the CLI gets to defer at once (Starbridge off, unpaired) before the dialog shows. */
export const QUIET_MS = 1_000;

/**
 * How long the link waits for the CLI at most: its own wait (570 s) plus slack. A CLI stuck on a
 * stalled server must never hold the prompt, nor the keyboard's dialog after it.
 */
export const HOOK_MS = 600_000;

/** Asks the devices, and the keyboard when there is one; the first to answer decides. */
export async function authorize(
  stdin: string,
  deps: LinkDeps,
  quietMs = QUIET_MS,
  limits = { hookMs: HOOK_MS, stopMs: STOP_MS },
): Promise<Verdict> {
  const devices = new AbortController();
  const here = new AbortController();
  const end = () => {
    here.abort();
    devices.abort();
  };
  if (deps.ended?.aborted) return { kind: "defer" };
  deps.ended?.addEventListener("abort", end);
  try {
    return await decide(stdin, deps, quietMs, limits, devices, here);
  } finally {
    deps.ended?.removeEventListener("abort", end);
  }
}

async function decide(
  stdin: string,
  deps: LinkDeps,
  quietMs: number,
  limits: { hookMs: number; stopMs: number },
  devices: AbortController,
  here: AbortController,
): Promise<Verdict> {
  const defer = { kind: "defer" } as Verdict;
  const hook = deps.hook(stdin, devices.signal).then(verdictOf, () => defer);
  /** The CLI's verdict, or defer once it overran `ms`; then it is stopped. */
  const within = (ms: number) =>
    Promise.race([
      hook,
      deps.sleep(ms).then(() => {
        devices.abort();
        return defer;
      }),
    ]);
  const answered = within(limits.hookMs);
  const keyboard = deps.keyboard;
  if (!keyboard) return answered;
  const quick = await Promise.race([answered, deps.sleep(quietMs).then(() => undefined)]);
  if (quick) return quick;
  const first = await Promise.race([
    answered,
    keyboard(here.signal).then(() => "keyboard" as const),
  ]);
  if (first !== "keyboard") {
    here.abort();
    return first;
  }
  // The CLI settles the prompt on the devices as answered at the keyboard and prints nothing,
  // unless a device's answer came first.
  devices.abort();
  return within(limits.stopMs);
}
