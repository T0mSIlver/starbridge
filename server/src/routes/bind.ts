import { B64, Id, verifyBind } from "@starbridge/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { fail, randomToken, recheck, requireCaller } from "../auth";
import type { Env } from "../env";
import { json } from "../http";
import { rateLimit } from "../limits";
import { activeMember } from "./directory";

const NONCE_MS = 5 * 60_000;

/** One outstanding nonce per session, kept in memory: a restart only means asking again. */
const nonces = new Map<string, { nonce: string; expires: number }>();

function take(session: string): string | undefined {
  const n = nonces.get(session);
  nonces.delete(session);
  return n && n.expires > Date.now() ? n.nonce : undefined;
}

/**
 * Binding a fresh session to an existing device: a browser or phone that signed in again proves
 * it holds an active device's signing key by signing a nonce (`bindMessage`), and the session
 * becomes that device's, as it would after writing the genesis or pairing.
 */
export const bindRoutes = new Hono<Env>();

bindRoutes.get("/auth/challenge", requireCaller("device"), (c) => {
  const caller = c.var.caller;
  if (caller.role !== "device") fail(403, "forbidden");
  rateLimit(c, `bind:${caller.account}`, [20, 60_000]);
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires <= now) nonces.delete(k);
  // Two tabs of one browser share the session: both get the outstanding nonce, so the first
  // bind succeeds instead of each replacing the other's.
  const held = nonces.get(caller.session);
  if (held) return c.json({ nonce: held.nonce, expiresInSeconds: (held.expires - now) / 1000 });
  const nonce = randomToken("");
  nonces.set(caller.session, { nonce, expires: now + NONCE_MS });
  return c.json({ nonce, expiresInSeconds: NONCE_MS / 1000 });
});

bindRoutes.post("/auth/bind", requireCaller("device"), async (c) => {
  const { member, sig } = await json(c, z.object({ member: Id, sig: B64 }));
  const caller = c.var.caller;
  if (caller.role !== "device") fail(403, "forbidden");
  // Taken before any check, so each nonce allows one attempt.
  const nonce = take(caller.session);
  if (!nonce) fail(400, "no-challenge", "get a nonce from GET /v1/auth/challenge first");
  const { db } = c.var;
  db.transaction(() => {
    recheck(c);
    if (caller.member !== null && caller.member !== member)
      fail(409, "already-paired", "this session belongs to another device");
    const m = activeMember(db, caller.account, member, "device");
    if (!m) fail(404, "not-found", "no active device with this id");
    if (!verifyBind({ account: caller.account, member, nonce, sig }, m.sign_pk))
      fail(401, "bad-signature", "the signature does not check against the device's key");
    db.query("UPDATE sessions SET member_id = ? WHERE token_hash = ?").run(member, caller.session);
  })();
  return c.json({ member });
});
