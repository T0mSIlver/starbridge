import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type Answer,
  addEntry,
  type Directory,
  generateMemberKeys,
  publicKeys,
  revokeEntry,
  type SignedEnvelope,
  seal,
  verifyDirectory,
} from "@starbridge/protocol";
import { LiveServer } from "@starbridge/server/test-support";
import { run } from "../src/cli";
import { Store } from "../src/config";
import { refreshDirectory, session } from "../src/context";
import { paired, testCtx, until } from "./helpers";

let server: LiveServer;
beforeEach(async () => {
  server = await LiveServer.start();
});
afterEach(() => server.stop());

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
  expect(await run(["ask", "--question", "Q?", "--default", "x"], a)).toBe(0);
  const [d] = await server.opened("decision");
  expect(d?.to).toEqual(["phone"]);
});

test("a revocation the server withholds stops counting once another device answers", async () => {
  const ctx = await paired(server);
  const laptop = await server.addDevice("laptop");
  const ask = async () => {
    await run(
      ["ask", "--question", "Deploy?", "--option", "Yes", "--option", "No", "--session", "s"],
      ctx,
    );
    return ctx.lines.at(-1) as string;
  };
  const [first, second, third] = [await ask(), await ask(), await ask()];
  const known = ctx.store.directory().length;
  // The phone is lost and the laptop revokes it.
  const signer = { id: laptop.id, signKey: laptop.keys.sign.privateKey };
  const entry = revokeEntry(await server.directory(), signer, "phone", now());
  const r = await fetch(`${server.url}/v1/directory`, {
    method: "POST",
    headers: { authorization: `Bearer ${laptop.token}`, "content-type": "application/json" },
    body: JSON.stringify({ entry }),
  });
  expect(r.status).toBe(201);
  // The phone's session ended with it: the laptop reads the chain.
  const fetched = await fetch(`${server.url}/v1/directory?from=0`, {
    headers: { authorization: `Bearer ${laptop.token}` },
  });
  const full = verifyDirectory(((await fetched.json()) as { entries: unknown[] }).entries);
  const machine = full.members.get(ctx.store.machine()?.id as string)?.member;
  if (!machine) throw new Error("no machine");
  const answer = (by: typeof laptop, decisionId: string, choice: string, dir?: Answer["dir"]) => {
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
    const ids: string[] = ctx.lines.map((l) => JSON.parse(l).decisionId);
    for (const id of ids) await run(["answers", "--session", "s", "--ack", id], ctx);
    return ids;
  };
  // A compromised server, holding the phone's key, hides the revocation from the machine.
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const res = await real(url, init);
    const m = /\/v1\/directory\?from=(\d+)/.exec(String(url));
    if (!m) return res;
    const { entries } = (await res.json()) as { entries: unknown[] };
    return Response.json({ entries: entries.slice(0, Math.max(0, known - Number(m[1]))) });
  }) as typeof fetch;
  try {
    // Until another device answers, nothing tells the machine: the limit PROTOCOL.md states.
    answer(server.owner.device, first, "Yes");
    expect(await delivered()).toEqual([first]);
    // The laptop answers, naming the chain it holds: the machine sees it is behind.
    answer(laptop, second, "No", { length: full.length, head: full.head });
    expect(await delivered()).toEqual([]);
    expect(ctx.errors.at(-1)).toContain("holding back directory entries");
    // From then on the revoked phone's answers count no more.
    answer(server.owner.device, third, "Yes");
    expect(await delivered()).toEqual([]);
    expect(ctx.errors.at(-1)).toContain("holding back directory entries");
  } finally {
    globalThis.fetch = real;
  }
  // Served in full, the chain revokes the phone, and the laptop's answers count again.
  answer(laptop, second, "No", { length: full.length, head: full.head });
  expect(await delivered()).toEqual([second]);
});
