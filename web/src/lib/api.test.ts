import { afterEach, expect, test } from "bun:test";
import { ApiError, api, backingOff, backoff, pairingError, retryAfter, Unreachable } from "./api";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  globalThis.dispatchEvent(new Event("online"));
  backoff.retryForMs = 20_000;
});

/**
 * Answers each call with the next of `replies`: a status, a 429 with its Retry-After, or an Error
 * to throw as fetch does.
 */
function serve(...replies: (number | { retryAfter: string } | Error)[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init.method ?? "GET");
    const r = replies.shift() ?? 200;
    if (r instanceof Error) throw r;
    if (typeof r === "object")
      return new Response("", { status: 429, headers: { "retry-after": r.retryAfter } });
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
  // Calls made while the backoff still runs; a timer may fire a millisecond early.
  let during = 0;
  const failing = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    if (Date.now() < backoff.until - 1) during++;
    return failing(...args);
  }) as typeof fetch;
  // A poller's turn every 50 ms for two seconds, as the inbox, prompts and runs add up to.
  const reads: Promise<unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    if (!backingOff()) reads.push(api.challenge().catch((e) => e));
    await new Promise((r) => setTimeout(r, 50));
  }
  const errors = await Promise.all(reads);
  expect(errors.every((e) => e instanceof Unreachable)).toBe(true);
  expect(errors[0]).toHaveProperty("message", "Can't reach the Starbridge server.");
  // Reads retry when the shared backoff ends, and pollers skip their turn until then: no call
  // goes out during a backoff, however slow the machine (a count of calls was flaky).
  expect(calls.length).toBeGreaterThan(1);
  expect(during).toBe(0);
});

test("a call's first try goes out during the backoff, and its answer ends it (#332)", async () => {
  const calls = serve(new TypeError("Failed to fetch"), 200);
  await expect(api.logout()).rejects.toBeInstanceOf(Unreachable);
  expect(backingOff()).toBe(true);
  // An answer's directory read, a push or a sign-in may be what finds the server back.
  expect(await api.challenge()).toBe("n");
  expect(backingOff()).toBe(false);
  expect(calls).toEqual(["POST", "GET"]);
});

test("the browser's online event ends the backoff (#332)", async () => {
  serve(new TypeError("Failed to fetch"));
  await expect(api.logout()).rejects.toBeInstanceOf(Unreachable);
  expect(backingOff()).toBe(true);
  globalThis.dispatchEvent(new Event("online"));
  expect(backingOff()).toBe(false);
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

test("a 429 holds every call until its Retry-After, then the call is retried (#645)", async () => {
  const calls = serve({ retryAfter: "1" });
  let during = 0;
  const limited = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    if (Date.now() < backoff.until - 1) during++;
    return limited(...args);
  }) as typeof fetch;
  const write = api.logout();
  await new Promise((r) => setTimeout(r, 50));
  expect(backingOff()).toBe(true);
  // A new call's first try waits too: the server is up and said when to come back.
  const read = api.challenge();
  await write;
  expect(await read).toBe("n");
  expect(calls).toEqual(["POST", "POST", "GET"]);
  expect(during).toBe(0);
  expect(backingOff()).toBe(false);
});

test("a 429 waiting longer than a call retries reaches the caller, and the backoff stays (#645)", async () => {
  const calls = serve({ retryAfter: new Date(Date.now() + 60_000).toUTCString() });
  await expect(api.challenge()).rejects.toMatchObject({ status: 429, code: "rate-limited" });
  expect(backingOff()).toBe(true);
  await expect(api.logout()).rejects.toMatchObject({ status: 429 });
  expect(calls).toEqual(["GET"]);
});

test("once a 429's hold is over, an outage reads as one again (#645)", async () => {
  serve({ retryAfter: "60" });
  await expect(api.challenge()).rejects.toMatchObject({ status: 429 });
  backoff.until = Date.now();
  backoff.retryForMs = 500;
  serve(...Array.from({ length: 20 }, () => 502));
  await expect(api.challenge()).rejects.toBeInstanceOf(Unreachable);
});

test("a 429 without Retry-After is a cap, and reaches the caller at once", async () => {
  const calls = serve(429);
  await expect(api.challenge()).rejects.toMatchObject({ status: 429 });
  expect(calls).toHaveLength(1);
  expect(backingOff()).toBe(false);
});

test("Retry-After reads as seconds or an HTTP date", () => {
  const res = (v: string) => new Response("", { status: 429, headers: { "retry-after": v } });
  expect(retryAfter(res("2"))).toBe(2000);
  const ms = retryAfter(res(new Date(Date.now() + 30_000).toUTCString())) ?? 0;
  expect(ms).toBeGreaterThan(28_000);
  expect(ms).toBeLessThanOrEqual(30_000);
  expect(retryAfter(res("soon"))).toBeNull();
  expect(retryAfter(new Response(""))).toBeNull();
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
