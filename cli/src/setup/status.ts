/** `starbridge status`: setup's checks, at any time. */
import { join } from "node:path";
import type { Status } from "../agent/api";
import { AgentClient } from "../agent/client";
import { REMOVED, REMOVED_CLOUD } from "../api";
import { autoOn, RETRY_MS } from "../autoupdate";
import { hooklessCopies } from "../claude";
import type { LatestRelease, UpdateRecord } from "../config";
import type { Ctx } from "../context";
import { deliverable, hooklessLine } from "../decisions";
import { newerRelease, updateCheckOn, updateCommand } from "../latest";
import { type InstallKind, installKind } from "../release";
import { MANAGED } from "../update";
import { VERSION } from "../version";
import { AGENT_IDS, AGENTS, HARNESSES, removedAgents } from "./agents";
import { findCodexbar, listProviders, probe } from "./codexbar";
import { SERVICE } from "./integrations";
import { REMOTE_PLUGIN, remotePluginLoaded } from "./remote-plugin";
import { probeLines } from "./setup";
import { otherCopies, type Sys } from "./sys";

async function agentStatus(sys: Sys): Promise<Status | string> {
  const agent = AgentClient.for(sys.ctx);
  if (!agent) return "off (STARBRIDGE_NO_AGENT is set)";
  try {
    return await agent.call<Status>("GET", "/v1/status", undefined, 5_000);
  } catch (e) {
    return `not running (${(e as Error).message})`;
  }
}

/** The latest release as the agent last read it (#1050), and what to run when it is newer. */
export function latestLine(ctx: Ctx): string {
  if (!updateCheckOn(ctx)) return "Latest: not checked (`starbridge config update-check on`)";
  let latest: LatestRelease | undefined;
  try {
    latest = ctx.store.latest();
  } catch (e) {
    return `Latest: ${(e as Error).message}`;
  }
  if (!latest) return "Latest: not checked yet (the agent reads it once a day)";
  const newer = newerRelease(ctx);
  return newer
    ? `Latest: ${newer}, checked ${latest.checkedAt}: run ${updateCommand(installKind(), newer)}`
    : `Latest: ${latest.version}, checked ${latest.checkedAt}`;
}

/**
 * Automatic updates (#1266): whether they are on, the last update and the last failure, from
 * `update.json`; what holds the next one comes from the agent.
 */
export function updateLines(ctx: Ctx, install: InstallKind): string[] {
  const lines = [
    install.kind !== "binary"
      ? `Updates: through ${install.kind} (${MANAGED[install.kind].update(VERSION)})`
      : autoOn(ctx, install)
        ? "Updates: automatic (`starbridge config updates off`)"
        : ctx.store.agentConfig().updates?.auto === false
          ? "Updates: off (`starbridge config updates on`)"
          : "Updates: off while the update check is off (`starbridge config update-check on`)",
  ];
  let r: UpdateRecord;
  try {
    r = ctx.store.updates();
  } catch (e) {
    return [...lines, `  ${(e as Error).message}`];
  }
  if (r.updated) lines.push(`  Last update: ${r.updated.from} to ${r.updated.to}, ${r.updated.at}`);
  if (r.failed) {
    const retry =
      r.tried && autoOn(ctx, install)
        ? `; tries again after ${new Date(Date.parse(r.tried.at) + RETRY_MS).toISOString()}`
        : "";
    lines.push(
      `  Last failure: ${r.failed.at}${r.failed.version ? ` (${r.failed.version})` : ""}: ${r.failed.why}${retry}; output in ${join(ctx.store.dir, "update.log")}`,
    );
  }
  return lines;
}

export async function status(sys: Sys): Promise<number> {
  const { ctx } = sys;
  const out = ctx.out;
  out(`starbridge ${VERSION} (${sys.self.join(" ")})`);
  for (const line of await otherCopies(sys)) out(line);
  out(latestLine(ctx));
  for (const line of updateLines(ctx, installKind())) out(line);

  const machine = ctx.store.machine();
  out(
    machine
      ? `Paired: "${machine.name}" (${machine.id}) on ${machine.server}`
      : "Paired: no (run `starbridge setup`)",
  );

  // An answer whose session's `wait` died sits unseen: no session that is not waiting notices
  // it (#557).
  const st = ctx.store.state();
  const unseen = Object.entries(st.answers).filter(
    ([id, a]) => !a.seen && !st.asked[id]?.held && deliverable(st, id),
  );
  if (unseen.length > 0) out(`Answers no session has taken: ${unseen.length}`);
  for (const [id] of unseen) {
    const a = st.asked[id];
    out(
      `  ${id} (${a?.question ?? ""})${a?.session ? ` from session ${a.session}` : ""}: \`starbridge wait ${id}\` prints it`,
    );
  }

  const agent = await agentStatus(sys);
  if (typeof agent === "string") out(`Agent: ${agent}`);
  else {
    out(`Agent: ${agent.version}, pid ${agent.pid}, since ${agent.startedAt}, on ${agent.socket}`);
    const s = agent.server;
    // The server answered, refusing this machine's token.
    if (s.lastError === REMOVED || s.lastError === REMOVED_CLOUD)
      out(`Server: reachable, but ${s.lastError}`);
    else
      out(
        `Server: ${s.reachable ? "reachable" : "not reachable"}${s.lastOkAt ? `, last answered ${s.lastOkAt}` : ""}${s.lastError ? `, last error: ${s.lastError}` : ""}`,
      );
    const q = agent.quota;
    out(
      q.providers.length > 0
        ? `Quota: ${q.providers.join(", ")} every ${q.intervalSeconds / 60} min${q.lastPostAt ? `, last upload ${q.lastPostAt}` : ""}${q.lastError ? `, last error: ${q.lastError}` : ""}`
        : "Quota: no providers",
    );
    if (agent.update) out(`Update: ${agent.update}`);
    out(`Sessions: ${agent.sessions.length}`);
    for (const x of agent.sessions)
      out(
        `  ${x.id}${x.title ? ` "${x.title}"` : ""}${x.client ? ` ${x.client}` : ""}, last seen ${x.lastSeenAt}`,
      );
    // Run from a Claude Code session whose mod never called: its answers wait for `wait` (#863).
    const own = ctx.env.CLAUDECODE === "1" ? ctx.env.CLAUDE_CODE_SESSION_ID : undefined;
    if (
      own &&
      ctx.env.CLAUDE_CODE_SESSION_ATTENDED !== "0" &&
      !agent.sessions.some((x) => x.id === own)
    ) {
      out(
        `  Not this session (${own}): no Starbridge mod runs in it, so answers come back only through \`starbridge wait\``,
      );
      const copies = hooklessCopies(ctx.env, own, sys.argsOf);
      if (copies.length > 0) {
        out(`    ${hooklessLine(copies)}`);
        out(
          remotePluginLoaded(sys)
            ? `    The ${REMOTE_PLUGIN} plugin stands in for them from the next session Claude desktop starts.`
            : "    `starbridge setup --refresh` adds a plugin that stands in for them, from the next session Claude desktop starts.",
        );
      }
    }
  }

  for (const line of await SERVICE.status(sys)) out(line);

  const cfg = ctx.store.agentConfig().quota;
  const found = findCodexbar(sys, cfg?.codexbar);
  const missing =
    sys.platform === "win32"
      ? "none (no Windows build)"
      : "not found (`starbridge setup` installs it)";
  out(`CodexBar: ${found?.path ?? missing}`);
  if (found && cfg?.providers?.length) {
    const list = await listProviders(sys, found.path);
    for (const line of probeLines(sys, await probe(found.path, cfg.providers, list))) out(line);
  }

  const removed = removedAgents(ctx);
  for (const id of AGENT_IDS) {
    const harness = HARNESSES[id];
    if (!harness.found(sys)) {
      for (const line of harness.absent?.(sys) ?? []) out(line);
      continue;
    }
    if (removed.includes(id)) {
      out(`${AGENTS[id]}: left out (\`starbridge setup --agent ${id}\` brings it back)`);
      continue;
    }
    for (const line of await harness.status(sys)) out(line);
  }
  return 0;
}
