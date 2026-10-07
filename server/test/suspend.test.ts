import { expect, test } from "bun:test";
import { type Answer, type Decision, type SealedItem, seal } from "@starbridge/protocol";
import { setSuspended } from "../src/auth";
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

function answer(d: SealedItem, by: Actor, machine: Actor): SealedItem {
  const body: Answer = {
    v: 1,
    id: `a${++n}`,
    decisionId: d.id,
    to: machine.id,
    answeredAt: at,
    choice: "yes",
  };
  return seal("answer", body, { id: by.id, signKey: by.keys.sign.privateKey }, [machine.member]);
}

test("a suspended account's machines read but write nothing; its devices work (#785)", async () => {
  const s = await makeServer();
  const acct = await setupAccount(s);
  const devbox = await pair(s, acct, "devbox", "machine");
  const asked = decision(devbox, acct.device);
  expect((await s.call("POST", "/v1/items", { token: devbox.token, body: asked })).status).toBe(
    201,
  );

  expect(setSuspended(s.deps.db, acct.id, true)).toBe(true);
  const refused = await s.call("POST", "/v1/items", {
    token: devbox.token,
    body: decision(devbox, acct.device),
  });
  expect(refused.status).toBe(403);
  expect(refused.json.error).toBe("account-suspended");
  // The owner still answers, and the waiting machine still reads the answer.
  const reply = answer(asked, acct.device, devbox);
  expect(
    (await s.call("POST", "/v1/items", { token: acct.device.token, body: reply })).status,
  ).toBe(201);
  const answers = await s.call("GET", "/v1/answers?wait=0", { token: devbox.token });
  expect(answers.status).toBe(200);
  expect(JSON.stringify(answers.json)).toContain(reply.id);

  expect(setSuspended(s.deps.db, acct.id, false)).toBe(true);
  expect(
    (
      await s.call("POST", "/v1/items", {
        token: devbox.token,
        body: decision(devbox, acct.device),
      })
    ).status,
  ).toBe(201);
  expect(setSuspended(s.deps.db, "no-such-account", true)).toBe(false);
});
