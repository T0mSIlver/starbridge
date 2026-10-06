/**
 * The demo account's first device. It approves the demo machine's pairing and every join by
 * digits without comparing them, so a Play reviewer gets in with the owner token alone (#423).
 */
import {
  addEntry,
  approverKeys,
  bindMessage,
  type Directory,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  joinApproval,
  type Member,
  type MemberKeys,
  newJoinKeyPair,
  openJoinRequest,
  openPairingRequest,
  type PairingMessage,
  pairingApproval,
  parsePairingCode,
  publicKeys,
  ready,
  recoveryKeyPair,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import sodium from "libsodium-wrappers";

/** The program stops, and its container restarts with a fresh account, past this many entries. */
export const FULL_DIRECTORY = 180;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    what: string,
  ) {
    super(`${what}: ${status} ${code}`);
  }
}

/** The demo is broken past repair: its device or machine was revoked, or the directory is full. */
export class Broken extends Error {}

interface JoinView {
  id: string;
  request: string;
  commitment: string;
  state: "open" | "comparing" | "approved" | "cancelled";
  approver?: string;
  joinerKey?: string;
  expiresAt: string;
  version: number;
}

const now = () => `${new Date().toISOString().slice(0, 19)}Z`;

export class DemoDevice {
  readonly id = "demo-owner";
  /** Made once libsodium is ready, in `createAccount`. */
  private keys!: MemberKeys;
  private session = "";
  account = "";

  constructor(
    readonly server: string,
    private readonly ownerToken: string,
    private readonly log: (line: string) => void = console.log,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const res = await fetch(`${this.server}/v1${path}`, {
      method,
      headers: {
        ...(this.session ? { authorization: `Bearer ${this.session}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (res.ok) return json as T;
    const code = (json as { error?: string } | undefined)?.error ?? "";
    if (res.status === 401 && code === "revoked") throw new Broken("the demo device was revoked");
    // Sessions expire, and an account keeps 50: reviewers' sign-ins push the oldest out.
    if (res.status === 401 && retry && this.account) {
      await this.signInAgain();
      return this.call(method, path, body, false);
    }
    throw new HttpError(res.status, code, `${method} ${path}`);
  }

  /** Refuses any server that is not a demo server, such as starbridge.run. */
  async checkDemo(): Promise<void> {
    const res = await fetch(`${this.server}/v1/demo`).catch(() => undefined);
    const body = res?.ok ? ((await res.json()) as { demo?: unknown }) : undefined;
    if (body?.demo !== true) throw new Error(`${this.server} is not a demo server (DEMO=1)`);
  }

  private async signIn(): Promise<void> {
    this.session = "";
    this.session = (
      await this.call<{ session: string }>("POST", "/auth/owner", { token: this.ownerToken })
    ).session;
  }

  private async signInAgain(): Promise<void> {
    await this.signIn();
    const { nonce } = await this.call<{ nonce: string }>("GET", "/auth/challenge");
    const sig = sodium.crypto_sign_detached(
      bindMessage(this.account, this.id, nonce),
      this.keys.sign.privateKey,
    );
    await this.call("POST", "/auth/bind", { member: this.id, sig: toB64(sig) }, false);
  }

  /** Signs in with the owner token and creates the account's keys; the recovery key is dropped. */
  async createAccount(): Promise<void> {
    await ready;
    this.keys = generateMemberKeys();
    await this.checkDemo();
    await this.signIn();
    const me = await this.call<{ account: string; member: string | null }>("GET", "/me");
    if (me.member !== null)
      throw new Error("the account already has keys: start on an empty database");
    this.account = me.account;
    const seed = generateRecoverySeed();
    const entry = genesisEntry({
      account: this.account,
      device: this.member(),
      signKey: this.keys.sign.privateKey,
      recovery: recoveryKeyPair(seed),
      at: now(),
    });
    seed.fill(0);
    await this.call("POST", "/directory", { entry });
  }

  private member(): Member {
    return { id: this.id, role: "device", name: "Demo owner", ...publicKeys(this.keys) };
  }

  async directory(): Promise<Directory> {
    const { entries } = await this.call<{ entries: unknown[] }>("GET", "/directory");
    return verifyDirectory(entries, { account: this.account });
  }

  /** Adds a member; a full directory means the demo starts over. */
  private async add(member: Member): Promise<{ length: number; head: string }> {
    const dir = await this.directory();
    if (dir.length >= FULL_DIRECTORY) throw new Broken(`the directory holds ${dir.length} entries`);
    const signer = { id: this.id, signKey: this.keys.sign.privateKey };
    return this.call("POST", "/directory", { entry: addEntry(dir, signer, member, now()) });
  }

  /** What the owner does after typing the machine's code. */
  async approvePairing(codeText: string): Promise<void> {
    const code = parsePairingCode(codeText);
    const { request } = await this.call<{ request: PairingMessage }>(
      "GET",
      `/pairings/${code.rendezvous}?wait=25`,
    );
    const req = openPairingRequest(request, code);
    const { length, head } = await this.add({
      id: req.id,
      role: req.role,
      name: req.name,
      boxPk: req.boxPk,
      signPk: req.signPk,
    });
    const approval = pairingApproval(
      { v: 1, rendezvous: code.rendezvous, account: this.account, length, head, approver: this.id },
      code,
    );
    await this.call("POST", `/pairings/${code.rendezvous}/approve`, { approval });
  }

  /** Approves every join by digits until `signal` aborts; throws Broken when it cannot. */
  async approveJoins(signal: AbortSignal): Promise<void> {
    let cursor = "0";
    let broken: Broken | undefined;
    const busy = new Set<string>();
    while (!signal.aborted) {
      if (broken) throw broken;
      let page: { joins: JoinView[]; cursor: string };
      try {
        page = await this.call("GET", `/joins?after=${cursor}&wait=25`);
      } catch (e) {
        if (e instanceof Broken) throw e;
        this.log(`joins: ${(e as Error).message}`);
        await Bun.sleep(3000);
        continue;
      }
      cursor = page.cursor;
      for (const join of page.joins) {
        if (join.state !== "open" || busy.has(join.id)) continue;
        busy.add(join.id);
        this.approveJoin(join)
          .catch((e) => {
            if (e instanceof Broken) broken = e;
            else this.log(`join ${join.id}: ${(e as Error).message}`);
          })
          .finally(() => busy.delete(join.id));
      }
    }
  }

  /** The approver's side of joining by digits, with nobody comparing the digits. */
  async approveJoin(join: JoinView): Promise<void> {
    const body = openJoinRequest(join.request);
    if (body.account !== this.account || body.join !== join.id) return;
    const eph = newJoinKeyPair();
    let view = (
      await this.call<{ join: JoinView }>("POST", `/joins/${join.id}/approver`, {
        key: toB64(eph.publicKey),
        approver: this.id,
      })
    ).join;
    try {
      while (!view.joinerKey) {
        if (view.state === "cancelled" || Date.parse(view.expiresAt) < Date.now()) return;
        view = (
          await this.call<{ join: JoinView }>(
            "GET",
            `/joins/${join.id}?after=${view.version}&wait=25`,
          )
        ).join;
      }
      const keys = approverKeys({
        mine: eph,
        joinerKey: view.joinerKey,
        request: join.request,
        commitment: join.commitment,
      });
      const { length, head } = await this.add({
        id: body.id,
        role: "device",
        name: body.name,
        boxPk: body.boxPk,
        signPk: body.signPk,
      });
      const approval = joinApproval(
        { v: 1, join: join.id, account: this.account, length, head, approver: this.id },
        keys,
      );
      await this.call("POST", `/joins/${join.id}/approve`, { approval });
      this.log(`approved ${body.name} (digits ${keys.digits})`);
    } finally {
      eph.privateKey.fill(0);
    }
  }
}
