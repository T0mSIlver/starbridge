// IndexedDB, shared by the page and the service worker. One object store of records keyed by
// account, so a browser signed in to a second account keeps both devices apart.
import type { Heads, Pin } from "@starbridge/protocol";
import type { StoredKeys } from "./crypto/keys";
import type { Kept } from "./kept";
import type { PromptReply, Reply } from "./types";

/** This browser's member of an account's directory. */
export interface DeviceRecord {
  account: string;
  id: string;
  name: string;
  /** base64url, as in the directory. */
  boxPk: string;
  signPk: string;
  keys: StoredKeys;
  /** A first device whose genesis may have reached the server: an empty directory is forged. */
  posted?: true;
}

/** What this browser answered, since answers are sealed to the machine and unreadable after. */
export type SentAnswers = Record<string, Reply & { answeredAt: string }>;

type Records = {
  device: DeviceRecord;
  /** Keys a join generated, until a device approves it: an active device's keys stay put (#274). */
  pending: DeviceRecord;
  pin: Pin;
  answers: SentAnswers;
  /** What this browser answered to permission prompts, by permission id. */
  promptAnswers: Record<string, PromptReply & { answeredAt: string }>;
  /** The last replacement of the recovery key whose notice this browser dismissed (its seq). */
  recoverySeen: number;
  /** The last account signed in here: the service worker's default. */
  current: string;
  /** Keys written and read back once by `keeps`. */
  probe: StoredKeys;
  /** The longest directory head each machine signed into its items (#362). */
  heads: Heads;
  /**
   * Members whose directory heads the owner told this browser to forget (#813): heads they
   * signed are never kept again, even from a read that started before.
   */
  forgotten: string[];
  /**
   * The latest snooze this browser knows of each decision (#571): a return pushed for an older
   * one shows nothing. Its signed time by decision id; since #2103, under `until:<id>`, that
   * snooze's "<at> <until>", which breaks a tie. Pages from before read and write the times only.
   */
  snoozes: Record<string, string>;
  /**
   * What the service worker's pushes already did to each question (#2151), so a late, repeated
   * or reordered push rings nothing after a restart: `closed:<id>` once an answered or settled
   * push closed it, `rang:<id>` once it rang, `waiting:<id>` the last flip applied ("<at>
   * <state>"), `back:<id>` the snooze whose return rang (its at). Oldest entries go first.
   */
  pushed: Record<string, string>;
  /** The inbox's items as listed, still sealed, and the cursor after them (#1380). */
  kept: Kept;
};

/** Every record kind kept per account, so signing out can remove them all. */
const PER_ACCOUNT: Record<Exclude<keyof Records, "current">, true> = {
  device: true,
  pending: true,
  pin: true,
  answers: true,
  promptAnswers: true,
  recoverySeen: true,
  probe: true,
  heads: true,
  forgotten: true,
  snoozes: true,
  pushed: true,
  kept: true,
};
export const ACCOUNT_KINDS = Object.keys(PER_ACCOUNT) as Exclude<keyof Records, "current">[];

/** The database's version is the records' format (#473): a newer one fails to open here. */
const DB = "starbridge";
const STORE = "kv";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

const key = (kind: keyof Records, account: string) =>
  kind === "current" ? "current" : `${kind}:${account}`;

export async function get<K extends keyof Records>(
  kind: K,
  account = "",
): Promise<Records[K] | undefined> {
  return (await run("readonly", (s) => s.get(key(kind, account)))) as Records[K] | undefined;
}

/**
 * Kinds that live only beside the account's device or its pending join. Sign-out deletes them
 * all; a write from a read still in flight then finds neither and is dropped, so it cannot bring
 * them back (#1983).
 */
const SIGNED_IN = new Set<keyof Records>([
  "answers",
  "promptAnswers",
  "recoverySeen",
  "heads",
  "forgotten",
  "snoozes",
  "pushed",
  "kept",
]);

/** Runs `then` in the transaction unless `kind` is one that needs the account signed in here. */
function signedIn(
  s: IDBObjectStore,
  step: (f: () => void) => () => void,
  kind: keyof Records,
  account: string,
  then: () => void,
) {
  if (!SIGNED_IN.has(kind)) return then();
  const device = s.count(key("device", account));
  device.onsuccess = step(() => {
    if (device.result > 0) return then();
    const pending = s.count(key("pending", account));
    pending.onsuccess = step(() => {
      if (pending.result > 0) then();
    });
  });
}

export async function put<K extends keyof Records>(
  kind: K,
  value: Records[K],
  account = "",
): Promise<void> {
  await transact((s, step) =>
    signedIn(s, step, kind, account, () => s.put(value, key(kind, account))),
  );
}

export async function del(kind: keyof Records, account = ""): Promise<void> {
  await transact((s) => {
    s.delete(key(kind, account));
    // The kept list's images go with it.
    if (kind === "kept") s.delete(blobRange(account));
  });
}

/**
 * The images of a kept decision, apart from the kept list (#2097): a load reads only those it
 * shows, and a write of the list no longer rewrites every image it holds. `update("kept")` moves
 * them here, so the list it stores carries none.
 */
const blobKey = (account: string, id: string) => `blobs:${account}:${id}`;
const blobRange = (account: string) =>
  IDBKeyRange.bound(`blobs:${account}:`, `blobs:${account}:\uffff`);

/** Writes `next` as the kept list: its blobs to their own records, and drops those it lost. */
function putKept(s: IDBObjectStore, account: string, old: Kept | undefined, next: Kept) {
  const held = new Set<string>();
  const items = next.items.map((k) => {
    if (k.item.kind !== "decision") return k;
    held.add(k.item.id);
    if (!k.item.blobs) return k;
    s.put(k.item.blobs, blobKey(account, k.item.id));
    const { blobs: _, ...item } = k.item;
    return { ...k, item };
  });
  for (const k of old?.items ?? [])
    if (k.item.kind === "decision" && !held.has(k.item.id)) s.delete(blobKey(account, k.item.id));
  s.put({ ...next, items }, key("kept", account));
}

/**
 * Deletes the image records of every account this browser no longer keeps a list for: a page
 * from before #2097, still open in another tab, signs out deleting only the list.
 */
export async function sweepBlobs(): Promise<void> {
  await transact((s, step) => {
    const req = s.getAllKeys(IDBKeyRange.bound("blobs:", "blobs:\uffff"));
    req.onsuccess = step(() => {
      const accounts = new Set(
        (req.result as string[]).map((k) => k.slice("blobs:".length, k.indexOf(":", 6))),
      );
      for (const account of accounts) {
        const kept = s.count(key("kept", account));
        kept.onsuccess = step(() => {
          if (kept.result === 0) s.delete(blobRange(account));
        });
      }
    });
  });
}

/** The kept images of each of `ids` that has them. */
export async function keptBlobs(account: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readonly");
      const st = tx.objectStore(STORE);
      for (const id of ids) {
        const req = st.get(blobKey(account, id));
        req.onsuccess = () => {
          if (req.result) out.set(id, req.result as string[]);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
  return out;
}

/** Keeps a decision's images fetched on show, while device `device` still keeps the decision. */
export async function keepBlobs(
  account: string,
  device: string,
  id: string,
  blobs: string[],
): Promise<void> {
  await transact((s, step) =>
    signedIn(s, step, "kept", account, () => {
      const req = s.get(key("kept", account));
      req.onsuccess = step(() => {
        const kept = req.result as Kept | undefined;
        if (
          kept?.device === device &&
          kept.items.some((k) => k.item.kind === "decision" && k.item.id === id)
        )
          s.put(blobs, blobKey(account, id));
      });
    }),
  );
}

/** Thrown when another context pinned a longer chain meanwhile: read the directory again. */
export class StalePin extends Error {
  constructor() {
    super("the pin moved on while this chain was verified");
  }
}

/**
 * Runs `body` in one readwrite transaction and settles when it commits or aborts. A request
 * handler wrapped in `step` that throws aborts the transaction, which then rejects with what it
 * threw: an abort fires no `error` event, so without `onabort` the write would never settle and
 * its open connection would block a later upgrade (#1495).
 */
async function transact(
  body: (s: IDBObjectStore, step: (f: () => void) => () => void) => void,
): Promise<void> {
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      let thrown: { e: unknown } | undefined;
      const step = (f: () => void) => () => {
        try {
          f();
        } catch (e) {
          thrown = { e };
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(thrown ? thrown.e : (tx.error ?? new Error("the transaction was aborted")));
      step(() => body(tx.objectStore(STORE), step))();
    });
  } finally {
    d.close();
  }
}

/**
 * Moves the pin to a verified chain, inside one transaction so the page and the service worker
 * cannot pass each other: the chain must extend the stored pin (`headAt(length)` gives its hash
 * after `length` entries), and a chain shorter than the stored pin is refused as stale, since
 * the longer one may hold a revocation.
 */
export async function extendPin(
  account: string,
  pin: Pin,
  headAt: (length: number) => string | undefined,
): Promise<void> {
  let failure: Error | undefined;
  await transact((s, step) => {
    const req = s.get(key("pin", account));
    req.onsuccess = step(() => {
      const old = req.result as Pin | undefined;
      if (old && pin.length < old.length) failure = new StalePin();
      else if (old && headAt(old.length) !== old.head)
        failure = new Error("rollback: the chain does not extend the pinned one");
      else if (!old || pin.length > old.length) s.put(pin, key("pin", account));
    });
  });
  if (failure) throw failure;
}

/** Read-modify-write of one record in a single transaction. */
export async function update<K extends keyof Records>(
  kind: K,
  account: string,
  change: (old: Records[K] | undefined) => Records[K],
): Promise<void> {
  await transact((s, step) =>
    signedIn(s, step, kind, account, () => {
      const req = s.get(key(kind, account));
      req.onsuccess = step(() => {
        const old = req.result as Records[K] | undefined;
        const next = change(old);
        if (kind === "kept") putKept(s, account, old as Kept | undefined, next as Kept);
        else s.put(next, key(kind, account));
      });
    }),
  );
}

/** Read-modify-write of one record, reading another in the same transaction. */
export async function updateWith<K extends keyof Records, R extends keyof Records>(
  kind: K,
  account: string,
  read: R,
  change: (old: Records[K] | undefined, other: Records[R] | undefined) => Records[K],
): Promise<void> {
  await transact((s, step) =>
    signedIn(s, step, kind, account, () => {
      const other = s.get(key(read, account));
      other.onsuccess = step(() => {
        const req = s.get(key(kind, account));
        req.onsuccess = step(() =>
          s.put(
            change(req.result as Records[K] | undefined, other.result as Records[R] | undefined),
            key(kind, account),
          ),
        );
      });
    }),
  );
}

/**
 * Whether IndexedDB gives these keys back. WebKit stores an X25519 CryptoKey but reads the record
 * back as null (Playwright's WebKit 26.6), which would lose the device on the next load.
 */
export async function keeps(keys: StoredKeys): Promise<boolean> {
  // A key of its own, so a probe in another tab cannot delete this one midway.
  const slot = crypto.randomUUID();
  try {
    await put("probe", keys, slot);
    const back = await get("probe", slot);
    return (
      back?.kind === "raw" || (back?.box instanceof CryptoKey && back.sign instanceof CryptoKey)
    );
  } catch {
    return false;
  } finally {
    await del("probe", slot).catch(() => {});
  }
}
