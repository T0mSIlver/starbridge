import type { Database } from "bun:sqlite";
import type { SealedItem } from "@starbridge/protocol";
import type { Push } from "./push";
import { pushPayload } from "./routes/items";

/**
 * Brings snoozed decisions back (#571): pushes each snooze whose time has come once more to the
 * active devices it was sealed to, which notify for its decision again, once. An answer, a
 * settled notice or a newer snooze cleared its `wake_due` already. The devices it wakes have now
 * heard of the decision, so they leave its `hold_to` (#908): its answer and settled notice reach
 * them.
 */
export function wakeSnoozes(db: Database, push: Push, inlineLimit: number, now = Date.now()): void {
  const due = db
    .query(
      `SELECT account_id, id, kind, from_id, re, wake_at FROM items
       WHERE wake_due IS NOT NULL AND wake_due <= ?`,
    )
    .all(new Date(now).toISOString()) as {
    account_id: string;
    id: string;
    kind: SealedItem["kind"];
    from_id: string;
    re: string | null;
    wake_at: string;
  }[];
  for (const s of due) {
    const boxes = db
      .query(
        `SELECT b.to_id AS "to", b.box FROM boxes b JOIN members m
         ON m.account_id = b.account_id AND m.id = b.to_id AND m.role = 'device' AND m.active = 1
         WHERE b.account_id = ? AND b.item_id = ?`,
      )
      .all(s.account_id, s.id) as { to: string; box: string }[];
    // Cleared first: a push that fails is not retried, as no other push is.
    db.query("UPDATE items SET wake_due = NULL WHERE account_id = ? AND id = ?").run(
      s.account_id,
      s.id,
    );
    if (boxes.length === 0) continue;
    const devices = boxes.map((b) => b.to);
    if (s.re) heard(db, s.account_id, s.re, devices);
    const item: SealedItem = {
      v: 1,
      kind: s.kind,
      id: s.id,
      from: s.from_id,
      ...(s.re ? { re: s.re } : {}),
      wakeAt: s.wake_at,
      boxes,
    };
    push.notify(s.account_id, devices, (device) => pushPayload(item, device, inlineLimit));
  }
}

/** Takes `devices` off the held devices of item `id`, which no longer holds any once they all left. */
function heard(db: Database, account: string, id: string, devices: string[]): void {
  const row = db
    .query("SELECT hold_to FROM items WHERE account_id = ? AND id = ?")
    .get(account, id) as { hold_to: string | null } | null;
  if (!row?.hold_to) return;
  const held = (JSON.parse(row.hold_to) as string[]).filter((d) => !devices.includes(d));
  if (held.length > 0)
    db.query("UPDATE items SET hold_to = ? WHERE account_id = ? AND id = ?").run(
      JSON.stringify(held),
      account,
      id,
    );
  else
    db.query(
      "UPDATE items SET hold_due = NULL, hold_to = NULL WHERE account_id = ? AND id = ?",
    ).run(account, id);
}
