import { expect, test } from "bun:test";
import { judge, type Probe, type Reading, type State } from "./watch";

const NOW = Date.parse("2026-10-08T15:00:00Z");

function reading(over: Partial<Reading> = {}): Reading {
  return {
    at: "2026-10-08T15:00:00Z",
    load: [0.3, 0.3, 0.3],
    steal: 0,
    memTotalMB: 3814,
    memUsedMB: 1500,
    diskFree: 20 * 1024 ** 3,
    containers: { "starbridge-server-1": { restarts: 0, oomKilled: false, running: true } },
    kernelOom: 0,
    logs: {
      refusals: { counts: {}, accounts: {} },
      stackTraces: 0,
      sqlite: 0,
      diskFull: 0,
      pushQueueFull: 0,
      pushFailed: 0,
      githubSignIn: 0,
      caddyErrors: 0,
    },
    dbBytes: 10 * 1024 ** 2,
    connections: { total: 10, addresses: 5, busiest: 3, named: {}, toServer: 8 },
    addresses: { addressesLastMinute: 5, busiestLastMinute: 40, busy: {}, limited: {} },
    top: null,
    ...over,
  };
}

const ok: Probe[] = [{ url: "https://starbridge.run/healthz", status: 200, ms: 80 }];
const fresh = (): State => ({ history: [], alerted: {}, restarts: {} });
const keys = (r: Reading, probes = ok, state = fresh()) =>
  judge(r, probes, state, NOW).map((a) => a.key);

test("a quiet box raises nothing", () => {
  expect(keys(reading())).toEqual([]);
});

test("sustained thresholds need every reading over the whole span", () => {
  const at = (min: number, memUsedMB: number) => ({
    at: NOW - min * 60_000,
    memUsedMB,
    slowestMs: 0,
    dbBytes: 0,
  });
  const state = (h: ReturnType<typeof at>[]) => ({ ...fresh(), history: h });
  const high = reading({ memUsedMB: 3200 });
  expect(keys(high, ok, state([at(10, 3100), at(5, 3200), at(0, 3200)]))).toEqual(["memory"]);
  // Readings every 3 minutes: the one taken before the span began covers its start.
  const every3 = [12, 9, 6, 3, 0].map((m) => at(m, 3200));
  expect(keys(high, ok, state(every3))).toEqual(["memory"]);
  // One dip, or too short a span, is not 10 minutes over.
  expect(keys(high, ok, state([at(10, 2900), at(5, 3200), at(0, 3200)]))).toEqual([]);
  expect(keys(high, ok, state([at(5, 3200), at(0, 3200)]))).toEqual([]);
});

test("refusals and addresses come with the command that answers them", () => {
  const r = reading({
    logs: {
      ...reading().logs,
      refusals: {
        counts: { "429 rate-limited POST /v1/items": 400, "409 account-full POST /v1/items": 25 },
        accounts: { aBad: 420 },
      },
    },
    connections: {
      total: 400,
      addresses: 3,
      busiest: 250,
      named: { "198.51.100.7": 250 },
      toServer: 8,
    },
    addresses: {
      addressesLastMinute: 3,
      busiestLastMinute: 2950,
      busy: { "2001:db8::/64": 2950, "2001:db8:1::/64": 2000 },
      limited: {},
    },
  });
  const alerts = judge(r, ok, fresh(), NOW);
  // An address under Caddy's cap is not named, and no key holds an address: keys are saved.
  expect(alerts.map((a) => [a.key, a.response])).toEqual([
    ["429", "deploy/switch.sh suspend aBad"],
    ["account-full", "deploy/switch.sh suspend aBad"],
    ["addresses:2", "deploy/switch.sh block 198.51.100.7"],
    ["addresses:2", "deploy/switch.sh block 2001:db8::/64"],
  ]);
});

test("a failed page, a restart and fast database growth alert", () => {
  const state: State = {
    ...fresh(),
    restarts: { "starbridge-server-1": 0 },
    history: [{ at: NOW - 40 * 60_000, memUsedMB: 0, slowestMs: 0, dbBytes: 10 * 1024 ** 2 }],
  };
  const r = reading({
    containers: { "starbridge-server-1": { restarts: 1, oomKilled: false, running: true } },
    dbBytes: 110 * 1024 ** 2,
  });
  const down: Probe[] = [{ url: "https://starbridge.run/healthz/disk", status: 503, ms: 50 }];
  expect(keys(r, down, state)).toEqual([
    "restart:starbridge-server-1",
    "health:https://starbridge.run/healthz/disk",
    "db-growth",
  ]);
});
