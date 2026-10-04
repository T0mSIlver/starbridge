# Starbridge protocol, version 1

The server stores and relays ciphertext. Everything clients trust is signed, and the code that
signs, seals and verifies lives in `packages/protocol`; its JSON test vectors in
`packages/protocol/vectors` pin the byte formats for the Kotlin client. This file covers what the
code cannot show: the HTTP API and the flows.

## Formats

- Binary values are base64url without padding. Times are ISO 8601.
- **Signed envelope** `{v, kind, signer, body, sig}`: `body` is JSON text kept exactly as signed;
  `sig` is Ed25519 over `"starbridge/v1/<kind>" NUL signer NUL body`. Verifiers check the
  signature before they parse `body`.
- **Sealed item** `{v, kind, id, from, re?, boxes: [{to, box}]}`: a signed envelope sealed with
  `crypto_box_seal` to each recipient. `kind`, `id`, `from`, `re` and `to` are routing hints for
  the server; clients reject an item whose hints disagree with the signed body.
- Decisions and quota snapshots are signed by a machine and sealed to every active device.
  Answers are signed by a device and sealed to the asking machine.

## Directory

The account's directory is a hash chain of signed entries listing each member's X25519 and
Ed25519 public keys. Entry 0 adds the first device, names the recovery public key, and is signed
both by that device and by the recovery key (`recoverySig`). Each later entry carries `seq` and `prev` (BLAKE2b-256 of the previous
entry's body), and is signed by an active device or by the recovery key. Machines sign no
entries; the recovery key adds only devices. Revoking is an entry too.

Clients replay the chain with `verifyDirectory` and keep a pin `{length, head}`. A later fetch
must extend the pin, so the server can neither insert a key, nor roll back a revocation, nor serve
a chain of its own.

## Pairing

A new member (a machine, or a second device) makes its keys and shows a 24-character code: 8
characters of rendezvous id, then 16 characters (80 bits) of secret that never reach the server.
Both pairing messages carry an HMAC (`crypto_auth`) keyed from the secret.

1. The new member posts its request (role, id, name, public keys) under the rendezvous id.
2. The owner types the code on a device. The device checks the request's MAC, appends an `add`
   entry for those exact keys, and posts an approval `{account, length, head}` with its MAC.
3. The new member checks the approval's MAC, verifies the directory with `{length, head}` as its
   pin, and checks that the directory holds its own keys.

A code expires after 10 minutes. The server could brute-force the secret offline from a MAC, but
80 bits take far longer than that.

## Recovery

The first device shows a 32-byte recovery seed once, as 24 BIP-39 words. When every device is
lost, a new device turns the words into the recovery key pair, verifies the chain with that
public key (entry 0's `recoverySig` must check against it, which a copied public key cannot
fake), and signs its own `add` entry with it.

## HTTP API

Base path `/v1`. JSON bodies. Errors are `{error, detail?}` with an HTTP status; protocol
errors use the codes in `packages/protocol/src/sodium.ts`.

### Auth

- **Devices** sign in with GitHub (hosted) or the owner token from the server's environment
  (self-hosted). The web page holds an HTTP-only session cookie; Android sends
  `Authorization: Bearer <session>`. A session belongs to an account and, once paired, to one
  device member id. A device that signs in again binds the new session by signing a nonce with
  its signing key: `bindMessage` in `packages/protocol`, `"starbridge/v1/bind"` NUL account
  NUL member NUL nonce.
- **App sign-in** follows PKCE (RFC 7636, S256), because any app can claim the `starbridge://`
  scheme. The app keeps a random verifier and sends only its challenge,
  base64url(SHA-256(verifier)). The redirect carries a single-use code, never the session, and
  the app trades code and verifier for the session over HTTPS. Any trade attempt burns the code.
- **Machines** send `Authorization: Bearer <machine token>`, issued when their pairing is
  approved. The server stores a hash of it and drops it when the directory revokes the machine.
- Pairing requests are unauthenticated and rate-limited per IP.
- A session gets its device when that session writes the directory's first entry, or a
  recovery-signed `add`, or fetches its own pairing result (a new device signs in first).
  Revoking a device ends its sessions; revoking a machine drops its token.

| Route | Who | What |
|---|---|---|
| `GET /auth/github` | anyone | start GitHub sign-in; the app adds `?app=1&challenge=<S256 challenge>` |
| `GET /auth/github/callback` | anyone | finish it, set the session; for the app, redirect to `starbridge://auth?code=<code>` instead |
| `POST /auth/app/session` | the app | `{code, verifier}` → `{session}`; 400 `bad-code` when the code is unknown, used, older than 60 s or the verifier does not match; rate-limited per IP |
| `POST /auth/owner` | anyone | self-hosted: `{token}` against `OWNER_TOKEN`; sets the session and returns `{session}` |
| `POST /auth/logout` | device | end the session |
| `GET /auth/challenge` | device | `{nonce, expiresInSeconds}`: one nonce per session, single use, 5 minutes; asking again returns the outstanding one |
| `POST /auth/bind` | device | `{member, sig}`: binds the session to that active device when `sig` checks against its signing key; 400 `no-challenge`, 401 `bad-signature`, 404 for no such active device, 409 `already-paired` when the session holds another device |
| `GET /me` | device, machine | `{account, member, role}`; `member` is null until a device pairs |

### Directory

| Route | Who | What |
|---|---|---|
| `GET /directory?from=<seq>` | device, machine | `{entries}` from `seq` on |
| `POST /directory` | device | append `{entry}`; 409 unless its `seq` is the next one; 403 `machine-cap` past the account's machine limit (5 on the hosted server); 409 `directory-full` past 200 entries |

The server runs `verifyDirectory` before it accepts an entry, to refuse garbage early. Clients
never rely on that check.

### Pairing

| Route | Who | What |
|---|---|---|
| `POST /pairings` | new member | `{request, claimHash}`: the request message and BLAKE2b-256 of a random claim secret's text (`claimHash`); 409 if the rendezvous id is taken; 429 `busy` when the server holds 5000 waiting pairings |
| `GET /pairings/:rendezvous` | device | `{request}` |
| `POST /pairings/:rendezvous/approve` | device | `{approval}`; the directory must already hold the new member's entry; 409 `already-paired` when that member already holds a session or token |
| `GET /pairings/:rendezvous/result?wait=<s>` | new member, with `X-Claim: <secret>` | long-poll: `{approval, token?}` once approved, `token` for machines only; 204 when `wait` passes |

### Items

| Route | Who | What |
|---|---|---|
| `POST /items` | machine (decision, quota), device (answer) | store a sealed item and push it to each recipient; 409 on a reused id; 409 `too-many-items` and 413 `too-large` past the caps in Limits |
| `GET /items?kind=<kind>&after=<cursor>` | device | items with only the caller's box, and `cursor` |
| `GET /items/:id` | device, machine | one item, the caller's box only; push points here when the item exceeds 4 KB |
| `GET /quota` | device | the latest quota item from each machine |

Item ids are random, chosen by the sender. Cursors are opaque strings; without `after`, a list
starts at the first item. An answer's `re` marks its decision answered, so every
device moves it out of the open inbox.

Lists return `{items: [{item, cursor, receivedAt, answeredAt?}], cursor}`, 100 at a time, where
`item` holds only the caller's box and `answeredAt` is set on answered decisions. An answer moves
its decision past every cursor, so devices listing after their cursor see it again, answered.
The server keeps only the latest quota item from each machine, and drops old items as Limits says. Refusals: 403 when the caller's
role may not post this kind or `from` is not the caller; 400 `unknown-recipient` when a box goes
to anyone but active devices (decision, quota) or the asking machine (answer); 409
`already-answered`.

### Answers for machines (long-poll)

`GET /answers?after=<cursor>&wait=<seconds>` (machine). The server replies at once with
`{items, cursor}` when answers addressed to the machine came after `cursor`, else holds the request
until one arrives or `wait` (at most 300) passes and replies `{items: [], cursor}`. The Claude Code
mod keeps one such request open and re-opens it on every reply; the CLI's `wait` does the same.
A machine checks that an answer's `decisionId` is one it asked and its `choice` one of the
decision's options.

### Push

| Route | Who | What |
|---|---|---|
| `POST /push/subscriptions` | device | `{type: "fcm" \| "webpush" \| "unifiedpush", endpoint, keys?}` → `{id}`; URL endpoints must be public HTTPS; 409 `too-many-subscriptions` past 10 per device or 30 per account (re-subscribing a known endpoint always works) |
| `DELETE /push/subscriptions/:id` | device | stop pushing there |
| `GET /push/vapid` | anyone | `{publicKey}`: the VAPID key a browser subscribes with (the relay's when this server forwards Web Push) |
| `POST /relay` | another server | relay mode only: `{type: "fcm" \| "webpush", endpoint, keys?, payload}` → `{result: "ok" \| "gone" \| "failed" \| "no-route"}`; rate-limited per IP |

A push payload is JSON text: `{v, kind, id, from, re?, box?}` for a new item, with the device's
own box when the payload stays within 3 KB, else without it and the device fetches
`GET /items/:id`; `{v, kind: "answered", id}` to every device a decision was sealed to once it
is answered. FCM gets it as data field `p`; Web Push and UnifiedPush encrypt it per RFC 8291.

Quota snapshots go to FCM and UnifiedPush only. Browsers expect every Web Push to show a
notification and drop a subscription that keeps showing none (Firefox after 16), so the web page
fetches `GET /quota` when it opens instead. Decisions and `answered` still go to Web Push.

The server checks that a push URL's host resolves only to public addresses, then connects to the
address it checked, with SNI and the certificate check still on the host name, so a DNS answer
that changes in between cannot point the push inward. Each account has at most 4 pushes in
flight and 200 waiting; each request gives up after 10 s.

A server with FCM credentials or VAPID keys pushes directly. One without them posts to the relay
set in `RELAY_URL` (the owner's hosted server runs with `RELAY_MODE=1`), which pushes with its
own credentials; the payload is already ciphertext or an id. UnifiedPush always goes direct.
`gone` from a push service drops the subscription.

### Limits

These bound what one account, or one address, can make the server store or do. A rate limit
answers 429 `rate-limited` with `Retry-After` in seconds; a cap answers 409 or 413 with the
code below. Per-address limits count an IPv6 client as its /64.

| What | Limit |
|---|---|
| `POST /items` | 120 a minute per account |
| Stored decisions, open or answered | 10000 per account: 409 `too-many-items` |
| Stored boxes | 128 MB per account, of which decisions and quotas may fill all but the last 8 MB: 409 `too-many-items`; 256 KB per decision or quota and 32 KB per answer: 413 `too-large` |
| `POST /directory` | 30 an hour per account |
| Directory entries, revocations included | 200 per account: 409 `directory-full`; 8 KB per entry: 413 `too-large` |
| Sessions | 50 per account; signing in past that ends the oldest, unpaired ones first |
| `GET /auth/github/callback` | 20 a minute per address |
| Pairing messages | 4 KB each: 400 `bad-schema` |
| `GET /pairings/:rendezvous/result` waiting | 4 per pairing: 429 `too-many-waits` |
| `GET /answers` waiting | 32 per machine: 429 `too-many-waits` |
| `POST /push/subscriptions` | 30 a minute per account, on top of the subscription caps |

Answers skip the decision count and may use the last 8 MB, so a full account can still answer. An hourly sweep drops answered
decisions and their answers 7 days after the answer, unanswered decisions and quota snapshots 30
days after they arrived, quota snapshots of revoked machines, and expired sessions. Clients that
want a longer history keep their own copy.
