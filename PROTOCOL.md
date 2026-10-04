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
  device member id.
- **Machines** send `Authorization: Bearer <machine token>`, issued when their pairing is
  approved. The server stores a hash of it and drops it when the directory revokes the machine.
- Pairing requests are unauthenticated and rate-limited per IP.

| Route | Who | What |
|---|---|---|
| `GET /auth/github` | anyone | start GitHub sign-in |
| `GET /auth/github/callback` | anyone | finish it, set the session |
| `POST /auth/logout` | device | end the session |
| `GET /me` | device, machine | account id, member id, role |

### Directory

| Route | Who | What |
|---|---|---|
| `GET /directory?from=<seq>` | device, machine | `{entries}` from `seq` on |
| `POST /directory` | device | append `{entry}`; 409 unless its `seq` is the next one |

The server runs `verifyDirectory` before it accepts an entry, to refuse garbage early. Clients
never rely on that check.

### Pairing

| Route | Who | What |
|---|---|---|
| `POST /pairings` | new member | `{request, claimHash}`: the request message and BLAKE2b-256 of a random claim secret's text (`claimHash`); 409 if the rendezvous id is taken |
| `GET /pairings/:rendezvous` | device | `{request}` |
| `POST /pairings/:rendezvous/approve` | device | `{approval}`; the directory must already hold the new member's entry |
| `GET /pairings/:rendezvous/result?wait=<s>` | new member, with `X-Claim: <secret>` | long-poll: `{approval, token?}` once approved, `token` for machines only; 204 when `wait` passes |

### Items

| Route | Who | What |
|---|---|---|
| `POST /items` | machine (decision, quota), device (answer) | store a sealed item and push it to each recipient; 409 on a reused id |
| `GET /items?kind=<kind>&after=<cursor>` | device | items with only the caller's box, and `cursor` |
| `GET /items/:id` | device, machine | one item, the caller's box only; push points here when the item exceeds 4 KB |
| `GET /quota` | device | the latest quota item from each machine |

Item ids are random, chosen by the sender. Cursors are opaque strings; without `after`, a list
starts at the first item. An answer's `re` marks its decision answered, so every
device moves it out of the open inbox.

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
| `POST /push/subscriptions` | device | `{type: "fcm" \| "webpush" \| "unifiedpush", endpoint, keys?}` |
| `DELETE /push/subscriptions/:id` | device | stop pushing there |

A push carries the device's own box when the item fits FCM's 4 KB, else the item id. In relay
mode the server only forwards pushes to FCM for other self-hosted servers; issue #5 defines that
route.
