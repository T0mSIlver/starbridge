// The pin moves only along one chain, even when the page and the service worker race.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import * as store from "./store";

const chain = ["h1", "h2", "h3", "h4"];
const headAt = (heads: string[]) => (n: number) => heads[n - 1];

test("the pin extends along its chain and refuses stale or forked ones", async () => {
  await store.extendPin("acct", { length: 2, head: "h2" }, headAt(chain));
  await store.extendPin("acct", { length: 3, head: "h3" }, headAt(chain));
  expect(await store.get("pin", "acct")).toEqual({ length: 3, head: "h3" });

  // A context still holding the 2-entry chain loses to the 3-entry pin.
  await expect(
    store.extendPin("acct", { length: 2, head: "h2" }, headAt(chain)),
  ).rejects.toBeInstanceOf(store.StalePin);
  // A longer chain whose third entry differs is a fork.
  await expect(
    store.extendPin("acct", { length: 4, head: "x4" }, headAt(["h1", "h2", "x3", "x4"])),
  ).rejects.toThrow("rollback");
  expect(await store.get("pin", "acct")).toEqual({ length: 3, head: "h3" });
});

test("update merges into the stored record", async () => {
  await Promise.all(
    ["d1", "d2", "d3"].map((id) =>
      store.update("answers", "acct", (old) => ({
        ...old,
        [id]: { choice: "Yes", answeredAt: "2026-10-04T12:00:00Z" },
      })),
    ),
  );
  expect(Object.keys((await store.get("answers", "acct")) ?? {}).sort()).toEqual([
    "d1",
    "d2",
    "d3",
  ]);
});
