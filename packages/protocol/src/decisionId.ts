import { WORDS } from "./words";

/** Words in a decision id: 3 of 2048 is 33 bits. */
export const DECISION_ID_WORDS = 3;

/**
 * A new decision id: `d_` and three words from the BIP-39 list, joined by hyphens
 * (`d_amber-otter-lantern`, #1697), 33 bits. The id names a card and gates nothing: every
 * read of it takes a signed-in device or machine and its own box, so a guess opens nothing. The
 * bits only keep two decisions of one account from sharing an id, and a poster that gets a 409
 * `duplicate-id` mints again. An id from before #1697 is `d_` and 16 base64url characters; both
 * are an `Id`, and nothing reads an id's shape.
 */
export function newDecisionId(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(DECISION_ID_WORDS * 2);
  const words: string[] = [];
  for (let i = 0; i < DECISION_ID_WORDS; i++)
    // 2048 is 2^11, so masking 11 bits of two random bytes picks each word evenly.
    words.push(
      WORDS[(((bytes[2 * i] as number) << 8) | (bytes[2 * i + 1] as number)) & 0x7ff] as string,
    );
  return `d_${words.join("-")}`;
}

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}
