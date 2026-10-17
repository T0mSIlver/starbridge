import { joinLines, type Line } from "./agent.ts";

/**
 * Answers to the questions a Claude Code subagent asked (#1702). A subagent's Bash runs with its
 * parent's session id and no id of its own, so the mod tags its `starbridge ask` with the
 * subagent's id, which the CLI keeps with the decision, and sends the answer to that subagent
 * rather than submitting it as the parent's prompt. A subagent that runs gets it at its next tool
 * call; one that finished is resumed with it. One that cannot take it leaves it to the parent.
 */

/** The variable the CLI reads the asking subagent's id from. */
const AGENT_VAR = "STARBRIDGE_CLAUDE_AGENT";

/** Characters a Claude Code agent id or teammate address takes, as the CLI checks them. */
const AGENT_ID = /^[A-Za-z0-9_.@-]{1,200}$/;

/** A command that runs `starbridge ask`, by name or path, anywhere in it. */
const ASKS = /(?:^|[\s;&|(`'"/])starbridge(?:\.exe|\.cmd|\.js)?['"]?\s+ask(?=$|\s)/;

const TAG = new RegExp(`^export ${AGENT_VAR}=([A-Za-z0-9_.@-]{1,200})\\n`);

/**
 * The Bash command subagent `agentId` runs, with the subagent's id exported first when it runs
 * `starbridge ask`; any other command, or an id the CLI would refuse, unchanged.
 */
export function tagAsk(command: string, agentId: string): string {
  if (!AGENT_ID.test(agentId) || !ASKS.test(command) || TAG.test(command)) return command;
  return `export ${AGENT_VAR}=${agentId}\n${command}`;
}

/**
 * The command as the subagent wrote it: the permission check judges that, so the tag never makes
 * a command the rules allow ask anyone.
 */
export function untagAsk(command: string): string {
  return command.replace(TAG, "");
}

/** One message for subagent `agentId`: the lines, and the text `Line.text` joins them into. */
export type Send = (
  agentId: string,
  lines: Line[],
  text: string,
) => Promise<{ isDelivered: boolean; reason?: string }>;

/** What the parent gets for a line its subagent `agent` could not take. */
export function forParent(l: Line, agent: string): Line {
  return {
    text: `${l.text}\nYour subagent ${agent} asked this and could not take the answer: act on it, or pass it on.`,
    ack: l.ack,
  };
}

/**
 * Sends each subagent its answers, one message per subagent in the order they came. Returns the
 * acks it delivered, and the lines left for the parent: those no subagent asked, then those a
 * subagent could not take, which say so. A line in `failed`, which a send already failed, goes to
 * the parent without another try: retried while the parent's turn holds it, it could reach both.
 */
export async function toSubagents(
  lines: Line[],
  send: Send,
  log: (text: string) => void,
  failed: Set<string> = new Set(),
): Promise<{ taken: string[]; rest: Line[] }> {
  const byAgent = new Map<string, Line[]>();
  const rest: Line[] = [];
  for (const l of lines) {
    if (l.subagent === undefined) rest.push(l);
    else if (failed.has(l.ack)) rest.push(forParent(l, l.subagent));
    else byAgent.set(l.subagent, [...(byAgent.get(l.subagent) ?? []), l]);
  }
  const taken: string[] = [];
  for (const [agent, group] of byAgent) {
    let why: string | undefined;
    try {
      const r = await send(agent, group, joinLines(group));
      if (r.isDelivered) {
        taken.push(...group.map((l) => l.ack));
        continue;
      }
      why = r.reason ?? "not delivered";
    } catch (e) {
      why = (e as Error).message;
    }
    log(
      `starbridge: subagent ${agent} could not take ${group.map((l) => l.ack).join(", ")}: ${why}`,
    );
    for (const l of group) {
      failed.add(l.ack);
      rest.push(forParent(l, agent));
    }
  }
  return { taken, rest };
}
