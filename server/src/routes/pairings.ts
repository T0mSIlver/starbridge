import type { Database } from "bun:sqlite";
import {
  B64,
  claimHash,
  PairingApprovalBody,
  PairingMessage,
  PairingRequestBody,
} from "@starbridge/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { fail, hashToken, identify, randomToken, recheck, requireCaller, safeEqual } from "../auth";
import type { Env } from "../env";
import { holdOpen, json, waitSeconds } from "../http";
import { ipKey, rateLimit } from "../limits";
import { activeMember } from "./directory";

const LIFETIME_MS = 10 * 60_000;
/** A pairing message's JSON, in bytes, so waiting pairings cannot fill the disk. */
const MESSAGE_BYTES = 4 * 1024;
const RENDEZVOUS = /^[0-9A-HJKMNP-TV-Z]{8}$/;

interface Pairing {
  rendezvous: string;
  request: string;
  role: "device" | "machine";
  member_id: string;
  box_pk: string;
  sign_pk: string;
  claim_hash: string;
  created_at: number;
  account_id: string | null;
  approval: string | null;
  token: string | null;
  refused: string | null;
}

function parseBody<T extends z.ZodType>(schema: T, text: string): z.infer<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(400, "bad-schema", "body is not JSON");
  }
  const r = schema.safeParse(value);
  if (!r.success) fail(400, "bad-schema", r.error.issues[0]?.message);
  return r.data;
}

const Bounded = PairingMessage.refine(
  (m) => Buffer.byteLength(JSON.stringify(m)) <= MESSAGE_BYTES,
  `a pairing message is at most ${MESSAGE_BYTES} bytes`,
);

export const pairingRoutes = new Hono<Env>();

/**
 * Who posted each pairing, an IPv6 client as its /48, to cap the unapproved pairings per address.
 * It lives in memory, as every per-address limit does, so no address reaches the disk (#575); a
 * restart forgets it, as it forgets the rate limits.
 */
export class PairingClients {
  private readonly posted = new Map<string, { client: string; at: number }>();

  add(rendezvous: string, client: string, now: number): void {
    this.posted.set(rendezvous, { client, at: now });
  }

  /** The rendezvous ids `client` posted within a pairing's lifetime. */
  of(client: string, now: number): string[] {
    const ids: string[] = [];
    for (const [rendezvous, p] of this.posted)
      if (p.client === client && now - p.at <= LIFETIME_MS) ids.push(rendezvous);
    return ids;
  }

  /** Forgets the pairings past their lifetime, which the database has swept too. */
  sweep(now: number): void {
    for (const [rendezvous, p] of this.posted)
      if (now - p.at > LIFETIME_MS) this.posted.delete(rendezvous);
  }
}

/**
 * Deletes expired pairings, and with them any machine token still held for a retried result,
 * so no plaintext token outlives the pairing's 10 minutes.
 */
export function sweepPairings(db: Database): void {
  db.query("DELETE FROM pairings WHERE created_at < ?").run(Date.now() - LIFETIME_MS);
}

/**
 * Marks refused, with error code `reason`, the waiting pairings of a machine whose directory entry
 * the server refused, and wakes their result polls. Matched by the member's id and both keys,
 * which only the pairing's request carries, so only a device shown its code can end it.
 */
export function refusePairings(
  c: { var: Env["Variables"] },
  member: { id: string; boxPk: string; signPk: string },
  reason: string,
): void {
  const rows = c.var.db
    .query(
      `UPDATE pairings SET refused = ?
       WHERE member_id = ? AND box_pk = ? AND sign_pk = ? AND role = 'machine'
         AND approval IS NULL AND account_id IS NULL
       RETURNING rendezvous`,
    )
    .all(reason, member.id, member.boxPk, member.signPk) as { rendezvous: string }[];
  for (const r of rows) c.var.pairings.wake(r.rendezvous);
}

function load(c: { var: Env["Variables"] }, rendezvous: string): Pairing {
  if (!RENDEZVOUS.test(rendezvous)) fail(404, "not-found");
  sweepPairings(c.var.db);
  const p = c.var.db
    .query("SELECT * FROM pairings WHERE rendezvous = ?")
    .get(rendezvous) as Pairing | null;
  if (!p || Date.now() - p.created_at > LIFETIME_MS)
    fail(404, "not-found", "no such pairing, or it expired");
  return p;
}

pairingRoutes.post("/pairings", async (c) => {
  rateLimit(c, `pair:${ipKey(c)}`, c.var.config.limits.pairingPosts);
  const { request, claimHash: claim } = await json(
    c,
    z.object({ request: Bounded, claimHash: B64.length(43) }),
  );
  // The MAC needs the secret, which only the new member and the owner hold; the server reads the
  // body to route the pairing and checks it against the directory on approval.
  const body = parseBody(PairingRequestBody, request.body);
  if (!RENDEZVOUS.test(body.rendezvous)) fail(400, "bad-schema", "rendezvous");
  const db = c.var.db;
  const { limits } = c.var.config;
  const client = ipKey(c, 48);
  const created = db.transaction(() => {
    sweepPairings(db);
    const taken = db.query("SELECT 1 FROM pairings WHERE rendezvous = ?").get(body.rendezvous);
    if (taken) return false;
    const { n } = db.query("SELECT COUNT(*) AS n FROM pairings").get() as { n: number };
    if (n >= limits.pendingPairings) fail(429, "busy", "too many pairings waiting; retry later");
    const mine = db
      .query(
        "SELECT COUNT(*) AS n FROM pairings WHERE approval IS NULL AND rendezvous IN (SELECT value FROM json_each(?))",
      )
      .get(JSON.stringify(c.var.pairingClients.of(client, Date.now()))) as { n: number };
    if (mine.n >= limits.pairingsPerClient)
      fail(429, "too-many-pairings", "this address has too many pairings waiting; retry later");
    db.query(
      `INSERT INTO pairings (rendezvous, request, role, member_id, box_pk, sign_pk, claim_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      body.rendezvous,
      JSON.stringify(request),
      body.role,
      body.id,
      body.boxPk,
      body.signPk,
      claim,
      Date.now(),
    );
    c.var.pairingClients.add(body.rendezvous, client, Date.now());
    return true;
  })();
  if (!created) fail(409, "taken", "rendezvous id in use; make a new code");
  c.var.pairings.wake(`request:${body.rendezvous}`);
  return c.json({ expiresInSeconds: LIFETIME_MS / 1000 }, 201);
});

/**
 * The request under a rendezvous id. With `wait`, a device that showed a QR code holds the
 * request open until the new member posts, and gets 204 if `wait` passes first.
 */
pairingRoutes.get("/pairings/:rendezvous", requireCaller("paired-device"), async (c) => {
  rateLimit(c, `pair-read:${c.var.caller.account}`, c.var.config.limits.pairingReads);
  const rendezvous = c.req.param("rendezvous");
  if (!RENDEZVOUS.test(rendezvous)) fail(404, "not-found");
  const find = () => {
    sweepPairings(c.var.db);
    const p = c.var.db
      .query("SELECT * FROM pairings WHERE rendezvous = ?")
      .get(rendezvous) as Pairing | null;
    return p && Date.now() - p.created_at <= LIFETIME_MS ? p : null;
  };
  let p = find();
  const seconds = waitSeconds(c);
  if (!p && seconds > 0) {
    if (c.var.pairings.count(`request:${rendezvous}`) >= c.var.config.limits.pairingWaits)
      fail(429, "too-many-waits", "this rendezvous id already has its long-polls open");
    holdOpen(c);
    await c.var.pairings.wait(`request:${rendezvous}`, seconds, c.req.raw.signal);
    recheck(c);
    p = find();
    if (!p) return c.body(null, 204);
  }
  if (!p || (p.account_id && p.account_id !== c.var.caller.account))
    fail(404, "not-found", "no such pairing, or it expired");
  return c.json({ request: JSON.parse(p.request) });
});

pairingRoutes.post("/pairings/:rendezvous/approve", requireCaller("paired-device"), async (c) => {
  const { approval } = await json(c, z.object({ approval: Bounded }));
  const caller = c.var.caller;
  const { db } = c.var;
  const rendezvous = c.req.param("rendezvous");
  const body = parseBody(PairingApprovalBody, approval.body);
  if (
    body.rendezvous !== rendezvous ||
    body.account !== caller.account ||
    body.approver !== caller.member
  )
    fail(400, "bad-schema", "approval names another rendezvous, account or approver");

  db.transaction(() => {
    recheck(c);
    const p = load(c, rendezvous);
    if (p.approval) fail(409, "already-approved");
    // The new machine was told and gave up: a token minted now would reach nobody.
    if (p.refused) fail(409, p.refused, "this pairing was refused; pair again");
    const m = activeMember(db, caller.account, p.member_id, p.role);
    if (!m || m.box_pk !== p.box_pk || m.sign_pk !== p.sign_pk)
      fail(409, "not-in-directory", "append the new member's entry to the directory first");
    if (m.claimed) fail(409, "already-paired", "this member already holds credentials");
    db.query("UPDATE members SET claimed = 1 WHERE account_id = ? AND id = ?").run(
      caller.account,
      p.member_id,
    );
    let token: string | null = null;
    if (p.role === "machine") {
      token = randomToken("sbm_");
      db.query(
        "INSERT INTO machine_tokens (token_hash, account_id, member_id, created_at) VALUES (?, ?, ?, ?)",
      ).run(hashToken(token), caller.account, p.member_id, new Date().toISOString());
    }
    db.query(
      "UPDATE pairings SET account_id = ?, approval = ?, token = ? WHERE rendezvous = ?",
    ).run(caller.account, JSON.stringify(approval), token, rendezvous);
  })();
  c.var.pairings.wake(rendezvous);
  return c.json({ approved: true });
});

pairingRoutes.get("/pairings/:rendezvous/result", async (c) => {
  rateLimit(c, `pair-result:${ipKey(c)}`, c.var.config.limits.pairingResults);
  const rendezvous = c.req.param("rendezvous");
  const claim = c.req.header("x-claim") ?? "";
  let p = load(c, rendezvous);
  if (!safeEqual(claimHash(claim), p.claim_hash)) fail(403, "forbidden", "wrong claim");
  const refused = (r: string) =>
    fail(
      403,
      r,
      r === "machine-cap"
        ? `the account already has its ${c.var.config.maxMachines} machines (phones and browsers don't count): revoke one under Devices, then pair again`
        : "the approving device refused this pairing",
    );
  if (p.refused) refused(p.refused);
  if (!p.approval) {
    const seconds = waitSeconds(c);
    if (seconds > 0) {
      if (c.var.pairings.count(rendezvous) >= c.var.config.limits.pairingWaits)
        fail(429, "too-many-waits", "this pairing already has its long-polls open");
      holdOpen(c);
      await c.var.pairings.wait(rendezvous, seconds, c.req.raw.signal);
      const again = load(c, rendezvous);
      // The pairing may have expired and its rendezvous id been reused while this request waited.
      if (again.created_at !== p.created_at || !safeEqual(claimHash(claim), again.claim_hash))
        fail(404, "not-found", "no such pairing, or it expired");
      p = again;
      if (p.refused) refused(p.refused);
    }
    if (!p.approval) return c.body(null, 204);
  }
  if (p.role === "device") {
    // A new device fetches its result signed in; its session becomes the new device's.
    const caller = identify(c);
    if (caller?.role !== "device" || caller.account !== p.account_id)
      fail(403, "forbidden", "sign in to the approving account first");
    if (!activeMember(c.var.db, p.account_id, p.member_id, "device"))
      fail(404, "not-found", "revoked");
    if (caller.member !== null && caller.member !== p.member_id)
      fail(409, "already-paired", "this session belongs to another device");
    c.var.db
      .query("UPDATE sessions SET member_id = ? WHERE token_hash = ?")
      .run(p.member_id, caller.session);
  }
  return c.json({ approval: JSON.parse(p.approval), ...(p.token ? { token: p.token } : {}) });
});
