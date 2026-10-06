import { afterEach, expect, test } from "bun:test";
import { ApiError, api, backoff, pairingError, Unreachable } from "./api";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  globalThis.dispatchEvent(new Event("online"));
  backoff.retryForMs = 20_000;
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
  await expect(api.logout()).rejects.toThrow("Can't reach the Starbridge server.");
  expect(calls).toEqual(["POST"]);
});

test("while the server is down, pollers share one backoff instead of each retrying (#332)", async () => {
  backoff.retryForMs = 1_500;
  const calls = serve(...Array.from({ length: 100 }, () => new TypeError("Failed to fetch")));
  // A read every 50 ms for two seconds, as the inbox, prompts, runs and joins pollers add up to.
  const reads: Promise<unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    reads.push(api.challenge().catch((e) => e));
    await new Promise((r) => setTimeout(r, 50));
  }
  const errors = await Promise.all(reads);
  expect(errors.every((e) => e instanceof Unreachable)).toBe(true);
  expect(errors[0]).toHaveProperty("message", "Can't reach the Starbridge server.");
  // The first read retries at 125–250 ms, 250–500 ms and so on; reads started meanwhile wait.
  expect(calls.length).toBeLessThan(10);
});

test("any answer ends the backoff, and a write always tries (#332)", async () => {
  const calls = serve(new TypeError("Failed to fetch"), 204, 200);
  await expect(api.logout()).rejects.toBeInstanceOf(Unreachable);
  await expect(api.challenge()).rejects.toBeInstanceOf(Unreachable);
  expect(calls).toEqual(["POST"]);
  await api.logout();
  expect(await api.challenge()).toBe("n");
  expect(calls).toEqual(["POST", "POST", "GET"]);
});

test("the browser's online event ends the backoff (#332)", async () => {
  const calls = serve(new TypeError("Failed to fetch"), 200);
  await expect(api.logout()).rejects.toBeInstanceOf(Unreachable);
  globalThis.dispatchEvent(new Event("online"));
  expect(await api.challenge()).toBe("n");
  expect(calls).toEqual(["POST", "GET"]);
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
    "This code was already approved.",
  );
  expect(pairingError(new ApiError(429, "busy", "too many pairings waiting; retry later"))).toBe(
    "Too many pairings waiting; retry later.",
  );
});
