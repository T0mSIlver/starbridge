import { expect, test } from "bun:test";
import { type Decision, type SealedItem, seal } from "@starbridge/protocol";
import { DEFAULT_LIMITS } from "../src/limits";
import { top } from "../src/top";
import { Watch } from "../src/watch";
import { type Actor, at, makeServer, pair, setupAccount } from "../test-support/app";

let n = 0;
function decision(from: Actor, to: Actor): SealedItem {
  const body: Decision = {
    v: 1,
    id: `d${++n}`,
    to: [to.id],
    createdAt: at,
    question: "Ship it?",
    context: "",
    options: ["yes", "no"],
    recommended: "yes",
    source: { machine: from.id, project: "starbridge", session: "s1" },
  };
  return seal("decision", body, { id: from.id, signKey: from.keys.sign.privateKey }, [to.member]);
}

test("refusals are counted by status, error and route, with the accounts refused most", async () => {
  const s = await makeServer({ limits: { ...DEFAULT_LIMITS, machineItems: [2, 60_000] } });
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  s.deps.watch.flush();
  for (let i = 0; i < 5; i++)
    await s.call("POST", "/v1/items", { token: devbox.token, body: decision(devbox, acct.device) });
  await s.call("GET", "/v1/items/nope", { token: devbox.token });
  await s.call("GET", "/v1/me");

  const line = s.deps.watch.flush();
  expect(line?.startsWith("refusals ")).toBe(true);
  const { counts, accounts } = JSON.parse(line?.slice("refusals ".length) ?? "");
  // 401 and 404 are not refusals of a limit; nothing names the item or the address.
  expect(counts).toEqual({ "429 rate-limited POST /v1/items": 3 });
  expect(accounts).toEqual({ [acct.id]: 3 });
  expect(s.deps.watch.flush()).toBeNull();
});

test("top lists the accounts holding and posting the most, and the last hour's sign-ups", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  for (let i = 0; i < 3; i++)
    expect(
      (
        await s.call("POST", "/v1/items", {
          token: devbox.token,
          body: decision(devbox, acct.device),
        })
      ).status,
    ).toBe(201);

  const t = top(s.deps.db, 5);
  expect(t).toMatchObject({ accounts: 1, signUpsLastHour: 1, machinesPairedLastHour: 1 });
  expect(t.byItems).toEqual([
    expect.objectContaining({
      account: acct.id,
      items: 3,
      postsLastHour: 3,
      machines: 1,
      devices: 1,
    }),
  ]);
  expect(t.byBytes[0]?.bytes).toBeGreaterThan(0);
  // An hour later nothing counts as recent.
  const later = top(s.deps.db, 5, Date.now() + 3_600_001);
  expect(later).toMatchObject({ signUpsLastHour: 0, byPostsLastHour: [] });
});

test("addresses are named only past the threshold or when refused with 429", () => {
  const w = new Watch();
  for (let i = 0; i < 5; i++) w.request("192.0.2.1");
  w.request("192.0.2.2");
  w.refused("429 rate-limited GET /v1/x", undefined, "192.0.2.3", 429);
  w.refused("409 account-full POST /v1/items", "a1", "192.0.2.4", 409);
  w.rotate();
  w.request("192.0.2.2");
  expect(w.addresses(5)).toEqual({
    addressesLastMinute: 2,
    busiestLastMinute: 5,
    busy: { "192.0.2.1": 5 },
    limited: { "192.0.2.3": 1 },
  });
  w.rotate();
  w.rotate();
  expect(w.addresses(1)).toMatchObject({ busy: {}, limited: {} });
});
