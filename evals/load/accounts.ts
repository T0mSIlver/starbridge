/**
 * Makes one user as a new user would: GitHub sign-in (fake.ts) on the phone through the app's
 * code exchange, the phone's first directory entry, then a machine and a web page that the phone
 * pairs, with an FCM token for the phone and a Web Push subscription for the page.
 */
import {
  addEntry,
  claimHash,
  generateMemberKeys,
  generateRecoverySeed,
  genesisEntry,
  type Member,
  newPairingCode,
  pairingApproval,
  pairingRequest,
  publicKeys,
  recoveryKeyPair,
  toB64,
  verifyDirectory,
} from "../../packages/protocol/src/index.ts";
import type { User } from "./lib.ts";

export interface Via {
  /** Base URL: the server itself (18080) or Caddy (18000). */
  server: string;
  /** The fake services' URL as the server reaches them. */
  fake: string;
  /** The caller's address: sent as X-Forwarded-For to the server direct, as X-Sim-IP through Caddy. */
  ip?: string;
  /** Through Caddy, which replaces X-Forwarded-For with X-Sim-IP (stack.sh). */
  viaCaddy?: boolean;
  /** Told of each 429 before the call waits Retry-After and tries again, as a patient user. */
  limited?: (path: string, seconds: number) => void;
}

export async function makeUser(n: number, via: Via): Promise<User> {
  async function call(
    method: string,
    path: string,
    opts: {
      token?: string;
      cookie?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    for (;;) {
      const headers: Record<string, string> = { ...opts.headers };
      if (via.ip) headers[via.viaCaddy ? "x-sim-ip" : "x-forwarded-for"] = via.ip;
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (opts.cookie) headers.cookie = opts.cookie;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${via.server}/v1${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: "manual",
      });
      const text = await res.text();
      if (res.status === 429) {
        const seconds = Number(res.headers.get("retry-after") ?? 10);
        via.limited?.(path.replace(/\?.*|\/[0-9A-Z]{8}(?=\/|$)/g, ""), seconds);
        await Bun.sleep(seconds * 1000);
        continue;
      }
      return {
        status: res.status,
        headers: res.headers,
        json: text ? JSON.parse(text) : undefined,
      };
    }
  }

  function must(r: { status: number; json?: unknown }, what: string, ok = [200, 201]) {
    if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
  }

  /** GitHub sign-in; `app` signs in as the Android app does, trading GitHub's code for the session. */
  async function signIn(github: number, app: boolean): Promise<string> {
    const verifier = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
    const start = await call("GET", `/auth/github${app ? `?app=1&challenge=${challenge}` : ""}`);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    // The app's sign-in comes back to its own path, which hands GitHub's code on to the app.
    const back = app ? "/auth/github/callback/app" : "/auth/github/callback";
    const cb = await call("GET", `${back}?code=${github}&state=${state}`, { cookie });
    must(cb, "callback", [302]);
    if (app) {
      const code = new URL(cb.headers.get("location") ?? "").searchParams.get("code");
      const r = await call("POST", "/auth/app/session", { body: { code, verifier } });
      must(r, "app session");
      return r.json.session;
    }
    const session = /sb_session=([^;]+)/.exec(cb.headers.get("set-cookie") ?? "")?.[1];
    if (!session) throw new Error("no session cookie");
    return session;
  }

  function newMember(id: string, role: Member["role"]) {
    const keys = generateMemberKeys();
    return { keys, member: { id, role, name: id, ...publicKeys(keys) } as Member };
  }

  // A new GitHub user each try, so a run cut short leaves no half-made account in the way.
  const github = 1 + Math.floor(Math.random() * 2 ** 40);
  const at = `${new Date().toISOString().slice(0, 19)}Z`;
  const phoneSession = await signIn(github, true);
  const me = await call("GET", "/me", { token: phoneSession });
  const account = me.json.account as string;
  const phone = newMember("phone", "device");
  const genesis = genesisEntry({
    account,
    device: phone.member,
    signKey: phone.keys.sign.privateKey,
    recovery: recoveryKeyPair(generateRecoverySeed()),
    at,
  });
  must(
    await call("POST", "/directory", { token: phoneSession, body: { entry: genesis } }),
    "genesis",
  );
  const signer = { id: "phone", signKey: phone.keys.sign.privateKey };

  // The phone pairs a member: the new member's request, the phone's directory entry and
  // approval, then the member's result.
  async function pair(id: string, role: Member["role"], session?: string) {
    const { keys, member } = newMember(id, role);
    const code = newPairingCode();
    const claim = toB64(crypto.getRandomValues(new Uint8Array(32)));
    const request = pairingRequest(
      { v: 1, rendezvous: code.rendezvous, role, id, name: id, ...publicKeys(keys), at },
      code,
    );
    // 429 `busy` too: the server holds at most 20000 pairings from the last 10 minutes,
    // approved ones included.
    must(
      await call("POST", "/pairings", { body: { request, claimHash: claimHash(claim) } }),
      "pair",
    );
    const dir = verifyDirectory(
      (await call("GET", "/directory", { token: phoneSession })).json.entries,
    );
    const added = await call("POST", "/directory", {
      token: phoneSession,
      body: { entry: addEntry(dir, signer, member, at) },
    });
    must(added, "add entry");
    const approval = pairingApproval(
      {
        v: 1,
        rendezvous: code.rendezvous,
        account,
        length: added.json.length,
        head: added.json.head,
        approver: "phone",
      },
      code,
    );
    must(
      await call("POST", `/pairings/${code.rendezvous}/approve`, {
        token: phoneSession,
        body: { approval },
      }),
      "approve",
    );
    const result = await call("GET", `/pairings/${code.rendezvous}/result`, {
      token: session,
      headers: { "x-claim": claim },
    });
    must(result, "result");
    return role === "machine" ? (result.json.token as string) : (session as string);
  }

  const machine = await pair("mac", "machine");
  const web = await pair("web", "device", await signIn(github, false));
  must(
    await call("POST", "/push/subscriptions", {
      token: phoneSession,
      body: { type: "fcm", endpoint: `fcm-${n}` },
    }),
    "fcm",
  );
  // Real Web Push keys: the server encrypts each push for them, as it would for a browser.
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const p256dh = Buffer.from(await crypto.subtle.exportKey("raw", ecdh.publicKey)).toString(
    "base64url",
  );
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  must(
    await call("POST", "/push/subscriptions", {
      token: web,
      body: { type: "webpush", endpoint: `${via.fake}/wp/${n}`, keys: { p256dh, auth } },
    }),
    "webpush",
  );
  return { n, account, phone: phoneSession, machine, web, directory: 3 };
}
