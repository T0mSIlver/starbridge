// The inbox as one feed (DESIGN.md, "Rules"): runs, then what needs the owner, then History.
// Pure, so the order has tests.
import { closedAt, outcomeText } from "./outcome";
import { shownRuns } from "./runs";
import type { InboxItem, PromptItem, RunItem, Source } from "./types";

/** What a machine is, for its icon; #122 adds it to `source`, older items have none. */
export type MachineKind = "server" | "desktop" | "laptop" | "cloud";

type Base = { id: string; machine: string; kind?: MachineKind; repo: string };
export type Entry =
  | (Base & { type: "prompt"; at: string; item: PromptItem })
  | (Base & { type: "question"; at: string; item: InboxItem })
  | (Base & { type: "run"; at: string; item: RunItem });

const facts = (source: Source & { machineKind?: MachineKind }) => ({
  machine: source.machine,
  kind: source.machineKind,
  repo: source.project,
});

export const promptEntry = (p: PromptItem): Entry => ({
  type: "prompt",
  id: p.permission.id,
  at: p.permission.createdAt,
  item: p,
  ...facts(p.permission.source),
});

export const questionEntry = (i: InboxItem): Entry => ({
  type: "question",
  id: i.decision.id,
  at: i.decision.createdAt,
  item: i,
  ...facts(i.decision.source),
});

const runEntry = (r: RunItem): Entry => ({
  type: "run",
  id: r.run.id,
  at: r.run.startedAt,
  item: r,
  ...facts(r.run.source),
  // The run's signer, which the page names as the directory does.
  machine: r.machine,
});

/** A prompt waiting for an answer: not answered, not settled, not expired. */
export const promptOpen = (p: PromptItem, now: number) =>
  p.closedAt === undefined && !p.answeredAt && Date.parse(p.permission.expiresAt) > now;

/**
 * What holds an agent up comes first: prompts, then questions their agent waits on, then
 * questions it works around. Within each, the one waiting longest leads.
 */
export function needsYou(inbox: InboxItem[], prompts: PromptItem[], now: number): Entry[] {
  const rank = (e: Entry) =>
    e.type === "prompt" ? 0 : e.type === "question" && e.item.waitingSince ? 1 : 2;
  return [
    ...prompts.filter((p) => promptOpen(p, now)).map(promptEntry),
    ...inbox.filter((i) => !closedAt(i)).map(questionEntry),
  ].sort((a, b) => rank(a) - rank(b) || a.at.localeCompare(b.at));
}

export const running = (runs: RunItem[], now: number): Entry[] =>
  shownRuns(runs, now).map(runEntry);

export type Group = { machine: string; kind?: MachineKind; entries: Entry[] };

/**
 * "Group by machine": one group per machine, its runs then its needs, the groups in the order of
 * their most pressing need; machines with only runs come last.
 */
export function byMachine(runs: Entry[], needs: Entry[]): Group[] {
  const groups = new Map<string, Group>();
  const add = (e: Entry) => {
    const g = groups.get(e.machine) ?? { machine: e.machine, kind: e.kind, entries: [] };
    g.kind ??= e.kind;
    g.entries.push(e);
    groups.set(e.machine, g);
  };
  needs.forEach(add);
  const order = [...groups.keys()];
  for (const r of runs) add(r);
  const rank = (m: string) => (order.includes(m) ? order.indexOf(m) : order.length);
  return [...groups.values()]
    .map((g) => ({
      ...g,
      entries: [
        ...g.entries.filter((e) => e.type === "run"),
        ...g.entries.filter((e) => e.type !== "run"),
      ],
    }))
    .sort((a, b) => rank(a.machine) - rank(b.machine));
}

/** An answered item, as History lists it. */
export type Past = { entry: Entry; closed: string; text: string; outcome: string };

/**
 * Answered questions, and prompts the page saw answered or loaded from the last 7 days,
 * latest first.
 */
export function history(
  inbox: InboxItem[],
  prompts: PromptItem[],
  promptOutcome: (p: PromptItem) => string,
  now: number,
): Past[] {
  const questions = inbox.flatMap((i): Past[] => {
    const closed = closedAt(i);
    return closed
      ? [{ entry: questionEntry(i), closed, text: i.decision.question, outcome: outcomeText(i) }]
      : [];
  });
  const answered = prompts.flatMap((p): Past[] =>
    promptOpen(p, now)
      ? []
      : [
          {
            entry: promptEntry(p),
            closed: p.answeredAt ?? p.permission.expiresAt,
            text: p.permission.summary,
            outcome: promptOutcome(p),
          },
        ],
  );
  return [...questions, ...answered].sort((a, b) => b.closed.localeCompare(a.closed));
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** How many of `past` closed today, in the device's zone. */
export const closedToday = (past: Past[], now: number) =>
  past.filter((p) => sameDay(new Date(p.closed), new Date(now))).length;

/** "now", "12 min", "3 h", "2 d": how long ago, for the meta row. */
export function ago(iso: string, now: number): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / (24 * 60))} d`;
}

/** "1:12", "1:04:09": a timer since `iso`. */
export function timer(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
