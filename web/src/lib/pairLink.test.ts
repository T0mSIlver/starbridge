// A pairing link's code outlives the GitHub sign-in in the tab's storage, and only there.
import { expect, test } from "bun:test";
import { otherServer } from "./otherServer";
import { hasPairCode, holdPairCode, takePairCode } from "./pairLink";

function tab(address: string) {
  const url = new URL(address, "https://starbridge.test");
  const items = new Map<string, string>();
  Object.assign(globalThis, {
    location: url,
    history: {
      replaceState: (_: unknown, __: string, path: string) => (url.href = new URL(path, url).href),
    },
  });
  return {
    url,
    store: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    },
  };
}

test("a /pair link's code leaves the address bar and is taken once", () => {
  const { url, store } = tab("/pair#ABCD2345-EFGH-JKMN-PQRS-TVWX");
  holdPairCode(store, 0);
  expect(url.href).toBe("https://starbridge.test/pair");
  // Back from sign-in on `/`: the code is still there for the Devices page.
  url.href = "https://starbridge.test/";
  expect(hasPairCode(store, 60_000)).toBe(true);
  expect(takePairCode(store, 60_000)).toBe("ABCD2345-EFGH-JKMN-PQRS-TVWX");
  expect(takePairCode(store, 60_000)).toBeUndefined();
});

test("a held code lapses with the pairing code, after 10 minutes", () => {
  const { store } = tab("/pair#ABCD2345-EFGH-JKMN-PQRS-TVWX");
  holdPairCode(store, 0);
  expect(hasPairCode(store, 10 * 60_000)).toBe(false);
  expect(takePairCode(store, 0)).toBeUndefined();
});

test("other pages' fragments are left alone", () => {
  const { url, store } = tab("/devices#top");
  holdPairCode(store, 0);
  expect(url.hash).toBe("#top");
  expect(hasPairCode(store, 0)).toBe(false);
});

test("a link from another server names it; a bare code or this server's link does not (#671)", () => {
  expect(otherServer("https://starbridge.run/pair#ABCD", "sb.example.com")).toBe("starbridge.run");
  expect(otherServer("https://sb.example.com/pair#ABCD", "sb.example.com")).toBeUndefined();
  expect(otherServer("ABCD-EFGH", "sb.example.com")).toBeUndefined();
});
