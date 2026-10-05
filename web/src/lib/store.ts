// IndexedDB, shared by the page and the service worker. One object store of records keyed by
// account, so a browser signed in to a second account keeps both devices apart.
import type { Pin } from "@starbridge/protocol";
import type { StoredKeys } from "./crypto/keys";
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
}

/** What this browser answered, since answers are sealed to the machine and unreadable after. */
export type SentAnswers = Record<string, Reply & { answeredAt: string }>;

type Records = {
  device: DeviceRecord;
  pin: Pin;
  answers: SentAnswers;
  /** What this browser answered to permission prompts, by permission id. */
  promptAnswers: Record<string, PromptReply & { answeredAt: string }>;
  /** The last account signed in here: the service worker's default. */
  current: string;
  /** Quota alerts already notified, so a snapshot every few minutes does not repeat them. */
  alerts: string[];
  /** Keys written and read back once by `keeps`. */
  probe: StoredKeys;
};

const DB = "starbridge";
const STORE = "kv";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
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

export async function put<K extends keyof Records>(
  kind: K,
  value: Records[K],
  account = "",
): Promise<void> {
  await run("readwrite", (s) => s.put(value, key(kind, account)));
}

export async function del(kind: keyof Records, account = ""): Promise<void> {
  await run("readwrite", (s) => s.delete(key(kind, account)));
}

/** Thrown when another context pinned a longer chain meanwhile: read the directory again. */
export class StalePin extends Error {
  constructor() {
    super("the pin moved on while this chain was verified");
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
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      const req = s.get(key("pin", account));
      let failure: Error | undefined;
      req.onsuccess = () => {
        const old = req.result as Pin | undefined;
        if (old && pin.length < old.length) failure = new StalePin();
        else if (old && headAt(old.length) !== old.head)
          failure = new Error("rollback: the chain does not extend the pinned one");
        else if (!old || pin.length > old.length) s.put(pin, key("pin", account));
      };
      tx.oncomplete = () => (failure ? reject(failure) : resolve());
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

/** Read-modify-write of one record in a single transaction. */
export async function update<K extends keyof Records>(
  kind: K,
  account: string,
  change: (old: Records[K] | undefined) => Records[K],
): Promise<void> {
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      const req = s.get(key(kind, account));
      req.onsuccess = () => s.put(change(req.result as Records[K] | undefined), key(kind, account));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
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
