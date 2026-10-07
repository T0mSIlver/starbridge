/**
 * The launch watcher (#782), run from the operator's machine every few minutes:
 *
 *   bun deploy/watch/watch.ts            # report; exit 1 on an alert not raised in the last hour
 *   bun deploy/watch/watch.ts --all      # exit 1 on any alert that holds
 *
 * It reads the box through deploy/host/watch.sh over SSH, times the public pages from outside,
 * and judges both against thresholds.ts. It prints a short report, then one JSON line, and keeps
 * the readings that "for N minutes" thresholds need in ~/.local/state/starbridge-watch.json.
 * Exit 0: nothing new; 1: an alert; 2: the watcher itself failed (also worth a look).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { THRESHOLDS } from "./thresholds";

type T = typeof THRESHOLDS;

export interface Reading {
  at: string;
  load: [number, number, number];
  steal: number;
  memTotalMB: number;
  memUsedMB: number;
  diskFree: number;
  containers: Record<
    string,
    { restarts: number; oomKilled: boolean; running: boolean; memMB?: number; cpu?: number }
  >;
  kernelOom: number;
  logs: {
    refusals: { counts: Record<string, number>; accounts: Record<string, number> };
    stackTraces: number;
    sqlite: number;
    diskFull: number;
    pushQueueFull: number;
    pushFailed: number;
    githubSignIn: number;
    caddyErrors: number;
  };
  dbBytes: number;
  connections: {
    total: number;
    addresses: number;
    busiest: number;
    named: Record<string, number>;
    toServer: number;
  };
  addresses: {
    addressesLastMinute: number;
    busiestLastMinute: number;
    busy: Record<string, number>;
    limited: Record<string, number>;
  } | null;
  top: {
    accounts: number;
    signUpsLastHour: number;
    signInsLastHour: number;
    machinesPairedLastHour: number;
    pendingPairings: number;
    byBytes: { account: string; bytes: number; items: number }[];
    byPostsLastHour: { account: string; postsLastHour: number; machines: number }[];
  } | null;
}

export interface Probe {
  url: string;
  status: number;
  ms: number;
}

export interface Sample {
  at: number;
  memUsedMB: number;
  slowestMs: number;
  dbBytes: number;
}

export interface State {
  lastRun?: string;
  history: Sample[];
  /** When each alert key last woke the watcher. */
  alerted: Record<string, number>;
  restarts: Record<string, number>;
}

export interface Alert {
  key: string;
  what: string;
  /** A command that answers it, for the owner to approve; none when only a person can act. */
  response?: string;
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const SWITCH = "deploy/switch.sh";

/** Sums the refusal counts whose key ("429 rate-limited POST /v1/items") matches. */
function refused(r: Reading, test: (status: number, error: string, route: string) => boolean) {
  let n = 0;
  for (const [key, v] of Object.entries(r.logs.refusals.counts)) {
    const [status, error, method, route] = key.split(" ");
    if (test(Number(status), error ?? "", `${method} ${route}`)) n += v;
  }
  return n;
}

/**
 * True when every sample of the last `minutes` crosses, from the last one taken at or before
 * the span began, so readings every few minutes still cover it.
 */
function sustained(history: Sample[], now: number, minutes: number, over: (s: Sample) => boolean) {
  const start = now - minutes * 60_000;
  const first = history.findLastIndex((s) => s.at <= start);
  return first >= 0 && history.slice(first).every(over);
}

export function judge(
  r: Reading,
  probes: Probe[],
  state: State,
  now: number,
  t: T = THRESHOLDS,
): Alert[] {
  const alerts: Alert[] = [];
  const add = (key: string, what: string, response?: string) =>
    alerts.push({ key, what, ...(response && { response }) });
  const h = state.history;

  if (r.load[2] > t.load15)
    add(
      "load",
      `load ${r.load.join(" ")} (15-min over ${t.load15}): resize the VPS if it holds (watch.md)`,
    );
  if (r.steal > t.stealPercent) add("steal", `CPU steal ${r.steal}% (over ${t.stealPercent}%)`);
  if (sustained(h, now, t.memoryMinutes, (s) => s.memUsedMB > t.memoryUsedMB))
    add(
      "memory",
      `memory ${r.memUsedMB} MB used for ${t.memoryMinutes} min (over ${t.memoryUsedMB}); Caddy ${r.containers["starbridge-caddy-1"]?.memMB ?? "?"} MB: resize to 8 GB (watch.md)`,
    );
  for (const [name, c] of Object.entries(r.containers)) {
    if (c.oomKilled) add(`oom:${name}`, `${name} was OOM-killed`);
    if (c.restarts > (state.restarts[name] ?? c.restarts))
      add(`restart:${name}`, `${name} restarted (${c.restarts} restarts)`);
  }
  if (r.kernelOom > 0)
    add("kernel-oom", `${r.kernelOom} kernel OOM lines since ${state.lastRun ?? "the last run"}`);
  if (r.diskFree < t.diskFreeBytes)
    add(
      "disk",
      `disk ${(r.diskFree / GB).toFixed(1)} GB free (under ${t.diskFreeBytes / GB}): prune Docker build cache`,
      "ssh -i ~/.ssh/starbridge_ed25519 deploy@starbridge.run sudo docker builder prune -f",
    );

  for (const p of probes)
    if (p.status !== 200)
      add(`health:${p.url}`, `${p.url} answered ${p.status || "nothing"} in ${p.ms} ms`);
  const slowest = Math.max(0, ...probes.map((p) => p.ms));
  if (sustained(h, now, t.slowMinutes, (s) => s.slowestMs > t.slowMs))
    add("slow", `responses over ${t.slowMs} ms for ${t.slowMinutes} min (now ${slowest} ms)`);

  const l = r.logs;
  if (l.stackTraces >= t.stackTraces)
    add("stack", `${l.stackTraces} stack traces in the server log: file an issue for each new one`);
  if (l.sqlite >= t.sqlite) add("sqlite", `${l.sqlite} SQLITE_ errors in the server log`);
  if (l.diskFull >= t.diskFull) add("disk-full", "the server refused writes: disk full");
  if (l.pushQueueFull >= t.pushQueueFull)
    add("push-queue", `${l.pushQueueFull} "push queue full" lines`);
  if (l.pushFailed >= t.pushFailed)
    add(
      "push-failed",
      `${l.pushFailed} push failures: check the FCM service account (deploy/host/check-fcm.sh)`,
    );
  if (l.githubSignIn >= t.githubSignIn)
    add(
      "github",
      `${l.githubSignIn} GitHub sign-in errors: check the OAuth app and githubstatus.com`,
    );
  if (l.caddyErrors >= t.caddyErrors)
    add("caddy-errors", `${l.caddyErrors} Caddy error lines (502s, upstream failures)`);

  const accounts = Object.entries(l.refusals.accounts);
  const worst = accounts[0];
  const suspend = worst ? `${SWITCH} suspend ${worst[0]}` : undefined;
  const fiveXX = refused(r, (s, e) => s >= 500 && e !== "storage-full");
  if (fiveXX >= t.serverErrors) add("5xx", `${fiveXX} 5xx answers from the server`);
  const signIn = refused(
    r,
    (s, _e, route) =>
      s === 429 && /auth\/github\/callback|auth\/app\/session|POST \/v1\/pairings$/.test(route),
  );
  if (signIn >= t.signInLimited)
    add(
      "signin-429",
      `${signIn} 429s on sign-in or pairing: a NAT signing up together, or a script`,
    );
  const limited = refused(r, (s) => s === 429);
  if (limited >= t.limited)
    add(
      "429",
      `${limited} 429s since the last run; most refused: ${accounts.map(([a, n]) => `${a} ${n}`).join(", ") || "no account"}`,
      suspend,
    );
  const cap = refused(r, (s, e) => s === 403 && e === "machine-cap");
  if (cap >= t.machineCap)
    add(
      "machine-cap",
      `${cap} machine-cap refusals: raise MAX_MACHINES?`,
      `${SWITCH} limits set maxMachines 5`,
    );
  const full = refused(
    r,
    (s, e) => s === 409 && ["too-many-items", "account-full", "directory-full"].includes(e),
  );
  if (full >= t.accountFull)
    add("account-full", `${full} too-many-items/account-full/directory-full refusals`, suspend);
  const large = refused(r, (s) => s === 413);
  if (large >= t.tooLarge) add("413", `${large} 413 too-large refusals`, suspend);
  const storage = refused(r, (s, e) => s === 503 && e === "storage-full");
  if (storage >= t.storageFull)
    add("storage-full", `${storage} storage-full refusals: the server-wide byte cap is reached`);

  if (r.dbBytes > t.dbBytes)
    add("db", `database ${(r.dbBytes / MB).toFixed(0)} MB (over ${t.dbBytes / MB})`);
  const hourAgo = h.find((s) => s.at >= now - 3_600_000);
  if (hourAgo && now - hourAgo.at >= 30 * 60_000) {
    const perHour = ((r.dbBytes - hourAgo.dbBytes) * 3_600_000) / (now - hourAgo.at);
    if (perHour > t.dbGrowthPerHour)
      add(
        "db-growth",
        `database growing ${(perHour / MB).toFixed(0)} MB an hour (over ${t.dbGrowthPerHour / MB})`,
      );
  }

  const c = r.connections;
  if (c.toServer > t.toServer)
    add("long-polls", `${c.toServer} connections from Caddy to the server (over ${t.toServer})`);
  // Tom's rule: an address is named only while it holds over 200 connections or is being
  // rate-limited, by Caddy (at its cap) or by the server (429s). The alerts' keys hold the
  // number of named addresses, never one, since the state file is on disk; a new address
  // changes the number and wakes the watcher again.
  const named: [string, string][] = [];
  for (const [a, n] of Object.entries(c.named))
    if (n > t.addressConnections)
      named.push([a, `${a} holds ${n} connections (over ${t.addressConnections})`]);
  for (const [a, n] of Object.entries(r.addresses?.busy ?? {}))
    if (n >= t.addressRequests)
      named.push([a, `${a} made ${n} /v1 requests in a minute: Caddy refuses it past 3000`]);
  for (const [a, n] of Object.entries(r.addresses?.limited ?? {}))
    if (n >= t.addressLimited)
      named.push([a, `${a} was refused ${n} times with 429 by the server in the last 2 minutes`]);
  const distinct = new Set(named.map(([a]) => a)).size;
  for (const [a, what] of named) add(`addresses:${distinct}`, what, `${SWITCH} block ${a}`);

  const top = r.top;
  if (top && top.signUpsLastHour > t.signUpsPerHour)
    add(
      "signups",
      `${top.signUpsLastHour} sign-ups in the last hour (over ${t.signUpsPerHour})`,
      `${SWITCH} signups pause`,
    );
  for (const a of top?.byPostsLastHour ?? [])
    if (a.postsLastHour > t.accountPostsPerHour)
      add(
        `posts:${a.account}`,
        `account ${a.account} posted ${a.postsLastHour} items in the last hour from ${a.machines} machines`,
        `${SWITCH} suspend ${a.account}`,
      );
  for (const a of top?.byBytes ?? [])
    if (a.bytes > t.accountBytes)
      add(
        `bytes:${a.account}`,
        `account ${a.account} stores ${(a.bytes / MB).toFixed(0)} MB in ${a.items} items`,
        `${SWITCH} suspend ${a.account}`,
      );
  return alerts;
}

/** The report's first lines: what the box looks like now, whatever crossed. */
export function summary(r: Reading, probes: Probe[]): string[] {
  const mem = Object.entries(r.containers)
    .filter(([, c]) => c.running)
    .map(([n, c]) => `${n.replace(/^starbridge-|-1$/g, "")} ${c.memMB ?? "?"}`)
    .join(", ");
  const top = r.top;
  return [
    `starbridge.run at ${r.at}: load ${r.load.join(" ")}, steal ${r.steal}%, memory ${r.memUsedMB}/${r.memTotalMB} MB (${mem}), disk ${(r.diskFree / GB).toFixed(1)} GB free, db ${(r.dbBytes / MB).toFixed(1)} MB`,
    `pages: ${probes.map((p) => `${new URL(p.url).host}${new URL(p.url).pathname} ${p.status} ${p.ms} ms`).join(", ")}`,
    `connections: ${r.connections.total} from ${r.connections.addresses} addresses (busiest ${r.connections.busiest}), ${r.connections.toServer} to the server; /v1 busiest address ${r.addresses?.busiestLastMinute ?? "?"} a minute`,
    top
      ? `accounts: ${top.accounts}; last hour ${top.signUpsLastHour} sign-ups, ${top.signInsLastHour} sign-ins, ${top.machinesPairedLastHour} machines paired`
      : "accounts: the server has no `top` command yet",
  ];
}

async function probe(url: string): Promise<Probe> {
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
    await res.arrayBuffer();
    return { url, status: res.status, ms: Math.round(performance.now() - start) };
  } catch {
    return { url, status: 0, ms: Math.round(performance.now() - start) };
  }
}

const PROBES = [
  "https://starbridge.run/healthz",
  "https://starbridge.run/",
  "https://starbridge.run/healthz/backup",
  "https://starbridge.run/healthz/disk",
  "https://demo.starbridge.run/healthz",
];

async function main() {
  const all = process.argv.includes("--all");
  const file = join(homedir(), ".local/state/starbridge-watch.json");
  let state: State = { history: [], alerted: {}, restarts: {} };
  try {
    state = { ...state, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {}
  const now = Date.now();
  const since = state.lastRun ?? new Date(now - 5 * 60_000).toISOString();
  const script = readFileSync(join(import.meta.dir, "../host/watch.sh"));
  const ssh = Bun.spawn(
    [
      "ssh",
      "-i",
      join(homedir(), ".ssh/starbridge_ed25519"),
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "deploy@starbridge.run",
      "sudo",
      "sh",
      "-s",
      "--",
      "--since",
      since,
      "--conns",
      String(THRESHOLDS.addressConnections),
      "--over",
      String(THRESHOLDS.addressRequests),
    ],
    { stdin: script, stdout: "pipe", stderr: "pipe" },
  );
  const [probes, out, err, code] = await Promise.all([
    Promise.all(PROBES.map(probe)),
    new Response(ssh.stdout).text(),
    new Response(ssh.stderr).text(),
    ssh.exited,
  ]);
  if (code !== 0) {
    console.log(
      `watcher: SSH to starbridge.run failed (exit ${code}): ${err.trim().slice(0, 300)}`,
    );
    console.log(`pages: ${probes.map((p) => `${p.url} ${p.status} ${p.ms} ms`).join(", ")}`);
    console.log(JSON.stringify({ at: new Date(now).toISOString(), error: "ssh", probes }));
    process.exit(2);
  }
  const r = JSON.parse(out) as Reading;
  const slowestMs = Math.max(0, ...probes.slice(0, 2).map((p) => p.ms));
  state.history = [
    ...state.history.filter((s) => s.at >= now - 2 * 3_600_000),
    { at: now, memUsedMB: r.memUsedMB, slowestMs, dbBytes: r.dbBytes },
  ];
  const alerts = judge(r, probes, state, now);
  const fresh = alerts.filter(
    (a) => now - (state.alerted[a.key] ?? 0) >= THRESHOLDS.remindMinutes * 60_000,
  );
  for (const a of fresh) state.alerted[a.key] = now;
  state.lastRun = r.at;
  state.restarts = Object.fromEntries(
    Object.entries(r.containers).map(([n, c]) => [n, c.restarts]),
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));

  for (const line of summary(r, probes)) console.log(line);
  if (alerts.length === 0) console.log("no alerts");
  for (const a of alerts)
    console.log(
      `ALERT ${fresh.includes(a) ? "" : "(already raised) "}${a.what}${a.response ? `\n  response: ${a.response}` : ""}`,
    );
  console.log(JSON.stringify({ at: r.at, alerts, fresh: fresh.map((a) => a.key), probes }));
  process.exit((all ? alerts : fresh).length > 0 ? 1 : 0);
}

if (import.meta.main) await main();
