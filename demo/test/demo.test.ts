import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Decision,
  generateMemberKeys,
  joinCommitment,
  joinerKeys,
  joinRequest,
  newJoinId,
  newJoinKeyPair,
  open,
  openJoinApproval,
  publicKeys,
  revokeEntry,
  type SealedItem,
  seal,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { makeServer } from "@starbridge/server/test-support";
import { Broken, DemoDevice } from "../src/device";
import { DemoMachine, QUESTIONS } from "../src/machine";

const TOKEN = "owner-secret";
const ROOT = join(import.meta.dir, "..", "..");

async function serve(demo: boolean) {
  const { app } = await makeServer({ demo, ownerToken: TOKEN });
  const http = Bun.serve({ port: 0, fetch: (req, server) => app.fetch(req, { server }) });
  return { url: `http://localhost:${http.port}`, stop: () => http.stop(true) };
}

const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanup) c();
});

test("refuses a server without DEMO=1", async () => {
  const s = await serve(false);
  cleanup.push(s.stop);
  await expect(new DemoDevice(s.url, TOKEN, () => {}).createAccount()).rejects.toThrow(
    "not a demo server",
  );
});

/** A phone that signs in with the owner token and joins by digits, as a reviewer's does. */
async function joinByDigits(url: string, phoneId = "pixel") {
  const call = async (method: string, path: string, session: string, body?: unknown) => {
    const res = await fetch(`${url}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const { session } = await call("POST", "/auth/owner", "", { token: TOKEN });
  const { account } = await call("GET", "/me", session);
  const keys = generateMemberKeys();
  const eph = newJoinKeyPair();
  const id = newJoinId();
  const at = `${new Date().toISOString().slice(0, 19)}Z`;
  const request = joinRequest({
    v: 1,
    join: id,
    account,
    id: phoneId,
    name: phoneId,
    ...publicKeys(keys),
    at,
  });
  await call("POST", "/joins", session, {
    request,
    commitment: joinCommitment(eph.publicKey, request),
  });
  let after = 0;
  let derived: ReturnType<typeof joinerKeys> | undefined;
  for (;;) {
    const { join: j } = await call("GET", `/joins/${id}?after=${after}&wait=25`, session);
    after = j.version;
    if (!derived && j.approverKey) {
      derived = joinerKeys({ mine: eph, approverKey: j.approverKey, request });
      await call("POST", `/joins/${id}/reveal`, session, { key: toB64(eph.publicKey) });
    }
    if (derived && j.approval) {
      openJoinApproval(j.approval, derived, id);
      break;
    }
  }
  const me = { id: phoneId, box: keys.box };
  const directory = async () => verifyDirectory((await call("GET", "/directory", session)).entries);
  return {
    /** The open questions this phone can read. */
    async questions(): Promise<Decision[]> {
      const { items } = await call("GET", "/items?kind=decision&open=1", session);
      const dir = await directory();
      return items.flatMap((s: { item: SealedItem & { kind: "decision" } }) => {
        try {
          return [open(s.item, me, dir).body];
        } catch {
          return [];
        }
      });
    },
    async answer(d: Decision, choice: string) {
      const dir = await directory();
      const machine = [...dir.members.values()].find((m) => m.member.role === "machine")?.member;
      if (!machine) throw new Error("no machine");
      const body = {
        v: 1 as const,
        id: `a_${crypto.randomUUID()}`,
        decisionId: d.id,
        to: machine.id,
        answeredAt: `${new Date().toISOString().slice(0, 19)}Z`,
        choice,
        dir: { length: dir.length, head: dir.head },
      };
      await call(
        "POST",
        "/items",
        session,
        seal("answer", body, { id: phoneId, signKey: keys.sign.privateKey }, [machine]),
      );
    },
    /** What a reviewer does who removes a member in the app. */
    async revoke(id: string) {
      const signer = { id: phoneId, signKey: keys.sign.privateKey };
      const entry = revokeEntry(
        await directory(),
        signer,
        id,
        `${new Date().toISOString().slice(0, 19)}Z`,
      );
      await call("POST", "/directory", session, { entry });
    },
  };
}

async function until<T>(get: () => Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(200);
  }
}

/** A demo server with the demo device and its paired machine; nothing runs yet. */
async function demo() {
  const s = await serve(true);
  cleanup.push(s.stop);
  const device = new DemoDevice(s.url, TOKEN, () => {});
  await device.createAccount();
  const machine = new DemoMachine(
    {
      cli: ["bun", join(ROOT, "cli/src/main.ts")],
      server: s.url,
      dir: mkdtempSync(join(tmpdir(), "starbridge-demo-")),
      codexbar: join(ROOT, "demo/src/codexbar.ts"),
      nextQuestionAfter: 0,
      log: () => {},
    },
    device,
  );
  cleanup.push(() => machine.stop());
  await machine.pair();
  const stop = new AbortController();
  cleanup.push(() => stop.abort());
  const joins = device.approveJoins(stop.signal);
  joins.catch(() => {});
  return { url: s.url, device, machine, stop, joins };
}

test("a phone joins by digits, sees the open question, answers it and gets the next", async () => {
  const { url, device, machine, stop } = await demo();
  machine.agent().catch(() => {});
  machine.questions(stop.signal).catch(() => {});

  // The question is asked before the phone joins: the machine re-seals it to the phone.
  await until(async () => ((await device.directory()).length >= 2 ? true : undefined), 20_000);
  const phone = await joinByDigits(url);
  const first = await until(async () => (await phone.questions())[0], 40_000);
  expect(first.question).toBe(QUESTIONS[0]?.question as string);
  await phone.answer(first, first.options?.[0] as string);
  const next = await until(
    async () => (await phone.questions()).find((d) => d.id !== first.id),
    40_000,
  );
  expect(next.question).toBe(QUESTIONS[1]?.question as string);
}, 120_000);

test("two phones joining at once both get in", async () => {
  const { url, device } = await demo();
  await Promise.all([joinByDigits(url, "pixel"), joinByDigits(url, "tablet")]);
  const dir = await device.directory();
  expect(dir.members.get("pixel")?.active).toBe(true);
  expect(dir.members.get("tablet")?.active).toBe(true);
}, 60_000);

for (const revoked of ["demo-owner", "machine"])
  test(`stops, for a fresh account, once a reviewer revokes the ${revoked}`, async () => {
    const { url, device, joins } = await demo();
    const phone = await joinByDigits(url);
    await phone.revoke(revoked === "machine" ? (device.machine as string) : device.id);
    await expect(joins).rejects.toBeInstanceOf(Broken);
  }, 60_000);
