import {
  type Directory,
  laterSnooze,
  open,
  ProtocolError,
  parseWith,
  SealedItem,
} from "@starbridge/protocol";
import type { State } from "../config";
import type { Ctx, Session } from "../context";

/**
 * Keeps the owner's snooze of a decision this machine asked (#571), when a device it was sealed
 * to signed it and it is newer than the one kept. A snooze is not an answer: it only tells `wait`
 * and `waiting` that none comes before its time.
 */
export function acceptSnooze(raw: unknown, s: Session, dir: Directory, st: State): void {
  const item = parseWith(SealedItem, raw);
  if (item.kind !== "snooze") throw new ProtocolError("wrong-kind", item.kind);
  const { body, signer } = open(
    item as SealedItem & { kind: "snooze" },
    { id: s.machine.id, box: s.keys.box },
    dir,
  );
  const decision = st.asked[body.decisionId];
  if (!decision?.to.includes(signer.id)) return;
  // The rule every client applies, so a tie keeps the same snooze here as on the devices (#2103).
  if (!laterSnooze(decision.snooze, body)) return;
  decision.snooze = { until: body.until, at: body.at };
}

/** Until when the owner snoozed decision `id`, while that time is still to come and no answer is. */
export function snoozedUntil(st: State, id: string, now: Date): string | undefined {
  const a = st.asked[id];
  const until = a?.snooze?.until;
  // Held while the directory is behind, as answers are: a newer word may be among the held.
  if (!until || a.settled || st.answers[id] || st.behind) return undefined;
  // Back now ends at its own time, read before this machine's clock: the device's may run ahead.
  if (Date.parse(until) <= Date.parse(a.snooze?.at ?? "")) return undefined;
  if (Date.parse(until) <= now.getTime()) return undefined;
  return until;
}

/** Decision `id`'s snooze, once per snooze: `wait` says it and exits, then waits on. */
export function takeSnooze(store: Ctx["store"], id: string, now: Date): string | undefined {
  const st = store.state();
  if (!snoozedUntil(st, id, now) || st.asked[id]?.snooze?.told) return undefined;
  let until: string | undefined;
  store.updateState((st) => {
    const s = st.asked[id]?.snooze;
    if (!s || s.told || !snoozedUntil(st, id, now)) return;
    s.told = true;
    until = s.until;
  });
  return until;
}

/**
 * "18:00", "tomorrow 09:00", "Fri 09:00": when a snooze ends, in this machine's zone and 24-hour
 * time, as an agent reads it.
 */
export function snoozeTime(until: Date, now: Date): string {
  const time = until.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => d.toDateString();
  if (day(until) === day(now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (day(until) === day(tomorrow)) return `tomorrow ${time}`;
  return `${until.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** The line `wait` and `waiting` print for a snoozed decision; the skill tells agents what it means. */
export function snoozeLine(id: string, question: string | undefined, until: string, now: Date) {
  return `Snoozed ${id}${question ? ` (${question})` : ""} until ${snoozeTime(new Date(until), now)}: no answer before then.`;
}

/** A snooze as `wait` prints it: the line, or `{decisionId, snoozedUntil}` with `--json`. */
export function printSnooze(
  ctx: Ctx,
  id: string,
  question: string | undefined,
  until: string,
  json?: boolean,
) {
  ctx.out(
    json
      ? JSON.stringify({ decisionId: id, snoozedUntil: until })
      : snoozeLine(id, question, until, ctx.now()),
  );
}
