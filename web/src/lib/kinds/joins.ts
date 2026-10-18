// Join requests: another browser or phone of the account asks to join, and this device compares
// digits with it and approves (PROTOCOL.md). The joining side is the device's (startDigitJoin).
import {
  approverKeys,
  type JoinKeys,
  joinApproval,
  type Member,
  newJoinKeyPair,
  openJoinRequest,
  ProtocolError,
  ready,
  toB64,
} from "@starbridge/protocol";
import { ApiError, api, backoff } from "../api";
import type { JoinAsk, JoinView } from "../types";
import { appendMember, type Ctx } from "./core";

/**
 * Runs a join call again after a network or server failure, until the join expires or `signal`
 * aborts. Giving up would drop the ephemeral key, and the server takes one key per side.
 */
export async function retrying<T>(
  expiresAt: string,
  signal: AbortSignal,
  call: () => Promise<T>,
): Promise<T> {
  for (;;) {
    try {
      return await call();
    } catch (e) {
      const transient = !(e instanceof ApiError) || e.status >= 500 || e.status === 429;
      if (signal.aborted || !transient) throw e;
      if (Date.parse(expiresAt) < Date.now()) throw new Error("The request expired.");
      await new Promise((r) => setTimeout(r, retryDelay.ms));
    }
  }
}

/** How long a failed join call waits before its next try; tests shorten it. */
export const retryDelay = { ms: 3_000 };

function toAsk(view: JoinView): JoinAsk | undefined {
  try {
    const body = openJoinRequest(view.request);
    return {
      id: view.id,
      name: body.name,
      at: body.at,
      ...(view.approver ? { approver: view.approver } : {}),
      view,
    };
  } catch {
    return undefined;
  }
}

/** Calls `onChange` with the account's open join requests until `signal` aborts. */
export async function watchJoins(signal: AbortSignal, onChange: (asks: JoinAsk[]) => void) {
  await ready;
  let cursor = "0";
  while (!signal.aborted) {
    try {
      const page = await api.joins(cursor, 25, signal);
      cursor = page.cursor;
      onChange(page.joins.flatMap((v) => toAsk(v) ?? []));
    } catch {
      if (signal.aborted) return;
      // At most every 5 s, and not before the server's backoff ends (#332).
      await new Promise((r) => setTimeout(r, Math.max(5_000, backoff.until - Date.now())));
    }
  }
}

/** Digits this device derived for a join request, and what approving it does. */
export interface Comparison {
  digits: string;
  approve: (ctx: Ctx) => Promise<Ctx>;
}

/**
 * Takes the request as listed: posts this device's key, waits for the joining device to reveal
 * its key, and checks the reveal against the commitment listed before this key went out.
 */
export async function compareJoin(
  ctx: Ctx,
  ask: JoinAsk,
  signal: AbortSignal,
): Promise<Comparison> {
  await ready;
  const { request, commitment } = ask.view;
  const body = openJoinRequest(request);
  if (body.account !== ctx.account) throw new ProtocolError("wrong-account", body.account);
  if (body.join !== ask.id) throw new ProtocolError("id-mismatch", "join");
  const eph = newJoinKeyPair();
  const claimed = (await api.claimJoin(ask.id, toB64(eph.publicKey), ctx.device.id)).join;
  let after = claimed.version - 1;
  let keys: JoinKeys;
  try {
    for (;;) {
      const { join } = await retrying(claimed.expiresAt, signal, () =>
        api.join(ask.id, after, 25, signal),
      );
      after = join.version;
      if (join.state === "cancelled") throw new Error(`${body.name} cancelled the request.`);
      if (join.joinerKey) {
        keys = approverKeys({ mine: eph, joinerKey: join.joinerKey, request, commitment });
        break;
      }
      if (Date.parse(join.expiresAt) < Date.now()) throw new Error("The request expired.");
    }
  } finally {
    eph.privateKey.fill(0);
  }
  const member: Member = {
    id: body.id,
    role: "device",
    name: body.name,
    boxPk: body.boxPk,
    signPk: body.signPk,
  };
  return {
    digits: keys.digits,
    approve: async (current) => {
      const next = await appendMember(current, member);
      const approval = joinApproval(
        {
          v: 1,
          join: ask.id,
          account: current.account,
          length: next.dir.length,
          head: next.dir.head,
          approver: current.device.id,
        },
        keys,
      );
      await api.approveJoin(ask.id, approval);
      return next;
    },
  };
}

export function refuseJoin(id: string): Promise<void> {
  return api.cancelJoin(id);
}
