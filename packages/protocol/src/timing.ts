// Durations pages read without the crypto: this file imports no libsodium, so the web's landing
// page and sign-in screen can use them (#1961).

/**
 * How long a machine waits for its owner to confirm its check code, from its approval. Devices
 * show the code beside the machine only this long after its `add` entry, while it can still be
 * confirmed (#939).
 */
export const CHECK_CONFIRM_MS = 10 * 60_000;
