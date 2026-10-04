import type { Database } from "bun:sqlite";
import {
  activeMembers,
  type Directory,
  ProtocolError,
  RECOVERY,
  SignedEnvelope,
  verifyDirectory,
} from "@starbridge/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { fail, requireCaller } from "../auth";
import type { Env } from "../env";
import { json } from "../http";

export function loadEntries(db: Database, account: string, from = 0): SignedEnvelope[] {
  const rows = db
    .query("SELECT entry FROM directory WHERE account_id = ? AND seq >= ? ORDER BY seq")
    .all(account, from) as { entry: string }[];
  return rows.map((r) => JSON.parse(r.entry));
}

/** The active member with this id and role, from what the server derived of the chain. */
export function activeMember(
  db: Database,
  account: string,
  id: string,
  role?: "device" | "machine",
): { id: string; role: string; box_pk: string; sign_pk: string } | null {
  const m = db
    .query(
      "SELECT id, role, box_pk, sign_pk FROM members WHERE account_id = ? AND id = ? AND active = 1",
    )
    .get(account, id) as { id: string; role: string; box_pk: string; sign_pk: string } | null;
  return m && (!role || m.role === role) ? m : null;
}

function seqOf(env: SignedEnvelope): number | undefined {
  try {
    const seq = (JSON.parse(env.body) as { seq?: unknown }).seq;
    return typeof seq === "number" ? seq : undefined;
  } catch {
    return undefined;
  }
}

/** Records the verified directory's members and drops the credentials of revoked ones. */
function syncMembers(db: Database, account: string, dir: Directory): void {
  const upsert = db.query(
    `INSERT INTO members (account_id, id, role, box_pk, sign_pk, active) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, id) DO UPDATE SET active = excluded.active`,
  );
  for (const { member, active } of dir.members.values()) {
    upsert.run(account, member.id, member.role, member.boxPk, member.signPk, active ? 1 : 0);
    if (!active) {
      db.query("DELETE FROM sessions WHERE account_id = ? AND member_id = ?").run(
        account,
        member.id,
      );
      db.query("DELETE FROM machine_tokens WHERE account_id = ? AND member_id = ?").run(
        account,
        member.id,
      );
      db.query("DELETE FROM push_subscriptions WHERE account_id = ? AND member_id = ?").run(
        account,
        member.id,
      );
    }
  }
}

export const directoryRoutes = new Hono<Env>();

directoryRoutes.get("/directory", requireCaller("any"), (c) => {
  const from = Number(c.req.query("from") ?? 0);
  if (!Number.isInteger(from) || from < 0) fail(400, "bad-request", "from must be a seq");
  return c.json({ entries: loadEntries(c.var.db, c.var.caller.account, from) });
});

directoryRoutes.post("/directory", requireCaller("device"), async (c) => {
  const { entry } = await json(c, z.object({ entry: SignedEnvelope }));
  const caller = c.var.caller;
  if (caller.role !== "device") fail(403, "forbidden");
  const { db, config } = c.var;

  const result = db.transaction(() => {
    const entries = loadEntries(db, caller.account);
    if (seqOf(entry) !== entries.length)
      fail(409, "not-next", `the next entry has seq ${entries.length}`);
    // Only to refuse garbage early: clients verify the chain themselves and trust nothing here.
    let dir: Directory;
    try {
      dir = verifyDirectory([...entries, entry], { account: caller.account });
    } catch (e) {
      if (e instanceof ProtocolError) fail(400, e.code, e.message);
      throw e;
    }
    const genesis = entries.length === 0;
    if (!genesis && entry.signer !== RECOVERY && entry.signer !== caller.member)
      fail(403, "forbidden", "a device appends only entries it signed");
    if (activeMembers(dir, "machine").length > config.maxMachines)
      fail(403, "machine-cap", `an account holds at most ${config.maxMachines} machines`);

    db.query("INSERT INTO directory (account_id, seq, entry) VALUES (?, ?, ?)").run(
      caller.account,
      entries.length,
      JSON.stringify(entry),
    );
    syncMembers(db, caller.account, dir);
    // The device that wrote the genesis, or recovered with the words, is this session's device.
    const body = JSON.parse(entry.body) as { op: string; member?: { id: string } };
    if ((genesis || entry.signer === RECOVERY) && caller.member === null && body.member)
      db.query("UPDATE sessions SET member_id = ? WHERE token_hash = ?").run(
        body.member.id,
        caller.session,
      );
    return { length: dir.length, head: dir.head };
  })();
  return c.json(result, 201);
});
