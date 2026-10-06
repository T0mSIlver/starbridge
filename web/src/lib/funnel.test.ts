import { afterEach, beforeEach, expect, test } from "bun:test";
import { FUNNEL_KEY, firstSignIn, reach } from "./funnel";

const sent: string[] = [];
const store = new Map<string, string>();
const realFetch = globalThis.fetch;
const before = process.env.NEXT_PUBLIC_ANALYTICS;
const globals = ["localStorage", "location", "screen"] as const;
const realGlobals = globals.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));

beforeEach(() => {
  sent.length = 0;
  store.clear();
  process.env.NEXT_PUBLIC_ANALYTICS = "umami";
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    location: { hostname: "starbridge.run" },
    screen: { width: 412, height: 915 },
  });
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string).payload.name);
    return new Response();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globals.forEach((k, i) => {
    const d = realGlobals[i];
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  });
  if (before === undefined) delete process.env.NEXT_PUBLIC_ANALYTICS;
  else process.env.NEXT_PUBLIC_ANALYTICS = before;
});

test("a new account's steps are each sent once, in the order they happen", () => {
  firstSignIn(0);
  firstSignIn(1000); // the setup screen shown again
  reach(() => false, 2000);
  reach((s) => s === "first-machine", 3000);
  reach(() => true, 4000);
  reach(() => true, 5000);
  expect(sent).toEqual(["first-sign-in", "first-machine", "first-answer"]);
  expect(store.has(FUNNEL_KEY)).toBe(false);
});

test("steps reached after two days are not sent", () => {
  firstSignIn(0);
  reach(() => true, 2 * 24 * 3600 * 1000);
  expect(sent).toEqual(["first-sign-in"]);
  expect(store.has(FUNNEL_KEY)).toBe(false);
});

test("a self-hosted build sends nothing and keeps no note", () => {
  delete process.env.NEXT_PUBLIC_ANALYTICS;
  firstSignIn(0);
  reach(() => true, 1000);
  expect(sent).toEqual([]);
  expect(store.size).toBe(0);
});
