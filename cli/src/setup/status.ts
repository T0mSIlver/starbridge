/** `starbridge status`: setup's checks, at any time. */
import type { Status } from "../agent/api";
import { AgentClient } from "../agent/client";
import { VERSION } from "../version";
import { findCodexbar, listProviders, probe } from "./codexbar";
import { autoUpdate, hasClaude, legacyInstalls, PLUGINS, pluginState } from "./plugins";
import { legacyUnits, lingering, serviceState } from "./service";
import { probeLines } from "./setup";
import type { Sys } from "./sys";

async function agentStatus(sys: Sys): Promise<Status | string> {
  const agent = AgentClient.for(sys.ctx);
  if (!agent) return "off (STARBRIDGE_NO_AGENT is set)";
  try {
    return await agent.call<Status>("GET", "/v1/status", undefined, 5_000);
  } catch (e) {
    return `not running (${(e as Error).message})`;
  }
}

export async function status(sys: Sys): Promise<number> {
  const { ctx } = sys;
  const out = ctx.out;
  out(`starbridge ${VERSION} (${sys.self.join(" ")})`);

  const machine = ctx.store.machine();
  out(
    machine
      ? `Paired: "${machine.name}" (${machine.id}) on ${machine.server}`
      : "Paired: no (run `starbridge setup`)",
  );

  const agent = await agentStatus(sys);
  if (typeof agent === "string") out(`Agent: ${agent}`);
  else {
    out(`Agent: ${agent.version}, pid ${agent.pid}, since ${agent.startedAt}, on ${agent.socket}`);
    const s = agent.server;
    out(
      `Server: ${s.reachable ? "reachable" : "not reachable"}${s.lastOkAt ? `, last answered ${s.lastOkAt}` : ""}${s.lastError ? `, last error: ${s.lastError}` : ""}`,
    );
    const q = agent.quota;
    out(
      q.providers.length > 0
        ? `Quota: ${q.providers.join(", ")} every ${q.intervalSeconds / 60} min${q.lastPostAt ? `, last upload ${q.lastPostAt}` : ""}${q.lastError ? `, last error: ${q.lastError}` : ""}`
        : "Quota: no providers",
    );
    out(`Sessions: ${agent.sessions.length}`);
    for (const x of agent.sessions)
      out(
        `  ${x.id}${x.title ? ` "${x.title}"` : ""}${x.client ? ` ${x.client}` : ""}, last seen ${x.lastSeenAt}`,
      );
  }

  const svc = await serviceState(sys);
  out(
    svc.installed
      ? `Service: ${svc.state}${svc.enabled === undefined ? "" : svc.enabled ? ", enabled" : ", not enabled"}`
      : "Service: not installed",
  );
  if ((await lingering(sys)) === false)
    out("  Lingering is off: the agent stops when your last login session ends.");
  for (const u of legacyUnits(sys))
    out(`  Old uploader ${u.path} still exists: \`starbridge setup\` replaces it.`);

  const cfg = ctx.store.agentConfig().quota;
  const found = findCodexbar(sys, cfg?.codexbar);
  out(`CodexBar: ${found?.path ?? "not found"}`);
  if (found && cfg?.providers?.length) {
    const list = await listProviders(sys, found.path);
    for (const line of probeLines(sys, await probe(found.path, cfg.providers, list))) out(line);
  }

  if (!hasClaude(sys)) out("Claude Code: not on the PATH");
  else {
    const p = await pluginState(sys);
    if (!p) out("Claude Code: `claude plugin list` failed");
    else {
      out(
        `Claude Code marketplace: ${p.marketplace ? "added" : "not added"}${autoUpdate(sys) ? ", auto-update on" : ""}`,
      );
      for (const id of PLUGINS) {
        const x = p.plugins[id];
        out(
          `  ${id}: ${x ? `${x.version ?? "installed"}${x.enabled ? "" : ", disabled"}` : "not installed"}`,
        );
      }
    }
    for (const old of legacyInstalls(sys)) out(`  Manual install left: ${old.what}`);
  }
  return 0;
}
