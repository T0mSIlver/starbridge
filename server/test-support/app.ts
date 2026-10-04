import {
  addEntry,
  claimHash,
  type Directory,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  type KeyPair,
  type Member,
  type MemberKeys,
  newPairingCode,
  pairingApproval,
  pairingRequest,
  publicKeys,
  recoveryKeyPair,
  revokeEntry,
  type SignedEnvelope,
  toB64,
  verifyDirectory,
} from "@starbridge/protocol";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import { DEFAULT_LIMITS } from "../src/limits";

export const at = "2026-10-04T12:00:00Z";

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    dbPath: ":memory:",
    publicUrl: "http://localhost",
    secureCookies: false,
    trustProxy: false,
    ownerToken: "owner-secret",
    appRedirectUri: "starbridge://auth",
    maxMachines: 5,
    maxWaitSeconds: 300,
    pushInlineLimit: 3072,
    allowPrivatePushEndpoints: true,
    pushTimeoutMs: 2000,
    relayMode: false,
    limits: DEFAULT_LIMITS,
    ...over,
  };
}

export type Server = Awaited<ReturnType<typeof makeServer>>;

export async function makeServer(over: Partial<Config> = {}) {
  const { app, deps } = await createApp(testConfig(over));
  async function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
  }
  return { app, deps, call };
}

export interface Actor {
  id: string;
  keys: MemberKeys;
  member: Member;
  token: string;
}

export interface Account {
  id: string;
  device: Actor;
  recovery: KeyPair;
}

export async function signIn(s: Server): Promise<string> {
  const r = await s.call("POST", "/v1/auth/owner", { body: { token: "owner-secret" } });
  if (r.status !== 200) throw new Error(`sign-in: ${r.status}`);
  return r.json.session;
}

function newMember(id: string, role: Member["role"]): { keys: MemberKeys; member: Member } {
  const keys = generateMemberKeys();
  return { keys, member: { id, role, name: id, ...publicKeys(keys) } };
}

/** Signs in with the owner token and writes the directory's first entry. */
export async function setupAccount(s: Server, deviceId = "phone"): Promise<Account> {
  const session = await signIn(s);
  const me = await s.call("GET", "/v1/me", { token: session });
  const { keys, member } = newMember(deviceId, "device");
  const recovery = recoveryKeyPair(generateRecoverySeed());
  const entry = genesisEntry({
    account: me.json.account,
    device: member,
    signKey: keys.sign.privateKey,
    recovery,
    at,
  });
  const r = await s.call("POST", "/v1/directory", { token: session, body: { entry } });
  if (r.status !== 201) throw new Error(`genesis: ${r.status} ${JSON.stringify(r.json)}`);
  return { id: me.json.account, device: { id: deviceId, keys, member, token: session }, recovery };
}

export async function directory(s: Server, token: string): Promise<Directory> {
  const r = await s.call("GET", "/v1/directory", { token });
  return verifyDirectory(r.json.entries);
}

export async function append(s: Server, token: string, entry: SignedEnvelope) {
  return s.call("POST", "/v1/directory", { token, body: { entry } });
}

/**
 * Runs the pairing flow for a new member. For a device, `newSession` is the session it signed
 * in with; it fetches its result with that session.
 */
export async function pair(
  s: Server,
  acct: Account,
  id: string,
  role: Member["role"],
  newSession?: string,
): Promise<Actor> {
  const { keys, member } = newMember(id, role);
  const code = newPairingCode();
  const claim = toB64(crypto.getRandomValues(new Uint8Array(32)));
  const request = pairingRequest(
    { v: 1, rendezvous: code.rendezvous, role, id, name: id, ...publicKeys(keys), at },
    code,
  );
  let r = await s.call("POST", "/v1/pairings", { body: { request, claimHash: claimHash(claim) } });
  if (r.status !== 201) throw new Error(`pairing request: ${r.status} ${JSON.stringify(r.json)}`);

  const dir = await directory(s, acct.device.token);
  const signer = { id: acct.device.id, signKey: acct.device.keys.sign.privateKey };
  r = await append(s, acct.device.token, addEntry(dir, signer, member, at));
  if (r.status !== 201) throw new Error(`add entry: ${r.status} ${JSON.stringify(r.json)}`);
  const approval = pairingApproval(
    {
      v: 1,
      rendezvous: code.rendezvous,
      account: acct.id,
      length: r.json.length,
      head: r.json.head,
      approver: acct.device.id,
    },
    code,
  );
  r = await s.call("POST", `/v1/pairings/${code.rendezvous}/approve`, {
    token: acct.device.token,
    body: { approval },
  });
  if (r.status !== 200) throw new Error(`approve: ${r.status} ${JSON.stringify(r.json)}`);
  r = await s.call("GET", `/v1/pairings/${code.rendezvous}/result`, {
    token: newSession,
    headers: { "x-claim": claim },
  });
  if (r.status !== 200) throw new Error(`result: ${r.status} ${JSON.stringify(r.json)}`);
  return { id, keys, member, token: role === "machine" ? r.json.token : (newSession as string) };
}

export async function revoke(s: Server, acct: Account, id: string) {
  const dir = await directory(s, acct.device.token);
  const signer = { id: acct.device.id, signKey: acct.device.keys.sign.privateKey };
  return append(s, acct.device.token, revokeEntry(dir, signer, id, at));
}
