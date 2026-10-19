// The pin moves only along one chain, even when the page and the service worker race.
import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import type { Kept } from "./kept";
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

const device = {
  account: "acct",
  id: "d1",
  name: "Chrome",
  boxPk: "b",
  signPk: "s",
  keys: { kind: "raw" },
} as unknown as store.DeviceRecord;

test("update merges into the stored record", async () => {
  await store.put("device", device, "acct");
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

test("a change that throws rejects with its error, writes nothing and leaves the database free (#1495)", async () => {
  await store.put("device", device, "bad");
  await store.put("answers", { d1: { choice: "Yes", answeredAt: "2026-10-04T12:00:00Z" } }, "bad");
  await store.put("pin", { length: 1, head: "h1" }, "bad");
  const boom = new Error("another shape");
  const throws = () => {
    throw boom;
  };
  await expect(store.update("answers", "bad", throws)).rejects.toBe(boom);
  await expect(store.updateWith("answers", "bad", "pin", throws)).rejects.toBe(boom);
  await expect(store.extendPin("bad", { length: 2, head: "h2" }, throws)).rejects.toBe(boom);
  expect(Object.keys((await store.get("answers", "bad")) ?? {})).toEqual(["d1"]);
  expect(await store.get("pin", "bad")).toEqual({ length: 1, head: "h1" });
  // No connection was left open: an upgrade goes through rather than blocking.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("starbridge", 2);
    req.onblocked = () => reject(new Error("blocked"));
    req.onsuccess = () => {
      req.result.close();
      indexedDB.deleteDatabase("starbridge").onsuccess = () => resolve();
    };
  });
});

test("a write that lands after sign-out deleted the account's records brings none back (#1983)", async () => {
  await store.put("device", device, "gone");
  await store.update("heads", "gone", () => ({ m: { length: 1, head: "h1" } }));
  expect(await store.get("heads", "gone")).toBeDefined();
  // Sign-out deletes every record of the account; a read still in flight then writes.
  for (const kind of store.ACCOUNT_KINDS) await store.del(kind, "gone");
  await store.update("heads", "gone", () => ({ m: { length: 2, head: "h2" } }));
  await store.updateWith("heads", "gone", "forgotten", () => ({ m: { length: 2, head: "h2" } }));
  await store.update("kept", "gone", () => ({ device: "d1", cursor: "9", items: [] }));
  await store.update("snoozes", "gone", () => ({ d_1: "2026-10-18T10:00:00Z" }));
  await store.put("recoverySeen", 3, "gone");
  for (const kind of store.ACCOUNT_KINDS) expect(await store.get(kind, "gone")).toBeUndefined();
});

test("the kept list stores its images apart, and they go with their decision (#2097)", async () => {
  await store.put("device", device, "kb");
  const d = (id: string, blobs?: string[]) =>
    ({
      item: { kind: "decision", id, ...(blobs ? { blobs } : {}) },
      cursor: id,
      receivedAt: "2026-10-19T12:00:00Z",
    }) as unknown as Kept["items"][number];
  await store.update("kept", "kb", () => ({
    device: "d1",
    cursor: "2",
    items: [d("a", ["A"]), d("b", ["B"])],
  }));
  const kept = await store.get("kept", "kb");
  expect(kept?.items.map((k) => k.item.blobs)).toEqual([undefined, undefined]);
  expect([...(await store.keptBlobs("kb", ["a", "b", "c"]))]).toEqual([
    ["a", ["A"]],
    ["b", ["B"]],
  ]);
  // Listed again without its images (answered), a decision keeps them; one dropped loses them.
  await store.update("kept", "kb", (had) => ({
    device: "d1",
    cursor: "3",
    items: [...(had?.items ?? []).filter((k) => k.item.id !== "b"), d("c")],
  }));
  expect([...(await store.keptBlobs("kb", ["a", "b"]))]).toEqual([["a", ["A"]]]);
  // Images fetched on show stay only for a decision the device still keeps.
  await store.keepBlobs("kb", "d1", "c", ["C"]);
  await store.keepBlobs("kb", "d1", "b", ["B"]);
  await store.keepBlobs("kb", "d2", "a", ["X"]);
  expect([...(await store.keptBlobs("kb", ["a", "b", "c"]))]).toEqual([
    ["a", ["A"]],
    ["c", ["C"]],
  ]);
  await store.del("kept", "kb");
  expect((await store.keptBlobs("kb", ["a", "c"])).size).toBe(0);
});

test("images an older page's sign-out left behind go at the next load (#2097)", async () => {
  await store.put("device", device, "ks");
  const d = (id: string) =>
    ({
      item: { kind: "decision", id, blobs: [id] },
      cursor: id,
      receivedAt: "",
    }) as unknown as Kept["items"][number];
  for (const account of ["ks", "gone"]) {
    await store.put("device", { ...device, account }, account);
    await store.update("kept", account, () => ({ device: "d1", cursor: "1", items: [d("a")] }));
  }
  // As the page before #2097 signed out: the list goes, its images stay.
  await store.del("device", "gone");
  const raw = await new Promise<IDBDatabase>((done) => {
    const q = indexedDB.open("starbridge");
    q.onsuccess = () => done(q.result);
  });
  await new Promise((done) => {
    const tx = raw.transaction("kv", "readwrite");
    tx.objectStore("kv").delete("kept:gone");
    tx.oncomplete = done;
  });
  raw.close();
  expect((await store.keptBlobs("gone", ["a"])).size).toBe(1);
  await store.sweepBlobs();
  expect((await store.keptBlobs("gone", ["a"])).size).toBe(0);
  expect((await store.keptBlobs("ks", ["a"])).size).toBe(1);
});
