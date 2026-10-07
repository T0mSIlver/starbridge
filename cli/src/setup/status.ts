/** `starbridge status`: setup's checks, at any time. */
import type { Status } from "../agent/api";
import { AgentClient } from "../agent/client";
import { REMOVED } from "../api";
import { deliverable } from "../decisions";
import { VERSION } from "../version";
import { AGENT_IDS, AGENTS, found as agentFound, installed, removedAgents } from "./agents";
import { findCodexbar, listProviders, probe } from "./codexbar";
import { codexSkill, opencodeState, PI_PACKAGE, piPackage } from "./harnesses";
import { autoUpdate, hasClaude, PLUGINS, pluginState } from "./plugins";
import { lingering, serviceState } from "./service";
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

export async function status(sys: Sys): Promise<number> {
  const { ctx } = sys;
  const out = ctx.out;
  out(`starbridge ${VERSION} (${sys.self.join(" ")})`);
  for (const line of await otherCopies(sys)) out(line);

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
    if (s.lastError === REMOVED) out(`Server: reachable, but ${REMOVED}`);
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

  if (!hasClaude(sys)) out("Claude Code: not on the PATH");
  const removed = removedAgents(ctx);
  for (const id of AGENT_IDS) {
    if (!agentFound(sys, id)) continue;
    if (removed.includes(id)) {
      out(`${AGENTS[id]}: left out (\`starbridge setup --agent ${id}\` brings it back)`);
      continue;
    }
    // Claude Code's state costs two `claude` runs: read once, and its own error shown as is.
    const claude = id === "claude" ? await pluginState(sys) : undefined;
    if (typeof claude === "string") {
      out(`Claude Code: ${claude}`);
      continue;
    }
    const isIn = claude ? PLUGINS.every((pid) => claude.plugins[pid]) : await installed(sys, id);
    // An agent installed after setup: nothing installs in the background (#750).
    if (!isIn) {
      out(`${AGENTS[id]} found, Starbridge not installed: run \`starbridge setup --refresh\``);
      continue;
    }
    if (claude) {
      out(
        `Claude Code marketplace: ${claude.marketplace ? "added" : "not added"}${autoUpdate(sys) ? ", auto-update on" : ""}`,
      );
      for (const pid of PLUGINS) {
        const x = claude.plugins[pid];
        out(
          `  ${pid}: ${x ? `${x.version ?? "installed"}${x.enabled ? "" : ", disabled"}` : "not installed"}`,
        );
      }
    } else if (id === "codex") {
      const state = codexSkill(sys);
      out(
        `Codex skill: ${state === "current" ? "installed" : state === "outdated" ? "outdated (`starbridge setup --refresh` updates it)" : "another skill named starbridge"}`,
      );
    } else if (id === "pi") {
      const pi = piPackage(sys);
      out(
        `Pi package: ${pi === PI_PACKAGE ? "installed" : `${pi} (\`starbridge setup\` moves it to v${VERSION})`}`,
      );
    } else {
      const state = opencodeState(sys);
      out(
        `opencode skill and plugin: ${state === "current" ? "installed" : state === "outdated" ? "outdated (`starbridge setup --refresh` updates them)" : "not managed by starbridge (another skill or plugin named starbridge)"}`,
      );
    }
  }
  return 0;
}
