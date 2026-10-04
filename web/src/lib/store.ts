// IndexedDB, shared by the page and the service worker. One object store of records keyed by
// account, so a browser signed in to a second account keeps both devices apart.
import type { Pin } from "@starbridge/protocol";
import type { StoredKeys } from "./crypto/keys";
import type { Reply } from "./types";

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
  /** The last account signed in here: the service worker's default. */
  current: string;
  /** Quota alerts already notified, so a snapshot every few minutes does not repeat them. */
  alerts: string[];
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

/** Keeps the longer pin: the page and the service worker both extend it. */
export async function extendPin(account: string, pin: Pin): Promise<void> {
  const d = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      const s = tx.objectStore(STORE);
      const req = s.get(key("pin", account));
      req.onsuccess = () => {
        const old = req.result as Pin | undefined;
        if (!old || pin.length > old.length) s.put(pin, key("pin", account));
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}
