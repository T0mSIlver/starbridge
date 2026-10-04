import type { Permission, PermissionAnswer } from "./schemas";
import { ProtocolError, sodium, toB64, utf8 } from "./sodium";

/**
 * A permission's `inputHash`: BLAKE2b-256 of the tool input's JSON text as the machine holds it,
 * before redaction. Devices only repeat it; the machine compares it with its own.
 */
export function hashInput(inputJson: string): string {
  return toB64(sodium.crypto_generichash(32, utf8(inputJson), null));
}

/**
 * The machine's checks on an answer that `open` already verified as signed by `device`, an active
 * device: it answers this permission, comes from a device the permission was sealed to, repeats
 * its input hash, picks a scope the permission offered, and arrives before the prompt expires.
 * The caller checks that the permission is still waiting.
 */
export function checkPermissionAnswer(
  asked: Permission,
  answer: PermissionAnswer,
  device: string,
  now = Date.now(),
): void {
  if (answer.permissionId !== asked.id)
    throw new ProtocolError("id-mismatch", "answers another permission");
  if (!asked.to.includes(device))
    throw new ProtocolError("signer-not-allowed", `${device} was not asked`);
  if (answer.inputHash !== asked.inputHash)
    throw new ProtocolError("wrong-input", "the input hash differs from the one asked");
  if (answer.scope !== "once" && !asked.suggestions.some((s) => s.scope === answer.scope))
    throw new ProtocolError("scope-not-offered", answer.scope);
  if (now > Date.parse(asked.expiresAt)) throw new ProtocolError("expired");
}
