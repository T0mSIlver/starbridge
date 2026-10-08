import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type Answer,
  addEntry,
  type Directory,
  generateMemberKeys,
  generateRecoverySeed,
  open,
  publicKeys,
  recoveryConfirmEntry,
  recoveryEntry,
  recoveryKeyPair,
  revokeEntry,
  type SealedItem,
  type SignedEnvelope,
  type Snooze,
  seal,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { run } from "../src/cli";
import { Store } from "../src/config";
import { refreshDirectory, session } from "../src/context";
import { poll, postWaiting } from "../src/decisions";
import { hookPermission } from "../src/hook";
import { postSettled } from "../src/permissions";
import { pushOnce } from "../src/quota";
import { postRun } from "../src/run";
import { FAKE_CODEXBAR, paired, testCtx, until } from "./helpers";

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

type Actor = Awaited<ReturnType<LiveServer["addDevice"]>>;

/** The owner's phone appends one directory entry. */
async function phoneAppends(
  make: (dir: Directory, signer: { id: string; signKey: Uint8Array }) => SignedEnvelope,
) {
  const signer = { id: "phone", signKey: server.owner.device.keys.sign.privateKey };
  const entry = make(await server.directory(), signer);
  const r = await fetch(`${server.url}/v1/directory`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.owner.device.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ entry }),
  });
  if (r.status !== 201) throw new Error(`append: ${r.status} ${await r.text()}`);
}

const now = () => `${new Date().toISOString().slice(0, 19)}Z`;

test("two processes refreshing at once never roll back a revocation", async () => {
  const a = await paired(server);
  // A second process on the same machine, such as the mod's poll beside an agent's `ask`.
  const b = { ...testCtx(), store: new Store(a.store.dir) };
  const tablet = {
    id: "tablet",
    role: "device" as const,
    name: "tablet",
    ...publicKeys(generateMemberKeys()),
  };

  // B starts its refresh after the tablet joins, and its reply is slow to arrive.
  await phoneAppends((dir, signer) => addEntry(dir, signer, tablet, now()));
  const sb = session(b);
  const fetchDirectory = sb.api.directory.bind(sb.api);
  let fetched = false;
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  sb.api.directory = async (since) => {
    const entries = await fetchDirectory(since);
    fetched = true;
    await held;
    return entries;
  };
  const refreshB = refreshDirectory(b, sb);
  await until(() => fetched);

  // Meanwhile the owner revokes the tablet, and A sees it.
  await phoneAppends((dir, signer) => revokeEntry(dir, signer, "tablet", now()));
  const dirA = await refreshDirectory(a, session(a));
  expect(dirA.members.get("tablet")?.active).toBe(false);

  release();
  const dirB = await refreshB;
  expect(dirB.members.get("tablet")?.active).toBe(false);
  expect(a.store.machine()?.pin.length).toBe(dirA.length);

  // The next ask seals to the phone only.
  expect(await run(["ask", "--question", "Q?"], a)).toBe(0);
  const [d] = await server.opened("decision");
  expect(d?.to).toEqual(["phone"]);
});

/** A chain read as the laptop, which the phone's revocation leaves signed in. */
async function laptopChain(laptop: Actor) {
  const r = await fetch(`${server.url}/v1/directory?from=0`, {
    headers: { authorization: `Bearer ${laptop.token}` },
  });
  return verifyDirectory(((await r.json()) as { entries: unknown[] }).entries);
}

/** The laptop appends one entry. */
async function laptopAppends(laptop: Actor, make: (dir: Directory) => SignedEnvelope) {
  const r = await fetch(`${server.url}/v1/directory`, {
    method: "POST",
    headers: { authorization: `Bearer ${laptop.token}`, "content-type": "application/json" },
    body: JSON.stringify({ entry: make(await laptopChain(laptop)) }),
  });
  if (r.status !== 201) throw new Error(`append: ${r.status} ${await r.text()}`);
}

/**
 * A paired machine with three open questions, a laptop beside the phone, and helpers: devices
 * answer through a compromised server, which can serve the machine only the first `limit`
 * directory entries.
 */
async function withholding() {
  const ctx = await paired(server);
  const laptop = await server.addDevice("laptop");
  const ask = async () => {
    await run(
      ["ask", "--question", "Deploy?", "--option", "Yes", "--option", "No", "--session", "s"],
      ctx,
    );
    return ctx.lines.at(-1) as string;
  };
  const ids = [await ask(), await ask(), await ask()] as const;
  const machine = (await server.directory()).members.get(ctx.store.machine()?.id as string)?.member;
  if (!machine) throw new Error("no machine");
  const answer = (by: Actor, decisionId: string, choice: string, dir?: Answer["dir"]) => {
    const body = {
      v: 1,
      id: `a_${crypto.randomUUID()}`,
      decisionId,
      to: machine.id,
      answeredAt: now(),
      choice,
      ...(dir ? { dir } : {}),
    } satisfies Answer;
    server.inject(seal("answer", body, { id: by.id, signKey: by.keys.sign.privateKey }, [machine]));
  };
  const delivered = async () => {
    ctx.lines.length = 0;
    expect(await run(["answers", "--session", "s", "--wait", "1"], ctx)).toBe(0);
    const got: string[] = ctx.lines.map((l) => JSON.parse(l).decisionId);
    for (const id of got) await run(["answers", "--session", "s", "--ack", id], ctx);
    return got;
  };
  const real = globalThis.fetch;
  const serve = (limit: number | undefined) => {
    globalThis.fetch = (
      limit === undefined
        ? real
        : async (url: string | URL | Request, init?: RequestInit) => {
            const res = await real(url, init);
            const m = /\/v1\/directory\?from=(\d+)/.exec(String(url));
            if (!m) return res;
            const { entries } = (await res.json()) as { entries: unknown[] };
            return Response.json({ entries: entries.slice(0, Math.max(0, limit - Number(m[1]))) });
          }
    ) as typeof fetch;
  };
  return { ctx, laptop, ids, answer, delivered, serve, known: ctx.store.directory().length };
}

test("a revocation the server withholds stops counting once another device answers", async () => {
  const { ctx, laptop, ids, answer, delivered, serve, known } = await withholding();
  const [first, second, third] = ids;
  const phone = server.owner.device;
  // The phone is lost and the laptop revokes it; a compromised server holding the phone's key
  // hides that entry from the machine.
  await laptopAppends(laptop, (dir) =>
    revokeEntry(dir, { id: laptop.id, signKey: laptop.keys.sign.privateKey }, "phone", now()),
  );
  const full = await laptopChain(laptop);
  serve(known);
  try {
    // Until another device answers, nothing tells the machine: the limit PROTOCOL.md states.
    // This answer is accepted, but no session has taken it yet.
    answer(phone, first, "Yes");
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 1, shared: true });
    expect(ctx.store.state().answers[first]).toBeDefined();
    // The phone answers again, then the laptop, naming the chain it holds, in the same page:
    // the machine sees it is behind and accepts neither.
    answer(phone, third, "Yes");
    answer(laptop, second, "No", { length: full.length, head: full.head });
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 1, shared: true });
    expect(ctx.errors.at(-1)).toContain("holding back directory entries");
    // Nothing is delivered, not even the answer accepted before.
    expect(await delivered()).toEqual([]);
  } finally {
    serve(undefined);
  }
  // Served in full, the chain revokes the phone: the laptop's held answer counts, neither of the
  // phone's does.
  expect(await delivered()).toEqual([second]);
  expect(ctx.store.state().answers[first]).toBeUndefined();
  expect(ctx.errors.at(-1)).toContain("revoked");
});

test("a snooze's signed head shows a withheld revocation too (#571)", async () => {
  const { ctx, laptop, ids, serve, known } = await withholding();
  const machine = (await server.directory()).members.get(ctx.store.machine()?.id as string)?.member;
  if (!machine) throw new Error("no machine");
  await laptopAppends(laptop, (dir) =>
    revokeEntry(dir, { id: laptop.id, signKey: laptop.keys.sign.privateKey }, "phone", now()),
  );
  const full = await laptopChain(laptop);
  serve(known);
  try {
    const body = {
      v: 1,
      id: `z_${crypto.randomUUID()}`,
      decisionId: ids[0],
      to: [machine.id],
      until: new Date(Date.now() + 3_600_000).toISOString(),
      at: now(),
      dir: { length: full.length, head: full.head },
    } satisfies Snooze;
    server.inject(
      seal("snooze", body, { id: laptop.id, signKey: laptop.keys.sign.privateKey }, [machine]),
    );
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 1, shared: true });
    expect(ctx.errors.at(-1)).toContain("holding back directory entries");
  } finally {
    serve(undefined);
  }
});

test("a machine that knows the server holds back a revocation seals nothing new (#794)", async () => {
  const { ctx, laptop, ids, answer, serve, known } = await withholding();
  expect(await run(["config", "permissions", "on"], ctx)).toBe(0);
  ctx.env.STARBRIDGE_NO_AGENT = "1";
  // The laptop revokes the stolen phone; the server hides that from the machine, but delivers
  // the laptop's answer, which names the longer chain.
  await laptopAppends(laptop, (dir) =>
    revokeEntry(dir, { id: laptop.id, signKey: laptop.keys.sign.privateKey }, "phone", now()),
  );
  const full = await laptopChain(laptop);
  const real = globalThis.fetch;
  serve(known);
  try {
    // Counted from the poll on: it announces and re-seals nothing either.
    let posted = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/items") && init?.method === "POST") posted++;
      return inner(url, init);
    }) as typeof fetch;
    answer(laptop, ids[0], "No", { length: full.length, head: full.head });
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 1, shared: true });
    const s = session(ctx);
    const refused = "Nothing is sent meanwhile";
    const at = now();
    const senders: [string, () => Promise<unknown>][] = [
      ["ask", async () => expect(await run(["ask", "--question", "Ship?"], ctx)).toBe(1)],
      ["waiting", () => postWaiting(ctx, s, ids[1], "waiting")],
      ["settle", async () => expect(await run(["settle", ids[2]], ctx)).toBe(1)],
      [
        "run",
        () =>
          postRun(ctx, s, {
            id: "r_1",
            title: "t",
            reason: "r",
            startedAt: at,
            at,
            project: "p",
            session: "s",
          }),
      ],
      ["quota", () => pushOnce(ctx, { providers: ["codex"], codexbar: FAKE_CODEXBAR })],
      ["permission settled", () => postSettled(ctx, s, "p_1", { outcome: "keyboard" })],
    ];
    for (const [name, send] of senders) {
      ctx.errors.length = 0;
      const error = await send().then(
        () => ctx.errors.join("\n"),
        (e: Error) => e.message,
      );
      expect(error, name).toContain(refused);
    }
    // The permission hook leaves the prompt to the terminal.
    ctx.lines.length = 0;
    await hookPermission(
      ctx,
      JSON.stringify({
        session_id: "s",
        cwd: "/work/p",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "git push" },
      }),
      { agent: "claude-code" },
    );
    expect(ctx.errors.join("\n")).toContain(refused);
    expect(posted).toBe(0);
  } finally {
    globalThis.fetch = real;
    serve(undefined);
  }
  // Served the revocation, the machine seals to the laptop alone, under the head they share.
  let item: SealedItem | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/v1/items") && init?.method === "POST")
      item = JSON.parse(init.body as string);
    return real(url, init);
  }) as typeof fetch;
  try {
    expect(await run(["ask", "--question", "Ship now?"], ctx)).toBe(0);
  } finally {
    globalThis.fetch = real;
  }
  const chain = await laptopChain(laptop);
  const { body } = open(
    item as SealedItem & { kind: "decision" },
    { id: laptop.id, box: laptop.keys.box },
    chain,
  );
  expect(body.to).toEqual([laptop.id]);
  expect(body.dir).toEqual({ length: chain.length, head: chain.head });
});

test("the stolen phone cannot lift the hold by revoking the revoker on a fork (#794)", async () => {
  const { ctx, laptop, ids, answer, serve, known } = await withholding();
  await laptopAppends(laptop, (dir) =>
    revokeEntry(dir, { id: laptop.id, signKey: laptop.keys.sign.privateKey }, "phone", now()),
  );
  const full = await laptopChain(laptop);
  // The server, holding the phone's keys, serves the machine its stale chain plus the phone's
  // revocation of the laptop.
  const r = await fetch(`${server.url}/v1/directory?from=0`, {
    headers: { authorization: `Bearer ${laptop.token}` },
  });
  const stale = ((await r.json()) as { entries: SignedEnvelope[] }).entries.slice(0, known);
  const phone = { id: "phone", signKey: server.owner.device.keys.sign.privateKey };
  const fork = [...stale, revokeEntry(verifyDirectory(stale), phone, laptop.id, now())];
  const real = globalThis.fetch;
  try {
    // First the stale chain, with the laptop's answer naming the full one: the machine holds.
    serve(known);
    answer(laptop, ids[0], "No", { length: full.length, head: full.head });
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 1, shared: true });
    expect(ctx.errors.at(-1)).toContain("holding back directory entries");
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const m = /\/v1\/directory\?from=(\d+)/.exec(String(url));
      if (!m) return real(url, init);
      return Response.json({ entries: fork.slice(Number(m[1])) });
    }) as typeof fetch;
    // The machine took the fork: the laptop is revoked there, the phone active.
    const dir = await refreshDirectory(ctx, session(ctx));
    expect(dir.members.get(laptop.id)?.active).toBe(false);
    expect(await run(["ask", "--question", "Ship?"], ctx)).toBe(1);
    expect(ctx.errors.join("\n")).toContain("the server may be serving a fork");
    // The phone's own answer still does not count.
    answer(server.owner.device, ids[1], "Yes");
    await poll(ctx, session(ctx), { cursor: ctx.store.state().cursor, seconds: 1, shared: true });
    expect(ctx.store.state().answers[ids[1]]).toBeUndefined();
  } finally {
    globalThis.fetch = real;
  }
});

test("replaying a device's older answer does not lift the refusal", async () => {
  const { ctx, laptop, ids, answer, delivered, serve, known } = await withholding();
  const signer = { id: laptop.id, signKey: laptop.keys.sign.privateKey };
  // The laptop adds a tablet, then revokes the phone. The server serves the tablet's entry only.
  const tablet = {
    id: "tablet",
    role: "device" as const,
    name: "Tablet",
    ...publicKeys(generateMemberKeys()),
  };
  await laptopAppends(laptop, (dir) => addEntry(dir, signer, tablet, now()));
  const older = await laptopChain(laptop);
  await laptopAppends(laptop, (dir) => revokeEntry(dir, signer, "phone", now()));
  const full = await laptopChain(laptop);
  serve(known);
  try {
    answer(laptop, ids[0], "No", { length: full.length, head: full.head });
    expect(await delivered()).toEqual([]);
    // An answer the laptop signed before the revocation, released late; then the server
    // serves the chain up to that answer's head, still without the revocation.
    answer(laptop, ids[1], "No", { length: older.length, head: older.head });
    expect(await delivered()).toEqual([]);
    serve(older.length);
    answer(server.owner.device, ids[2], "Yes");
    expect(await delivered()).toEqual([]);
    expect(ctx.errors.at(-1)).toContain("holding back directory entries");
  } finally {
    serve(undefined);
  }
});

test("a machine follows a recovery key replacement and still seals to the devices (#348)", async () => {
  const a = await paired(server);
  const fresh = recoveryKeyPair(generateRecoverySeed());
  await phoneAppends((dir, signer) => recoveryEntry(dir, signer, fresh, now()));
  await phoneAppends((dir) =>
    recoveryConfirmEntry(dir, server.owner.recovery.privateKey, toB64(fresh.publicKey), now()),
  );
  const dir = await refreshDirectory(a, session(a));
  expect(dir.recoveryPk).toBe(toB64(fresh.publicKey));
  expect(dir.recoverySet.by).toBe("phone");
  expect(dir.members.get("phone")?.active).toBe(true);
});
