import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  checkCode,
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
  opts: { server?: string; name?: string; force?: boolean; again?: string },
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

  // The server's 10 minutes start when it stores the pairing, after this: ending here first
  // keeps the last poll from finding the pairing gone (#623).
  const deadline = ctx.now().getTime() + CODE_LIFETIME_MS;
  const expired = () =>
    new UsageError(`the pairing code expired; run \`${opts.again ?? "starbridge pair"}\` again`);
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
  // The first line is part of the CLI's contract (CONTRACT.md); the link sits alone on its line
  // so it does not wrap in an 80-column terminal.
  ctx.out(`Pairing code: ${formatPairingCode(code)}`);
  ctx.out("  Scan this with your phone's camera or the Starbridge app:");
  for (const line of terminalQr(link)) ctx.out(line);
  ctx.out(`  Or open  ${link}`);
  ctx.out("  Or type the code under Devices in the app or web page. It expires in 10 minutes.");

  let result: { approval: unknown; token?: string } | undefined;
  while (!result) {
    if (ctx.signal?.aborted) return 130;
    const left = Math.ceil((deadline - ctx.now().getTime()) / 1000);
    if (left <= 0) throw expired();
    try {
      result = await api.pairingResult(
        code.rendezvous,
        claim,
        Math.min(POLL_SECONDS, left),
        ctx.signal,
      );
    } catch (e) {
      if (ctx.signal?.aborted) return 130;
      // The server forgets a pairing when it expires.
      if (e instanceof ApiError && e.status === 404) throw expired();
      // The approving device hit the account's machine limit; the server ended the pairing (#615).
      if (e instanceof ApiError && e.code === "machine-cap")
        throw new UsageError(
          "this account already has its maximum number of machines (phones and browsers don't count): revoke one under Devices in the app or web page, then run `starbridge setup` again",
        );
      throw e;
    }
  }

  const approval = openPairingApproval(result.approval, code);
  if (!result.token) throw new UsageError("the server approved the pairing but sent no token");
  const entries = await new Api(server, result.token).directory(0);
  const pin = { length: approval.length, head: approval.head };
  const dir = verifyDirectory(entries, { account: approval.account, pin });
  checkJoined(dir, { id, role: "machine", ...publicKeys(keys) });
  // A hostile server that read the code in a browser could have approved this machine into a
  // chain it controls: only the owner, comparing with the app, can tell (#795).
  const confirmed = await confirmCheck(ctx, checkCode(entries, id), name);
  if (ctx.signal?.aborted) return 130;
  if (!confirmed)
    throw new UsageError(
      `the check code was not confirmed, so this machine is not paired. If Devices lists "${name}" from this attempt, revoke it there, then run \`${opts.again ?? "starbridge pair"}\` again`,
    );

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
    // Heads from the old pairing: one a compromised device forged would hold this one too.
    delete s.heads;
    delete s.held;
    delete s.behind;
  });
  // `starbridge status` shows the machine's id.
  ctx.out(`✓ Paired as ${name}`);
  if (previous && dir.members.get(previous.id)?.active) {
    // Named as Devices shows it: the id appears in no client (#287).
    const at = addedAt(entries, previous.id);
    ctx.out(
      `Devices still lists the old pairing as the earlier "${previous.name}"${at ? `, added ${at}` : ""}. Revoke it there.`,
    );
  }
  rememberMachineKind(ctx);
  return 0;
}

/** When the directory added member `id`, as "Oct 6, 10:32 AM UTC", in this machine's zone. */
function addedAt(entries: unknown[], id: string): string | undefined {
  for (const e of entries as { body: string }[]) {
    const body = JSON.parse(e.body) as { op: string; at: string; member?: { id: string } };
    if (body.op === "add" && body.member?.id === id)
      return new Date(body.at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        // A sandbox or container often runs in UTC while Devices shows the viewer's zone.
        timeZoneName: "short",
      });
  }
}

/** How long the owner has to confirm the check code, and how many wrong tries. */
const CONFIRM_MS = 10 * 60_000;
const CONFIRM_TRIES = 3;

/** Where `starbridge pair --confirm` leaves the last group for the waiting `pair`. */
const confirmFile = (ctx: Ctx) => join(ctx.store.dir, "pair-confirm");

/** `starbridge pair --confirm <group>`: hands the group typed from the app to the waiting `pair`. */
export function sendConfirm(ctx: Ctx, group: string): number {
  // A first pairing has written nothing yet, so the directory may not exist.
  mkdirSync(ctx.store.dir, { recursive: true, mode: 0o700 });
  rmSync(confirmFile(ctx), { force: true });
  writeFileSync(confirmFile(ctx), group, { mode: 0o600, flag: "wx" });
  ctx.out("Sent to the waiting `starbridge pair`.");
  return 0;
}

/** Crockford base32 as typed: case, spaces and hyphens aside, O as 0, I and L as 1. */
const normal = (text: string) =>
  text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

/**
 * Shows the first three groups of `code` and waits for the owner to type the fourth from the
 * app, on this terminal or with `starbridge pair --confirm`. Nothing confirms it otherwise: an
 * agent running setup has no terminal and does not see the last group.
 */
async function confirmCheck(ctx: Ctx, code: string, name: string): Promise<boolean> {
  const file = confirmFile(ctx);
  rmSync(file, { force: true });
  ctx.out(`Check code: ${code.slice(0, 14)}-????`);
  ctx.out(
    `  The Starbridge Android app shows "${name}" under Devices with its full check code; a browser shows what the server sends. Type its last four characters${process.stdin.isTTY ? " here" : ""}, or run \`starbridge pair --confirm <last four>\`.`,
  );
  const typed: string[] = [];
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin }).on("line", (l) => typed.push(l))
    : undefined;
  try {
    const until = ctx.now().getTime() + CONFIRM_MS;
    for (let tries = 0; tries < CONFIRM_TRIES; ) {
      if (ctx.signal?.aborted || ctx.now().getTime() > until) return false;
      let answer = typed.shift();
      if (answer === undefined) {
        try {
          answer = readFileSync(file, "utf8");
          rmSync(file, { force: true });
        } catch {
          await ctx.sleep(500);
          continue;
        }
      }
      if (normal(answer) === normal(code.slice(15))) return true;
      tries++;
      ctx.err(
        `starbridge: that is not the code's last group (${CONFIRM_TRIES - tries} tries left)`,
      );
    }
    return false;
  } finally {
    rl?.close();
    rmSync(file, { force: true });
  }
}
