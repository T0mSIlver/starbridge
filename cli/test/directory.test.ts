import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  addEntry,
  type Directory,
  generateMemberKeys,
  publicKeys,
  revokeEntry,
  type SignedEnvelope,
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
