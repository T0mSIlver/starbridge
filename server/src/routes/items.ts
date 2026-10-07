import type { Database } from "bun:sqlite";
import {
  ITEM_KINDS,
  ItemKind,
  PERMISSION_TTL_MS,
  SealedItem,
  SNOOZE_MAX_MS,
} from "@starbridge/protocol";
import { type Context, Hono } from "hono";
import { fail, memberOf, recheck, requireCaller } from "../auth";
import { nextSeq } from "../db";
import type { Env } from "../env";
import { holdOpen, json, waitSeconds } from "../http";
import { rateLimit } from "../limits";
import { activeMember, wakeMachines } from "./directory";

const PAGE = 100;

type KindRule = {
  signer: "device" | "machine";
  re?: { field: string; kinds: readonly ItemKind[]; open?: true };
  updates?: true;
  toDevices?: true;
  wake?: string;
};

/** How far a device's clock may run ahead of the server's when it names a time. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** Snoozes the server keeps per decision; each owner tap adds one (#571). */
const SNOOZES_PER_DECISION = 50;

/** How long after it arrives an item can still be answered; unlisted kinds have no limit. */
const ANSWERABLE_FOR: Partial<Record<ItemKind, number>> = { permission: PERMISSION_TTL_MS };

/**
 * Kinds a machine re-seals (`reseal`) under their id while open, to the devices active now: a
 * device that joined since reads them too. Only an item the server still holds is re-sealed.
 */
const RESEALED: readonly ItemKind[] = ["decision", "permission"];

/** Kinds a device answers: what device-signed kinds refer to. */
const ANSWERABLE = ItemKind.options.flatMap((k) => {
  const rule: KindRule = ITEM_KINDS[k];
  return rule.signer === "device" && rule.re ? [...rule.re.kinds] : [];
});
/** Kinds devices list: what machines sign, by default, and what devices seal to each other. */
const DEVICE_KINDS = ItemKind.options.filter((k) => ITEM_KINDS[k].signer === "machine");
const DEVICE_LISTABLE = [
  ...DEVICE_KINDS,
  ...ItemKind.options.filter((k) => (ITEM_KINDS[k] as KindRule).toDevices),
];
/** Kinds a machine's inbox (`/answers`) holds: what devices sign. */
const MACHINE_KINDS = ItemKind.options.filter((k) => ITEM_KINDS[k].signer === "device");
/** What a machine reads when it names no kinds: the kinds there were before snoozes (#571). */
const MACHINE_DEFAULT: ItemKind[] = ["answer", "permission-answer"];

interface Row {
  seq: number;
  id: string;
  kind: SealedItem["kind"];
  from_id: string;
  re: string | null;
  wake_at: string | null;
  received_at: string;
  answered_at: string | null;
  to_id: string;
  box: string;
  blobs: string | null;
}

/** An item as a recipient sees it: its own box only, plus what the server knows about it. */
export interface Stored {
  item: SealedItem;
  cursor: string;
  receivedAt: string;
  /** Decisions and permissions: when a device answered it, or the machine settled it. */
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
      ...(r.wake_at ? { wakeAt: r.wake_at } : {}),
      ...(r.blobs ? { blobs: JSON.parse(r.blobs) as string[] } : {}),
      boxes: [{ to: r.to_id, box: r.box }],
    },
    cursor: String(r.seq),
    receivedAt: r.received_at,
    ...(r.answered_at ? { answeredAt: r.answered_at } : {}),
  };
}

const SELECT = `SELECT i.seq, i.id, i.kind, i.from_id, i.re, i.wake_at, i.received_at, i.answered_at, b.to_id, b.box, i.blobs
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
  openOnly = false,
): Stored[] {
  // Open: unanswered items of answerable kinds, before their answer window closes.
  const open = openOnly
    ? `AND i.answered_at IS NULL AND i.kind IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (SELECT 1 FROM json_each(?) t
                       WHERE t.key = i.kind AND i.received_at < t.value)`
    : "";
  const now = Date.now();
  const cutoffs = Object.fromEntries(
    Object.entries(ANSWERABLE_FOR).map(([k, ms]) => [k, new Date(now - ms).toISOString()]),
  );
  const rows = db
    .query(
      `${SELECT} WHERE i.account_id = ? AND b.to_id = ? AND i.seq > ?
       AND i.kind IN (SELECT value FROM json_each(?)) ${open} ORDER BY i.seq LIMIT ${PAGE}`,
    )
    .all(
      account,
      member,
      from,
      JSON.stringify(kinds),
      ...(openOnly ? [JSON.stringify(ANSWERABLE), JSON.stringify(cutoffs)] : []),
    ) as Row[];
  return rows.map(stored);
}

function page(items: Stored[], from: number) {
  return { items, cursor: items.at(-1)?.cursor ?? String(from) };
}

/** What a machine's answer long-poll watches besides answers. */
function watched(c: Context<Env>, account: string) {
  const { n } = c.var.db
    .query("SELECT COUNT(*) AS n FROM directory WHERE account_id = ?")
    .get(account) as { n: number };
  const asked = c.var.quotaAsks.get(account);
  return { directory: n, ...(asked ? { quotaAsked: asked } : {}) };
}

/**
 * What a push carries: the recipient's own box when it fits, else the id to fetch. An item with
 * blobs (a decision's images) goes as its id, so the device fetches the images with it.
 */
export function pushPayload(item: SealedItem, to: string, limit: number): string {
  const head = {
    v: 1,
    kind: item.kind,
    id: item.id,
    from: item.from,
    ...(item.re ? { re: item.re } : {}),
    ...(item.wakeAt ? { wakeAt: item.wakeAt } : {}),
  };
  const box = item.boxes.find((b) => b.to === to)?.box;
  const full = JSON.stringify({ ...head, box });
  return box && !item.blobs?.length && Buffer.byteLength(full) <= limit
    ? full
    : JSON.stringify(head);
}

export const itemRoutes = new Hono<Env>();

itemRoutes.post("/items", requireCaller("paired"), async (c) => {
  const limits = c.var.config.limits;
  const { account } = c.var.caller;
  const poster = memberOf(c.var.caller);
  if (c.var.caller.role === "device")
    rateLimit(c, `items:${account}:${poster}`, limits.deviceItems);
  else {
    rateLimit(c, `items:${account}:${poster}`, limits.machineItems);
    rateLimit(c, `items:${account}`, limits.items);
  }
  const item = await json(c, SealedItem);
  const caller = c.var.caller;
  const me = memberOf(caller);
  const { db, config } = c.var;
  const rule: KindRule = ITEM_KINDS[item.kind];
  const fromDevice = rule.signer === "device";
  if (caller.role !== rule.signer)
    fail(403, "forbidden", `only a ${rule.signer} posts ${item.kind} items`);
  if (item.from !== me) fail(403, "forbidden", "from must be the caller");
  const to = item.boxes.map((b) => b.to);
  if (new Set(to).size !== to.length) fail(400, "bad-schema", "one box per recipient");
  if (item.blobs && item.kind !== "decision")
    fail(400, "bad-schema", `${item.kind} items carry no blobs`);
  // A decision's images are stored once, so they count once, whatever the number of devices.
  const blobBytes = (blobs: string[] | undefined) =>
    (blobs ?? []).reduce((n, b) => n + b.length, 0);
  const size = item.boxes.reduce((n, b) => n + b.box.length, 0) + blobBytes(item.blobs);
  // What it costs to store: its boxes and blobs, and its rows, which a small item would
  // otherwise get free. A re-seal that sends no blobs keeps the stored ones, which count too.
  let charged = size + limits.rowBytes * (1 + item.boxes.length);
  const most = fromDevice
    ? limits.answerBytes
    : item.kind === "run"
      ? limits.runBytes * item.boxes.length
      : item.kind === "quota"
        ? limits.quotaBytes
        : limits.itemBytes;
  const tooLarge = () =>
    fail(413, "too-large", `a ${item.kind}'s boxes and blobs hold at most ${most} bytes`);
  if (size > most) tooLarge();
  // A snooze names when the server pushes it again (#571): within 7 days of now.
  let wakeDue: string | null = null;
  if (rule.wake) {
    if (item.wakeAt === undefined) fail(400, "bad-schema", `a ${item.kind} needs wakeAt`);
    const due = Date.parse(item.wakeAt);
    if (due > Date.now() + SNOOZE_MAX_MS + CLOCK_SKEW_MS)
      fail(400, "bad-schema", `wakeAt is at most ${SNOOZE_MAX_MS / 86_400_000} days ahead`);
    if (due > Date.now()) wakeDue = new Date(due).toISOString();
  } else if (item.wakeAt !== undefined)
    fail(400, "bad-schema", `${item.kind} items carry no wakeAt`);
  // Answers are small and the owner's; only machines' items spend the byte budget, so a looping
  // machine never blocks an answer. A post is refused unless it fits what is left, and only a
  // stored one spends it (#718). Nothing awaits between this check and the charge below.
  const budget = `bytes:${caller.account}`;
  if (!fromDevice) rateLimit(c, budget, limits.postedBytes, size, true);

  // Devices the referred item was sealed to, told once a device answers it.
  let answeredDevices: string[] = [];
  // What a device answered and when it arrived, for the usage counts.
  let answered: { kind: ItemKind; receivedAt: string } | undefined;
  // Devices to push to: all of them, or for a re-sealed item those it was not sealed to yet.
  let pushTo = to;
  // The machine a device's item goes to.
  let machine = "";
  // A waiting flip on a snoozed decision pushes nothing: the owner said not now (#571).
  let snoozed = false;
  // The images as stored: those posted, or on a re-seal that sends none, those kept.
  let blobs = item.blobs;
  const seq = db.transaction(() => {
    recheck(c);
    const now = new Date();
    if (fromDevice) {
      // To the one machine that asked; a `toDevices` kind to every active device as well.
      const machines = to.filter((id) => activeMember(db, caller.account, id, "machine"));
      const devices = rule.toDevices
        ? to.filter((id) => activeMember(db, caller.account, id, "device"))
        : [];
      if (machines.length !== 1 || machines.length + devices.length !== to.length)
        fail(
          400,
          "unknown-recipient",
          rule.toDevices
            ? `a ${item.kind} goes to the machine that asked and to active devices`
            : `a ${item.kind} goes to the one machine that asked`,
        );
      machine = machines[0] as string;
    } else {
      for (const id of to)
        if (!activeMember(db, caller.account, id, "device"))
          fail(400, "unknown-recipient", `${id} is not an active device`);
    }
    if (!rule.re) {
      if (item.re !== undefined) fail(400, "bad-schema", `${item.kind} items carry no re`);
    } else {
      if (!item.re) fail(400, "bad-schema", `a ${item.kind} needs re`);
      const target = db
        .query(
          `SELECT kind, from_id, received_at, answered_at FROM items WHERE account_id = ? AND id = ?
           AND kind IN (SELECT value FROM json_each(?))`,
        )
        .get(caller.account, item.re, JSON.stringify(rule.re.kinds)) as {
        kind: ItemKind;
        from_id: string;
        received_at: string;
        answered_at: string | null;
      } | null;
      if (fromDevice) {
        const mine = db
          .query("SELECT 1 FROM boxes WHERE account_id = ? AND item_id = ? AND to_id = ?")
          .get(caller.account, item.re, me);
        if (!target || target.from_id !== machine || !mine)
          fail(404, "not-found", `no such ${rule.re.kinds.join(" or ")} for this device`);
        if (target.answered_at) fail(409, "already-answered");
        if (rule.wake && item.wakeAt !== undefined) {
          // Its return must come before the sweep drops the question it brings back.
          const drops = Date.parse(target.received_at) + c.var.config.limits.staleRetention;
          if (Date.parse(item.wakeAt) >= drops)
            fail(400, "bad-schema", "the question is dropped before wakeAt");
          const { n } = db
            .query("SELECT COUNT(*) AS n FROM items WHERE account_id = ? AND kind = ? AND re = ?")
            .get(caller.account, item.kind, item.re) as { n: number };
          if (n >= SNOOZES_PER_DECISION)
            fail(409, "too-many-items", `a decision keeps at most ${SNOOZES_PER_DECISION} snoozes`);
        }
        if (!rule.re.open) {
          const ttl = ANSWERABLE_FOR[target.kind];
          if (ttl !== undefined && now.getTime() > Date.parse(target.received_at) + ttl)
            fail(409, "expired", `a ${target.kind} can be answered for ${ttl / 60_000} minutes`);
          answered = { kind: target.kind, receivedAt: target.received_at };
          answeredDevices = (
            db
              .query("SELECT to_id FROM boxes WHERE account_id = ? AND item_id = ?")
              .all(caller.account, item.re) as { to_id: string }[]
          ).map((r) => r.to_id);
        }
      } else {
        if (!target || target.from_id !== me)
          fail(404, "not-found", `no such ${rule.re.kinds.join(" or ")} from this machine`);
        const other = db
          .query("SELECT 1 FROM items WHERE account_id = ? AND kind = ? AND re = ? AND id != ?")
          .get(caller.account, item.kind, item.re, item.id);
        if (rule.re.open) {
          // A machine's note on one of its open items (a decision's waiting state): one per
          // item, re-posted under its id, until the item is answered.
          if (target.answered_at) fail(409, "already-answered");
          if (other) fail(409, "duplicate-id", `${item.re} has a ${item.kind} under another id`);
          // By the snooze that came last; the devices order them by their signed `at`.
          const last = db
            .query(
              `SELECT wake_due FROM items WHERE account_id = ? AND kind = 'snooze' AND re = ?
               ORDER BY seq DESC LIMIT 1`,
            )
            .get(caller.account, item.re) as { wake_due: string | null } | null;
          snoozed = !!last?.wake_due;
        } else if (other) {
          // A machine's notice that one of its own items is over (a settled prompt, a withdrawn
          // decision): one each.
          fail(409, "already-settled");
        }
      }
    }
    const earlier = db
      .query(
        "SELECT kind, from_id, received_at, answered_at, blobs FROM items WHERE account_id = ? AND id = ?",
      )
      .get(caller.account, item.id) as {
      kind: string;
      from_id: string;
      received_at: string;
      answered_at: string | null;
      blobs: string | null;
    } | null;
    let receivedAt = now.toISOString();
    const resealed = item.reseal === true;
    if (resealed && (!RESEALED.includes(item.kind) || !earlier))
      fail(404, "not-found", `no ${item.kind} ${item.id} to re-seal`);
    if (earlier) {
      // A kind with updates is re-posted under its id as it changes: the latest replaces it.
      if (!(rule.updates || resealed) || earlier.kind !== item.kind || earlier.from_id !== me)
        fail(409, "duplicate-id");
      if (resealed) {
        // It keeps its arrival, so a permission's answer window does not move.
        if (earlier.answered_at) fail(409, "already-answered");
        receivedAt = earlier.received_at;
        const had = (
          db
            .query("SELECT to_id FROM boxes WHERE account_id = ? AND item_id = ?")
            .all(caller.account, item.id) as { to_id: string }[]
        ).map((r) => r.to_id);
        pushTo = to.filter((id) => !had.includes(id));
        // The images were sealed once for every device, so a re-seal sends only the boxes.
        if (!blobs && earlier.blobs) {
          blobs = JSON.parse(earlier.blobs) as string[];
          const kept = blobBytes(blobs);
          if (size + kept > most) tooLarge();
          charged += kept;
        }
      }
      db.query("DELETE FROM items WHERE account_id = ? AND id = ?").run(caller.account, item.id);
    }

    if (item.kind === "quota") {
      // Only the latest snapshot from each machine matters.
      db.query("DELETE FROM items WHERE account_id = ? AND kind = 'quota' AND from_id = ?").run(
        caller.account,
        me,
      );
    }
    // Machines' items leave the last answerReserve bytes to devices' answers, so a full account
    // can still answer, and answering lets its decisions expire.
    const held = db
      .query(
        `SELECT COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(n) FILTER (WHERE kind = ?), 0) AS n
         FROM item_totals WHERE account_id = ?`,
      )
      .get(item.kind, caller.account) as { bytes: number; n: number };
    // The kinds a machine posts at will; the rest each answer or note one of these, or replace.
    const cap = { decision: limits.decisions, run: limits.runs, permission: limits.permissions }[
      item.kind as string
    ];
    if (cap !== undefined && held.n >= cap)
      fail(409, "too-many-items", `an account holds at most ${cap} ${item.kind} items`);
    const room = limits.storedBytes - (fromDevice ? 0 : limits.answerReserve);
    if (held.bytes + charged > room)
      fail(
        409,
        "account-full",
        `this account stores at most ${limits.storedBytes / 1024 / 1024} MB; answered questions are dropped ${limits.answeredRetention / 86_400_000} days after their answer`,
      );
    if (!fromDevice) {
      const { bytes } = db
        .query("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM item_totals")
        .get() as { bytes: number };
      // Answers pass, so decisions still close and expire. The hourly sweep is what frees room.
      if (bytes + charged > limits.serverBytes)
        fail(503, "storage-full", "the server's storage is full; retry later", {
          "retry-after": "3600",
        });
    }
    const iso = now.toISOString();
    const seq = nextSeq(db);
    db.query(
      `INSERT INTO items (seq, account_id, id, kind, from_id, re, wake_at, wake_due, received_at, size, blobs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seq,
      caller.account,
      item.id,
      item.kind,
      me,
      item.re ?? null,
      item.wakeAt ?? null,
      wakeDue,
      receivedAt,
      charged,
      blobs ? JSON.stringify(blobs) : null,
    );
    const box = db.query("INSERT INTO boxes (account_id, item_id, to_id, box) VALUES (?, ?, ?, ?)");
    for (const b of item.boxes) box.run(caller.account, item.id, b.to, b.box);
    // Marks the referred item answered and moves it past every cursor, so devices listing after
    // their cursor see it again, answered. A settled notice after a device's answer changes
    // nothing: the prompt was already answered. An open kind's note closes nothing.
    if (item.re !== undefined && !rule.re?.open) {
      db.query(
        "UPDATE items SET answered_at = ?, seq = ? WHERE account_id = ? AND id = ? AND answered_at IS NULL",
      ).run(iso, nextSeq(db), caller.account, item.re);
      // Answered or settled, a snoozed decision does not come back.
      db.query(
        "UPDATE items SET wake_due = NULL WHERE account_id = ? AND kind = 'snooze' AND re = ?",
      ).run(caller.account, item.re);
    }
    return seq;
  })();
  if (!fromDevice) c.var.limiter.retryAfter(budget, ...limits.postedBytes, size);

  c.var.usage.record(`items.${item.kind}`);
  if (answered && caller.role === "device") {
    const seconds = (Date.now() - Date.parse(answered.receivedAt)) / 1000;
    c.var.usage.record(`answered.${answered.kind}.seconds`, null, seconds);
    c.var.usage.record(`answered.by.${caller.client}`);
  }
  if (item.kind === "quota") c.var.quotas.wake(caller.account);
  if (fromDevice) {
    c.var.answers.wake(`${caller.account}/${machine}`);
    if (rule.re?.open) {
      // A note for every device (a snooze): the others hide the decision, or show it again.
      const devices = to.filter((id) => id !== machine && id !== me);
      c.var.push.notify(caller.account, devices, (device) =>
        pushPayload(item, device, config.pushInlineLimit),
      );
    } else {
      const payload = JSON.stringify({ v: 1, kind: "answered", id: item.re });
      c.var.push.notify(caller.account, answeredDevices, () => payload);
    }
  } else if (!item.quiet && !snoozed) {
    // Browsers expect each Web Push to show a notification and drop subscriptions that keep
    // showing none, so quota snapshots and runs, which show none there, skip Web Push; pages
    // fetch them instead.
    c.var.push.notify(
      caller.account,
      pushTo,
      // With the kept blobs, so a device a re-seal adds fetches the images too.
      (device) =>
        pushPayload({ ...item, ...(blobs ? { blobs } : {}) }, device, config.pushInlineLimit),
      item.kind === "quota" || item.kind === "run" ? ["fcm", "unifiedpush"] : undefined,
    );
  }
  return c.json({ cursor: String(seq) }, 201);
});

itemRoutes.get("/items", requireCaller("paired-device"), (c) => {
  const raw = c.req.query("kind");
  const kinds = raw === undefined ? DEVICE_KINDS : raw.split(",");
  if (kinds.some((k) => !(DEVICE_LISTABLE as string[]).includes(k)))
    fail(400, "bad-request", `kind is a comma-separated list of ${DEVICE_LISTABLE.join(", ")}`);
  const from = after(c.req.query("after"));
  const caller = c.var.caller;
  const open = c.req.query("open") === "1";
  const items = list(c.var.db, caller.account, memberOf(caller), kinds, from, open);
  return c.json(page(items, from));
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
  const raw = c.req.query("kinds");
  const kinds = raw === undefined ? MACHINE_DEFAULT : raw.split(",");
  if (kinds.some((k) => !(MACHINE_KINDS as string[]).includes(k)))
    fail(400, "bad-request", `kinds is a comma-separated list of ${MACHINE_KINDS.join(", ")}`);
  const fetch = () => list(c.var.db, caller.account, me, kinds, from);
  // A machine that passes what it knows hears at once when the directory grew past it or a
  // device asked for fresh quotas since.
  const known = c.req.query("directory");
  if (known !== undefined && !/^\d{1,6}$/.test(known))
    fail(400, "bad-request", "directory must be a directory length");
  const changed = () => {
    if (known === undefined) return false;
    const now = watched(c, caller.account);
    return (
      now.directory > Number(known) ||
      (now.quotaAsked !== undefined && now.quotaAsked !== c.req.query("quotaAsked"))
    );
  };
  let items = fetch();
  const seconds = waitSeconds(c);
  if (items.length === 0 && !changed() && seconds > 0) {
    if (c.var.answers.count(`${caller.account}/${me}`) >= c.var.config.limits.answerWaits)
      fail(
        429,
        "too-many-waits",
        `a machine holds at most ${c.var.config.limits.answerWaits} open waits`,
      );
    holdOpen(c);
    // Nothing yields between the query above and this registration, so no answer slips by.
    const woken = await c.var.answers.wait(`${caller.account}/${me}`, seconds, c.req.raw.signal);
    recheck(c);
    if (woken) items = fetch();
  }
  return c.json({ ...page(items, from), ...watched(c, caller.account) });
});

itemRoutes.post("/quota/ask", requireCaller("paired-device"), async (c) => {
  const caller = c.var.caller;
  const { db } = c.var;
  rateLimit(c, `quota-asks:${caller.account}`, c.var.config.limits.quotaAsks);
  const askedAt = new Date().toISOString();
  c.var.quotaAsks.set(caller.account, askedAt);
  wakeMachines(c, caller.account);
  // Machines whose latest snapshot predates the ask; one that never posted is not waited for.
  const behind = () =>
    (
      db
        .query(
          `SELECT COUNT(*) AS n FROM items i JOIN members m ON m.account_id = i.account_id
           AND m.id = i.from_id AND m.active = 1
           WHERE i.account_id = ? AND i.kind = 'quota' AND i.received_at < ?`,
        )
        .get(caller.account, askedAt) as { n: number }
    ).n;
  const end = Date.now() + waitSeconds(c) * 1000;
  if (Date.now() < end) holdOpen(c);
  while (behind() > 0 && Date.now() < end && !c.req.raw.signal.aborted && !c.var.quotas.closed)
    await c.var.quotas.wait(caller.account, (end - Date.now()) / 1000, c.req.raw.signal);
  recheck(c);
  return c.json({ askedAt, behind: behind() });
});
