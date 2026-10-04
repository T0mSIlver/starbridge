import type { Database } from "bun:sqlite";
import { SealedItem } from "@starbridge/protocol";
import { Hono } from "hono";
import { fail, memberOf, recheck, requireCaller } from "../auth";
import { nextSeq } from "../db";
import type { Env } from "../env";
import { holdOpen, json, waitSeconds } from "../http";
import { activeMember } from "./directory";

const PAGE = 100;

interface Row {
  seq: number;
  id: string;
  kind: SealedItem["kind"];
  from_id: string;
  re: string | null;
  received_at: string;
  answered_at: string | null;
  to_id: string;
  box: string;
}

/** An item as a recipient sees it: its own box only, plus what the server knows about it. */
export interface Stored {
  item: SealedItem;
  cursor: string;
  receivedAt: string;
  /** Decisions only: when a device answered it. */
  answeredAt?: string;
}

function stored(r: Row): Stored {
  return {
    item: {
      v: 1,
      kind: r.kind,
      id: r.id,
      from: r.from_id,
      ...(r.re ? { re: r.re } : {}),
      boxes: [{ to: r.to_id, box: r.box }],
    },
    cursor: String(r.seq),
    receivedAt: r.received_at,
    ...(r.answered_at ? { answeredAt: r.answered_at } : {}),
  };
}

const SELECT = `SELECT i.seq, i.id, i.kind, i.from_id, i.re, i.received_at, i.answered_at, b.to_id, b.box
  FROM items i JOIN boxes b ON b.account_id = i.account_id AND b.item_id = i.id`;

function after(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  if (!/^\d{1,15}$/.test(raw)) fail(400, "bad-request", "after must be a cursor from this server");
  return Number(raw);
}

function list(
  db: Database,
  account: string,
  member: string,
  kinds: string[],
  from: number,
): Stored[] {
  const rows = db
    .query(
      `${SELECT} WHERE i.account_id = ? AND b.to_id = ? AND i.seq > ?
       AND i.kind IN (SELECT value FROM json_each(?)) ORDER BY i.seq LIMIT ${PAGE}`,
    )
    .all(account, member, from, JSON.stringify(kinds)) as Row[];
  return rows.map(stored);
}

function page(items: Stored[], from: number) {
  return { items, cursor: items.at(-1)?.cursor ?? String(from) };
}

/** What a push carries: the recipient's own box when it fits, else the id to fetch. */
function pushPayload(item: SealedItem, to: string, limit: number): string {
  const head = {
    v: 1,
    kind: item.kind,
    id: item.id,
    from: item.from,
    ...(item.re ? { re: item.re } : {}),
  };
  const box = item.boxes.find((b) => b.to === to)?.box;
  const full = JSON.stringify({ ...head, box });
  return box && Buffer.byteLength(full) <= limit ? full : JSON.stringify(head);
}

export const itemRoutes = new Hono<Env>();

itemRoutes.post("/items", requireCaller("paired"), async (c) => {
  const item = await json(c, SealedItem);
  const caller = c.var.caller;
  const me = memberOf(caller);
  const { db, config } = c.var;
  const signer = item.kind === "answer" ? "device" : "machine";
  if (caller.role !== signer) fail(403, "forbidden", `only a ${signer} posts ${item.kind} items`);
  if (item.from !== me) fail(403, "forbidden", "from must be the caller");
  const to = item.boxes.map((b) => b.to);
  if (new Set(to).size !== to.length) fail(400, "bad-schema", "one box per recipient");

  let decisionDevices: string[] = [];
  const seq = db.transaction(() => {
    recheck(c);
    if (item.kind === "answer") {
      const machine = to[0] as string;
      if (to.length !== 1 || !activeMember(db, caller.account, machine, "machine"))
        fail(400, "unknown-recipient", "an answer goes to the one machine that asked");
      if (!item.re) fail(400, "bad-schema", "an answer needs re");
      const d = db
        .query(
          "SELECT from_id, answered_at FROM items WHERE account_id = ? AND id = ? AND kind = 'decision'",
        )
        .get(caller.account, item.re) as { from_id: string; answered_at: string | null } | null;
      const mine = db
        .query("SELECT 1 FROM boxes WHERE account_id = ? AND item_id = ? AND to_id = ?")
        .get(caller.account, item.re, me);
      if (!d || d.from_id !== machine || !mine)
        fail(404, "not-found", "no such decision for this device");
      if (d.answered_at) fail(409, "already-answered");
      decisionDevices = (
        db
          .query("SELECT to_id FROM boxes WHERE account_id = ? AND item_id = ?")
          .all(caller.account, item.re) as {
          to_id: string;
        }[]
      ).map((r) => r.to_id);
    } else {
      if (item.re !== undefined) fail(400, "bad-schema", `re is for answers, not ${item.kind}`);
      for (const id of to)
        if (!activeMember(db, caller.account, id, "device"))
          fail(400, "unknown-recipient", `${id} is not an active device`);
    }
    if (
      db.query("SELECT 1 FROM items WHERE account_id = ? AND id = ?").get(caller.account, item.id)
    )
      fail(409, "duplicate-id");

    const now = new Date().toISOString();
    if (item.kind === "quota") {
      // Only the latest snapshot from each machine matters.
      db.query("DELETE FROM items WHERE account_id = ? AND kind = 'quota' AND from_id = ?").run(
        caller.account,
        me,
      );
    }
    const seq = nextSeq(db);
    db.query(
      "INSERT INTO items (seq, account_id, id, kind, from_id, re, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(seq, caller.account, item.id, item.kind, me, item.re ?? null, now);
    const box = db.query("INSERT INTO boxes (account_id, item_id, to_id, box) VALUES (?, ?, ?, ?)");
    for (const b of item.boxes) box.run(caller.account, item.id, b.to, b.box);
    if (item.kind === "answer")
      db.query("UPDATE items SET answered_at = ?, seq = ? WHERE account_id = ? AND id = ?").run(
        now,
        nextSeq(db),
        caller.account,
        item.re ?? "",
      );
    return seq;
  })();

  if (item.kind === "answer") {
    c.var.answers.wake(`${caller.account}/${to[0]}`);
    const payload = JSON.stringify({ v: 1, kind: "answered", id: item.re });
    c.var.push.notify(caller.account, decisionDevices, () => payload);
  } else {
    c.var.push.notify(caller.account, to, (device) =>
      pushPayload(item, device, config.pushInlineLimit),
    );
  }
  return c.json({ cursor: String(seq) }, 201);
});

itemRoutes.get("/items", requireCaller("paired-device"), (c) => {
  const kind = c.req.query("kind");
  if (kind !== undefined && !["decision", "quota"].includes(kind))
    fail(400, "bad-request", "kind is decision or quota");
  const from = after(c.req.query("after"));
  const caller = c.var.caller;
  return c.json(
    page(
      list(c.var.db, caller.account, memberOf(caller), kind ? [kind] : ["decision", "quota"], from),
      from,
    ),
  );
});

itemRoutes.get("/items/:id", requireCaller("paired"), (c) => {
  const caller = c.var.caller;
  const row = c.var.db
    .query(`${SELECT} WHERE i.account_id = ? AND i.id = ? AND b.to_id = ?`)
    .get(caller.account, c.req.param("id"), memberOf(caller)) as Row | null;
  if (!row) fail(404, "not-found");
  return c.json(stored(row));
});

itemRoutes.get("/quota", requireCaller("paired-device"), (c) => {
  const caller = c.var.caller;
  const rows = c.var.db
    .query(
      `${SELECT} JOIN members m ON m.account_id = i.account_id AND m.id = i.from_id AND m.active = 1
       WHERE i.account_id = ? AND b.to_id = ? AND i.kind = 'quota'
       AND i.seq = (SELECT MAX(seq) FROM items j WHERE j.account_id = i.account_id
                    AND j.kind = 'quota' AND j.from_id = i.from_id)
       ORDER BY i.from_id`,
    )
    .all(caller.account, memberOf(caller)) as Row[];
  return c.json({ items: rows.map(stored) });
});

itemRoutes.get("/answers", requireCaller("machine"), async (c) => {
  const caller = c.var.caller;
  const me = memberOf(caller);
  const from = after(c.req.query("after"));
  const fetch = () => list(c.var.db, caller.account, me, ["answer"], from);
  let items = fetch();
  const seconds = waitSeconds(c);
  if (items.length === 0 && seconds > 0) {
    holdOpen(c);
    // Nothing yields between the query above and this registration, so no answer slips by.
    if (await c.var.answers.wait(`${caller.account}/${me}`, seconds, c.req.raw.signal))
      items = fetch();
  }
  return c.json(page(items, from));
});
