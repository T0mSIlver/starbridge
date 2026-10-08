import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  appPairingLink,
  checkCode,
  checkJoined,
  claimHash,
  formatPairingCode,
  generateMemberKeys,
  newCheckKey,
  newClaimSecret,
  newPairingCode,
  openPairingApproval,
  pairingLink,
  pairingRequest,
  publicKeys,
  verifyCheckProof,
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
  // Only the QR carries it: the Android app that scans it confirms the check code by itself.
  const checkKey = newCheckKey();

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
  // A starbridge: link, which no browser opens: only the app reads the check key (#795).
  ctx.out("  Scan this with the Starbridge Android app or your phone's camera:");
  for (const line of terminalQr(appPairingLink(server, code, checkKey))) ctx.out(line);
  ctx.out(`  No app? Open  ${link}`);
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
  // chain it controls: only the Android app, from the QR, or the owner comparing with it can tell
  // (#795).
  const again = opts.again ?? "starbridge pair";
  const check = checkCode(entries, id);
  if (approval.check !== undefined) {
    if (!verifyCheckProof(entries, id, checkKey, approval.check))
      throw new UsageError(
        `the Android app that scanned the QR code saw another check code, so a server may have paired this machine into an account it controls. Nothing is saved: revoke "${name}" under Devices, then run \`${again}\` again`,
      );
  } else {
    const answer = await confirmCheck(ctx, check, name);
    if (ctx.signal?.aborted) return 130;
    if (answer === "no")
      throw new UsageError(
        `the codes differ, so this machine is not paired. A server may have read the pairing code. Revoke "${name}" under Devices, then run \`${again}\` again`,
      );
    if (answer === undefined)
      throw new UsageError(
        `the check code was not confirmed within 10 minutes, so this machine is not paired. Revoke "${name}" under Devices, then run \`${again}\` again`,
      );
  }

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

/** How long the owner has to confirm the check code. */
const CONFIRM_MS = 10 * 60_000;

/** The check code a waiting `pair` shows, which `pair --confirm` or `--reject` answers. */
const waitingFile = (ctx: Ctx) => join(ctx.store.dir, "pair-waiting");
/** The answer for one check code: a `pair` waiting on another code never reads it. */
const answerFile = (ctx: Ctx, code: string) => join(ctx.store.dir, `pair-answer.${code}`);

/** Whole or not at all: a waiting reader sees the file complete or not yet. */
function writeWhole(path: string, text: string) {
  const tmp = `${path}.${process.pid}`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

/** `starbridge pair --confirm` or `--reject`: answers the check code a waiting `pair` shows. */
export function sendConfirm(ctx: Ctx, same: boolean): number {
  let code: string;
  try {
    code = readFileSync(waitingFile(ctx), "utf8").trim();
  } catch {
    throw new UsageError("no `starbridge pair` is waiting for its check code to be confirmed");
  }
  if (!/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(code))
    throw new UsageError("no `starbridge pair` is waiting for its check code to be confirmed");
  writeWhole(answerFile(ctx, code), same ? "yes" : "no");
  ctx.out(
    `${same ? "Confirmed" : "Rejected"} check code ${code} for the waiting \`starbridge pair\`.`,
  );
  return 0;
}

/**
 * Shows `code` and asks the owner whether the Android app shows the same beside the machine, on
 * this terminal or through `starbridge pair --confirm` or `--reject`. Undefined when nobody
 * answered in time.
 */
async function confirmCheck(
  ctx: Ctx,
  code: string,
  name: string,
): Promise<"yes" | "no" | undefined> {
  const file = answerFile(ctx, code);
  rmSync(file, { force: true });
  // Answers name the code they answer, so two waiting pairings cannot take each other's. A first
  // pairing has written nothing yet, so the directory may not exist.
  mkdirSync(ctx.store.dir, { recursive: true, mode: 0o700 });
  writeWhole(waitingFile(ctx), code);
  const tty = process.stdin.isTTY;
  ctx.out(`Check code: ${code}`);
  ctx.out(
    `  The Starbridge Android app shows "${name}" under Devices with its check code. A browser shows what the server sends, so compare with the app if you have it. An app that shows no code needs updating.`,
  );
  ctx.out(
    tty
      ? "Same code? [Y/n]"
      : "  Same code? Run `starbridge pair --confirm` if so, `starbridge pair --reject` if not.",
  );
  const typed: string[] = [];
  // Lines typed while the machine waited for approval arrive at once: a stray Enter among them
  // must not confirm a code nobody read.
  const shown = Date.now();
  const rl = tty
    ? createInterface({ input: process.stdin }).on("line", (l) => {
        if (Date.now() - shown > 500) typed.push(l);
      })
    : undefined;
  try {
    const until = ctx.now().getTime() + CONFIRM_MS;
    for (;;) {
      if (ctx.signal?.aborted || ctx.now().getTime() > until) return undefined;
      const line = typed.shift();
      // Enter alone confirms (Tom, 2026-10-08).
      if (line !== undefined) return /^\s*(y(es)?)?\s*$/i.test(line) ? "yes" : "no";
      try {
        const answer = readFileSync(file, "utf8");
        rmSync(file, { force: true });
        return answer === "yes" ? "yes" : "no";
      } catch {
        await ctx.sleep(500);
      }
    }
  } finally {
    rl?.close();
    rmSync(file, { force: true });
    try {
      if (readFileSync(waitingFile(ctx), "utf8") === code)
        rmSync(waitingFile(ctx), { force: true });
    } catch {}
  }
}
