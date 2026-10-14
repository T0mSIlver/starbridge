import { spawn } from "node:child_process";
import { computePace, type QuotaSnapshot, type QuotaWindow } from "@starbridge/protocol";
import { killTree, spawnable } from "./platform";

/**
 * Reads `codexbar usage --format json`. CodexBar's JSON has no stable contract, so this takes
 * only the fields it knows, skips anything malformed, and ignores the rest.
 */

export type ProviderQuota = QuotaSnapshot["providers"][number];

/**
 * Above CodexBar's own worst case, so its retries run out before this does: Claude's probe gives
 * `claude` 12 s, then 60 s, each followed by up to 8 s for `claude /usage` (#397).
 */
const RUN_TIMEOUT_MS = 120_000;
/** What one run may print before it is stopped, and what is read of its stderr. */
export const MAX_STDOUT_BYTES = 1 << 20;
const MAX_STDERR_BYTES = 64 << 10;
/** How long after the process exits its pipes may stay open, held by a child it left behind. */
const EXIT_GRACE_MS = 500;
/** The most providers, and the most extra windows of one, taken from CodexBar. */
export const MAX_PROVIDERS = 20;
const MAX_EXTRA_WINDOWS = 20;

/** Kills the process and everything it started: its own group on Unix, its tree on Windows. */
function killGroup(child: ReturnType<typeof spawn>) {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      return void process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  killTree(child);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCodexbar(
  bin: string,
  provider: string | undefined,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<RunResult> {
  const args = ["usage", "--format", "json", ...(provider ? ["--provider", provider] : [])];
  return new Promise((resolve) => {
    // A `.cmd` on Windows starts only through cmd.exe, as every other command the CLI runs.
    let start: ReturnType<typeof spawnable>;
    try {
      start = spawnable(bin, args);
    } catch (e) {
      return resolve({ code: null, stdout: "", stderr: (e as Error).message });
    }
    const child = spawn(start.file, start.args, {
      windowsVerbatimArguments: start.windowsVerbatimArguments,
      windowsHide: true,
      // Its own process group on Unix, so a timeout reaches what CodexBar started too.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_STDOUT_BYTES) {
        killGroup(child);
        return finish({ code: null, stdout: "", stderr: `output over ${MAX_STDOUT_BYTES} bytes` });
      }
      stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += d;
    });
    const timer = setTimeout(() => killGroup(child), timeoutMs);
    child.on("error", (e) => finish({ code: null, stdout, stderr: e.message }));
    // `close` waits for every pipe, which a child CodexBar left running holds open.
    child.on("exit", (code) => {
      killGroup(child);
      setTimeout(() => finish({ code, stdout, stderr }), EXIT_GRACE_MS).unref();
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : undefined);
/** `s` cut to `n` characters, control and format characters (escape sequences, bidi) dropped. */
const clip = (s: string, n: number) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").slice(0, n);

function isoOrNull(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = Date.parse(x);
  return Number.isNaN(t) ? null : `${new Date(t).toISOString().slice(0, 19)}Z`;
}

/**
 * CodexBar calls Claude's and Codex's 5-hour window "Session", which read as the weekly limit in a
 * notification (#844): such a window is named by its length, as z.ai's already is ("5-hour").
 */
function named(label: string, minutes: number | null): string {
  if (label !== "Session" || minutes === null || minutes >= 24 * 60 || minutes % 60 !== 0)
    return label;
  return `${minutes / 60}-hour`;
}

function window(id: string, label: string, raw: unknown, now: Date): QuotaWindow | undefined {
  if (!isObj(raw)) return undefined;
  const used = raw.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined;
  const minutes = raw.windowMinutes;
  const windowMinutes =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 1
      ? Math.round(minutes)
      : null;
  const w = {
    id: clip(id, 100),
    label: clip(named(label, windowMinutes), 100),
    usedPercent: used,
    windowMinutes,
    resetsAt: isoOrNull(raw.resetsAt),
  };
  return { ...w, pace: computePace(w, now) };
}

/** One provider's windows from one row of CodexBar's output. */
export function parseRow(row: Obj, now: Date): ProviderQuota {
  const provider = clip(str(row.provider) ?? "unknown", 100);
  const usage = isObj(row.usage) ? row.usage : {};
  const labels = isObj(row.rateWindowLabels) ? row.rateWindowLabels : {};
  const extras: QuotaWindow[] = [];
  const extraRows = Array.isArray(usage.extraRateWindows) ? usage.extraRateWindows : [];
  for (const x of extraRows.slice(0, MAX_EXTRA_WINDOWS)) {
    if (!isObj(x) || !str(x.id)) continue;
    const w = window(x.id as string, str(x.title) ?? (x.id as string), x.window, now);
    if (w) extras.push(w);
  }
  // Antigravity's primary and secondary repeat its most used named window of each model family
  // (#963): a main window equal to a named one shows once, under the name.
  const same = (a: QuotaWindow, b: QuotaWindow) =>
    a.usedPercent === b.usedPercent &&
    a.windowMinutes === b.windowMinutes &&
    a.resetsAt === b.resetsAt;
  const windows: QuotaWindow[] = [];
  for (const key of ["primary", "secondary", "tertiary"]) {
    const w = window(key, str(labels[key]) ?? key, usage[key], now);
    if (w && !extras.some((x) => same(w, x))) windows.push(w);
  }
  windows.push(...extras);
  const identity = isObj(usage.identity) ? usage.identity : {};
  const account = str(identity.accountEmail) ?? str(usage.accountEmail);
  const error = rowError(row);
  return {
    provider,
    ...(account ? { account: clip(account, 200) } : {}),
    windows,
    ...(error ? { error } : {}),
  };
}

function rowError(row: Obj): string | undefined {
  const e = row.error;
  if (typeof e === "string") return clip(e, 1000);
  if (isObj(e)) return clip(str(e.message) ?? JSON.stringify(e), 1000);
  return undefined;
}

/**
 * Parses one run. With `provider`, keeps that provider's rows only: CodexBar falls back to every
 * enabled provider when it does not know the name. Throws when the output is not a JSON array.
 */
export function parseUsage(stdout: string, provider: string | undefined, now: Date) {
  const json: unknown = JSON.parse(stdout || "[]");
  if (!Array.isArray(json)) throw new Error("codexbar output is not a JSON array");
  const rows = json.filter(isObj).map((r) => parseRow(r, now));
  return (provider ? rows.filter((r) => r.provider === provider) : rows).slice(0, MAX_PROVIDERS);
}

function tryParse(stdout: string, provider: string | undefined, now: Date): ProviderQuota[] {
  try {
    return parseUsage(stdout, provider, now);
  } catch {
    return [];
  }
}

/**
 * Every provider asked for, with an `error` entry for each that failed or was missing. A provider
 * that fails is asked once more before its failure counts: CodexBar's Claude probe drives the
 * `claude` TUI and times out now and then on a busy machine (#397). A run that hung until
 * RUN_TIMEOUT_MS is not asked again. Throws when a run for every provider fails as a whole, so
 * no snapshot replaces the last one. Errors are logged whole and returned short (`shortError`).
 */
export async function collect(
  bin: string,
  providers: string[],
  now: () => Date,
  log: (line: string) => void,
  run: typeof runCodexbar = runCodexbar,
): Promise<ProviderQuota[]> {
  // Providers are read at once, so a snapshot takes as long as the slowest one: a device's
  // refresh waits for it (#450). The rows keep the providers' order.
  const one = async (p: string | undefined): Promise<ProviderQuota[]> => {
    let first = await once(bin, p, now, run);
    if ("failed" in first && first.retry) {
      log(`codexbar all: ${first.failed}; retrying`);
      first = await once(bin, p, now, run);
    }
    if ("failed" in first) throw new Error(`codexbar: ${first.failed}`);
    const out: ProviderQuota[] = [];
    for (const row of first.rows) {
      if (!row.error || !first.retry) {
        if (row.error) log(`codexbar ${row.provider}: ${row.error}`);
        out.push(row);
        continue;
      }
      log(`codexbar ${row.provider}: ${row.error}; retrying`);
      const again = await once(bin, row.provider, now, run);
      const rows = "rows" in again ? again.rows : [];
      for (const x of rows) if (x.error) log(`codexbar ${x.provider}: ${x.error}`);
      out.push(...rows);
    }
    return out;
  };
  const asked = providers.length > 0 ? providers.slice(0, MAX_PROVIDERS) : [undefined];
  const out = (await Promise.all(asked.map(one))).flat();
  // The log above keeps each error whole; devices get it in words for the owner.
  return out.map((r) => (r.error ? { ...r, error: shortError(r.error) } : r));
}

/**
 * A provider's error in words for the owner (#450): an HTTP failure becomes "Mistral's usage API
 * failed (500)", and a response body that CodexBar quotes, JSON or HTML, is cut off.
 */
export function shortError(error: string): string {
  const named = /^(.+?) API error: HTTP (\d{3})\b/.exec(error);
  if (named) return `${named[1]}'s usage API failed (${named[2]})`;
  const status = /\bHTTP (\d{3})\b/.exec(error);
  if (status) return `The usage API failed (${status[1]})`;
  const body = error.search(/:\s*[{<]/);
  const head = (body < 0 ? error : error.slice(0, body)).replace(/[\s:;,-]+$/, "");
  return head ? clip(head, 200) : "CodexBar's error was unreadable";
}

/**
 * One run for `p`, or every enabled provider. A run that fails without rows gives an error row for
 * `p`, or `failed` for every provider; `retry` is false when it hung until the timeout.
 */
async function once(
  bin: string,
  p: string | undefined,
  now: () => Date,
  run: typeof runCodexbar,
): Promise<({ rows: ProviderQuota[] } | { failed: string }) & { retry: boolean }> {
  const r = await run(bin, p);
  const retry = r.code !== null;
  const failure = (error: string) =>
    p
      ? { rows: [{ provider: p, windows: [], error: clip(error, 1000) }], retry }
      : { failed: error, retry };
  if (r.code !== 0) {
    // A provider that cannot fetch exits 1 with its reason in its JSON row, beside the others.
    const rows = r.code === null ? [] : tryParse(r.stdout, p, now());
    if (rows.length > 0 && rows.some((x) => x.error)) return { rows, retry };
    const last = r.stderr.trim().split("\n").pop() ?? "";
    return failure(`exited ${r.code ?? "on a signal"}${last ? `: ${last}` : ""}`);
  }
  let rows: ProviderQuota[];
  try {
    rows = parseUsage(r.stdout, p, now());
  } catch (e) {
    return failure(`unreadable output: ${(e as Error).message}`);
  }
  if (rows.length === 0 && p) return failure("missing from codexbar's output");
  return { rows, retry };
}
