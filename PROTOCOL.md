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
- Each sealed kind has one signing role (`ITEM_KINDS` in `packages/protocol/src/schemas.ts`).
  A machine's items are sealed to every active device; a device's items are sealed to the one
  machine they answer. A kind that refers to an earlier item names it in a body field, which
  `re` repeats:

  | Kind | Signed by | Refers to (`re`) |
  |---|---|---|
  | `decision` | machine | |
  | `answer` | device | `decisionId`, a decision |
  | `quota` | machine | |
  | `permission` | machine | |
  | `permission-answer` | device | `permissionId`, a permission |
  | `settled` | machine | `permissionId`, a permission |

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
| `POST /items` | the kind's signing role | store a sealed item and push it to each recipient; 409 on a reused id; 409 `too-many-items` and 413 `too-large` past the caps in Limits |
| `GET /items?kind=<kinds>&after=<cursor>&open=1` | device | items with only the caller's box, and `cursor`; `kinds` is a comma-separated list of machine-signed kinds, all of them when left out; `open=1` keeps only unanswered decisions and permissions still in their answer window |
| `GET /items/:id` | device, machine | one item, the caller's box only; push points here when the item exceeds 4 KB |
| `GET /quota` | device | the latest quota item from each machine |

Item ids are random, chosen by the sender. Cursors are opaque strings; without `after`, a list
starts at the first item. An item with `re` marks the item it names answered, so every device
moves it out of the open inbox: an answer its decision, a permission answer or a settled notice
its permission.

Lists return `{items: [{item, cursor, receivedAt, answeredAt?}], cursor}`, 100 at a time, where
`item` holds only the caller's box and `answeredAt` is set on answered decisions and permissions.
Marking an item answered moves it past every cursor, so devices listing after their cursor see it
again, answered.
The server keeps only the latest quota item from each machine, and drops old items as Limits says. Refusals: 403 when the caller's
role may not post this kind or `from` is not the caller; 400 `unknown-recipient` when a box goes
to anyone but active devices (machine-signed kinds) or the asking machine (device-signed kinds);
404 when `re` names no such item, one sealed to another device, or one another machine posted;
409 `already-answered` when the item `re` names is answered or settled, 409 `expired` for a
permission answered more than 10 minutes after it arrived, 409 `already-settled` for a second
settled notice.

### Answers for machines (long-poll)

`GET /answers?after=<cursor>&wait=<seconds>` (machine). The server replies at once with
`{items, cursor}` when device-signed items (answers and permission answers) addressed to the
machine came after `cursor`, else holds the request
until one arrives or `wait` (at most 300) passes and replies `{items: [], cursor}`. The Claude Code
mod keeps one such request open and re-opens it on every reply; the CLI's `wait` does the same.
A machine checks that an answer's `decisionId` is one it asked and its `choice` one of the
decision's options; for permission answers, see below.

### Push

| Route | Who | What |
|---|---|---|
| `POST /push/subscriptions` | device | `{type: "fcm" \| "webpush" \| "unifiedpush", endpoint, keys?}` → `{id}`; URL endpoints must be public HTTPS; 409 `too-many-subscriptions` past 10 per device or 30 per account (re-subscribing a known endpoint always works) |
| `DELETE /push/subscriptions/:id` | device | stop pushing there |
| `GET /push/vapid` | anyone | `{publicKey}`: the VAPID key a browser subscribes with (the relay's when this server forwards Web Push) |
| `POST /relay` | another server | relay mode only: `{type: "fcm" \| "webpush", endpoint, keys?, payload}` → `{result: "ok" \| "gone" \| "failed" \| "no-route"}`; rate-limited per IP |

A push payload is JSON text: `{v, kind, id, from, re?, box?}` for a new item, with the device's
own box when the payload stays within 3 KB, else without it and the device fetches
`GET /items/:id`; `{v, kind: "answered", id}` to every device a decision or permission was
sealed to once a device answers it. A settled notice is pushed as a new item. FCM gets it as data field `p`; Web Push and UnifiedPush encrypt it per RFC 8291.

Quota snapshots go to FCM and UnifiedPush only. Browsers expect every Web Push to show a
notification and drop a subscription that keeps showing none (Firefox after 16), so the web page
fetches `GET /quota` when it opens instead. Decisions, permissions, settled notices and
`answered` still go to Web Push.

The server checks that a push URL's host resolves only to public addresses, then connects to the
address it checked, with SNI and the certificate check still on the host name, so a DNS answer
that changes in between cannot point the push inward. Each account has at most 4 pushes in
flight and 200 waiting; each request gives up after 10 s.

A server with FCM credentials or VAPID keys pushes directly. One without them posts to the relay
set in `RELAY_URL` (the owner's hosted server runs with `RELAY_MODE=1`), which pushes with its
own credentials; the payload is already ciphertext or an id. UnifiedPush always goes direct.
`gone` from a push service drops the subscription.

## Local agent API

`starbridge agent` runs once per machine as a user service. It holds the machine's keys and its
one connection to the server, and serves the CLI and the Claude Code sessions on that machine
over HTTP on a unix socket: `$XDG_RUNTIME_DIR/starbridge/agent.sock` on Linux when that is set,
else `agent.sock` in the config directory (`$STARBRIDGE_AGENT_SOCKET` overrides). The directory
is 0700, the socket 0600, and there is no TCP listener. Types: `cli/src/agent/api.ts`.

Every request sends `starbridge-api: <n>` and a `user-agent` such as `starbridge-mod/0.2.0`. The
agent serves revisions `min` to `max` (1 to 1 today) and answers anything else with 426
`{error: "agent-too-old" | "client-too-old", detail, agent: {version, api}}`, `detail` saying
what to update. Adding a route or a field keeps the revision. The CLI falls back to the server on
a 426, and whenever no agent listens (no socket, or a socket nobody listens on); it never falls
back once the agent has answered one of its calls, so nothing is posted twice.

Errors are `{error, detail?}`: 400 for a bad request (`detail` is the CLI's own message), 404
for an unknown route or decision, 502 when the server refused or failed (`detail` says how).
`wait` holds a request at most 25 s, under the 30 s the mod's host allows a call.

| Route | What |
|---|---|
| `GET /status` | `{version, api, pid, startedAt, socket, machine?, server: {reachable, lastOkAt?, lastError?}, quota: {providers, intervalSeconds, lastPostAt?, lastError?}, sessions}` |
| `POST /decisions` | `{input}` with `ask`'s fields (`question`, `default`, `options`, `project`, `session`, …); the client fills `project`, `session`, title and links from its own process → `{id}` |
| `POST /answers/next` | `{id?, wait?}`: the answer to decision `id`, or the first answer no `wait` printed, marked printed → `{answer?, question?, defaultAt?}`; 404 `unknown-decision`. `starbridge wait` |
| `POST /quota` | `{providers?}`: run CodexBar and post a snapshot now → `{snapshot}` |
| `POST /sessions/:id/hello` | `{pid?, cwd?, title?}`: a session starts → `{version}` |
| `POST /sessions/:id/bye` | the session ended; its session-scoped state goes |
| `GET /sessions/:id/events?wait=<s>` | `{events: [{type, ack, line, decisionId?}]}`: what the session has not confirmed, held up to `wait` while there is nothing |
| `POST /sessions/:id/ack` | `{acks}`: confirm events by their `ack`; others' tokens do nothing |

Paths are under `/v1`. Event types today are `answer` and `default` (a decision's default time
passed with no answer, sent only once the server confirmed no answer was waiting at that
time). A client skips types it does not know. The agent keeps answers in the CLI's state file,
so a restart loses nothing unconfirmed.

Features plug in as `Feature`s (`cli/src/agent/server.ts`): routes, the events they hand
sessions, the acks they take, `bye`, a background loop and their part of `status`. #57 adds
`POST /permissions` and a `permission` event, #58 `PUT /controls/:id` and a `control` event,
#60 `POST /runs`.

### Limits

These bound what one account, or one address, can make the server store or do. A rate limit
answers 429 `rate-limited` with `Retry-After` in seconds; a cap answers 409 or 413 with the
code below. Per-address limits count an IPv6 client as its /64.

| What | Limit |
|---|---|
| `POST /items` | 120 a minute per account |
| Stored decisions, open or answered | 10000 per account: 409 `too-many-items` |
| Stored boxes | 128 MB per account, of which machine-signed items may fill all but the last 8 MB: 409 `too-many-items`; 256 KB per machine-signed item and 32 KB per answer or permission answer: 413 `too-large` |
| `POST /directory` | 30 an hour per account |
| Directory entries, revocations included | 200 per account: 409 `directory-full`; 8 KB per entry: 413 `too-large` |
| Sessions | 50 per account; signing in past that ends the oldest, unpaired ones first |
| `GET /auth/github/callback` | 20 a minute per address |
| Pairing messages | 4 KB each: 400 `bad-schema` |
| `GET /pairings/:rendezvous/result` waiting | 4 per pairing: 429 `too-many-waits` |
| `GET /answers` waiting | 32 per machine: 429 `too-many-waits` |
| `POST /push/subscriptions` | 30 a minute per account, on top of the subscription caps |

Answers skip the decision count and may use the last 8 MB, so a full account can still answer. An hourly sweep drops answered
decisions and their answers 7 days after the answer, permissions, permission answers and settled
notices 7 days after they arrived, unanswered decisions and quota snapshots 30
days after they arrived, quota snapshots of revoked machines, and expired sessions. Clients that
want a longer history keep their own copy.

## Permission prompts

When a coding agent stops at a permission prompt, the machine's hook posts a `permission`; a
device can answer it with a `permission-answer`, and the machine posts `settled` once the prompt
is over, however it ended. The prompt stays open at the keyboard and in the Claude app, and the
first answer wins.

- `permission` `{v, id, to, createdAt, agent, tool, summary, description?, input, inputHash,
  suggestions, expiresAt, source}`: `input` is the tool input as JSON text, redacted on the
  machine (provider token patterns, PEM blocks, `*_KEY=` and `*_TOKEN=` values) and at most 8000
  characters; `inputHash` is `hashInput` of the input before redaction (BLAKE2b-256); `expiresAt`
  is at most 10 minutes after `createdAt`. Each of the at most 2 `suggestions`
  `{label, rule, scope: "session" | "project"}` shows the exact rule a wider allow would add.
- `permission-answer` `{v, id, permissionId, to, answeredAt, behavior: "allow" | "deny", scope:
  "once" | "session" | "project", inputHash, message?}`: a deny is for this call only and may
  carry a message to the agent; an allow carries none.
- `settled` `{v, id, permissionId, to, outcome: "keyboard" | "timeout" | "device", device?, at}`:
  `keyboard` covers any answer outside Starbridge (terminal, Desktop, the Claude app);
  `device` names the device whose answer the machine applied.

### Security model

Answering a permission from a phone is a trust decision, so:

- **The answer binds to one call.** It is signed by a device key in the pinned directory and
  names the permission id and repeats its `inputHash`. The machine accepts it only when
  `checkPermissionAnswer` passes: the permission is one it asked and is still waiting, the
  signer is an active device the permission was sealed to, the hash matches, the scope is
  `once` or one the permission offered, and the prompt has not expired. So an answer cannot
  approve a different command, and the server, which reads none of it, can neither forge nor
  replay one. It is single use: the server refuses a second answer, and the machine forgets the
  permission once it is settled. It dies with the prompt, at most 10 minutes; the server refuses
  later answers with 409 `expired`.
- **The machine refreshes the directory before it accepts an allow**, so a revoked device's
  answers are refused as soon as the revocation is in the chain.
- **The device chooses only a scope, never a rule.** The machine keeps the rule behind each
  suggestion; "always" writes only Claude Code's local project settings
  (`.claude/settings.local.json`), never user settings.
- **Allow needs the phone's unlock on Android; deny never does**, since denying is always safe.
  "Always" needs the app open and shows the exact rule.
- **The input is redacted on the machine before sealing**, because it shows on lock screens and
  in notification history.
- **The hook never allows anything by itself.** When it errors, times out or loses the network,
  it answers nothing and the agent's own dialog decides.
- **Opt-in per machine.** Nothing is routed until `starbridge permissions enable`.
