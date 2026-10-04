import type { z } from "zod";
import type { Directory } from "./directory";
import type { KeyPair } from "./keys";
import {
  BODY_SCHEMAS,
  type BodyOf,
  type Kind,
  type Member,
  SealedItem,
  SignedEnvelope,
} from "./schemas";
import { concat, fromB64, ProtocolError, sodium, toB64, utf8 } from "./sodium";

/**
 * The bytes an Ed25519 signature covers: "starbridge/v1/<kind>", NUL, signer id, NUL, body.
 * The kind keeps a signature for one kind of message from passing as another; the signer id
 * binds the envelope's signer field.
 */
export function signatureMessage(kind: Kind, signer: string, body: string): Uint8Array {
  const nul = new Uint8Array([0]);
  return concat(utf8(`starbridge/v1/${kind}`), nul, utf8(signer), nul, utf8(body));
}

export function sign<K extends Kind>(
  kind: K,
  body: BodyOf<K>,
  signer: string,
  signKey: Uint8Array,
): SignedEnvelope {
  const text = JSON.stringify(body);
  const sig = sodium.crypto_sign_detached(signatureMessage(kind, signer, text), signKey);
  return { v: 1, kind, signer, body: text, sig: toB64(sig) };
}

/** Signs a message with a key held outside libsodium, such as a non-extractable WebCrypto key. */
export type SignFn = (message: Uint8Array) => Promise<Uint8Array>;

/** `sign` with a `SignFn`. Ed25519 is deterministic, so both give the same envelope. */
export async function signAsync<K extends Kind>(
  kind: K,
  body: BodyOf<K>,
  signer: string,
  signFn: SignFn,
): Promise<SignedEnvelope> {
  const text = JSON.stringify(body);
  const sig = await signFn(signatureMessage(kind, signer, text));
  return { v: 1, kind, signer, body: text, sig: toB64(sig) };
}

/** Throws `bad-signature` unless `signPk` signed this envelope. */
export function verify(env: SignedEnvelope, signPk: string): void {
  let ok = false;
  try {
    ok = sodium.crypto_sign_verify_detached(
      fromB64(env.sig),
      signatureMessage(env.kind, env.signer, env.body),
      fromB64(signPk),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new ProtocolError("bad-signature", `signer ${env.signer}`);
}

/** Parses a body whose signature was already checked. */
export function parseBody<K extends Kind>(kind: K, body: string): BodyOf<K> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ProtocolError("bad-schema", "body is not JSON");
  }
  return parseWith(BODY_SCHEMAS[kind], json) as BodyOf<K>;
}

export function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ProtocolError("bad-schema", r.error.issues[0]?.message);
  return r.data;
}

// --- Sealed items ------------------------------------------------------------

type ItemKind = SealedItem["kind"];

/** Which role may sign each kind: machines ask and report quotas, devices answer. */
const SIGNER_ROLE = { decision: "machine", quota: "machine", answer: "device" } as const;

/**
 * Signs `body` and seals the signed envelope to each recipient (sign, then seal).
 * The body's `to` must name exactly the recipients, so a recipient cannot re-seal it to
 * someone else unnoticed.
 */
export function seal<K extends ItemKind>(
  kind: K,
  body: BodyOf<K>,
  signer: { id: string; signKey: Uint8Array },
  recipients: Pick<Member, "id" | "boxPk">[],
): SealedItem & { kind: K } {
  checkRecipients(kind, body, recipients);
  return sealEnvelope(kind, body, sign(kind, body, signer.id, signer.signKey), recipients);
}

/** `seal` with a `SignFn`. */
export async function sealAsync<K extends ItemKind>(
  kind: K,
  body: BodyOf<K>,
  signer: { id: string; sign: SignFn },
  recipients: Pick<Member, "id" | "boxPk">[],
): Promise<SealedItem & { kind: K }> {
  checkRecipients(kind, body, recipients);
  return sealEnvelope(kind, body, await signAsync(kind, body, signer.id, signer.sign), recipients);
}

function checkRecipients<K extends ItemKind>(
  kind: K,
  body: BodyOf<K>,
  recipients: Pick<Member, "id" | "boxPk">[],
): void {
  const named = typeof body.to === "string" ? [body.to] : body.to;
  const ids = recipients.map((r) => r.id);
  if (named.length !== ids.length || !ids.every((id) => named.includes(id)))
    throw new Error("body.to must list exactly the recipients");
  parseWith(BODY_SCHEMAS[kind], body);
}

function sealEnvelope<K extends ItemKind>(
  kind: K,
  body: BodyOf<K>,
  env: SignedEnvelope,
  recipients: Pick<Member, "id" | "boxPk">[],
): SealedItem & { kind: K } {
  const plain = utf8(JSON.stringify(env));
  return {
    v: 1,
    kind,
    id: body.id,
    from: env.signer,
    ...("decisionId" in body ? { re: body.decisionId } : {}),
    boxes: recipients.map((r) => ({
      to: r.id,
      box: toB64(sodium.crypto_box_seal(plain, fromB64(r.boxPk))),
    })),
  };
}

/** Opens this member's box. The envelope inside is not verified yet. */
export function openBox(item: SealedItem, me: { id: string; box: KeyPair }): SignedEnvelope {
  const box = myBox(item, me.id);
  let plain: Uint8Array;
  try {
    plain = sodium.crypto_box_seal_open(fromB64(box), me.box.publicKey, me.box.privateKey);
  } catch {
    throw new ProtocolError("cannot-open");
  }
  return envelopeOf(item, plain);
}

function myBox(item: SealedItem, me: string): string {
  const mine = item.boxes.find((b) => b.to === me);
  if (!mine) throw new ProtocolError("wrong-recipient", `no box for ${me}`);
  return mine.box;
}

function envelopeOf(item: SealedItem, plain: Uint8Array): SignedEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  } catch {
    throw new ProtocolError("bad-schema", "sealed content is not JSON");
  }
  const env = parseWith(SignedEnvelope, json);
  if (env.kind !== item.kind) throw new ProtocolError("wrong-kind", `${env.kind} in ${item.kind}`);
  return env;
}

export interface Opened<K extends ItemKind> {
  signer: Member;
  body: BodyOf<K>;
}

/**
 * Opens, verifies and parses an item for `me`. The signer must be an active member of the
 * verified directory with the role allowed for this kind, and the signed body must match the
 * item's id and name `me` as a recipient.
 */
export function open<K extends ItemKind>(
  item: SealedItem & { kind: K },
  me: { id: string; box: KeyPair },
  directory: Directory,
): Opened<K> {
  const parsed = parseWith(SealedItem, item);
  return check(item, openBox(parsed, me), me.id, directory);
}

/**
 * Opens a sealed box with a key held outside libsodium. Rejects when the box does not open;
 * resolves to the plaintext otherwise.
 */
export type OpenSealFn = (box: Uint8Array) => Promise<Uint8Array>;

/** `open` with an `OpenSealFn`, running the same checks. */
export async function openAsync<K extends ItemKind>(
  item: SealedItem & { kind: K },
  me: { id: string; openSeal: OpenSealFn },
  directory: Directory,
): Promise<Opened<K>> {
  const parsed = parseWith(SealedItem, item);
  const box = myBox(parsed, me.id);
  let plain: Uint8Array;
  try {
    plain = await me.openSeal(fromB64(box));
  } catch {
    throw new ProtocolError("cannot-open");
  }
  return check(item, envelopeOf(parsed, plain), me.id, directory);
}

function check<K extends ItemKind>(
  item: SealedItem & { kind: K },
  env: SignedEnvelope,
  me: string,
  directory: Directory,
): Opened<K> {
  if (env.signer !== item.from) throw new ProtocolError("id-mismatch", "from is not the signer");
  const entry = directory.members.get(env.signer);
  if (!entry) throw new ProtocolError("unknown-signer", env.signer);
  if (!entry.active) throw new ProtocolError("revoked-signer", env.signer);
  if (entry.member.role !== SIGNER_ROLE[item.kind])
    throw new ProtocolError("signer-not-allowed", `${entry.member.role} cannot sign ${item.kind}`);
  verify(env, entry.member.signPk);
  const body = parseBody(item.kind, env.body) as BodyOf<K>;
  if (body.id !== item.id) throw new ProtocolError("id-mismatch", "body id is not the item id");
  const re = "decisionId" in body ? body.decisionId : undefined;
  if (item.re !== re) throw new ProtocolError("id-mismatch", "re is not the answered decision");
  const named = typeof body.to === "string" ? [body.to] : body.to;
  if (!named.includes(me)) throw new ProtocolError("wrong-recipient", "body does not name me");
  return { signer: entry.member, body };
}
