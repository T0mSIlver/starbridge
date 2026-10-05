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

/** The fields of pi-permission-system's `PromptPermissionDetails` this link reads. */
export interface AskDetails {
  toolName?: string;
  command?: string;
  path?: string;
  payload?: { request?: { surface?: string; toolName?: string; value?: string } };
}

/** pi-permission-system's `AuthorizerVerdict`. */
export type Verdict = { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "defer" };

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
        : { value: req?.value ?? "" };
  return { session_id: session, cwd, tool_name: tool, tool_input: input };
}

/** The verdict in what the CLI printed: Claude Code's `PermissionRequest` decision, or none. */
export function verdictOf(stdout: string): Verdict {
  try {
    const d = (JSON.parse(stdout) as { hookSpecificOutput?: { decision?: unknown } })
      .hookSpecificOutput?.decision as { behavior?: unknown; message?: unknown } | undefined;
    if (d?.behavior === "allow") return { kind: "allow" };
    if (d?.behavior === "deny")
      return { kind: "deny", ...(typeof d.message === "string" ? { reason: d.message } : {}) };
  } catch {}
  return { kind: "defer" };
}

export interface LinkDeps {
  /** Runs the CLI's hook with `stdin`; an abort ends it as the keyboard answering. */
  hook(stdin: string, signal: AbortSignal): Promise<string>;
  /** Resolves when the keyboard takes the prompt back; never while `signal` aborts it. */
  keyboard?(signal: AbortSignal): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** How long the CLI gets to defer at once (Starbridge off, unpaired) before the dialog shows. */
export const QUIET_MS = 1_000;

/** Asks the devices, and the keyboard when there is one; the first to answer decides. */
export async function authorize(
  stdin: string,
  deps: LinkDeps,
  quietMs = QUIET_MS,
): Promise<Verdict> {
  const devices = new AbortController();
  const here = new AbortController();
  const answered = deps
    .hook(stdin, devices.signal)
    .then(verdictOf, () => ({ kind: "defer" }) as Verdict);
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
  return answered;
}
