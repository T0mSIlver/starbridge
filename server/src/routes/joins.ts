import type { Database } from "bun:sqlite";
import {
  B64,
  fromB64,
  Id,
  JoinApprovalBody,
  joinCommitment,
  openJoinRequest,
  PairingMessage,
  ProtocolError,
} from "@starbridge/protocol";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { fail, identify, recheck, requireCaller } from "../auth";
import type { Env } from "../env";
import { holdOpen, json, waitSeconds } from "../http";
import { activeMember } from "./directory";

// Joining by digits (PROTOCOL.md, "Joining by digits"). The server relays the request, both
// ephemeral keys and the approval; the digits and the MAC key never reach it.

const LIFETIME_MS = 10 * 60_000;
const JOIN_ID = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const Key = B64.length(43);

interface Row {
  id: string;
  account_id: string;
  session_hash: string;
  request: string;
  member_id: string;
  box_pk: string;
  sign_pk: string;
  commitment: string;
  approver: string | null;
  approver_key: string | null;
  joiner_key: string | null;
  approval: string | null;
  cancelled: number;
  created_at: number;
  version: number;
}

/** What clients see of a join; `state` follows from the fields. */
function view(r: Row) {
  return {
    id: r.id,
    request: r.request,
    commitment: r.commitment,
    state: r.cancelled
      ? "cancelled"
      : r.approval
        ? "approved"
        : r.approver_key
          ? "comparing"
          : "open",
    ...(r.approver ? { approver: r.approver, approverKey: r.approver_key } : {}),
    ...(r.joiner_key ? { joinerKey: r.joiner_key } : {}),
    ...(r.approval ? { approval: JSON.parse(r.approval) } : {}),
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.created_at + LIFETIME_MS).toISOString(),
    version: r.version,
  };
}

export function sweepJoins(db: Database): void {
  db.query("DELETE FROM joins WHERE created_at < ?").run(Date.now() - LIFETIME_MS);
}

/** A version above every other join's, so a list cursor never misses a change. */
function nextVersion(db: Database): number {
  const row = db.query("SELECT MAX(version) AS v FROM joins").get() as { v: number | null };
  return Math.max(Date.now(), (row.v ?? 0) + 1);
}

function load(db: Database, id: string): Row {
  if (!JOIN_ID.test(id)) fail(404, "not-found");
  const r = db.query("SELECT * FROM joins WHERE id = ?").get(id) as Row | null;
  if (!r || Date.now() - r.created_at > LIFETIME_MS)
    fail(404, "not-found", "no such join request, or it expired");
  return r;
}

/** The joining device's own session, or a paired device of the same account. */
function party(c: Context<Env>, r: Row): "joiner" | "device" {
  const caller = identify(c);
  if (caller?.role === "device" && caller.account === r.account_id) {
    if (caller.session === r.session_hash) return "joiner";
    if (caller.member !== null) return "device";
  }
  fail(404, "not-found");
}

function touch(c: Context<Env>, r: Row, set: string, ...args: (string | number | null)[]) {
  const { db } = c.var;
  db.query(`UPDATE joins SET ${set}, version = ? WHERE id = ?`).run(...args, nextVersion(db), r.id);
}

function wake(c: Context<Env>, r: Row) {
  c.var.joins.wake(`join:${r.id}`);
  c.var.joins.wake(`account:${r.account_id}`);
}

const isOpen = (r: Row) => !r.cancelled && !r.approval;

export const joinRoutes = new Hono<Env>();

joinRoutes.post("/joins", requireCaller("device"), async (c) => {
  const caller = c.var.caller as Extract<Env["Variables"]["caller"], { role: "device" }>;
  if (caller.member !== null) fail(409, "already-paired", "this session is already a device");
  if (!c.var.limiter.allow(`join:${caller.account}`, 10, 60_000)) fail(429, "rate-limited");
  const { request, commitment } = await json(
    c,
    z.object({ request: z.string().max(4096), commitment: Key }),
  );
  let body: ReturnType<typeof openJoinRequest>;
  try {
    body = openJoinRequest(request);
  } catch (e) {
    fail(400, "bad-schema", e instanceof Error ? e.message : undefined);
  }
  if (body.account !== caller.account) fail(400, "bad-schema", "request names another account");
  const { db } = c.var;
  const created = db.transaction(() => {
    recheck(c);
    sweepJoins(db);
    if (db.query("SELECT 1 FROM joins WHERE id = ?").get(body.join)) return false;
    // One open request per session: a new one replaces the last.
    db.query(
      "UPDATE joins SET cancelled = 1, version = ? WHERE session_hash = ? AND cancelled = 0 AND approval IS NULL",
    ).run(nextVersion(db), caller.session);
    db.query(
      `INSERT INTO joins (id, account_id, session_hash, request, member_id, box_pk, sign_pk, commitment, created_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      body.join,
      caller.account,
      caller.session,
      request,
      body.id,
      body.boxPk,
      body.signPk,
      commitment,
      Date.now(),
      nextVersion(db),
    );
    return true;
  })();
  if (!created) fail(409, "taken", "join id in use; make a new one");
  const r = load(db, body.join);
  wake(c, r);
  const devices = (
    db
      .query("SELECT id FROM members WHERE account_id = ? AND role = 'device' AND active = 1")
      .all(caller.account) as { id: string }[]
  ).map((m) => m.id);
  const payload = JSON.stringify({ v: 1, kind: "join", id: r.id });
  c.var.push.notify(caller.account, devices, () => payload);
  return c.json({ join: view(r) }, 201);
});

/** Open join requests of the account; `after` and `wait` make it a long-poll on any change. */
joinRoutes.get("/joins", requireCaller("paired-device"), async (c) => {
  const account = c.var.caller.account;
  const after = Number(c.req.query("after") ?? 0) || 0;
  const { db } = c.var;
  const read = () => {
    sweepJoins(db);
    const rows = db.query("SELECT * FROM joins WHERE account_id = ?").all(account) as Row[];
    const cursor = Math.max(after, ...rows.map((r) => r.version));
    return { joins: rows.filter(isOpen).map(view), cursor };
  };
  let out = read();
  const seconds = waitSeconds(c);
  if (out.cursor <= after && seconds > 0) {
    holdOpen(c);
    await c.var.joins.wait(`account:${account}`, seconds, c.req.raw.signal);
    out = read();
  }
  return c.json({ joins: out.joins, cursor: String(out.cursor) });
});

/** One join, for its joining device or the account's devices; long-polls past `after`. */
joinRoutes.get("/joins/:id", async (c) => {
  const { db } = c.var;
  const id = c.req.param("id");
  let r = load(db, id);
  party(c, r);
  const after = Number(c.req.query("after") ?? 0) || 0;
  const seconds = waitSeconds(c);
  if (r.version <= after && seconds > 0) {
    holdOpen(c);
    await c.var.joins.wait(`join:${id}`, seconds, c.req.raw.signal);
    r = load(db, id);
  }
  return c.json({ join: view(r) });
});

joinRoutes.post("/joins/:id/approver", requireCaller("paired-device"), async (c) => {
  const { key, approver } = await json(c, z.object({ key: Key, approver: Id }));
  const caller = c.var.caller;
  if (approver !== caller.member) fail(400, "bad-schema", "approver is not the caller");
  const { db } = c.var;
  const r = db.transaction(() => {
    recheck(c);
    const r = load(db, c.req.param("id"));
    if (r.account_id !== caller.account) fail(404, "not-found");
    if (!isOpen(r)) fail(409, "closed", "this join request was answered or cancelled");
    if (r.approver_key) fail(409, "taken", "another device is comparing digits for it");
    touch(c, r, "approver = ?, approver_key = ?", approver, key);
    return r;
  })();
  wake(c, r);
  return c.json({ join: view(load(db, r.id)) });
});

joinRoutes.post("/joins/:id/reveal", requireCaller("device"), async (c) => {
  const { key } = await json(c, z.object({ key: Key }));
  const { db } = c.var;
  const r = db.transaction(() => {
    recheck(c);
    const r = load(db, c.req.param("id"));
    if (party(c, r) !== "joiner") fail(404, "not-found");
    if (!isOpen(r)) fail(409, "closed", "this join request was answered or cancelled");
    if (!r.approver_key) fail(409, "not-ready", "no device is comparing digits yet");
    if (r.joiner_key) fail(409, "already-revealed");
    // Clients check the commitment themselves; this refuses garbage early.
    let opens = false;
    try {
      opens = joinCommitment(fromB64(key), r.request) === r.commitment;
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
    }
    if (!opens) fail(400, "bad-commitment", "the key does not open the commitment");
    touch(c, r, "joiner_key = ?", key);
    return r;
  })();
  wake(c, r);
  return c.json({ join: view(load(db, r.id)) });
});

joinRoutes.post("/joins/:id/approve", requireCaller("paired-device"), async (c) => {
  const { approval } = await json(c, z.object({ approval: PairingMessage }));
  const caller = c.var.caller;
  const { db } = c.var;
  let body: JoinApprovalBody;
  try {
    body = JoinApprovalBody.parse(JSON.parse(approval.body));
  } catch {
    fail(400, "bad-schema", "approval body");
  }
  const r = db.transaction(() => {
    recheck(c);
    const r = load(db, c.req.param("id"));
    if (r.account_id !== caller.account) fail(404, "not-found");
    if (body.join !== r.id || body.account !== caller.account || body.approver !== caller.member)
      fail(400, "bad-schema", "approval names another join, account or approver");
    if (!isOpen(r)) fail(409, "closed", "this join request was answered or cancelled");
    if (r.approver !== caller.member || !r.joiner_key)
      fail(409, "not-ready", "compare the digits on this device first");
    const m = activeMember(db, caller.account, r.member_id, "device");
    if (!m || m.box_pk !== r.box_pk || m.sign_pk !== r.sign_pk)
      fail(409, "not-in-directory", "append the new device's entry to the directory first");
    if (m.claimed) fail(409, "already-paired", "this member already holds credentials");
    db.query("UPDATE members SET claimed = 1 WHERE account_id = ? AND id = ?").run(
      caller.account,
      r.member_id,
    );
    // The joining session becomes the new device's.
    db.query("UPDATE sessions SET member_id = ? WHERE token_hash = ? AND member_id IS NULL").run(
      r.member_id,
      r.session_hash,
    );
    touch(c, r, "approval = ?", JSON.stringify(approval));
    return r;
  })();
  wake(c, r);
  return c.json({ approved: true });
});

joinRoutes.delete("/joins/:id", async (c) => {
  const { db } = c.var;
  const r = load(db, c.req.param("id"));
  party(c, r);
  if (isOpen(r)) {
    touch(c, r, "cancelled = 1");
    wake(c, r);
  }
  return c.body(null, 204);
});
