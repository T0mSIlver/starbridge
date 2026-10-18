// PROTOCOL.md's numbers against DEFAULT_LIMITS (#1905): a limit changed in one and not the other
// fails here, and so does a new limit that PROTOCOL.md does not state.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIMITS, type Limits } from "../src/limits";

const L = DEFAULT_LIMITS;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** PROTOCOL.md as table rows and paragraphs, each on one line with its spaces collapsed. */
const blocks = readFileSync(join(import.meta.dir, "../../PROTOCOL.md"), "utf8")
  .split(/\n\s*\n|\n(?=\|)|(?<=\|)\n/)
  .map((b) => b.replace(/\s+/g, " ").trim());

/** Whether `block` holds `phrase` with no digit against either end: "50 a minute" is not in "150 a minute". */
function states(block: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![0-9])${escaped}(?![0-9])`).test(block);
}

/** `n` bytes as PROTOCOL.md writes them: 2 GB, 256 MB, 8 KB or 512 bytes. */
function bytes(n: number): string {
  for (const [unit, size] of [
    ["GB", 1024 ** 3],
    ["MB", 1024 ** 2],
    ["KB", 1024],
  ] as const)
    if (n >= size && n % size === 0) return `${n / size} ${unit}`;
  return `${n} bytes`;
}

/** A rate window's period: "a minute" or "an hour". */
function per(ms: number): string {
  if (ms === MINUTE) return "a minute";
  if (ms === HOUR) return "an hour";
  throw new Error(`no wording for a window of ${ms} ms`);
}

/** A retention in days: "a day", or "7 days". */
function days(ms: number): string {
  if (ms % DAY !== 0) throw new Error(`not whole days: ${ms} ms`);
  return ms === DAY ? "a day" : `${ms / DAY} days`;
}

/**
 * Where PROTOCOL.md states each limit: one block holds every string of its entry. The first is
 * what names the block, the others the number in its wording.
 */
const STATED: Record<keyof Limits, string[]> = {
  items: [
    "| `POST /items` |",
    `and ${L.items[0]} per account`,
    `${L.machineItems[0]} ${per(L.items[1])}`,
  ],
  machineItems: ["| `POST /items` |", `${L.machineItems[0]} ${per(L.machineItems[1])} per machine`],
  deviceItems: ["| `POST /items` |", `${L.deviceItems[0]} ${per(L.deviceItems[1])} per device`],
  itemReads: [
    "| `GET /items`, `GET /items/:id`, `GET /answers`, `GET /quota` |",
    `${bytes(L.itemReads[0])} of boxes and blobs ${per(L.itemReads[1])}`,
  ],
  decisions: ["| Stored decisions, open or answered |", `${L.decisions} per account`],
  storedBytes: ["| Stored items |", `${bytes(L.storedBytes)} per account`],
  answerReserve: ["| Stored items |", `all but the last ${bytes(L.answerReserve)}`],
  serverBytes: ["| Stored items |", `${bytes(L.serverBytes)} on the whole server`],
  itemBytes: ["| Stored items |", `${bytes(L.itemBytes)} per machine-signed item`],
  quotaBytes: ["| Stored items |", `${bytes(L.quotaBytes)} per quota snapshot`],
  postedBytes: [
    "| `POST /items` |",
    `${bytes(L.postedBytes[0])} of machines' boxes ${per(L.postedBytes[1])}`,
  ],
  answerBytes: ["| Stored items |", `${bytes(L.answerBytes)} per answer or permission answer`],
  permissions: ["| Stored permission prompts, open or settled |", `${L.permissions} per account`],
  rowBytes: ["| Stored items |", `plus ${bytes(L.rowBytes)} for the item and for each box`],
  runs: ["| Stored runs |", `${L.runs} per account`],
  runBytes: ["| Stored items |", `${bytes(L.runBytes)} per run update for each device`],
  runRetention: ["An hourly sweep drops", `runs ${days(L.runRetention)} after their last update`],
  answeredRetention: ["An hourly sweep drops", `${days(L.answeredRetention)} after the answer`],
  staleRetention: [
    "An hourly sweep drops",
    `quota snapshots ${days(L.staleRetention)} after they arrived`,
  ],
  floodUnanswered: ["| Unanswered decisions kept 30 days |", `${L.floodUnanswered} per account`],
  floodRetention: [
    "| Unanswered decisions kept 30 days |",
    `dropped ${days(L.floodRetention)} after they arrived`,
  ],
  directoryAppends: [
    "| `POST /directory` |",
    `${L.directoryAppends[0]} ${per(L.directoryAppends[1])} per account`,
  ],
  directoryEntries: ["| Directory entries |", `from entry ${L.directoryEntries} on`],
  recoveryAdds: ["| Directory entries |", `may add ${L.recoveryAdds} more devices`],
  recoveryProposals: [
    "| Directory entries |",
    `may propose ${L.recoveryProposals} more recovery keys`,
  ],
  entryBytes: ["| Directory entries |", `${bytes(L.entryBytes)} per entry`],
  sessions: ["| Sessions |", `${L.sessions} per account`],
  githubCallbacks: [
    "| `GET /auth/github/callback`,",
    `${L.githubCallbacks[0]} ${per(L.githubCallbacks[1])} per address`,
  ],
  appleSignIns: ["| Apple sign-ins:", `${L.appleSignIns[0]} ${per(L.appleSignIns[1])} per address`],
  appSessions: [
    "| `POST /auth/app/session`, either",
    `${L.appSessions[0]} ${per(L.appSessions[1])} per address`,
  ],
  signUps: ["| New accounts |", `${L.signUps[0]} ${per(L.signUps[1])} per address`],
  accountDeletes: [
    "| `DELETE /account` |",
    `${L.accountDeletes[0]} ${per(L.accountDeletes[1])} per address`,
  ],
  ownerSignIns: [
    "| `POST /auth/owner` |",
    `${L.ownerSignIns[0]} ${per(L.ownerSignIns[1])} per address`,
  ],
  challenges: [
    "| `GET /auth/challenge` |",
    `${L.challenges[0]} ${per(L.challenges[1])} per account`,
  ],
  pairingPosts: [
    "| `POST /pairings` | 30",
    `${L.pairingPosts[0]} ${per(L.pairingPosts[1])} per address`,
  ],
  pairingReads: [
    "| `GET /pairings/:rendezvous` |",
    `${L.pairingReads[0]} ${per(L.pairingReads[1])} per account`,
  ],
  pairingResults: [
    "| `GET /pairings/:rendezvous/result` |",
    `${L.pairingResults[0]} ${per(L.pairingResults[1])} per address`,
  ],
  pairingResultWaits: [
    "| `GET /pairings/:rendezvous/result` waiting |",
    `${L.pairingResultWaits} on the server`,
  ],
  pairingResultWaitsPerClient: [
    "| `GET /pairings/:rendezvous/result` waiting |",
    `and ${L.pairingResultWaitsPerClient} per address (IPv6 per /48)`,
  ],
  pendingPairings: [
    "| `POST /pairings` | new member |",
    `the server holds ${L.pendingPairings} pairings`,
  ],
  pairingsPerClient: [
    "| `POST /pairings` | 30",
    `${L.pairingsPerClient} unapproved pairings per address`,
  ],
  relaySends: [
    "| `POST /relay` | another server |",
    `the server has ${L.relaySends} relayed Web Pushes in flight`,
  ],
  relaySendsPerClient: [
    "| `POST /relay` | another server |",
    `the address ${L.relaySendsPerClient},`,
  ],
  relaySendsPerNetwork: [
    "| `POST /relay` | another server |",
    `its IPv6 /48 ${L.relaySendsPerNetwork},`,
  ],
  relaySendsPerHost: [
    "| `POST /relay` | another server |",
    `the push service's host ${L.relaySendsPerHost} |`,
  ],
  // Pushes this server sends; no request to it can meet this cap.
  pushesPerHost: [],
  pushHosts: [
    "| `POST /push/subscriptions` | device |",
    `${L.pushHosts} Web Push and UnifiedPush hosts per account`,
  ],
  pushSubscribes: [
    "| `POST /push/subscriptions` | 30",
    `${L.pushSubscribes[0]} ${per(L.pushSubscribes[1])} per account`,
  ],
  relayPosts: [
    "| `POST /relay`, on a relay server |",
    `${L.relayPosts[0]} ${per(L.relayPosts[1])} per address`,
  ],
  presenceBeats: [
    "| `PUT /presence` |",
    `${L.presenceBeats[0]} ${per(L.presenceBeats[1])} per device or machine`,
  ],
  settingsWrites: [
    "| `PUT /settings` |",
    `${L.settingsWrites[0]} ${per(L.settingsWrites[1])} per account`,
  ],
  notificationWrites: [
    "| `PUT /notifications` |",
    `${L.notificationWrites[0]} ${per(L.notificationWrites[1])} per device`,
  ],
  releaseWrites: [
    "| `PUT /release` |",
    `${L.releaseWrites[0]} ${per(L.releaseWrites[1])} per machine`,
  ],
  quotaAsks: ["| `POST /quota/ask` |", `${L.quotaAsks[0]} ${per(L.quotaAsks[1])} per account`],
  answerWaits: ["| `GET /answers` waiting |", `${L.answerWaits} per machine`],
  pairingWaits: [
    "| `GET /pairings/:rendezvous/result` and `GET /pairings/:rendezvous?wait=` waiting |",
    `${L.pairingWaits} per pairing`,
  ],
  joins: ["| `POST /joins` |", `${L.joins[0]} ${per(L.joins[1])} per account`],
  joinListWaits: ["| `GET /joins` waiting |", `${L.joinListWaits} per account`],
  joinWaits: ["| `GET /joins` waiting |", `${L.joinWaits} per join`],
};

test("every limit is stated in PROTOCOL.md", () => {
  // Record<keyof Limits> makes a new limit fail to compile until it has an entry here.
  expect(Object.keys(STATED).sort()).toEqual(Object.keys(L).sort());
});

for (const [key, [where, ...says]] of Object.entries(STATED)) {
  if (!where) continue;
  test(`PROTOCOL.md states ${key}`, () => {
    const found = blocks.filter((b) => b.includes(where));
    expect(found.length, `no block of PROTOCOL.md holds ${where}`).toBeGreaterThan(0);
    expect(
      found.some((b) => says.every((s) => states(b, s))),
      `PROTOCOL.md, ${where}: says no ${JSON.stringify(says)} (limits.ts has ${JSON.stringify(L[key as keyof Limits])})`,
    ).toBe(true);
  });
}
