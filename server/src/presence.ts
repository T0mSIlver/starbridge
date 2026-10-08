import type { Database } from "bun:sqlite";
import { PRESENCE_VALID_MS, PUSH_HOLD_DEFAULT, type SealedItem } from "@starbridge/protocol";
import type { Push } from "./push";
import { pushPayload } from "./routes/items";

/**
 * Who of an account sits at a screen right now (#848), as each machine and device last said:
 * one bit per source, kept in memory only and trusted `PRESENCE_VALID_MS` after its last beat. A
 * restart forgets it, which means push at once.
 */
export class Presence {
  private accounts = new Map<string, Map<string, number>>();

  beat(account: string, member: string, present: boolean, now = Date.now()): void {
    let sources = this.accounts.get(account);
    if (!present) {
      sources?.delete(member);
      if (sources?.size === 0) this.accounts.delete(account);
      return;
    }
    if (!sources) {
      sources = new Map();
      this.accounts.set(account, sources);
    }
    sources.set(member, now + PRESENCE_VALID_MS);
  }

  /** The account's present sources, or none when nobody is at a screen. */
  present(account: string, now = Date.now()): string[] {
    const sources = this.accounts.get(account);
    if (!sources) return [];
    for (const [member, until] of sources) if (until <= now) sources.delete(member);
    if (sources.size === 0) this.accounts.delete(account);
    return [...sources.keys()];
  }

  /** Drops what has run out, so an account that stopped beating leaves no entry. */
  sweep(now = Date.now()): void {
    for (const account of [...this.accounts.keys()]) this.present(account, now);
  }
}

/** Kinds whose push waits while the owner is present: those that block an agent. */
export const HELD_KINDS: readonly SealedItem["kind"][] = ["decision", "permission", "waiting"];

/** The account's hold time in seconds; unset is the default. */
export function pushHold(db: Database, account: string): number {
  const row = db.query("SELECT push_hold FROM accounts WHERE id = ?").get(account) as {
    push_hold: number | null;
  } | null;
  return row?.push_hold ?? PUSH_HOLD_DEFAULT;
}

/**
 * The devices of `to` whose push waits, and until when: every one not itself present, while any
 * source of the account is. None when nobody is present or the hold is off.
 */
export function holdFor(
  db: Database,
  presence: Presence,
  account: string,
  to: string[],
  now = Date.now(),
): { held: string[]; due: string } | undefined {
  const present = presence.present(account, now);
  if (present.length === 0) return undefined;
  const seconds = pushHold(db, account);
  if (seconds <= 0) return undefined;
  const held = to.filter((id) => !present.includes(id));
  if (held.length === 0) return undefined;
  return { held, due: new Date(now + seconds * 1000).toISOString() };
}

/**
 * Pushes the held items whose hold has run out to the devices they were held from, when they are
 * still open: a permission unanswered, a decision, or a `waiting` item's, unanswered and not
 * snoozed. One answered, settled or snoozed meanwhile never pushes.
 */
export function releaseHolds(
  db: Database,
  push: Push,
  inlineLimit: number,
  now = Date.now(),
): void {
  const due = db
    .query(
      `SELECT account_id, id, kind, from_id, re, answered_at, hold_to FROM items
       WHERE hold_due IS NOT NULL AND hold_due <= ?`,
    )
    .all(new Date(now).toISOString()) as {
    account_id: string;
    id: string;
    kind: SealedItem["kind"];
    from_id: string;
    re: string | null;
    answered_at: string | null;
    hold_to: string;
  }[];
  for (const h of due) {
    // Cleared first: a push that fails is not retried, as no other push is. A closed item keeps
    // `hold_to`, so the notices that close it skip the devices that never heard of it.
    const open = stillOpen(db, h);
    db.query(
      `UPDATE items SET hold_due = NULL${open ? ", hold_to = NULL" : ""} WHERE account_id = ? AND id = ?`,
    ).run(h.account_id, h.id);
    if (!open) continue;
    const held = JSON.parse(h.hold_to) as string[];
    const boxes = db
      .query(
        `SELECT b.to_id AS "to", b.box FROM boxes b JOIN members m
         ON m.account_id = b.account_id AND m.id = b.to_id AND m.role = 'device' AND m.active = 1
         WHERE b.account_id = ? AND b.item_id = ? AND b.to_id IN (SELECT value FROM json_each(?))`,
      )
      .all(h.account_id, h.id, JSON.stringify(held)) as { to: string; box: string }[];
    if (boxes.length === 0) continue;
    const item: SealedItem = {
      v: 1,
      kind: h.kind,
      id: h.id,
      from: h.from_id,
      ...(h.re ? { re: h.re } : {}),
      boxes,
    };
    push.notify(
      h.account_id,
      boxes.map((b) => b.to),
      // A decision with images goes as its id, as at its post: the device fetches the blobs.
      (device) => pushPayload(withBlobs(db, h.account_id, h.id, item), device, inlineLimit),
    );
  }
}

function withBlobs(db: Database, account: string, id: string, item: SealedItem): SealedItem {
  const row = db
    .query("SELECT blobs FROM items WHERE account_id = ? AND id = ?")
    .get(account, id) as {
    blobs: string | null;
  } | null;
  return row?.blobs ? { ...item, blobs: JSON.parse(row.blobs) as string[] } : item;
}

function stillOpen(
  db: Database,
  h: {
    account_id: string;
    id: string;
    kind: SealedItem["kind"];
    re: string | null;
    answered_at: string | null;
  },
): boolean {
  if (h.kind === "permission") return h.answered_at === null;
  const decisionId = h.kind === "waiting" ? h.re : h.id;
  const decision = db
    .query("SELECT answered_at FROM items WHERE account_id = ? AND id = ?")
    .get(h.account_id, decisionId) as { answered_at: string | null } | null;
  if (!decision || decision.answered_at) return false;
  // A snooze still to wake says not now, as it does to a waiting flip's own push (#571).
  const last = db
    .query(
      `SELECT wake_due FROM items WHERE account_id = ? AND kind = 'snooze' AND re = ?
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(h.account_id, decisionId) as { wake_due: string | null } | null;
  return !last?.wake_due;
}
