/**
 * A test device for a real Starbridge server: it pairs into the owner's account with a code the
 * owner types on a device, answers decisions the way the phone does, and revokes itself.
 *
 *   bun e2e/device.ts pair --server <url> --session <token> --file <path>
 *   bun e2e/device.ts revoke --file <path>
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type Answer,
  checkJoined,
  claimHash,
  type Directory,
  formatPairingCode,
  fromB64,
  generateMemberKeys,
  type MemberKeys,
  newClaimSecret,
  newPairingCode,
  openPairingApproval,
  pairingRequest,
  publicKeys,
  ready,
  revokeEntry,
  seal,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";

interface Saved {
  server: string;
  session: string;
  account: string;
  id: string;
  keys: { boxPk: string; boxSk: string; signPk: string; signSk: string };
}

const iso = () => `${new Date().toISOString().slice(0, 19)}Z`;

async function call(server: string, token: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${server}/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 300 && res.status !== 204)
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

export class TestDevice {
  private constructor(private readonly s: Saved) {}

  static load(file: string): TestDevice {
    return new TestDevice(JSON.parse(readFileSync(file, "utf8")));
  }

  get id() {
    return this.s.id;
  }

  private get keys(): MemberKeys {
    const k = this.s.keys;
    return {
      box: { publicKey: fromB64(k.boxPk), privateKey: fromB64(k.boxSk) },
      sign: { publicKey: fromB64(k.signPk), privateKey: fromB64(k.signSk) },
    };
  }

  private call(method: string, path: string, body?: unknown) {
    return call(this.s.server, this.s.session, method, path, body);
  }

  async directory(): Promise<Directory> {
    const { entries } = await this.call("GET", "/directory");
    return verifyDirectory(entries, { account: this.s.account });
  }

  /** Answers decision `decisionId` with `choice`, as the phone does. Returns when posted. */
  async answer(decisionId: string, choice: string): Promise<void> {
    await ready;
    const { item } = await this.call("GET", `/items/${decisionId}`);
    const dir = await this.directory();
    const machine = dir.members.get(item.from)?.member;
    if (!machine) throw new Error(`no member ${item.from}`);
    const body: Answer = {
      v: 1,
      id: `a_${crypto.randomUUID()}`,
      decisionId,
      to: machine.id,
      answeredAt: iso(),
      choice,
    };
    const signer = { id: this.s.id, signKey: this.keys.sign.privateKey };
    await this.call("POST", "/items", seal("answer", body, signer, [machine]));
  }

  async revoke(): Promise<void> {
    await ready;
    const dir = await this.directory();
    const signer = { id: this.s.id, signKey: this.keys.sign.privateKey };
    await this.call("POST", "/directory", { entry: revokeEntry(dir, signer, this.s.id, iso()) });
  }

  /** Prints a code for the owner to type under Devices, then waits for the approval. */
  static async pair(server: string, session: string, file: string): Promise<TestDevice> {
    await ready;
    const keys = generateMemberKeys();
    const id = `d_e2e_${toB64(crypto.getRandomValues(new Uint8Array(6)))}`;
    const code = newPairingCode();
    const claim = newClaimSecret();
    const request = {
      v: 1 as const,
      rendezvous: code.rendezvous,
      role: "device" as const,
      id,
      name: "e2e test device (#48)",
      ...publicKeys(keys),
      at: iso(),
    };
    await call(server, session, "POST", "/pairings", {
      request: pairingRequest(request, code),
      claimHash: claimHash(claim),
    });
    console.log(`Pairing code: ${formatPairingCode(code)}`);
    const deadline = Date.now() + 10 * 60_000;
    let result: { approval: unknown } | undefined;
    while (!result && Date.now() < deadline) {
      const res = await fetch(`${server}/v1/pairings/${code.rendezvous}/result?wait=60`, {
        headers: { authorization: `Bearer ${session}`, "x-claim": claim },
      });
      if (res.status === 200) result = (await res.json()) as { approval: unknown };
      else if (res.status !== 204) throw new Error(`result: ${res.status} ${await res.text()}`);
    }
    if (!result) throw new Error("the pairing code expired");
    const approval = openPairingApproval(result.approval, code);
    const { entries } = await call(server, session, "GET", "/directory");
    const dir = verifyDirectory(entries, {
      account: approval.account,
      pin: { length: approval.length, head: approval.head },
    });
    checkJoined(dir, { id, role: "device", ...publicKeys(keys) });
    const saved: Saved = {
      server,
      session,
      account: approval.account,
      id,
      keys: {
        boxPk: toB64(keys.box.publicKey),
        boxSk: toB64(keys.box.privateKey),
        signPk: toB64(keys.sign.publicKey),
        signSk: toB64(keys.sign.privateKey),
      },
    };
    writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`Paired test device ${id}`);
    return new TestDevice(saved);
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      server: { type: "string" },
      session: { type: "string" },
      file: { type: "string" },
    },
  });
  if (!values.file) throw new Error("--file is required");
  if (command === "pair") {
    if (!values.server || !values.session) throw new Error("pair needs --server and --session");
    await TestDevice.pair(values.server.replace(/\/+$/, ""), values.session, values.file);
  } else if (command === "revoke") {
    const d = TestDevice.load(values.file);
    await d.revoke();
    console.log(`Revoked ${d.id}`);
  } else {
    throw new Error(`unknown command ${command}`);
  }
}
