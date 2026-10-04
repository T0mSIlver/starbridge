import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  checkJoined,
  claimHash,
  formatPairingCode,
  generateMemberKeys,
  newClaimSecret,
  newPairingCode,
  openPairingApproval,
  pairingRequest,
  publicKeys,
  verifyDirectory,
} from "@starbridge/protocol";
import { Api, ApiError } from "./api";
import { encodeKeys } from "./config";
import { type Ctx, iso, UsageError } from "./context";

/** A pairing code expires after this long (PROTOCOL.md). */
const CODE_LIFETIME_MS = 10 * 60_000;
const POLL_SECONDS = 60;

export async function pair(
  ctx: Ctx,
  opts: { server?: string; name?: string; force?: boolean },
): Promise<number> {
  const server = opts.server ?? ctx.env.STARBRIDGE_SERVER;
  if (!server) throw new UsageError("pair needs --server <url> (or STARBRIDGE_SERVER)");
  if (ctx.store.machine() && !opts.force)
    throw new UsageError("this machine is already paired; pass --force to pair it again");

  const api = new Api(server);
  const keys = generateMemberKeys();
  const id = `m_${randomBytes(9).toString("base64url")}`;
  const name = opts.name ?? hostname();
  const claim = newClaimSecret();

  let code = newPairingCode();
  for (let attempt = 0; ; attempt++) {
    const request = {
      v: 1 as const,
      rendezvous: code.rendezvous,
      role: "machine" as const,
      id,
      name,
      ...publicKeys(keys),
      at: iso(ctx.now()),
    };
    try {
      await api.postPairing(pairingRequest(request, code), claimHash(claim));
      break;
    } catch (e) {
      // 409: the rendezvous id is taken; a fresh code makes a fresh one.
      if (!(e instanceof ApiError && e.status === 409) || attempt >= 2) throw e;
      code = newPairingCode();
    }
  }

  ctx.out(`Pairing code: ${formatPairingCode(code)}`);
  ctx.out(`Type it under Devices in the Starbridge app or web page within 10 minutes.`);

  const deadline = ctx.now().getTime() + CODE_LIFETIME_MS;
  let result: { approval: unknown; token?: string } | undefined;
  while (!result) {
    if (ctx.signal?.aborted || ctx.now().getTime() >= deadline)
      throw new UsageError("the pairing code expired; run `starbridge pair` again");
    result = await api.pairingResult(code.rendezvous, claim, POLL_SECONDS);
  }

  const approval = openPairingApproval(result.approval, code);
  if (!result.token) throw new UsageError("the server approved the pairing but sent no token");
  const entries = await new Api(server, result.token).directory(0);
  const pin = { length: approval.length, head: approval.head };
  const dir = verifyDirectory(entries, { account: approval.account, pin });
  checkJoined(dir, { id, role: "machine", ...publicKeys(keys) });

  const token = result.token;
  ctx.store.locked(() => {
    ctx.store.saveDirectory(entries);
    ctx.store.saveMachine({
      server,
      account: approval.account,
      id,
      name,
      token,
      keys: encodeKeys(keys),
      pin: { length: dir.length, head: dir.head },
    });
  });
  ctx.store.updateState((s) => {
    s.cursor = undefined;
    s.asked = {};
    s.answers = {};
  });
  ctx.out(`Paired "${name}" (${id}). Keys are in ${ctx.store.dir}.`);
  return 0;
}
