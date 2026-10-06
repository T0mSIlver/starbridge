import { spawn } from "node:child_process";
import { computePace, type QuotaSnapshot, type QuotaWindow } from "@starbridge/protocol";

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
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : undefined);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function isoOrNull(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = Date.parse(x);
  return Number.isNaN(t) ? null : `${new Date(t).toISOString().slice(0, 19)}Z`;
}

function window(id: string, label: string, raw: unknown, now: Date): QuotaWindow | undefined {
  if (!isObj(raw)) return undefined;
  const used = raw.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined;
  const minutes = raw.windowMinutes;
  const w = {
    id: clip(id, 100),
    label: clip(label, 100),
    usedPercent: used,
    windowMinutes:
      typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 1
        ? Math.round(minutes)
        : null,
    resetsAt: isoOrNull(raw.resetsAt),
  };
  return { ...w, pace: computePace(w, now) };
}

/** One provider's windows from one row of CodexBar's output. */
export function parseRow(row: Obj, now: Date): ProviderQuota {
  const provider = clip(str(row.provider) ?? "unknown", 100);
  const usage = isObj(row.usage) ? row.usage : {};
  const labels = isObj(row.rateWindowLabels) ? row.rateWindowLabels : {};
  const windows: QuotaWindow[] = [];
  for (const key of ["primary", "secondary", "tertiary"]) {
    const w = window(key, str(labels[key]) ?? key, usage[key], now);
    if (w) windows.push(w);
  }
  const extras = Array.isArray(usage.extraRateWindows) ? usage.extraRateWindows : [];
  for (const x of extras) {
    if (!isObj(x) || !str(x.id)) continue;
    const w = window(x.id as string, str(x.title) ?? (x.id as string), x.window, now);
    if (w) windows.push(w);
  }
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
  return provider ? rows.filter((r) => r.provider === provider) : rows;
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
 * no snapshot replaces the last one.
 */
export async function collect(
  bin: string,
  providers: string[],
  now: () => Date,
  log: (line: string) => void,
  run: typeof runCodexbar = runCodexbar,
): Promise<ProviderQuota[]> {
  const out: ProviderQuota[] = [];
  for (const p of providers.length > 0 ? providers : [undefined]) {
    let first = await once(bin, p, now, run);
    if ("failed" in first && first.retry) {
      log(`codexbar all: ${first.failed}; retrying`);
      first = await once(bin, p, now, run);
    }
    if ("failed" in first) throw new Error(`codexbar: ${first.failed}`);
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
  }
  return out;
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
