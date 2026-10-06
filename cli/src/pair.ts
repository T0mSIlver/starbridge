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
  pairingLink,
  pairingRequest,
  publicKeys,
  verifyDirectory,
} from "@starbridge/protocol";
import { Api, ApiError } from "./api";
import { encodeKeys } from "./config";
import { type Ctx, iso, UsageError } from "./context";
import { terminalQr } from "./qr";
import { rememberMachineKind } from "./settings";

/** A pairing code expires after this long (PROTOCOL.md). */
const CODE_LIFETIME_MS = 10 * 60_000;
const POLL_SECONDS = 60;
/** The hosted server; `--server` or `STARBRIDGE_SERVER` points at a self-hosted one. */
export const DEFAULT_SERVER = "https://starbridge.run";

export async function pair(
  ctx: Ctx,
  opts: { server?: string; name?: string; force?: boolean },
): Promise<number> {
  const previous = ctx.store.machine();
  if (previous && !opts.force)
    throw new UsageError(
      `this machine is already paired as "${previous.name}" on ${previous.server}; \`starbridge pair --force\` pairs it again with new keys`,
    );
  // Pairing again stays on the same server, under the same name, unless told otherwise.
  const server = opts.server ?? ctx.env.STARBRIDGE_SERVER ?? previous?.server ?? DEFAULT_SERVER;

  const api = new Api(server);
  const keys = generateMemberKeys();
  const id = `m_${randomBytes(9).toString("base64url")}`;
  const name = opts.name ?? previous?.name ?? hostname();
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

  const link = pairingLink(server, code);
  ctx.out(`Pairing code: ${formatPairingCode(code)}`);
  ctx.out(`Scan this with the Starbridge app or your phone's camera, or open ${link}`);
  for (const line of terminalQr(link)) ctx.out(line);
  ctx.out(
    "Or type the code under Devices in the Starbridge app or web page. It expires in 10 minutes.",
  );

  const deadline = ctx.now().getTime() + CODE_LIFETIME_MS;
  let result: { approval: unknown; token?: string } | undefined;
  while (!result) {
    if (ctx.signal?.aborted) return 130;
    if (ctx.now().getTime() >= deadline)
      throw new UsageError("the pairing code expired; run `starbridge pair` again");
    try {
      result = await api.pairingResult(code.rendezvous, claim, POLL_SECONDS, ctx.signal);
    } catch (e) {
      if (ctx.signal?.aborted) return 130;
      throw e;
    }
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
  if (previous && dir.members.get(previous.id)?.active) {
    // Named as Devices shows it: the id appears in no client (#287).
    const at = addedAt(entries, previous.id);
    ctx.out(
      `Devices still lists the old pairing, "${previous.name}"${at ? ` added ${at}` : ""}; revoke it there.`,
    );
  }
  rememberMachineKind(ctx);
  return 0;
}

/** When the directory added member `id`, as "Oct 6, 10:32 AM" in the local zone. */
function addedAt(entries: unknown[], id: string): string | undefined {
  for (const e of entries as { body: string }[]) {
    const body = JSON.parse(e.body) as { op: string; at: string; member?: { id: string } };
    if (body.op === "add" && body.member?.id === id)
      return new Date(body.at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
  }
}
