/**
 * `starbridge setup`: pairs the machine, finds or installs CodexBar and picks the providers,
 * installs the agent's user service and the Claude Code plugins, then uploads a first snapshot.
 * Every step shows what it found, so a rerun changes only what is missing.
 */

import { CLIENT_HEADER, clientHeader, type QuotaSnapshot } from "@starbridge/protocol";
import type { Status } from "../agent/api";
import { AgentClient, Interrupted, withAgent } from "../agent/client";
import { askVia, quotaVia } from "../agent/commands";
import { ApiError, REMOVED, Unreachable } from "../api";
import type { AgentConfig } from "../config";
import { type Ctx, refreshDirectory, session, UsageError } from "../context";
import { type AskInput, answerPrefix, ask, EXIT_INTERRUPTED, settle } from "../decisions";
import { DEFAULT_SERVER, pair } from "../pair";
import { permissionsEnabled } from "../permissions";
import { pushOnce } from "../quota";
import { rememberMachineKind } from "../settings";
import { VERSION } from "../version";
import {
  AGENT_IDS,
  AGENTS,
  type AgentId,
  agentLine,
  found,
  installAgent,
  installed,
  progressLine,
  removedAgents,
  setRemoved,
  UNDER,
} from "./agents";
import {
  type Found,
  findCodexbar,
  installCodexbar,
  linkIntoLocalBin,
  listProviders,
  type Probe,
  probe,
  probeSet,
} from "./codexbar";
import { refreshFiles } from "./harnesses";
import { ours } from "./marker";
import { pathStep, recordSelf } from "./path";
import {
  enableLinger,
  installedService,
  installService,
  kind,
  lingering,
  PLACES,
  unavailable,
  withInstalledPlaces,
} from "./service";
import { defaults, otherCopies, type Sys } from "./sys";

export interface SetupOpts {
  /** `--yes`: every question takes its default; sys.prompt answers so. */
  yes?: boolean;
  server?: string;
  name?: string;
  providers?: string[];
  noQuota?: boolean;
  noService?: boolean;
  /** `--no-agents`: installs Starbridge in no agent. */
  noAgents?: boolean;
  /** `--agent <name>`: only Starbridge in that agent, also one `uninstall --agent` removed. */
  agent?: AgentId;
  /** How long to wait for the agent to answer after starting it. */
  readyTimeoutMs?: number;
}

/** A Starbridge server answers `GET /v1/me` without a token with 401. */
async function checkServer(server: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/+$/, "")}/v1/me`, {
      headers: { [CLIENT_HEADER]: clientHeader("cli", VERSION) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new UsageError(`cannot reach ${server}: ${(e as Error).message}`);
  }
  if (res.status !== 200 && res.status !== 401)
    throw new UsageError(
      `${server} does not look like a Starbridge server (GET /v1/me: ${res.status})`,
    );
}

/**
 * Brings every file setup wrote into another tool to this release's version (`refreshFiles`),
 * and the agent's service too, which then restarts. It also installs Starbridge in an agent
 * found since setup, unless `uninstall --agent` removed it (#750). `starbridge update` runs it
 * with the new binary (`setup --refresh`). Returns what it did, one line each.
 */
export async function refresh(sys: Sys): Promise<string[]> {
  recordSelf(sys);
  const done = refreshFiles(sys);
  const removed = removedAgents(sys.ctx);
  for (const id of AGENT_IDS) {
    if (removed.includes(id) || !found(sys, id) || (await installed(sys, id))) continue;
    const r = await installAgent(sys, id);
    done.push(
      agentLine(r.mark, id, r.text),
      ...[...r.notes, ...(r.next ?? [])].map((n) => `${UNDER}${n}`),
    );
  }
  const { path, text } = installedService(sys) ?? {};
  if (path && text !== undefined && ours(text))
    try {
      // A task names no places: its agent reads the user's environment.
      const env = kind(sys) === "task" ? sys.ctx.env : withInstalledPlaces(sys.ctx.env, text);
      const { restarted } = await installService({ ...sys, ctx: { ...sys.ctx, env } }, true);
      if (restarted) done.push(`Restarted the agent (${path}).`);
    } catch (e) {
      done.push(`Could not restart the agent: ${(e as Error).message}`);
    }
  return done;
}

function trimServer(server: string): string {
  return server.replace(/\/+$/, "");
}

/** A server as setup names it: its host, or the whole URL when it is not plain https. */
function host(server: string): string {
  const s = trimServer(server);
  return s.startsWith("https://") ? s.slice("https://".length) : s;
}

function section(ctx: Ctx, title: string) {
  ctx.out("");
  ctx.out(title);
}

/**
 * Whether the server still lists this machine: "removed" when it revoked the machine or no
 * longer knows its token, as after the server lost its database.
 */
async function checkPairing(ctx: Ctx): Promise<"paired" | "removed" | { why: string }> {
  const s = session(ctx);
  try {
    await refreshDirectory(ctx, s, AbortSignal.timeout(15_000));
    return "paired";
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return "removed";
    if (e instanceof UsageError && e.message === REMOVED) return "removed";
    if (e instanceof Unreachable) return { why: e.message };
    if ((e as Error).name === "TimeoutError")
      return { why: `cannot reach ${trimServer(s.machine.server)}: no answer in 15 s` };
    if (e instanceof ApiError) return { why: e.message };
    throw e;
  }
}

/** Every later step needs the server: setup stops, saying why and what to run. */
function cannotGoOn(ctx: Ctx, why: string): number {
  ctx.out(`✗ ${why[0]?.toUpperCase()}${why.slice(1)}`);
  ctx.out("  Retry with:");
  ctx.out("    starbridge setup");
  return 1;
}

export async function setup(sys: Sys, opts: SetupOpts): Promise<number> {
  const { ctx, prompt } = sys;
  recordSelf(sys);
  if (opts.agent) return agentOnly(sys, opts.agent);

  let machine = ctx.store.machine();
  // Asks nothing (#749): install.sh passes the server that served it as --server.
  const server = trimServer(
    opts.server ?? ctx.env.STARBRIDGE_SERVER ?? machine?.server ?? DEFAULT_SERVER,
  );
  const switching =
    machine !== undefined &&
    trimServer(machine.server) !== server &&
    (await prompt.confirm(
      `This machine is paired with ${host(machine.server)}. Pair it with ${host(server)} instead?`,
      false,
    ));
  // The later steps need the server and the pairing, so setup checks both first (#774).
  let again = false;
  if (machine && !switching) {
    section(ctx, "Pairing");
    const pairing = await checkPairing(ctx);
    if (pairing === "paired") ctx.out(`✓ Paired as ${machine.name} on ${host(machine.server)}`);
    else if (pairing === "removed") {
      ctx.out(`✗ ${host(machine.server)} no longer lists ${machine.name}`);
      again = await prompt.confirm("  Pair this machine again?", true);
      if (!again) {
        ctx.out("  To pair it again later:");
        ctx.out("    starbridge setup");
        return 1;
      }
    } else return cannotGoOn(ctx, pairing.why);
  }
  if (!machine || switching || again) {
    // Pairing again stays on the machine's server: the owner declined any other.
    const to = again && machine ? trimServer(machine.server) : server;
    if (!again) section(ctx, `Pairing with ${host(to)}`);
    try {
      await checkServer(to);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      return cannotGoOn(ctx, e.message);
    }
    const code = await pair(ctx, {
      server: to,
      again: "starbridge setup",
      ...(switching || again ? { force: true } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    });
    if (code !== 0) return code;
    if (switching && machine)
      ctx.out(
        `  ${host(machine.server)} still lists ${machine.name}: revoke it under Devices there.`,
      );
    machine = ctx.store.machine();
  }
  // `starbridge status` shows it; `config machine-kind` changes it.
  if (machine) rememberMachineKind(ctx);

  const { done: agents, next } = opts.noAgents ? { done: [], next: [] } : await agentsStep(sys);

  const configBefore = JSON.stringify(ctx.store.agentConfig());
  const quota = await quotaStep(sys, opts, machine !== undefined);

  if (opts.noService) {
    section(ctx, "Background service");
    ctx.out("– Skipped (--no-service): commands talk to the server themselves");
  } else
    await serviceStep(
      sys,
      opts,
      // A running agent may hold the old token, or be backing off from its refusal.
      switching || again || JSON.stringify(ctx.store.agentConfig()) !== configBefore,
    );
  const last = await pathStep(sys);

  const upload = machine && quota && quota.providers.length > 0 ? quota : undefined;
  if (upload || (machine && !opts.yes)) section(ctx, "Test");
  if (upload) await firstUpload(ctx, upload);
  if (machine && !opts.yes && (await prompt.confirm("  Send a test decision to your phone?", true)))
    await testDecision(ctx, machine.name);

  section(ctx, "Starbridge is set up.");
  for (const line of await otherCopies(sys)) ctx.out(`  ${line}`);
  const one = agents[0] ?? "claude";
  ctx.out("");
  for (const line of commandTable([
    ["Check it", "starbridge status"],
    ...(permissionsEnabled(ctx)
      ? []
      : ([["Send permission prompts", "starbridge config permissions on"]] as const)),
    ["Remove from one agent", `starbridge uninstall --agent ${one}`],
    ["Remove everything", "starbridge uninstall"],
  ]))
    ctx.out(line);
  if (next.length > 0) ctx.out("");
  for (const line of next) ctx.out(`  ${line}`);
  if (last.length > 0) ctx.out("");
  for (const line of last) ctx.out(line);
  return 0;
}

/** `  Check it   starbridge status`: labels in one column, commands in the next. */
function commandTable(rows: readonly (readonly [string, string])[]): string[] {
  const w = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, cmd]) => `  ${label.padEnd(w)}  ${cmd}`);
}

/**
 * Starbridge in every agent found, without asking (#750), one line each; an agent
 * `uninstall --agent` removed stays out. Returns the agents it is in, and what is left to do.
 */
async function agentsStep(sys: Sys): Promise<{ done: AgentId[]; next: string[] }> {
  const { ctx } = sys;
  section(ctx, "Agents");
  const removed = removedAgents(ctx);
  const done: AgentId[] = [];
  const next: string[] = [];
  let any = false;
  for (const id of AGENT_IDS) {
    if (!found(sys, id)) continue;
    any = true;
    if (removed.includes(id)) {
      ctx.out(agentLine("–", id, "left out, as `uninstall --agent` asked"));
      ctx.out(`${UNDER}Bring it back with:`);
      ctx.out(`${UNDER}  starbridge setup --agent ${id}`);
      continue;
    }
    const progress = progressLine(id);
    if (progress) ctx.out(progress);
    const r = await installAgent(sys, id);
    ctx.out(agentLine(r.mark, id, r.text));
    for (const note of r.notes) ctx.out(`${UNDER}${note}`);
    next.push(...(r.next ?? []));
    if (r.mark === "✓") done.push(id);
  }
  if (!any)
    ctx.out(
      `– No agent found (${Object.values(AGENTS).join(", ")}): rerun setup after installing one`,
    );
  return { done, next };
}

/** `setup --agent <name>`: Starbridge in that one agent, also when `uninstall --agent` took it out. */
async function agentOnly(sys: Sys, id: AgentId): Promise<number> {
  const { ctx } = sys;
  if (!found(sys, id)) {
    ctx.out(`✗ ${AGENTS[id]} is not installed here.`);
    return 1;
  }
  setRemoved(ctx, id, false);
  const progress = progressLine(id);
  if (progress) ctx.out(progress);
  const r = await installAgent(sys, id);
  ctx.out(agentLine(r.mark, id, r.text));
  for (const note of [...r.notes, ...(r.next ?? [])]) ctx.out(`${UNDER}${note}`);
  return r.mark === "✗" ? 1 : 0;
}

function skipQuota(sys: Sys, line: string): undefined {
  const { ctx } = sys;
  const cfg = ctx.store.agentConfig();
  ctx.store.saveAgentConfig({ ...cfg, quota: { ...cfg.quota, providers: [] } });
  ctx.out(`– ${line}`);
  return undefined;
}

/** A machine that sent no quota snapshot for this long no longer counts as sending them. */
const SENDER_MAX_AGE_MS = 24 * 3600_000;

/**
 * The other machines of the account that sent quotas lately (#748), named. None when this
 * machine already sends them, `--providers` names them, or the server cannot say.
 */
async function otherSenders(sys: Sys, opts: SetupOpts): Promise<string[]> {
  const { ctx } = sys;
  if (opts.providers || ctx.store.agentConfig().quota?.providers?.length) return [];
  try {
    const s = session(ctx);
    const since = ctx.now().getTime() - SENDER_MAX_AGE_MS;
    const ids = (await s.api.quotaSenders())
      .filter((x) => x.id !== s.machine.id && Date.parse(x.receivedAt) >= since)
      .map((x) => x.id);
    if (ids.length === 0) return [];
    const dir = await refreshDirectory(ctx, s);
    return ids.flatMap((id) => dir.members.get(id)?.member.name ?? []);
  } catch {
    return [];
  }
}

/**
 * When another machine already sends quotas, asks whether this one should too, Enter saying no
 * (#748); a yes installs CodexBar without asking again. Otherwise CodexBar's own question.
 */
async function quotaStep(sys: Sys, opts: SetupOpts, paired: boolean): Promise<Quota | undefined> {
  const { ctx, prompt } = sys;
  section(ctx, "Quotas");
  if (opts.noQuota) return skipQuota(sys, "Skipped (--no-quota): this machine sends no quotas");
  const names = paired ? await otherSenders(sys, opts) : [];
  if (names.length === 0) return codexbarStep(sys, opts, true);
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const too = await prompt.confirm(
    `  ${who} already ${names.length === 1 ? "sends" : "send"} quotas. Send from this machine too?`,
    false,
  );
  return too ? codexbarStep(sys, opts, false) : skipQuota(sys, "Not sent from this machine");
}

type Quota = NonNullable<AgentConfig["quota"]> & { providers: string[] };

async function codexbarStep(
  sys: Sys,
  opts: SetupOpts,
  askInstall: boolean,
): Promise<Quota | undefined> {
  const { ctx, prompt } = sys;
  const cfg = ctx.store.agentConfig();
  let found: Found | undefined = findCodexbar(sys, cfg.quota?.codexbar);
  if (!found && sys.platform === "win32") {
    ctx.out("– CodexBar, which reads plan quotas, has no Windows build");
    ctx.out("  Questions and runs work without it.");
    return undefined;
  }
  if (!found) {
    // A third-party binary: asked, unless the owner just said to send quotas.
    const what = sys.platform === "darwin" ? "the CodexBar app" : "the CodexBar CLI";
    if (
      !askInstall ||
      (await prompt.confirm(`  CodexBar reads your plan quotas. Install ${what}?`, true))
    ) {
      try {
        found = await installCodexbar(sys);
      } catch (e) {
        ctx.out(`✗ Could not install CodexBar: ${(e as Error).message}`);
      }
    }
    if (!found) {
      ctx.out("– No quotas without CodexBar; questions and runs work without it");
      ctx.out("  To install it later:");
      ctx.out("    starbridge setup");
      return undefined;
    }
  }
  ctx.out(`✓ CodexBar ${found.path}`);
  if (found.inApp) {
    const link = linkIntoLocalBin(sys, found.path);
    ctx.out(
      link ? `  Linked ${link}` : "  ~/.local/bin/codexbar exists and is not a link: left alone",
    );
  }

  const list = await listProviders(sys, found.path);
  const prior = opts.providers ?? cfg.quota?.providers;
  const probes = await probe(found.path, probeSet(sys, list, prior ?? []), list);
  for (const line of probeLines(sys, probes)) ctx.out(line);

  const works = probes.filter((p) => p.works).map((p) => p.provider);
  let providers: string[];
  if (opts.providers) {
    providers = opts.providers;
    const broken = providers.filter((p) => !works.includes(p));
    if (broken.length > 0)
      ctx.out(`  Sending ${broken.join(", ")} although CodexBar could not read them now`);
  } else {
    const preselected = prior?.length ? works.filter((p) => prior.includes(p)) : works;
    const known = new Set([...probes.map((p) => p.provider), ...list.map((p) => p.provider)]);
    providers = await pickProviders(sys, preselected, known);
  }
  const q: Quota = {
    ...cfg.quota,
    providers,
    codexbar: found.path,
    interval: cfg.quota?.interval ?? "5m",
  };
  ctx.store.saveAgentConfig({ ...cfg, quota: q });
  ctx.out(
    providers.length > 0
      ? `✓ Sends ${providers.join(", ")} every ${q.interval}`
      : "– Sends no quotas",
  );
  return q;
}

export function probeLines(sys: Sys, probes: Probe[]): string[] {
  if (probes.length === 0)
    return ["  CodexBar has no provider turned on, and found no Claude or Codex sign-in."];
  // A CodexBar the system cannot start fails every provider the same way, which no sign-in fixes.
  const lib = probes
    .map((p) => /error while loading shared libraries: ([^:\s]+):/.exec(p.detail)?.[1])
    .find((l) => l !== undefined);
  if (lib && probes.every((p) => !p.works))
    return [
      `✗ CodexBar cannot start: it needs ${lib}`,
      lib.startsWith("libsqlite3.")
        ? "  On Debian or Ubuntu: sudo apt install libsqlite3-0"
        : `  Install the package that provides ${lib}`,
      "  Then run again:",
      "    starbridge setup",
    ];
  const w = Math.max(...probes.map((p) => p.provider.length));
  return probes.flatMap((p) => {
    const lines = [
      `  ${p.provider.padEnd(w)}  ${p.works ? `works (${p.detail})` : `needs sign-in: ${p.detail}`}`,
    ];
    if (!p.works && sys.platform === "linux" && /cookie/i.test(p.detail))
      lines.push(
        `  ${" ".repeat(w)}  On Linux CodexBar cannot import browser cookies: paste a cookie header into its config (see codexbar's docs/cli.md).`,
      );
    return lines;
  });
}

async function pickProviders(
  sys: Sys,
  preselected: string[],
  known: Set<string>,
): Promise<string[]> {
  while (true) {
    const a = await sys.prompt.text(
      "  Providers to send, comma-separated (none for no quotas):",
      preselected.length > 0 ? preselected.join(",") : "none",
    );
    if (a.trim().toLowerCase() === "none") return [];
    const picked = [...new Set(a.split(/[\s,]+/).filter(Boolean))];
    const unknown = picked.filter((p) => !known.has(p));
    if (unknown.length === 0) return picked;
    sys.ctx.out(`  Not a CodexBar provider here: ${unknown.join(", ")}`);
  }
}

async function serviceStep(sys: Sys, opts: SetupOpts, configChanged: boolean) {
  const { ctx, prompt } = sys;
  section(ctx, "Background service");
  const why = await unavailable(sys);
  if (why) {
    ctx.out(`✗ Cannot install the service: ${why}`);
    ctx.out("  To keep one running yourself:");
    ctx.out("    starbridge agent");
    return;
  }
  // After a brew or npm upgrade the agent still runs the old binary.
  const running = await agentVersion(ctx);
  const outdated = running !== undefined && running !== VERSION;
  let installed: { path: string; restarted: boolean };
  try {
    installed = await installService(sys, configChanged || outdated);
  } catch (e) {
    ctx.out(`✗ Could not start the service: ${(e as Error).message}`);
    ctx.out("  Retry with:");
    ctx.out("    starbridge setup");
    ctx.out("  Or keep one running yourself:");
    ctx.out("    starbridge agent");
    return;
  }
  ctx.out(installed.restarted ? `✓ Started ${installed.path}` : `✓ Runs ${installed.path}`);
  if (kind(sys) === "task")
    for (const k of PLACES.filter((k) => ctx.env[k])) {
      ctx.out(`  The service reads your user environment, not this terminal's. If ${k} is`);
      ctx.out("  not one of your user variables yet:");
      ctx.out(`    setx ${k} "${ctx.env[k]}"`);
    }
  const status = await waitReady(ctx, opts.readyTimeoutMs ?? 20_000);
  if (!status) ctx.out("  The agent did not answer yet: starbridge status shows its state");
  else if (status.machine && !status.server.reachable)
    ctx.out(`✗ The server is not reachable: ${status.server.lastError ?? "no answer yet"}`);
  if ((await lingering(sys)) === false) {
    if (
      await prompt.confirm("  Keep it running after you log out (loginctl enable-linger)?", true)
    ) {
      const err = await enableLinger(sys);
      ctx.out(err ? `✗ loginctl enable-linger failed: ${err}` : "✓ Runs after logout");
    } else ctx.out("– Stops when your last login session ends");
  }
}

/** The running agent's version, or undefined when none answers. */
async function agentVersion(ctx: Ctx): Promise<string | undefined> {
  const agent = AgentClient.for(ctx);
  if (!agent) return undefined;
  try {
    return (await agent.call<Status>("GET", "/v1/status", undefined, 2_000)).version;
  } catch {
    return undefined;
  }
}

/** Polls the agent's status until it answers and, once paired, reaches the server. */
async function waitReady(ctx: Ctx, timeoutMs: number): Promise<Status | undefined> {
  const agent = AgentClient.for(ctx) ?? new AgentClient("");
  const end = Date.now() + timeoutMs;
  let last: Status | undefined;
  while (Date.now() < end) {
    try {
      last = await agent.call<Status>("GET", "/v1/status", undefined, 2_000);
      if (!last.machine || last.server.reachable) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

function summary(snap: QuotaSnapshot): string {
  const windows = snap.providers.reduce((n, p) => n + p.windows.length, 0);
  const failed = snap.providers.filter((p) => p.error).map((p) => p.provider);
  return `✓ Sent a first quota snapshot: ${snap.providers.length} providers, ${windows} windows${failed.length > 0 ? ` (${failed.join(", ")} failed)` : ""}.`;
}

async function firstUpload(ctx: Ctx, q: Quota) {
  try {
    const snap = await withAgent(
      ctx,
      (agent) => quotaVia(agent, q.providers),
      () =>
        pushOnce(ctx, { providers: q.providers, ...(q.codexbar ? { codexbar: q.codexbar } : {}) }),
    );
    ctx.out(summary(snap));
  } catch (e) {
    const why = e instanceof ApiError || e instanceof UsageError ? e.message : (e as Error).message;
    ctx.out(`✗ The first quota upload failed: ${why}`);
  }
}

/** Asks from no session, so no Claude Code session receives the answer, and prints it. */
async function testDecision(ctx: Ctx, name: string) {
  const input: AskInput = {
    question: `Does Starbridge reach you from ${name}?`,
    context:
      "Sent by `starbridge setup` to check the path from this machine to your devices. The answer prints in the terminal.",
    options: ["Yes", "No"],
    project: "starbridge setup",
    session: "",
  };
  const opts = { wait: true, timeout: "10m" };
  ctx.out("  Sent. Answer it on your phone or the web page (Ctrl-C skips)…");
  // `ask` prints the decision's id first, kept to withdraw the card on Ctrl-C (#613), then the
  // answer line agents read; the owner sees neither, only what they answered.
  let id: string | undefined;
  const asking: Ctx = {
    ...ctx,
    out: (line) => {
      if (id === undefined) {
        id = line;
        return;
      }
      const prefix = answerPrefix(id, input.question);
      // Other lines, such as a snooze's, name the decision the agents' way: `<id> (<question>)`.
      ctx.out(
        line.startsWith(prefix)
          ? `✓ You answered ${line.slice(prefix.length)}`
          : line.replace(` ${id} (${input.question})`, ""),
      );
    },
  };
  let code: number;
  try {
    code = await withAgent(
      asking,
      (agent) => askVia(asking, agent, input, opts),
      () => ask(asking, input, opts),
    );
  } catch (e) {
    if (!(e instanceof Interrupted)) {
      ctx.out(`✗ The test decision failed: ${(e as Error).message}`);
      return;
    }
    code = EXIT_INTERRUPTED;
  }
  if (code === 2) ctx.out("✗ No answer within 10 minutes");
  if (code !== EXIT_INTERRUPTED || !id) return;
  try {
    await settle(ctx, { id, outcome: "withdrawn" });
    ctx.out("– Skipped");
  } catch (e) {
    ctx.out(`– Skipped, but the card stays open on your devices: ${(e as Error).message}`);
  }
}
