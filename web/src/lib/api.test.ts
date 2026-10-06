import { afterEach, expect, test } from "bun:test";
import { ApiError, api, pairingError } from "./api";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** Answers each call with the next of `replies`: a status, or an Error to throw as fetch does. */
function serve(...replies: (number | Error)[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init.method ?? "GET");
    const r = replies.shift() ?? 200;
    if (r instanceof Error) throw r;
    return new Response(r === 200 ? '{"nonce":"n"}' : "", { status: r });
  }) as typeof fetch;
  return calls;
}

test("a deploy's 502, 503 and refused connection are retried quietly until the server answers", async () => {
  const calls = serve(502, new TypeError("Failed to fetch"), 503);
  expect(await api.challenge()).toBe("n");
  expect(calls).toHaveLength(4);
});

test("a write is not repeated after a failure that may have reached the server", async () => {
  const calls = serve(new TypeError("Failed to fetch"));
  await expect(api.logout()).rejects.toThrow("Failed to fetch");
  expect(calls).toEqual(["POST"]);
});

test("a write is retried on a 502 or 503, which Caddy sends when the server is away", async () => {
  const calls = serve(502, 204);
  await api.logout();
  expect(calls).toEqual(["POST", "POST"]);
});

test("other errors reach the caller at once", async () => {
  const calls = serve(500);
  await expect(api.challenge()).rejects.toBeInstanceOf(ApiError);
  expect(calls).toHaveLength(1);
});

test("a pairing error reads as a sentence, without the API's code (#289)", () => {
  expect(pairingError(new ApiError(404, "not-found", "no such pairing, or it expired"))).toBe(
    "No pairing with this code, or it expired.",
  );
  expect(pairingError(new ApiError(409, "already-approved"))).toBe(
    "Another device already approved this code.",
  );
  expect(pairingError(new ApiError(429, "busy", "too many pairings waiting; retry later"))).toBe(
    "Too many pairings waiting; retry later.",
  );
});
