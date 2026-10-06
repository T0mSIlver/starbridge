import { expect, test } from "bun:test";
import { seal } from "@starbridge/protocol";
import { at, makeServer, pair, setupAccount } from "../test-support/app";

test("over real HTTP, an answer long-poll outlives the idle timeout and completes on answer", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  const server = Bun.serve({
    port: 0,
    idleTimeout: 1,
    fetch: (req, srv) => s.app.fetch(req, { server: srv }),
  });
  try {
    const d = seal(
      "decision",
      {
        v: 1,
        id: "d1",
        to: ["phone"],
        createdAt: at,
        question: "Ship it?",
        context: "",
        options: [],
        default: { action: "ship" },
        source: { machine: "devbox", project: "p", session: "s" },
      },
      { id: "devbox", signKey: devbox.keys.sign.privateKey },
      [acct.device.member],
    );
    await s.call("POST", "/v1/items", { token: devbox.token, body: d });

    const started = Date.now();
    const polling = fetch(`http://localhost:${server.port}/v1/answers?wait=10`, {
      headers: { authorization: `Bearer ${devbox.token}` },
    });
    await Bun.sleep(2000);
    const a = seal(
      "answer",
      { v: 1, id: "a1", decisionId: "d1", to: "devbox", answeredAt: at, text: "go" },
      { id: "phone", signKey: acct.device.keys.sign.privateKey },
      [devbox.member],
    );
    await s.call("POST", "/v1/items", { token: acct.device.token, body: a });
    const res = await polling;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThan(1900);
  } finally {
    server.stop(true);
  }
});

test("on shutdown, an open long-poll answers at once with nothing, as if its wait passed", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  const server = Bun.serve({ port: 0, fetch: (req, srv) => s.app.fetch(req, { server: srv }) });
  try {
    const polling = fetch(`http://localhost:${server.port}/v1/answers?wait=60`, {
      headers: { authorization: `Bearer ${devbox.token}` },
    });
    while (s.deps.answers.count(`${acct.id}/devbox`) === 0) await Bun.sleep(10);
    s.deps.answers.close();
    const res = await polling;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
    expect(await s.deps.answers.wait("any", 60)).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("on shutdown, a quota ask still waiting for a machine answers at once", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  const quota = seal(
    "quota",
    { v: 1, id: "q1", to: ["phone"], takenAt: at, providers: [], alerts: [] },
    { id: "devbox", signKey: devbox.keys.sign.privateKey },
    [acct.device.member],
  );
  expect((await s.call("POST", "/v1/items", { token: devbox.token, body: quota })).status).toBe(
    201,
  );
  // The snapshot must predate the ask by a millisecond or more, or the machine is not behind.
  await Bun.sleep(5);
  const started = Date.now();
  let done = false;
  const asking = s.call("POST", "/v1/quota/ask?wait=30", { token: acct.device.token });
  asking.then(() => (done = true));
  await Bun.sleep(100);
  expect(done).toBe(false);
  s.deps.quotas.close();
  expect((await asking).json.behind).toBe(1);
  expect(Date.now() - started).toBeLessThan(2000);
});
