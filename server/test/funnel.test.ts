import { expect, test } from "bun:test";
import { type Answer, type Decision, seal } from "@starbridge/protocol";
import type { Context } from "hono";
import type { Env } from "../src/env";
import { at, makeServer, pair, setupAccount, signIn } from "../test-support/app";

const umami = { url: "http://umami:3000", websiteId: "f3741d82-c450-47d3-8845-646cddbe392f" };

async function server() {
  const sent: { name: string; id: string; data?: Record<string, string> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    if (url === `${umami.url}/api/send`) {
      const { payload } = JSON.parse(init.body as string);
      sent.push({
        name: payload.name,
        id: payload.id,
        ...(payload.data && { data: payload.data }),
      });
    }
    return new Response();
  }) as typeof fetch;
  return { s: await makeServer({ umami }, fetchFn), sent };
}

test("a new account's steps reach Umami once each, as one visit that names no account", async () => {
  const { s, sent } = await server();
  const acct = await setupAccount(s);
  const phone = acct.device;
  const devbox = await pair(s, acct, "devbox", "machine");
  await pair(s, acct, "laptop", "device", await signIn(s));
  await pair(s, acct, "server", "machine");
  await pair(s, acct, "tablet", "device", await signIn(s));

  for (const n of [1, 2]) {
    const decision: Decision = {
      v: 1,
      id: `d${n}`,
      to: [phone.id],
      createdAt: at,
      question: "Ship it?",
      context: "",
      options: ["yes", "no"],
      recommended: "yes",
      source: { machine: "devbox", project: "starbridge", session: "s1" },
    };
    const d = seal("decision", decision, { id: devbox.id, signKey: devbox.keys.sign.privateKey }, [
      phone.member,
    ]);
    await s.call("POST", "/v1/items", { token: devbox.token, body: d });
    const answer: Answer = {
      v: 1,
      id: `a${n}`,
      decisionId: d.id,
      to: devbox.id,
      answeredAt: at,
      choice: "yes",
    };
    const a = seal("answer", answer, { id: phone.id, signKey: phone.keys.sign.privateKey }, [
      devbox.member,
    ]);
    expect((await s.call("POST", "/v1/items", { token: phone.token, body: a })).status).toBe(201);
  }

  expect(sent.map((e) => e.name)).toEqual([
    "first-keys",
    "first-machine",
    "second-device",
    "first-answer",
  ]);
  expect(sent.at(-1)?.data).toEqual({ via: "android" });
  expect(new Set(sent.map((e) => e.id)).size).toBe(1);
  // Random, not a hash anyone could compute from the account id (#1745).
  const unsalted = new Bun.CryptoHasher("sha256").update(`funnel:${acct.id}`).digest("hex");
  expect(sent[0]?.id).toMatch(/^[0-9a-f]{32}$/);
  expect(sent[0]?.id).not.toBe(unsalted.slice(0, 32));
  // Kept with the account, and gone with it.
  const holder = () =>
    s.deps.db.query("SELECT id FROM accounts WHERE funnel_id = ?").get(sent[0]?.id ?? "");
  expect(holder()).toEqual({ id: acct.id });
  expect((await s.call("DELETE", "/v1/account", { token: phone.token })).status).toBe(204);
  expect(holder()).toBeNull();
});

test("Do Not Track, an account older than two days, or a server without Umami sends nothing", async () => {
  const { s, sent } = await server();
  const acct = await setupAccount(s);
  sent.length = 0;
  const dnt = { req: { header: (name: string) => (name === "dnt" ? "1" : undefined) } };
  s.deps.funnel.reached(dnt as unknown as Context<Env>, acct.id, "first-machine");
  expect(sent).toEqual([]);
  s.deps.db
    .query("UPDATE accounts SET created_at = ?")
    .run(new Date(Date.now() - 3 * 86_400_000).toISOString());
  await pair(s, acct, "devbox", "machine");
  expect(sent).toEqual([]);

  const off = await makeServer({}, (() => {
    throw new Error("no Umami to reach");
  }) as unknown as typeof fetch);
  await pair(off, await setupAccount(off), "devbox", "machine");
});
