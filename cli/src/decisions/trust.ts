import {
  type Answer,
  type Directory,
  noteHead as keepHead,
  open,
  openBox,
  ProtocolError,
  parseBody,
  parseWith,
  SealedItem,
  verify,
  verifyDirectory,
} from "@starbridge/protocol";
import type { State } from "../config";
import { type Ctx, refreshDirectory, type Session, session, withheld } from "../context";

/** What `checkAnswer` reads of a decision this machine asked. */
type Asked = Pick<State["asked"][string], "options" | "settled" | "answerIn" | "done" | "to">;

/**
 * Checks an answer item: sealed to this machine, signed by an active device that the decision was
 * sealed to, for an open decision this machine asked that takes answers in Starbridge, with one of
 * its options or a typed reply; or, for one answered on its own page, a Done.
 */
export function checkAnswer(
  raw: unknown,
  s: Session,
  dir: Directory,
  asked: Record<string, Asked>,
): Answer {
  const item = parseWith(SealedItem, raw);
  if (item.kind !== "answer") throw new ProtocolError("wrong-kind", item.kind);
  const { body, signer } = open(
    item as SealedItem & { kind: "answer" },
    { id: s.machine.id, box: s.keys.box },
    dir,
  );
  const decision = asked[body.decisionId];
  if (!decision) throw new ProtocolError("unknown-member", `not my decision: ${body.decisionId}`);
  // A server can hold a signed answer back and release it once the agent moved on.
  if (decision.settled)
    throw new ProtocolError("id-mismatch", `${body.decisionId} is settled: no answer counts`);
  // A decision answered on its own page takes a Done, when it asked for one, and nothing else.
  if (!!body.done !== !!(decision.answerIn && decision.done))
    throw new ProtocolError(
      "id-mismatch",
      decision.answerIn
        ? `${body.decisionId} is answered on its own page`
        : `${body.decisionId} takes no Done`,
    );
  if (!decision.to.includes(signer.id))
    throw new ProtocolError("unknown-member", `${body.decisionId} was not sent to ${signer.id}`);
  // A typed reply answers any decision (`replies`); a choice must be one of its options. The
  // schema already holds an answer to exactly one of the two.
  if (body.choice !== undefined && !decision.options.includes(body.choice))
    throw new ProtocolError("bad-schema", "choice is not one of the options");
  return body;
}

/**
 * Records the directory head a device signed into answer `raw`. A shorter head never replaces a
 * longer one the chain lacks, so replaying an older answer cannot lift a refusal. Returns the
 * device that signed `raw` when it is an answer an active device signed.
 */
export function noteHead(
  raw: unknown,
  s: Session,
  dir: Directory,
  entries: unknown[],
  st: State,
): string | undefined {
  const item = SealedItem.safeParse(raw);
  const kind = item.success ? item.data.kind : undefined;
  // A snooze is a device's word too, with the head it signed (#571).
  if (!item.success || (kind !== "answer" && kind !== "permission-answer" && kind !== "snooze"))
    return undefined;
  let opened: ReturnType<typeof open<"answer" | "permission-answer" | "snooze">>;
  try {
    opened = open(
      item.data as SealedItem & { kind: "answer" | "permission-answer" | "snooze" },
      { id: s.machine.id, box: s.keys.box },
      dir,
    );
  } catch {
    return undefined;
  }
  // A device vouches for its own head only: a `by` in an answer would add a key per id it names.
  const head = opened.body.dir && { length: opened.body.dir.length, head: opened.body.dir.head };
  st.heads ??= {};
  keepHead(st.heads, opened.signer.id, head, entries);
  return opened.signer.id;
}

/**
 * Why no answer counts now: a device active in `dir` signed a head the machine's chain `entries`
 * lacks, so the server is holding back entries, perhaps the revocation of a device that answers.
 */
export function behindBy(st: State, dir: Directory, entries: unknown[]): string | undefined {
  const held = withheld(st, dir, entries);
  return held && `${held}. No answer counts meanwhile`;
}

/**
 * Closes a decision as `dropRevoked` does when this machine refused an answer to it only because
 * its device was revoked before the machine fetched it (#1301): the server holds the decision
 * answered and takes no other answer, so `wait` would wait forever. Only when the signed body
 * names that decision, its hint agrees and the device was one it was sealed to: the hint is
 * unsigned, so a server could otherwise point a device's answer at any open decision.
 */
export function refuse(raw: unknown, e: unknown, s: Session, dir: Directory, st: State): void {
  if (!(e instanceof ProtocolError) || e.code !== "revoked-signer") return;
  let decisionId: string;
  let signer: string;
  try {
    const item = parseWith(SealedItem, raw);
    if (item.kind !== "answer") return;
    const env = openBox(item, { id: s.machine.id, box: s.keys.box });
    const member = dir.members.get(env.signer)?.member;
    if (env.signer !== item.from || member?.role !== "device") return;
    verify(env, member.signPk);
    decisionId = parseBody("answer", env.body).decisionId;
    if (item.re !== decisionId) return;
    signer = env.signer;
  } catch {
    return;
  }
  const asked = st.asked[decisionId];
  if (!asked || asked.settled || st.answers[decisionId] || !asked.to.includes(signer)) return;
  asked.settled = true;
  asked.revoked = true;
  forget(asked);
}

/**
 * Drops the answers accepted but not yet delivered whose device the chain now revokes, such as
 * one accepted while the server withheld that revocation, or before the owner revoked a stolen
 * device: a revoked device's answer never reaches a session.
 */
export function dropRevoked(st: State, dir: Directory): boolean {
  const revoked = (device: string | undefined) =>
    device !== undefined && !dir.members.get(device)?.active;
  let dropped = false;
  for (const [id, a] of Object.entries(st.answers))
    if (!a.seen && revoked(a.device)) {
      delete st.answers[id];
      // The server holds it answered, so no device can answer it again: closed (#515).
      const asked = st.asked[id];
      if (asked) {
        asked.settled = true;
        asked.revoked = true;
        forget(asked);
      }
      dropped = true;
    }
  for (const p of Object.values(st.permissions ?? {}))
    if (p.answer && !p.settled && revoked(p.answer.device)) {
      delete p.answer;
      dropped = true;
    }
  return dropped;
}

/**
 * Before a saved answer is handed out without a poll: drops those from devices revoked since,
 * against the directory as the server has it now, else as this machine last verified it. Only
 * when there is an undelivered answer from a device, so a call with nothing to hand out stays
 * offline.
 */
export async function dropRevokedNow(ctx: Ctx) {
  const st = ctx.store.state();
  if (!Object.values(st.answers).some((a) => !a.seen && a.device)) return;
  const s = session(ctx);
  let dir: Directory;
  try {
    dir = await refreshDirectory(ctx, s, ctx.signal);
  } catch {
    dir = verifyDirectory(ctx.store.directory(), {
      account: s.machine.account,
      pin: s.machine.pin,
    });
  }
  if (dropRevoked(st, dir)) ctx.store.updateState((fresh) => dropRevoked(fresh, dir));
}

/** Drops a closed decision's body, so its plaintext does not stay on disk. */
export function forget(a: State["asked"][string]) {
  delete a.body;
}
