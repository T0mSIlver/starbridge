/**
 * `starbridge setup`: pairs the machine, finds or installs CodexBar and picks the providers,
 * installs the agent's user service and the Claude Code plugins, then uploads a first snapshot.
 * Every step shows what it found, so a rerun changes only what is missing.
 */

import type { QuotaSnapshot } from "@starbridge/protocol";
import type { Status } from "../agent/api";
import { AgentClient, withAgent } from "../agent/client";
import { askVia, quotaVia } from "../agent/commands";
import { ApiError } from "../api";
import type { AgentConfig } from "../config";
import { type Ctx, UsageError } from "../context";
import { type AskInput, ask } from "../decisions";
import { DEFAULT_SERVER, pair } from "../pair";
import { permissionsEnabled } from "../permissions";
import { pushOnce } from "../quota";
import { offerPiAllow, offerPiChain, rememberMachineKind, setPermissions } from "../settings";
import { VERSION } from "../version";
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
import {
  codexRulePath,
  codexSkill,
  codexSkillDir,
  hasCodex,
  hasCodexRule,
  hasOpencode,
  hasPi,
  installCodexRule,
  installCodexSkill,
  installOpencode,
  installPiPackage,
  opencodeDir,
  opencodeState,
  PI_PACKAGE,
  piPackage,
} from "./harnesses";
import {
  ALLOW_RULES,
  addAllowRules,
  autoUpdate,
  enableAutoUpdate,
  foreignMarketplace,
  hasClaude,
  installPlugins,
  missingAllowRules,
  PLUGINS,
  pluginState,
  settingsPath,
} from "./plugins";
import { enableLinger, installService, lingering, unavailable } from "./service";
import type { Sys } from "./sys";

export interface SetupOpts {
  /** `--yes`: every question takes its default; sys.prompt answers so. */
  yes?: boolean;
  server?: string;
  name?: string;
  providers?: string[];
  noQuota?: boolean;
  noService?: boolean;
  noPlugin?: boolean;
  /** How long to wait for the agent to answer after starting it. */
  readyTimeoutMs?: number;
}

/** A Starbridge server answers `GET /v1/me` without a token with 401. */
async function checkServer(server: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${server.replace(/\/+$/, "")}/v1/me`, {
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

function section(ctx: Ctx, title: string) {
  ctx.out("");
  ctx.out(title);
}

export async function setup(sys: Sys, opts: SetupOpts): Promise<number> {
  const { ctx, prompt } = sys;

  section(ctx, "Pairing");
  let machine = ctx.store.machine();
  if (machine) {
    ctx.out(`Paired as "${machine.name}" (${machine.id}) on ${machine.server}.`);
  } else {
    const server =
      opts.server ??
      ctx.env.STARBRIDGE_SERVER ??
      (await prompt.text("Starbridge server:", DEFAULT_SERVER));
    await checkServer(server);
    const code = await pair(ctx, { server, ...(opts.name ? { name: opts.name } : {}) });
    if (code !== 0) return code;
    machine = ctx.store.machine();
  }
  if (machine)
    ctx.out(
      `Shown as a ${rememberMachineKind(ctx)} (\`starbridge config machine-kind\` changes it).`,
    );

  const configBefore = JSON.stringify(ctx.store.agentConfig());
  const quota = opts.noQuota ? await skipQuota(sys) : await codexbarStep(sys, opts);

  if (opts.noService) {
    section(ctx, "Agent");
    ctx.out("Skipped (--no-service): commands talk to the server themselves.");
  } else await serviceStep(sys, opts, JSON.stringify(ctx.store.agentConfig()) !== configBefore);

  if (opts.noPlugin) {
    section(ctx, "Agents");
    ctx.out("Skipped (--no-plugin).");
  } else {
    await pluginStep(sys);
    await codexStep(sys);
    await piStep(sys);
    await opencodeStep(sys);
  }
  await permissionStep(sys);

  section(ctx, "Check");
  if (machine && quota && quota.providers.length > 0) await firstUpload(ctx, quota);
  if (machine && !opts.yes && (await prompt.confirm("Send a test decision to your phone?", true)))
    await testDecision(ctx, machine.name);

  ctx.out("");
  ctx.out("Setup is done. `starbridge status` shows the same checks at any time.");
  return 0;
}

async function skipQuota(sys: Sys): Promise<undefined> {
  section(sys.ctx, "CodexBar");
  const cfg = sys.ctx.store.agentConfig();
  sys.ctx.store.saveAgentConfig({ ...cfg, quota: { ...cfg.quota, providers: [] } });
  sys.ctx.out("Skipped (--no-quota): the agent uploads no quotas.");
  return undefined;
}

type Quota = NonNullable<AgentConfig["quota"]> & { providers: string[] };

async function codexbarStep(sys: Sys, opts: SetupOpts): Promise<Quota | undefined> {
  const { ctx, prompt } = sys;
  section(ctx, "CodexBar");
  const cfg = ctx.store.agentConfig();
  let found: Found | undefined = findCodexbar(sys, cfg.quota?.codexbar);
  if (!found) {
    const how = sys.platform === "darwin" ? "the CodexBar app" : "the CodexBar CLI";
    if (
      await prompt.confirm(
        `CodexBar reads your plan quotas and is not installed. Install ${how}?`,
        true,
      )
    ) {
      try {
        found = await installCodexbar(sys);
      } catch (e) {
        ctx.out(`Could not install CodexBar: ${(e as Error).message}`);
      }
    }
    if (!found) {
      ctx.out(
        "No quotas without CodexBar; questions and runs work without it. `starbridge setup` installs it when you rerun it.",
      );
      return undefined;
    }
  }
  ctx.out(`CodexBar: ${found.path}`);
  if (found.inApp && (await prompt.confirm("Link it as ~/.local/bin/codexbar?", true))) {
    const link = linkIntoLocalBin(sys, found.path);
    ctx.out(
      link ? `Linked ${link}.` : "~/.local/bin/codexbar exists and is not a link: left alone.",
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
      ctx.out(`Uploading ${broken.join(", ")} although CodexBar could not read them now.`);
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
      ? `The agent uploads ${providers.join(", ")} every ${q.interval}.`
      : "The agent uploads no quotas.",
  );
  return q;
}

export function probeLines(sys: Sys, probes: Probe[]): string[] {
  if (probes.length === 0)
    return ["CodexBar has no provider turned on, and no Claude or Codex sign-in was found."];
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
      "Providers to upload, comma-separated (none for no quotas):",
      preselected.length > 0 ? preselected.join(",") : "none",
    );
    if (a.trim().toLowerCase() === "none") return [];
    const picked = [...new Set(a.split(/[\s,]+/).filter(Boolean))];
    const unknown = picked.filter((p) => !known.has(p));
    if (unknown.length === 0) return picked;
    sys.ctx.out(`Not a CodexBar provider here: ${unknown.join(", ")}`);
  }
}

async function serviceStep(sys: Sys, opts: SetupOpts, configChanged: boolean) {
  const { ctx, prompt } = sys;
  section(ctx, "Agent");
  const why = await unavailable(sys);
  if (why) {
    ctx.out(`Cannot install the agent service: ${why}.`);
    ctx.out(
      "Run `starbridge agent` yourself to keep one running; commands talk to the server themselves meanwhile.",
    );
    return;
  }
  // After a brew or npm upgrade the agent still runs the old binary.
  const running = await agentVersion(ctx);
  const outdated = running !== undefined && running !== VERSION;
  let installed: { path: string; restarted: boolean };
  try {
    installed = await installService(sys, configChanged || outdated);
  } catch (e) {
    ctx.out(`Could not start the agent service: ${(e as Error).message}`);
    return;
  }
  ctx.out(
    installed.restarted
      ? `Started ${installed.path}.`
      : `${installed.path} is up to date and running.`,
  );
  const status = await waitReady(ctx, opts.readyTimeoutMs ?? 20_000);
  if (!status)
    ctx.out("The agent did not answer on its socket yet: `starbridge status` shows its state.");
  else if (status.machine && !status.server.reachable)
    ctx.out(
      `Agent ${status.version} runs, but the server is not reachable: ${status.server.lastError ?? "no answer yet"}.`,
    );
  else ctx.out(`Agent ${status.version} runs (pid ${status.pid}).`);
  if ((await lingering(sys)) === false) {
    if (
      await prompt.confirm(
        "Keep the agent running when you are logged out (loginctl enable-linger)?",
        true,
      )
    ) {
      const err = await enableLinger(sys);
      ctx.out(err ? `loginctl enable-linger failed: ${err}` : "Lingering is on.");
    } else ctx.out("The agent stops when your last session ends.");
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

async function pluginStep(sys: Sys) {
  const { ctx, prompt } = sys;
  section(ctx, "Claude Code");
  if (!hasClaude(sys)) {
    ctx.out("`claude` is not on the PATH: skipped. Rerun setup after installing Claude Code.");
    return;
  }
  const state = await pluginState(sys);
  if (!state) {
    ctx.out("`claude plugin list` failed: skipped.");
    return;
  }
  const foreign = foreignMarketplace(state);
  if (foreign) {
    ctx.out(`Skipped: ${foreign}.`);
    return;
  }
  const missing = !state.marketplace || PLUGINS.some((id) => !state.plugins[id]);
  let installed = !missing;
  if (!missing) ctx.out(`The ${PLUGINS.join(" and ")} plugins are installed.`);
  else if (
    await prompt.confirm(
      "Install the Starbridge plugins for Claude Code (the skill and the mod)?",
      true,
    )
  ) {
    try {
      for (const line of await installPlugins(sys, state)) ctx.out(line);
      installed = true;
      ctx.out("Claude Code sessions load them when they next start.");
    } catch (e) {
      ctx.out(`Could not install the plugins: ${(e as Error).message}`);
    }
  }
  if (!installed) return;
  if (
    autoUpdate(sys) === false &&
    (await prompt.confirm("Let Claude Code update the Starbridge plugins by itself?", true))
  )
    ctx.out(enableAutoUpdate(sys) ? "Auto-update is on." : "Could not turn on auto-update.");
  if (
    missingAllowRules(sys).length > 0 &&
    (await prompt.confirm(
      "Let Claude Code run `starbridge ask`, `waiting`, `wait` and `settle` without a permission prompt? They post questions to your devices and read your answers.",
      true,
    ))
  ) {
    ctx.out(
      addAllowRules(sys)
        ? `Allowed ${ALLOW_RULES.join(", ")} in ${settingsPath(sys)}.`
        : `${settingsPath(sys)} is not valid JSON, so it stays as it is; add ${ALLOW_RULES.join(", ")} to permissions.allow there.`,
    );
  }
}

/** The skill in Codex's skills folder, asked first, and updated when this CLI has another. */
async function codexStep(sys: Sys) {
  const { ctx, prompt } = sys;
  if (!hasCodex(sys)) return;
  section(ctx, "Codex");
  const dir = codexSkillDir(sys);
  const state = codexSkill(sys);
  if (state === "current") ctx.out(`The starbridge skill is in ${dir}.`);
  else {
    const verb = state === "missing" ? "Install" : "Update";
    if (await prompt.confirm(`${verb} the Starbridge skill for Codex in ${dir}?`, true)) {
      try {
        installCodexSkill(sys);
        ctx.out(`${verb === "Install" ? "Installed" : "Updated"} ${dir}/SKILL.md.`);
      } catch (e) {
        ctx.out(`Could not write the skill: ${(e as Error).message}`);
      }
    } else ctx.out("Codex sessions won't know the skill: rerun setup to install it.");
  }
  const rule = codexRulePath(sys);
  if (hasCodexRule(sys)) ctx.out(`The starbridge rule is in ${rule}.`);
  else if (
    await prompt.confirm(
      "Let `starbridge ask`, `waiting`, `wait` and `settle` run outside Codex's sandbox, which has no network?",
      true,
    )
  ) {
    try {
      installCodexRule(sys);
      ctx.out(`Wrote ${rule}.`);
    } catch (e) {
      ctx.out(`Could not write the rule: ${(e as Error).message}`);
    }
  } else ctx.out("Codex's sandbox will stop `starbridge ask`: rerun setup to add the rule.");
}

/** The Starbridge Pi package: the skill, the rules and answers into the session. */
async function piStep(sys: Sys) {
  const { ctx } = sys;
  if (!hasPi(sys)) return;
  section(ctx, "Pi");
  await piPackageStep(sys);
  await offerPiAllow(sys.ctx, sys.prompt);
}

async function piPackageStep(sys: Sys) {
  const { ctx, prompt } = sys;
  const installed = piPackage(sys);
  if (installed === PI_PACKAGE) {
    ctx.out("The Starbridge Pi package is installed.");
    return;
  }
  // Installed at another ref, or none: Pi moves the one entry to this CLI's tag.
  if (installed) {
    try {
      await installPiPackage(sys);
      ctx.out(`Moved the Starbridge Pi package to v${VERSION}.`);
    } catch (e) {
      ctx.out(`Could not move the Starbridge Pi package to v${VERSION}: ${(e as Error).message}`);
    }
    return;
  }
  if (
    await prompt.confirm(
      `Install the Starbridge Pi package (the skill, and answers into the session)? This runs \`pi install ${PI_PACKAGE}\`.`,
      true,
    )
  ) {
    try {
      await installPiPackage(sys);
      ctx.out("Installed. Pi sessions load it when they next start.");
    } catch (e) {
      ctx.out(`Could not install it: ${(e as Error).message}`);
    }
  } else ctx.out(`Skipped: \`pi install ${PI_PACKAGE}\` installs it later.`);
}

/** The skill and the plugin in opencode's config folder, updated when this CLI has others. */
async function opencodeStep(sys: Sys) {
  const { ctx, prompt } = sys;
  if (!hasOpencode(sys)) return;
  section(ctx, "opencode");
  const dir = opencodeDir(sys);
  const state = opencodeState(sys);
  if (state === "current") {
    ctx.out(`The starbridge skill and plugin are in ${dir}.`);
    return;
  }
  const verb = state === "missing" ? "Install" : "Update";
  if (
    await prompt.confirm(
      `${verb} the Starbridge skill and plugin for opencode in ${dir}? The plugin puts answers into the session.`,
      true,
    )
  ) {
    try {
      const kept = installOpencode(sys);
      ctx.out(
        `${verb === "Install" ? "Installed" : "Updated"}. opencode loads them when it next starts.`,
      );
      for (const path of kept) ctx.out(`Kept ${path}: setup did not write it.`);
    } catch (e) {
      ctx.out(`Could not write them: ${(e as Error).message}`);
    }
  } else ctx.out("opencode sessions won't know Starbridge: rerun setup to install it.");
}

/** Off unless asked: the Claude app already answers prompts for Remote Control sessions. */
async function permissionStep(sys: Sys) {
  const { ctx, prompt } = sys;
  section(ctx, "Permission prompts");
  if (permissionsEnabled(ctx)) {
    ctx.out("Sent to your devices (`starbridge config permissions off` stops it).");
    await offerPiChain(ctx, prompt);
    return;
  }
  const on = await prompt.confirm(
    "Also send permission prompts (Claude Code's, opencode's, and Pi's through pi-permission-system) to your devices? The Claude app already shows Claude Code's for Remote Control sessions.",
    false,
  );
  if (on) setPermissions(ctx, true);
  ctx.out(
    on
      ? "Sent to your devices (`starbridge config permissions off` stops it)."
      : "They stay at the keyboard (`starbridge config permissions on` sends them).",
  );
  if (on) await offerPiChain(ctx, prompt);
}

function summary(snap: QuotaSnapshot): string {
  const windows = snap.providers.reduce((n, p) => n + p.windows.length, 0);
  const failed = snap.providers.filter((p) => p.error).map((p) => p.provider);
  return `Uploaded a first quota snapshot: ${snap.providers.length} providers, ${windows} windows${failed.length > 0 ? ` (${failed.join(", ")} failed)` : ""}.`;
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
    ctx.out(`The first quota upload failed: ${why}`);
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
  ctx.out("Answer it on your phone or the web page (Ctrl-C skips):");
  try {
    const code = await withAgent(
      ctx,
      (agent) => askVia(ctx, agent, input, opts),
      () => ask(ctx, input, opts),
    );
    if (code === 2) ctx.out("No answer within 10 minutes.");
  } catch (e) {
    ctx.out(`The test decision failed: ${(e as Error).message}`);
  }
}
