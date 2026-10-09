# Starbridge protocol, version 1

The server stores and relays ciphertext. Everything clients trust is signed, and the code that
signs, seals and verifies lives in `packages/protocol`; its JSON test vectors in
`packages/protocol/vectors` pin the byte formats for the Kotlin client. This file covers what the
code cannot show: the HTTP API and the flows.

## The web app trusts its server

A browser runs the page the server sends on each load, so a compromised server can send a page
that works against the owner. In a member browser, it uses the browser's keys while it is open,
and where the browser lacks WebCrypto's X25519 and Ed25519, or WebCrypto fails, it can read the keys and keep them.
With them it opens every item sealed to that browser, signs answers and permission answers, and
signs directory entries, since any active device may. So it can add a device of its own, which
every machine then seals new items to, revoke the owner's other devices, or propose a new
recovery key, which only the current key can confirm. A device it adds shows in every device
list, so the owner can spot it and revoke it.

The recovery key passes through the page too, when the web app creates it on a first sign-in and
when the owner types it in to recover or to replace it. A page that sees it can recover the
account, which revokes every other member, and replace the key with one of its own. That works
in a browser that was never a member.

A machine's pairing code passes through the page as well, when the owner opens the machine's
`/pair#<code>` link in a browser or types its code into one (#795). Whoever holds the code can
make the approval's MAC, so the page can approve the machine into a chain the server made, which
lists the machine, and pair a stand-in machine of the same name into the owner's real account.
The server would then relay between the two and read everything the real machine sends. The
machine's check code stops this ("Pairing"): approved from a browser, the machine saves the
pairing only once the owner says the Android app shows the same code beside it, which differs
for a machine the server paired elsewhere. Compared against the web page instead, it proves
nothing, since the server writes that page.

So the checks in this file protect an account against a hostile server only while no browser is
a member, the recovery key never reaches a browser, and machines' check codes are compared on
the Android app. Where that matters, set up the account on the Android app, type the recovery key
only there, and add no browser; or host your own server.

## Known limits

Besides the web app's trust in its server:

- **No forward secrecy.** Device and machine keys stay the same while they are members, and the
  server keeps sealed items for up to 30 days ("Limits"). Whoever later gets a member's private
  key and the stored boxes opens every item still stored for that member.
- **A GitHub session alone can ask to join.** Anyone signed in to the account's GitHub, without
  pairing, can read the directory (names, ids, public keys), post join requests under any name,
  which push a join card to every device ("Joins"). It reads no item. An
  owner who compares digits and approves a join they did not start lets it in, since with nobody
  in the middle the digits match. Approve only a join you started.
- **Items carry no account id.** Replaying an item into another account would need one member
  key in two directories, which no client makes: the web makes fresh keys per account, and
  Android and the CLI hold one account.
- **Times are the sender's clock.** `createdAt`, `at` and `answeredAt` are what the sender says,
  and only permission prompts expire: an open question can be answered any time.
- **A code a device shows can be claimed first** by whoever sees it ("Pairing"); the owner checks
  the requester's name before approving.

## Formats

- Binary values are base64url without padding. Times are ISO 8601.
- **Signed envelope** `{v, kind, signer, body, sig}`: `body` is JSON text kept exactly as signed;
  `sig` is Ed25519 over `"starbridge/v1/<kind>" NUL signer NUL body`. Verifiers check the
  signature before they parse `body`.
- **Sealed item** `{v, kind, id, from, re?, wakeAt?, quiet?, reseal?, blobs?, boxes: [{to, box}]}`:
  a signed envelope sealed with `crypto_box_seal` to each recipient, and for a decision its
  images' blobs. `kind`, `id`, `from`, `re`,
  `wakeAt` and `to` are routing hints for the server; clients reject an item whose hints disagree
  with the signed body. `quiet: true` asks the server to store the item without pushing it.
- Each sealed kind has one signing role (`ITEM_KINDS` in `packages/protocol/src/schemas.ts`).
  A machine's items are sealed to every active device; a device's items are sealed to the one
  machine they answer, and a `snooze` to every active device too. A kind that refers to an
  earlier item names it in a body field, which `re` repeats:

  | Kind | Signed by | Refers to (`re`) |
  |---|---|---|
  | `decision` | machine | |
  | `answer` | device | `decisionId`, a decision |
  | `quota` | machine | |
  | `permission` | machine | |
  | `permission-answer` | device | `permissionId`, a permission |
  | `settled` | machine | `itemId`, a permission or a decision the same machine posted |
  | `run` | machine | |
  | `waiting` | machine | `decisionId`, an open decision the same machine posted |
  | `snooze` | device | `decisionId`, an open decision |

- Every machine-signed body names its `source` (machine, project, session, and optionally the
  session's title and links, and `machineKind`: `server`, `desktop`, `laptop` or `cloud`, for
  its icon). A decision or a permission may name its `agent`, such as `claude-code`, `codex`, `pi`, `opencode`, `cursor` or `antigravity`. Clients accept any agent name (lowercase letters, digits and dashes, at most 40), so a newer machine's agent never makes an item unreadable; an agent a client does not know gets no "Open in" link.
- A decision's links (HTTPS) are part of its signed body. Its images (PNG or JPEG) are sealed once
  for every device (#685): each is a blob in the item's `blobs`, at the index of its entry in the
  body's `images`, made of a random 24-byte nonce then `crypto_secretbox` of the image under a
  random 32-byte key. The body's entry carries that `key` and the blob's `hash`, BLAKE2b-256 of
  `"starbridge/v1/image"` NUL and the blob's bytes, so the signature covers the image and each
  box holds a few dozen bytes per image. A client checks the hash, then opens the blob; one that
  fails either is left out, as a broken image. A push carries no blobs, so the server sends a
  decision with blobs as its id. A re-seal (`reseal`) may leave `blobs` out: the server keeps
  those it stored. `vectors/images.json` holds the cases.
  A decision with `answerIn` is answered on that page (a claude.ai artifact whose button wakes
  the agent), never in Starbridge: it has no options, devices show the page and no answer
  field, and it closes when the machine posts `settled` for it. When it also sets `done: true`,
  devices offer Done beside the page: an answer with `done: true` in place of a choice or text,
  saying the owner answered there, which closes it like any answer (#539).

## Versions

The protocol version is the `v: 1` in every signed body, the `starbridge/v1/` prefix of every
signed or hashed string, and the `/v1` of every route. It names the algorithms too: keys are bare
X25519 and Ed25519, boxes are `crypto_box_seal`, image blobs `crypto_secretbox`, hashes BLAKE2b-256, with no algorithm tag or
suite id. Changing any of them is version 2 (`v: 2`, `starbridge/v2/...`, `/v2` routes), and
members re-pair; nothing changes an algorithm in place. A member's keys change only by revoking it
and adding new ones.

### What a reader keeps

Within version 1 a newer sender may send what an older reader does not know, so a reader:

- ignores a field it does not know;
- reads a string it only displays, when it does not know it, as the neutral case and keeps the
  item: `source.machineKind` as none, a settled notice's `outcome` as none, `waiting.state` as
  `working`, a run's `progress` with another `unit` as no progress, a pace `stage` as `unknown`,
  and a quota alert of another `kind` is left out of its snapshot;
- refuses an item whose value gates behaviour when it does not know it: a directory `op`, a
  member's `role`, a permission answer's `scope` and `behavior`, a session link's `kind`;
- lists only the item kinds it asks for, and ignores a push of a kind it does not know.

A missing field, a value of another type, or a `null` in a field the schema does not make
nullable (#505) still refuses the item, and a writer sends only values it knows. `readable` in
packages/protocol and its Kotlin twin apply these rules to the
body before its schema checks it; `schemas.json` in the vectors holds a case for each, with what
the reader reads (`read`).

## Directory

The account's directory is a hash chain of signed entries listing each member's X25519 and
Ed25519 public keys. Entry 0 adds the first device, names the recovery public key, and is signed
both by that device and by the recovery key (`recoverySig`). Each later entry carries `seq` and `prev` (BLAKE2b-256 of the previous
entry's body), and is signed by an active device or by the recovery key. Machines sign no
entries. An entry's `op` is one of:

| `op` | Signed by | Does |
|---|---|---|
| `add` | an active device | adds a member |
| `revoke` | an active device | revokes a member |
| `recover` | the recovery key | adds a device and revokes every other member, machines included ("Recovery") |
| `recovery` | an active device | proposes a new recovery key ("Replacing the recovery key") |
| `recovery-confirm` | the recovery key | makes the proposed key current |

The recovery key signs nothing else; in particular it revokes no one. A verifier refuses a
chain holding an `op` it does not know, rather than skipping the entry, since a skipped
`recover` or `recovery-confirm` would leave it trusting a revoked device or a replaced key.

Clients replay the chain with `verifyDirectory` and keep a pin `{length, head}`. A later fetch
must extend the pin, so the server can neither insert a key, nor roll back a revocation, nor serve
a chain of its own.

A pin cannot show that a chain is current: a server can hold back entries it has, such as a
revocation, and serve a shorter chain that still extends the pin. Devices therefore sign the
head they hold, `dir: {length, head}`, into each answer and permission answer. A machine keeps
the longest head each device signed, and refuses every device's answer while a device active in
its chain has signed a head that chain does not hold (`holdsHead`): the server is withholding
entries, or serving that device another chain. It reads every answer's head in a reply before it
accepts any, never lets a shorter head replace a longer one, and while refusing delivers nothing it
accepted earlier either; once it stops refusing, it drops undelivered answers whose device the
chain now revokes. It keeps the refused answers, since their devices count them sent, and
checks them again once the server serves the missing entries, or once the recovery key's
`recover` revokes that device (below).

This bounds the attack rather than ending it. A server that withholds a phone's revocation from a
machine can relay that phone's answers only until any other device answers that machine (the ones
a session has not taken by then never reach it); from
then on it must drop every message from the owner's other devices to it, which the owner sees as
answers that never arrive. A machine cannot detect a revocation that no device has told it about,
since the server is its only channel; the revoked device's key can sign any stale head itself.

While a device active in its chain has signed a head that chain does not hold, a machine also
posts nothing new: no question, permission prompt, run, quota snapshot or notice (#794). Its
device list may still hold a device the missing entries revoke, and sealing to it would hand
that device's keys everything the machine sends. The command fails and says the server is
holding back entries; the machine posts again once the server serves them.

A revocation does not end a hold either, on a machine or a device, unless the recovery key made
it (`recover`). A member signs no head past its own revocation, so a chain that revokes a member
before the head that member signed forks from the chain the member saw: a revoked device whose
revocation the server hides can extend a stale chain and revoke the member whose head exposed
it (#794, #813). So a head the chain does not hold keeps counting while a `revoke` entry names
its signer or its `by` (`withheldBy`, whose result names that revocation as `revoked`). When the
owner revoked that member because it signed a false long head:

- on a machine, `starbridge pair --force` pairs it again and forgets the heads it kept;
- the device that signs the revocation forgets the heads that member signed or is named in
  (`forgetHeads`): it knows its own revocation is real;
- any other device that holds names who revoked the member and when, and offers to stop waiting
  for it, which runs `forgetHeads` on the owner's word. A forged revocation shows as signed by a
  device the owner revoked, which they did not make.

Devices run the same check on machines (#362). A machine signs its own head into every item it
posts, `dir: {length, head, by?}`. Before #794 a machine could instead sign a longer head an
active device had signed into an answer, naming that device as `by` (`headToSign`). A device
keeps the longest head each machine signed, apart for each `by` it lists, and in one slot per
machine for any `by` it does not list (`noteHead`), so storage stays bounded. It keeps no head
naming a `by` its chain lists as revoked, so a head the owner told it to forget does not come back
when that item is read again; a fork served before the head could as well revoke the machine,
whose items then open no more. The web app also keeps the members the owner told it to forget,
and keeps no head they signed or are named in, even from a read begun on an older chain. While a head its chain does not hold counts, it refuses every
machine's items and says the server is holding back directory entries; a head counts while its
machine is listed in the device's chain and no `recover` came after a revocation of the machine
or its `by`: the recovery key's `recover` revokes every member and ends every earlier hold. A `by` the chain does not list counts: its `add` may be what the server holds back, as
when the owner revokes from a new phone. Before holding, a device reads the directory once more,
since a machine may simply have signed an entry made elsewhere since its last read. It reads the
items again once the server serves those entries, or once the owner stops waiting. Reading the
directory and revoking keep working meanwhile. The device names both members, and says to revoke
the machine first: a compromised machine can name any `by`, such as the owner's own phone.

So one machine that holds a withheld revocation exposes it to every device whose items from that
machine the server delivers, and one that has only seen the head of the device that made it
stops posting. A server that
withholds it from every machine, and drops the revoking device's answers, keeps it hidden, as it
does from a device that gets items only from the revoked machine. A member that is compromised
but not yet revoked can sign a false long head and hold every device's items until the owner
revokes it and stops waiting on each device that saw the head, which the owner sees; machines
that saw the head post nothing until they are paired again. The server itself can always hold items back.

The head is optional: an item without one opens and counts neither for nor against a hold. The
head is part of the signed body, so the server can neither strip nor change it.

In the inbox, a device applies a `settled` or `waiting` notice only to items of the machine that
signed it, so a revoked machine cannot mark another machine's questions closed. A notification can
still close on a notice from any machine, as it does on the server's own `answered` push.

## Pairing

A new member (a machine, or a second device) makes its keys and shows a 24-character code: 8
characters of rendezvous id, then 16 characters (80 bits) of secret that never reach the server.
Both pairing messages carry an HMAC (`crypto_auth`) keyed from the secret.

1. The new member posts its request (role, id, name, public keys) under the rendezvous id.
2. The owner types the code on a device. The device checks the request's MAC, appends an `add`
   entry for those exact keys, and posts an approval `{account, length, head}` with its MAC, and
   `check` when it read a machine's check key from its QR (below).
3. The new member checks the approval's MAC, verifies the directory with `{length, head}` as its
   pin, and checks that the directory holds its own keys.

A code expires after 10 minutes. The server could brute-force the secret offline from a MAC, but
80 bits take far longer than that.

Either side may make the code. A machine prints its own as text, as a link
`<server>/pair#<code>` that opens the web page with the code filled in (`pairingLink`,
`codeFromLink`; the fragment never reaches the server), and as a QR code for the Android app
(below). An existing device can instead show a
code as a QR code: the new phone scans it and posts its request under it, and the device, which
waits on `GET /pairings/:rendezvous?wait=`, checks the MAC and asks the owner to approve. Anyone
who sees the code can post first, so the device shows the requester's name before approving, as
with a typed code.

A machine's check code shows that the machine joined the owner's own chain (#795). `checkCode`
is the first 80 bits of `BLAKE2b-256("starbridge/v1/check" NUL body NUL sig)` over the `add`
entry that added the machine, its body and its signature as sent, as 16 Crockford base32
characters in four groups. That body holds the machine's keys and name, and through `prev` the
whole chain before it. The Android app and the web page show each active machine's code under
Devices, computed from the chain they verified.

The machine's QR code carries a check key, 80 bits as 16 Crockford base32 characters, in a link
no browser opens: `starbridge://pair?server=<server>&k=<key>#<code>` (`appPairingLink`,
`newCheckKey`, `checkKeyFromLink`). Only the Android app handles `starbridge:` links, so the key
never reaches a page the server writes. The printed link and code leave it out. An Android app that read the key adds `check` to its approval:
`crypto_auth` over the same bytes `checkCode` hashes, keyed by
`BLAKE2b-256("starbridge/v1/check-key" NUL key)` (`checkProof`). The machine then, after it
verified the chain:

- with a `check` that verifies over its own `add` entry, saves the pairing;
- with a `check` that does not, saves nothing: the app wrote another entry;
- with no `check` (a browser, a typed code, an app that predates it), shows its code and saves
  the pairing once a person answers that the Android app shows the same. With no terminal, the
  answer comes from `starbridge pair --confirm` or `--reject`. A no, or no answer within 10
  minutes, saves nothing.

A hostile server that read the pairing code in a browser can approve the machine into a chain it
controls, even one that reuses the owner's entries and forks after them with a revoked device's
key or an old recovery key, and put a stand-in in the owner's chain, even one with the machine's
own public keys, since a pairing request proves no private key. The stand-in's `add` entry and
the machine's differ in their `prev` or their contents, so the codes differ unless the server
finds an entry whose code matches 80 bits of one the owner's device wrote. The signature keeps
it from searching both sides at once: it can predict the body of the entry the owner's device
will write, but not that device's signature. Without the check key, it cannot make a `check`
the machine accepts, and stripping the app's `check` only makes the machine ask.

Limits: a member browser lets a hostile page write both entries and search for a
pair that matches, about 2^40 tries; and the code proves nothing to a device that itself paired
or joined through a browser, which the server could have put in a chain of its own. The web page
shows the codes too, but a hostile server writes that page.

## Joining by digits

A browser or phone signed in to the account can join without a code: the owner compares 6 digits
on both screens, a short authentication string (SAS) with a commitment, as in ZRTP and Matrix's
SAS verification. Code: `packages/protocol/src/join.ts`; vectors: `vectors/join.json`.

1. The joining device makes an ephemeral X25519 key pair `j` and posts its request text `R`
   (JSON of `{v, join, account, id, name, boxPk, signPk, at}`) with
   `commitment = BLAKE2b-256("starbridge/v1/join-commit" NUL j.pk R)`.
2. The server relays the request to the account's devices: a long-poll for open pages and apps,
   and a push `{v, kind: "join", id}`. The owner taps Compare digits on one device, which makes
   its own ephemeral key pair `a` and posts `a.pk`. The server accepts one approver key per join.
3. The joining device reveals `j.pk`, only after it has `a.pk`, and answers no later approver
   key. The approver checks `j.pk` and `R` against the commitment it read before posting `a.pk`.
4. Both compute `s = X25519(own secret, peer public)`, refused when all zero, and
   `T = j.pk a.pk R`. The MAC key is `BLAKE2b-256(key = s, "starbridge/v1/join-mac" NUL T)`; the
   digits are the first 4 bytes of `BLAKE2b-256(key = s, "starbridge/v1/join-sas" NUL T)`,
   big-endian, mod 10^6, as 6 digits.
5. The owner checks that both screens show the same digits and confirms on both: Approve on the
   approver, They match on the joining device. The approver appends the `add` entry for the keys
   in `R` and posts the approval `{v, join, account, length, head, approver}` with `crypto_auth`
   under the MAC key, over `"starbridge/v1/join-approval" NUL body`. The joining device holds
   any approval until its owner confirmed, then checks the MAC, verifies the directory with
   `{length, head}` as its pin, and checks that it holds its own keys, as after a code.

A server in the middle must give the approver a commitment of its own before it sees `a.pk`, and
must send the joining device an approver key before it learns `j.pk`, so it cannot pick keys that
make the two screens agree: each attempt matches with probability 10^-6, and each needs the owner
to tap Compare digits. The MAC proves only that whoever sent the approver key approved, which
in that attack is the server, so the joining device counts it only once its own owner has seen
the digits match. Without the approval's MAC the joining device trusts no directory.

## Recovery

The first device shows a 16-byte recovery seed once, as a recovery key: the seed and a 12-bit
check (the first 12 bits of BLAKE2b-256 of "starbridge/v1/recovery-check", NUL, the seed), 140
bits written as 28 Crockford base32 characters in seven groups of four (`recoveryKey`). The
recovery key pair is `crypto_sign_seed_keypair` of BLAKE2b-256 of "starbridge/v1/recovery-seed",
NUL, the seed (`recoveryKeyPair`).

`readRecoveryKey` reads a key in any case, with or without dashes and spaces, O as 0 and I or L
as 1; it names the first character no key holds, else a length other than 28, else a failed
check. The length is the format's version: a future format uses another length.

When every device is lost, a new device turns the key into the recovery key pair,
verifies the chain with that public key (it must be the chain's current recovery key, whose
`recoverySig` checks against it, which a copied public key cannot fake), and signs a `recover`
entry with it, which adds the new device and revokes every other member, machines included. A
recovering device holds no pin unless it was a device of the account before, so the server can
serve it a chain cut short of a revocation; since `recover` revokes every earlier member, a fork
made that way cannot bring a revoked one back. The owner pairs the devices and machines they
still have again from the recovered device, through pairings or joins that pin its chain.

### Replacing the recovery key

An owner who thinks someone saw the key replaces it from one of their devices, with the current
key, in two entries:

1. `{op: "recovery", recoveryPk}` proposes a new key. An active device signs it, and the
   envelope's `recoverySig` is the new key's signature over the same body, as signer "recovery",
   as on entry 0. Its `recoveryPk` is no member's key and no recovery key the chain named before,
   current, proposed or retired. A later proposal replaces a pending one, and revoking the
   proposing device drops its proposal.
2. `{op: "recovery-confirm", proposal, recoveryPk}` names the pending proposal's `seq` and key,
   and makes that key the chain's recovery key. The current recovery key signs it. Naming the key
   means a proposal slipped in after the owner's, by a stolen device not yet revoked, cannot be
   the one confirmed.

Both keys sign, so neither a stolen device nor a leaked key can replace the key alone: the key is
what gets the owner back after a theft, so a thief must not be able to take it over. An owner who
lost the key cannot replace it; their devices keep working, and the app says so.

From the confirming entry on, the old key signs nothing on any chain that holds the
confirmation. A device that holds no pin can still be served a chain cut short of it, where the
old key still recovers; the owner's devices, which pin their chain, refuse such a fork, and
recovering with the new key on it fails with `wrong-recovery-key`. A member whose pin
predates the confirmation, offline or served a withheld tail, accepts such a fork as an
extension, but it is revoked there like every member: the fork reveals nothing and costs a
re-pairing, which a malicious server can force anyway. Every other device shows the
replacement once, as "Recovery key replaced on <proposing device>, <time of the confirming
entry>".

## HTTP API

Base path `/v1`. JSON bodies. Errors are `{error, detail?}` with an HTTP status; protocol
errors use the codes in `packages/protocol/src/sodium.ts`. Outside `/v1`, `GET /healthz`
answers anyone with `ok`; `/healthz/backup` and `/healthz/disk` answer `ok`, or 503 when the
last backup is stale or the disk runs low.

Every request names its client and release in `starbridge-client: <name>/<version>`, `name`
one of `cli`, `android`, `web`, `mod` and `desktop` (the desktop app's page), `version` MAJOR.MINOR.PATCH with an optional
pre-release, which comes before its release (`cli/0.1.0`, `android/0.2.0-rc.1`). The server counts the
releases in use, and keeps a minimum release per client name: below it, any route answers 426
`{error: "client-too-old", detail, client, minimum}`, and the client asks its owner to update. A
request without the header, or with one the server cannot read, is served.

### Auth

- **Devices** sign in with GitHub (hosted) or the owner token from the server's environment
  (self-hosted). The web page holds an HTTP-only session cookie; Android sends
  `Authorization: Bearer <session>`. A session belongs to an account and, once paired, to one
  device member id. A device that signs in again binds the new session by signing a nonce with
  its signing key: `bindMessage` in `packages/protocol`, `"starbridge/v1/bind"` NUL account
  NUL member NUL nonce.
- **App sign-in** follows PKCE (RFC 7636, S256), because any app can claim the `starbridge://`
  scheme. The app keeps a random verifier and sends only its challenge,
  base64url(SHA-256(verifier)), which the server passes to GitHub as `code_challenge` and as the
  state. GitHub binds its code to the challenge, and the app trades code and verifier for the
  session over HTTPS; the app ignores a redirect whose state is not its challenge, or with none.
  GitHub
  redirects to `/v1/auth/github/callback/app`, which the Android app claims as an App Link on
  starbridge.run (`/.well-known/assetlinks.json` binds it to the app's signing keys). When the
  browser gets the redirect instead, the server hands code and state on to `APP_REDIRECT_URI`:
  `starbridge://auth` by default, and on starbridge.run the App Link
  `https://starbridge.run/app/auth`, whose page has an "Open Starbridge" button to
  `starbridge://auth`.
- **Machines** send `Authorization: Bearer <machine token>`, issued when their pairing is
  approved. The server stores a hash of it and drops it when the directory revokes the machine.
- A session with no device yet can read the directory and post joins, but reads and posts no
  item ("Known limits").
- Pairing requests are unauthenticated and rate-limited per IP.
- A session gets its device when that session writes the directory's first entry, or a
  recovery-signed `add`, or fetches its own pairing result (a new device signs in first).
  Revoking a device ends its sessions, which then get 401 `revoked` instead of
  `unauthenticated` until they would have expired; revoking a machine drops its token.

| Route | Who | What |
|---|---|---|
| `GET /auth/methods` | anyone | `{methods}`: the sign-in methods this server offers, `github` and `owner` |
| `GET /auth/github` | anyone | start GitHub sign-in; the app adds `?app=1&challenge=<S256 challenge>`; without GitHub on the server, the page goes to `/?signin=off` and the app gets 404 `not-configured` |
| `GET /auth/github/callback` | anyone | finish it, set the session, redirect to `/`; on failure redirect to `/?signin=declined`, `expired` (state missing or not this browser's, kept an hour), `paused` (sign-ups paused and no account yet), `limited` (too many new accounts from the address) or `failed` |
| `GET /auth/github/callback/app` | anyone | the browser got the app's sign-in: redirect to `<APP_REDIRECT_URI>?code=<code>&state=<state>`, or GitHub's `error` instead of the code; 400 `bad-state` without them |
| `POST /auth/app/session` | the app | `{code, verifier}`: GitHub's code → `{session}`; 400 `bad-code` when GitHub refuses the code: unknown, used, expired or not this verifier's; 403 `signups-paused` while sign-ups are paused and the GitHub user has no account |
| `POST /auth/owner` | anyone | self-hosted: `{token}` against `OWNER_TOKEN`; sets the session and returns `{session}` |
| `POST /auth/logout` | device | end the session |
| `GET /auth/challenge` | device | `{nonce, expiresInSeconds}`: one nonce per session, single use, 5 minutes; asking again returns the outstanding one |
| `POST /auth/bind` | device | `{member, sig}`: binds the session to that active device when `sig` checks against its signing key; 400 `no-challenge`, 401 `bad-signature`, 404 for no such active device, 409 `already-paired` when the session holds another device |
| `GET /me` | device, machine | `{account, member, role}`; `member` is null until a device pairs |

### Directory

| Route | Who | What |
|---|---|---|
| `GET /directory?from=<seq>` | device, machine | `{entries}` from `seq` on |
| `POST /directory` | device | append `{entry}`; 409 unless its `seq` is the next one; 403 `machine-cap` past the account's machine limit (3 on the hosted server; devices don't count); 409 `directory-full` for an add or a recovery proposal past 200 entries, beyond their budgets ("Limits") |

The server runs `verifyDirectory` before it accepts an entry, to refuse garbage early. Clients
never rely on that check.

### Pairing

| Route | Who | What |
|---|---|---|
| `POST /pairings` | new member | `{request, claimHash}`: the request message and BLAKE2b-256 of a random claim secret's text (`claimHash`); 409 if the rendezvous id is taken; 429 `too-many-pairings` when the caller's address holds 50 unapproved pairings, 429 `busy` when the server holds 20000 pairings |
| `GET /pairings/:rendezvous?wait=<s>` | device | `{request}`; with `wait`, holds until the new member posts and answers 204 if `wait` passes first |
| `POST /pairings/:rendezvous/approve` | device | `{approval}`; the directory must already hold the new member's entry; 409 `already-paired` when that member already holds a session or token |
| `GET /pairings/:rendezvous/result?wait=<s>` | new member, with `X-Claim: <secret>` | long-poll: `{approval, token?}` once approved, `token` for machines only; 204 when `wait` passes; 403 `machine-cap` once the server refused the new machine's directory entry for the machine limit |

### Joins

A join is `{id, request, commitment, state, approver?, approverKey?, joinerKey?, approval?,
createdAt, expiresAt, version}`; `state` is `open`, `comparing`, `approved` or `cancelled`, and
`version` grows with each change. A join expires after 10 minutes.

| Route | Who | What |
|---|---|---|
| `POST /joins` | unpaired device session | `{request, commitment}` → `{join}`; the request must name the caller's account; a new join cancels the session's open one; pushes `{v, kind: "join", id}` to the account's devices; 409 `already-paired`, 409 `taken` |
| `GET /joins?after=<cursor>&wait=<s>` | device | `{joins, cursor}`: the open joins; holds until one changes past `after` |
| `GET /joins/:id?after=<version>&wait=<s>` | the joining session, device | `{join}`; holds until its `version` passes `after` |
| `POST /joins/:id/approver` | device | `{key, approver}`: `approver` is the caller; 409 `taken` once another key is in |
| `POST /joins/:id/reveal` | the joining session | `{key}`; 409 `not-ready` before an approver key, 400 `bad-commitment` when the key does not open the commitment |
| `POST /joins/:id/approve` | the approver | `{approval}`; the directory must hold the new device's entry; binds the joining session to it; 409 `not-ready`, `not-in-directory`, `already-paired` |
| `DELETE /joins/:id` | the joining session, device | cancel |

### Items

| Route | Who | What |
|---|---|---|
| `POST /items` | the kind's signing role | store a sealed item and push it to each recipient; 409 on a reused id; 409 `too-many-items` and 413 `too-large` past the caps in Limits; 403 `account-suspended` from a machine of an account the operator suspended (every machine write gets it; reads still pass) |
| `GET /items?kind=<kinds>&after=<cursor>&open=1` | device | items with only the caller's box (and a decision's blobs), and `cursor`; `kinds` is a comma-separated list of machine-signed kinds and `snooze`, the machine-signed ones when left out; `open=1` keeps only unanswered decisions and permissions still in their answer window |
| `DELETE /items/:id` | device | drop a run sealed to the caller, for every device (#827); 404 for any other kind, or a run already gone |
| `GET /items/:id` | device, machine | one item, the caller's box only, with a decision's blobs; push points here when the item is over the inline limit (3 KB by default) |
| `GET /quota` | device | the latest quota item from each machine |
| `GET /quota/senders` | device, machine | `{senders: [{id, receivedAt}]}`: each active machine with a quota item, and when its latest arrived; never the item |
| `POST /quota/ask?wait=<s>` | device | ask every machine for a fresh quota snapshot → `{askedAt, behind}`; with `wait`, holds until each active machine that has a snapshot posted a newer one; `behind` counts those that have not |

Item ids are random, chosen by the sender. A machine re-posts a run under its id as it changes;
the server replaces the earlier post and moves it past every cursor. It also re-posts an open
decision or permission under its id with `reseal: true`, re-signed to the active devices, when a
device joined since it was posted; the server replaces it only while it holds it unanswered (404
once dropped), keeps its `receivedAt`, and pushes only the devices that had no box yet. Any other reused id, or a
reused id posted by another machine or as another kind, is 409 `duplicate-id`; re-posting an
answered decision or permission is 409 `already-answered`. Cursors are opaque strings;
without `after`, a list starts at the first item. An item with `re` marks the item it names
answered, so every device moves it out of the open inbox: an answer its decision, a permission
answer its permission, a settled notice the permission or decision it closes. A `waiting` item
and a `snooze` are the exceptions: they describe their decision and close nothing.

Lists return `{items: [{item, cursor, receivedAt, answeredAt?}], cursor}`, 100 at a time, where
`item` holds only the caller's box and its routing hints as posted, `wakeAt` included, and `answeredAt` is set on answered decisions and permissions.
Marking an item answered moves it past every cursor, so devices listing after their cursor see it
again, answered.
The server keeps only the latest quota item from each machine, and drops old items as Limits says. Refusals: 403 when the caller's
role may not post this kind or `from` is not the caller; 400 `unknown-recipient` when a box goes
to anyone but active devices (machine-signed kinds) or the asking machine (device-signed kinds;
a `snooze` goes to the asking machine and every active device);
404 when `re` names no such item, one sealed to another device, or one another machine posted;
409 `already-answered` when the item `re` names is answered or settled, 409 `expired` for a
permission answered more than 10 minutes after it arrived, 409 `already-settled` for a second
settled notice, 409 `duplicate-id` for a `waiting` item under another id than its decision's
first one, 400 `bad-schema` for a `wakeAt` on any kind but `snooze`, or a `snooze` without one or
with one more than 7 days ahead.

### Answers for machines (long-poll)

`GET /answers?after=<cursor>&wait=<seconds>&kinds=<kinds>` (machine). The server replies at once
with `{items, cursor}` when device-signed items addressed to the machine came after `cursor`,
else holds the request
until one arrives or `wait` (at most 300) passes and replies `{items: [], cursor}`. `kinds` is a
comma-separated list of device-signed kinds, all of them when left out. The Claude Code
mod keeps one such request open and re-opens it on every reply; the CLI's `wait` does the same.

Each reply also carries `directory`, the number of entries in the account's directory, and
`quotaAsked`, when a device last asked for fresh quotas (`POST /quota/ask`), if one did since
the server started. A machine that sends back `directory=<n>&quotaAsked=<time>` with what it
knows gets a reply at once when the directory is longer or a device asked since, and every
directory append ends its open waits. So the machine's agent re-reads the directory as soon as a
device joins and posts a fresh snapshot sealed to it, and posts one when a device asks.
A machine checks that an answer's `decisionId` is one it asked, still open, and with
`answerIn` exactly when the answer is `done`, that its signer is one of the devices the decision was sealed to, and that its
`choice`, if any, is one of the decision's options. It never delivers an answer to a decision it
settled, even one it accepted before, since the server could have held it back until then. An answer carries one of `choice`, `text` and `done`: a decision with options that sets
`replies: true` also takes a typed `text` reply, which clients offer as "Reply" under the
options. For permission answers, see below.

### Push

| Route | Who | What |
|---|---|---|
| `POST /push/subscriptions` | device | `{type: "fcm" \| "webpush" \| "unifiedpush", endpoint, keys?}` → `{id}`; URL endpoints must be public HTTPS; 409 `too-many-subscriptions` past 10 per device or 30 per account (re-subscribing a known endpoint always works) |
| `DELETE /push/subscriptions/:id` | device | stop pushing there |
| `GET /push/vapid` | anyone | `{publicKey}`: the VAPID key a browser subscribes with (the relay's when this server forwards Web Push) |
| `POST /relay` | another server | relay mode only: `{type: "fcm" \| "webpush", endpoint, keys?, payload}` → `{result: "ok" \| "gone" \| "failed" \| "no-route"}`; rate-limited per IP; 503 `busy` with `Retry-After` while the server has 16 relayed Web Pushes in flight, or the address 4 |

A push payload is JSON text: `{v, kind, id, from, re?, wakeAt?, box?}` for a new item, with the device's
own box when the payload stays within 3 KB, else without it and the device fetches
`GET /items/:id`; `{v, kind: "answered", id}` to every device a decision or permission was
sealed to once a device answers it; `{v, kind: "join", id}` to every device when a join is posted.
A settled notice, a `waiting` item and a `snooze` are pushed as new items; a `snooze` once more
at its `wakeAt` ("Snoozing"). FCM gets it as data field `p`; Web Push and UnifiedPush
encrypt it per RFC 8291.

A quota snapshot asks for a push only when it raises an alert: the uploader marks that alert
`notify: true` and posts every other snapshot `quiet`. It raises each alert (a kind, and for
`low` a threshold) at most once per window per reset. Each device decides from its own
settings whether to show it.

Quota snapshots and runs go to FCM and UnifiedPush only. Browsers expect every Web Push to show a
notification and drop a subscription that keeps showing none (Firefox after 16), so the web page
fetches `GET /quota` and `GET /items?kind=run` instead. Decisions, permissions, settled notices,
waiting states, snoozes and `answered` still go to Web Push.

The server checks that a push URL's host resolves only to public addresses, then connects to the
address it checked, with SNI and the certificate check still on the host name, so a DNS answer
that changes in between cannot point the push inward. Each account has at most 4 pushes in
flight and 200 waiting; each request gives up after 10 s.

A server with FCM credentials or VAPID keys pushes directly. One without them posts to the relay
set in `RELAY_URL` (starbridge.run runs with `RELAY_MODE=1`), which pushes with its
own credentials; the payload is already ciphertext or an id. UnifiedPush always goes direct.
`gone` from a push service drops the subscription.

### Presence and settings

| Route | Who | What |
|---|---|---|
| `PUT /presence` | device, machine | `{present}`: whether the owner sits at this screen ("Held pushes") → 204 |
| `GET /settings` | device | the account's settings, `{pushHold}`: seconds a push waits while the owner is present, 30 unless set |
| `PUT /settings` | device | `{pushHold}`, 0 to 300 → the settings as stored |

### Limits

These bound what one account, or one address, can make the server store or do. A rate limit
answers 429 `rate-limited` with `Retry-After` in seconds; a cap answers 409, 413 or 429 with
the code below. Per-address limits count an IPv6 client as its /64, unless the row says /48. A
server whose disk is full answers writes 503 `storage-full` with `Retry-After`; reads go on.

| What | Limit |
|---|---|
| `POST /items` | from machines: 90 a minute per machine and 120 per account, and 16 MB of machines' boxes a minute per account, items that replace earlier ones included, a post that does not fit what is left refused; from devices: 60 a minute per device |
| Stored decisions, open or answered | 10000 per account: 409 `too-many-items` |
| Unanswered decisions kept 30 days | 1000 per account: past that, they are dropped 7 days after they arrived |
| Stored permission prompts, open or settled | 10000 per account: 409 `too-many-items` |
| Stored runs | 500 per account: 409 `too-many-items` for a new run; updates still pass |
| A snooze | until at most 7 days after it is posted (`SNOOZE_MAX_MS`), since an unanswered decision drops after 30: 400 `bad-schema` |
| A `wakeAt` | 40 characters, stored as sent and outside the byte budget (#713): 400 `bad-schema` |
| Stored items | 256 MB per account, counting each item's boxes and blobs plus 512 bytes for the item and for each box, of which machine-signed items may fill all but the last 8 MB: 409 `account-full`; 2 GB on the whole server, past which machine-signed items get 503 `storage-full` with `Retry-After` while answers pass; 2 MB per machine-signed item (all its boxes and blobs; only a decision carries blobs, at most 4 of 512 KB), 1 MB per quota snapshot, 32 KB per run update for each device it is sealed to, in each device's box, and 32 KB per answer or permission answer: 413 `too-large` |
| `POST /directory` | 30 an hour per account |
| Directory entries | from entry 200 on, a device's `add`: 409 `directory-full`; revocations and confirmations always pass, the recovery key may add 20 more devices, and devices may propose 20 more recovery keys; 8 KB per entry: 413 `too-large` |
| Sessions | 50 per account; signing in past that ends the oldest, unpaired ones first |
| `GET /auth/github/callback` and `POST /auth/app/session` | 60 a minute per address, together |
| New accounts | 30 an hour per address, an IPv6 client counting as its /64: the page goes to `/?signin=limited`, the app gets 429 `rate-limited`; sign-ins of existing accounts don't count |
| `POST /auth/owner` | 10 a minute per address |
| `GET /auth/challenge` | 20 a minute per account |
| `POST /pairings` | 30 a minute per address; 50 unapproved pairings per address, an IPv6 client counting as its /48: 429 `too-many-pairings` |
| `GET /pairings/:rendezvous` | 30 a minute per account |
| `GET /pairings/:rendezvous/result` | 150 a minute per address: 50 waiting pairings polling every 25 s |
| Pairing messages | 4 KB each: 400 `bad-schema` |
| `GET /pairings/:rendezvous/result` and `GET /pairings/:rendezvous?wait=` waiting | 4 per pairing: 429 `too-many-waits` |
| `POST /joins` | 10 a minute per account; request text 4 KB: 400 `bad-schema` |
| `GET /joins` waiting | 16 per account; `GET /joins/:id` waiting: 4 per join: 429 `too-many-waits` |
| `GET /answers` waiting | 32 per machine: 429 `too-many-waits` |
| `POST /quota/ask` | 6 a minute per account |
| `PUT /presence` | 10 a minute per device or machine |
| `PUT /settings` | 30 a minute per account |
| `POST /push/subscriptions` | 30 a minute per account, on top of the subscription caps |
| `POST /relay`, on a relay server | 120 a minute per address |

The directory cap stops the chain growing, since every client replays all of it, without
locking the owner out: revoking a lost member stays possible, and each member is revoked once,
so revocations never outnumber adds; an owner who lost every device can still recover. A chain
is therefore at most about 440 entries. Nothing compacts it: a full account starts a new one
through the operator.

Answers skip the decision count and may use the last 8 MB, so a full account can still answer. An hourly sweep drops answered
decisions and their answers 7 days after the answer, permissions, permission answers and settled
notices 7 days after they arrived, runs a day after their last update, a decision's waiting state and snooze with its decision, unanswered decisions and quota snapshots 30
days after they arrived (unanswered decisions 7 in an account holding more than 1000 of them), quota snapshots of revoked machines, and expired sessions. Each kind's
period is its `keep` in `ITEM_KINDS`, which every new kind must name. Clients that want a longer
history keep their own copy.

## Waiting state

Agents never answer a question for the owner, so a decision has no default time. Instead it
shows whether its agent is blocked on it: working on other things, or waiting for the owner.

- `waiting` `{v, id, decisionId, to, at, state: "working" | "waiting"}`: the machine posts it
  under one id per decision and re-posts it under that id whenever the agent flips the state,
  until the decision is answered or settled. Devices keep the update with the latest `at`; a
  decision without one is `working`.
- Each flip pushes: to `waiting` it notifies once more, and back to `working` it lets a device
  move or quiet the question's notification without a sound. A repeated state posts nothing.
- A decision asked already waiting is posted `quiet` and its `waiting` item pushes, so the one
  notification says the agent waits. A device that has not seen the decision fetches it with
  `GET /items/:id`.
- A client that does not know the kind never lists it (lists name their kinds) and ignores
  its push.

## Snoozing

The owner can put an open decision off until a time (#571): "not now, show me this again at
18:00". A snooze is not an answer. For the agent it means what no answer means, and it closes
nothing.

- `snooze` `{v, id, decisionId, to, until, at, dir?}`: a device signs it, under a new id each
  time, and seals it to the machine that asked and to every active device, so each one hides the
  decision. The latest `at`, compared as instants, wins, whichever device sent it. `until` at or
  before `at` brings the decision back now. The server cannot read `at`, so it keeps each snooze
  (at most 50 per decision), and a replayed id is 409 `duplicate-id`.
- The item's `wakeAt` hint repeats `until`, so the server learns that some decision was put off
  until then, and nothing else. At each snooze's `wakeAt` it pushes that snooze once more to
  every device; a device shows the decision's notification again, once, only when that snooze is
  the latest it knows. While the snooze that came last is pending, the server pushes no `waiting`
  item of that decision: the agent's flips are silent. An answer, Done or a settled notice
  cancels every pending push, and a stopping server sends the pushes it queued first.
- The server refuses a snooze once its decision is answered or settled (409 `already-answered`),
  one whose `wakeAt` is more than 7 days ahead, and one whose `wakeAt` comes after the sweep
  drops an unanswered decision (30 days after it arrived; 400 `bad-schema`).
- Devices list `snooze` with the machine-signed kinds. A device that does not know the kind never
  lists it and ignores its push, so it shows the decision as open; a machine reads it only when
  it asks for it in `GET /answers?kinds=`.
- On the machine, `starbridge waiting <id>` and `starbridge wait <id>` say when the decision is
  snoozed (`wait` exits 3, once per snooze); nothing wakes the agent.

## Held pushes

A question that shows in the agent's own picker and on the owner's screen needs no push to the
phone as well (#848). So while the owner sits at a screen, the push of an item that asks for them
waits a little, and goes only if nothing answered it meanwhile.

- **Presence.** A machine or a device sends `PUT /presence {present: true}` every 30 s
  (`PRESENCE_BEAT_MS`) while the owner sits at its screen, and `{present: false}` once they no
  longer do. It decides that where it reads it, and sends only the bit: a machine, its screen
  unlocked with input in the last minute (`isPresent`); a web page, visible with an input event on
  it in the last minute, or in the desktop app, its Mac unlocked with input in the last minute
  once the owner turned that on, and never while the Mac is locked or asleep; the Android app, in
  front and touched in the last minute. Tabs of one
  browser share its device, so an idle tab says nothing while another tab is in use. A refused
  beat is tried again a beat later. The server
  keeps each source's bit in memory, trusts a `true` for 75 s (`PRESENCE_VALID_MS`), and counts
  the account present while any source is. A restart forgets it: push at once.
- **What waits.** A machine's `decision`, `permission` or `waiting` item that asks for a push,
  posted while the account is present and its `pushHold` is not 0. Its push goes at once to the
  devices that are themselves present, and waits `pushHold` seconds for the others. A re-seal's
  new devices wait the same way; those that already waited keep their time.
- **When the hold ends**, within a few seconds, the server pushes the item to the
  devices it held it from, if it is still open: a permission unanswered, a decision, or a
  `waiting` item's decision, unanswered and not snoozed. The hold is stored with the item, so a
  restart delays it by no more than the restart.
- **Closed during the hold**, an item never pushes the devices it held it from, nor the
  `answered` push or the settled notice that closes it: they never heard of it. A snooze posted
  during the hold skips them too, and a snoozed item's hold ends without a push. When the snooze
  wakes, it pushes them as well, so the answer and settled notice reach them from then on (#908).
- **Devices** list a held item at once, as any other: only its push waits.

## Runs

An agent wraps a command in `starbridge run --title --reason -- <command>` when it blocks the
owner or needs them at the machine, or when one of the owner's rules names it (`cli/README.md`). The machine posts a `run` when the command starts,
re-posts it as the output shows progress (at most every 10 s) and at least every minute, and a
last time when the command exits.

- `run` `{v, id, to, title, reason, source, startedAt, at, progress?, exit?}`: `at` is when the
  machine sent this update, and devices keep the update with the latest `at`. `progress`
  `{done, total, unit: "step" | "percent"}` is the last progress the output printed: `[3/7]` as
  steps, `42%` or an OSC 9;4 progress sequence as a percent out of 100. `exit` `{code, at}` is
  set once the command exited, `code` being 128 + n when signal n ended it.
- A running run with no update for 3 minutes (`RUN_STALE_MS`) lost its machine: devices stop
  showing it as running.
- A device dismisses a run with `DELETE /items/:id`, and every device drops it from its list on
  its next read. The server cannot tell a finished run from a running one, so devices offer it
  only for finished and lost runs; a machine that posts the run again brings it back.

## Permission prompts

When a coding agent stops at a permission prompt, the machine's hook posts a `permission`; a
device can answer it with a `permission-answer`, and the machine posts `settled` once the prompt
is over, however it ended. The prompt stays open at the keyboard and in the Claude app, and the
first answer wins.

- `permission` `{v, id, to, createdAt, agent, tool, summary, description?, input, inputHash,
  suggestions, expiresAt, source}`: `input` is the tool input as JSON text, redacted on the
  machine (provider token patterns, PEM private keys, `Authorization` headers, URL passwords, and
  `*_KEY`, `*_TOKEN` or `*_PASSWORD` values) and at most 8000 characters; `inputHash` is `hashInput` of the input before redaction: BLAKE2b-256 keyed with BLAKE2b-256 of `"starbridge/v1/input-hash"` keyed with the machine's signing key, so a device cannot test guesses for a redacted value; `expiresAt`
  is at most 10 minutes after `createdAt`. Each of the at most 2 `suggestions`
  `{label, rule, scope: "session" | "project"}` shows the exact rule a wider allow would add.
- `permission-answer` `{v, id, permissionId, to, answeredAt, behavior: "allow" | "deny", scope:
  "once" | "session" | "project", inputHash, message?}`: a deny is for this call only and may
  carry a message to the agent; an allow carries none.
- `settled` `{v, id, itemId, to, at, outcome?: "keyboard" | "timeout" | "device" | "elsewhere" |
  "withdrawn", device?, behavior?: "allow" | "deny", choice?, text?}` closes any item its machine
  posted, a permission or a decision. For a permission, `keyboard` covers any answer outside
  Starbridge (terminal, Desktop, the Claude app) and `device` names the device whose answer the
  machine applied, with `behavior` saying whether it allowed or denied. For a decision,
  `elsewhere` means it was answered outside Starbridge and `withdrawn` that the agent no longer
  needs it; `device`, posted once the machine accepts a device's answer, names that device and
  repeats its `choice` or `text`, neither for a Done. An answer is sealed only to the machine, so this notice is how
  the other devices learn which answer won, for instance when two answered at once. Devices
  show it after the decision is answered, whenever it arrives; clients that predate the two
  fields ignore them.

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
  answers are refused as soon as the revocation is in the chain, and refuses every answer while
  another device has signed a longer chain than the server serves it (Directory, above).
- **The device chooses only a scope, never a rule.** The machine keeps the rule behind each
  suggestion; "always" writes only Claude Code's local project settings
  (`.claude/settings.local.json`), never user settings.
- **Allow needs the phone's unlock on Android; deny never does**, since denying is always safe.
  "Always" needs the app open and shows the exact rule.
- **The input is redacted on the machine before sealing**, because it shows on lock screens and
  in notification history. Redaction hides only single tokens: a value holding spaces, quotes,
  `$`, backticks or shell operators stays visible, so it cannot hide code the owner allows. A
  Bash command holding a private key stays at the keyboard. A wider scope is offered only when
  its rule shows in full, with no redaction.
- **The hook never allows anything by itself.** When it errors, times out or loses the network,
  it answers nothing and the agent's own dialog decides.
- **Opt-in per machine.** Nothing is routed until `starbridge config permissions on` (setup
  asks, default no); while off, the hook exits at once.
- **One secret, two uses.** The key behind `inputHash` is derived from the machine's Ed25519
  secret key with BLAKE2b, a PRF, and only that derived key touches the input, so the signing
  key and the hash key stay apart.

### On the machine

`starbridge hook permission --agent claude-code` runs as Claude Code's `PermissionRequest` hook;
the Starbridge Pi extension runs it with `--agent pi` from its link in pi-permission-system's
authorizer chain, with the same input shape (Pi's tool name, no suggestions, so an allow is once).
It posts the prompt through the agent (or to the server itself when no agent runs) and waits
at most `--wait`, 570 s by default, under the 600 s Claude Code gives a hook. An accepted
answer prints the hook's decision: `allow`, with `updatedPermissions` built from Claude Code's
own suggestions for a wider scope (destination `session`, or `localSettings` for the project),
or `deny` with the message, or with one saying the owner denied it when the answer has none. Only `addRules` allow rules and `addDirectories` are offered, and
only when their rules fit the 500-character `rule` in full; `setMode` and other suggestions stay
at the keyboard. Before printing, the machine marks the prompt settled, then posts `settled:
device`; without an agent it gives that post 5 s, and SIGTERM or the deadline during it still end
the hook with no answer. Every request the hook makes, the prompt's own post included, ends at SIGTERM or the
deadline, through the agent or not, so a stalled server never holds the agent's dialog back. The
Pi extension stops a CLI that ran 600 s, kills one still running 10 s after it was stopped, and
defers either way.

The keyboard can answer first. Esc or No sends the hook SIGTERM; it posts `settled: keyboard`
and exits. A keyboard Yes sends no signal, so `starbridge hook settle` runs on `PostToolUse`,
`PostToolUseFailure` (the call ran and failed) and `PermissionDenied`, settling the session's waiting prompt whose `inputHash` matches the call's
input (Claude Code's `PermissionRequest` input carries no `tool_use_id`), and on `Stop` and
`SessionEnd`, settling every waiting prompt of the session. The waiting hook then exits at
once through the agent, or within 5 s on its own path. At the deadline the hook prints nothing,
so the dialog decides, and posts `settled: timeout`.

## Local agent API

`starbridge agent` runs once per machine as a user service. It holds the machine's keys and its
one connection to the server, and serves the CLI and the Claude Code sessions on that machine
over HTTP on a unix socket: `$XDG_RUNTIME_DIR/starbridge/agent.sock` on Linux when that is set,
else `agent.sock` in the config directory (`$STARBRIDGE_AGENT_SOCKET` overrides). The directory
is 0700, the socket 0600. Types: `cli/src/agent/api.ts`.

On Windows (#552), Node and Bun read a socket path as a named pipe, which other local users can
open, so the agent listens on a free port on 127.0.0.1 instead. It writes `agent.port`,
`{port, token, pid}`, into the config directory through a temporary file that `icacls` makes
readable by its user only. `token` is 32 random bytes, new at each start, and never crosses the
wire. Each request sends a fresh 16-byte nonce as `starbridge-nonce: <32 hex>` and
`authorization: Starbridge <sha256hex("<token>:client:<nonce>")>`; the agent answers any other
with 401 `{error: "unauthorized"}`, and every answer to a proven request carries
`starbridge-proof: <sha256hex("<token>:agent:<nonce>")>`. A client takes an answer without that
proof as no agent: whatever took the port after the agent stopped learns nothing it can use and
cannot answer for it. (SHA-256 rather than HMAC, since the mod's host has no HMAC; the fixed
shape leaves a length extension nothing to forge.) A client sends nothing while `pid` runs no
more (#570): the CLI, the mod and the Pi and opencode extensions all check it before each call. An address ending in `.port` names such a file on any platform.

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
| `POST /decisions` | `{input}` with `ask`'s fields (`question`, `options`, `waiting`, `agent`, `project`, `session`, …); the client fills `project`, `session`, title and links from its own process, for Codex `codex` (`{home, bin}`: its `CODEX_HOME` and `codex` binary), and for Pi `piAnswers: true` while the Starbridge Pi extension runs in the session, for `claude -p` `headless: true` → `{id, delivery}`: `prompt` when the answer will come back into the session as a prompt (Claude Code's mod, when that session's mod called the agent within 45 s, which `claude -p` never does; the Pi extension; Codex, which the agent reaches with `codex queue` while the session's app-server daemon listens; that message names the decision and `starbridge wait <id>`, never its text, since process arguments are readable by other local users), else `wait` |
| `POST /decisions/:id/waiting` | `{state: "working" \| "waiting"}` → `{posted, snoozedUntil?}`: post the decision's waiting state, `posted: false` when it already had it; `snoozedUntil` while the owner has snoozed it; 404 `unknown-decision`, 400 when it is answered. `starbridge waiting`, `working` |
| `POST /answers/next` | `{id?, session?, wait?}`: the answer to decision `id`, or the first answer no `wait` printed to a decision session `session` asked, marked printed → `{answer?, question?, snoozedUntil?}`; with `id` and no answer, `snoozedUntil` once per snooze while the owner has snoozed it; 404 `unknown-decision`. `starbridge wait` |
| `POST /answers/all` | `{since?, known?, wait?}`: every accepted answer the asking sessions may have, answered from `since` (ms since the epoch) on, leaving out the decision ids in `known`, held up to `wait` while there is none; marks nothing seen → `{answers: [{decisionId, question, choice? \| text? \| done?, answeredAt, session?, sessionTitle?, project?}]}`. `starbridge answers --all` |
| `POST /quota` | `{providers?}`: run CodexBar and post a snapshot now → `{snapshot}` |
| `POST /runs` | `{run}`: seal one update of a `starbridge run` to every device and post it; `run` is `{id, title, reason, startedAt, at, progress?, exit?, project, session, sessionTitle?, links?}` → `{id}` |
| `POST /sessions/:id/hello` | `{pid?, cwd?, title?, replaces?}`: a session starts → `{version}`; `replaces` names the id it had before a `/clear`, which the agent no longer counts as having a mod (#537) |
| `POST /sessions/:id/bye` | the session ended; its session-scoped state goes |
| `GET /sessions/:id/events?wait=<s>` | `{events: [{type, ack, line, decisionId?}]}`: what the session has not confirmed, held up to `wait` while there is nothing |
| `POST /sessions/:id/ack` | `{acks}`: confirm events by their `ack`; others' tokens do nothing |
| `POST /permissions` | `{hook, agent, source: {project, session, sessionTitle?, links?}, waitMs}`: post a permission prompt from the hook's input → `{id}`; 403 `disabled` until `starbridge config permissions on` |
| `POST /permissions/:id/wait` | `{wait}`: `{output}` once an accepted answer is in, the hook's stdout, handed out once; `{settled}` when the prompt ended another way; `{}` when `wait` passed; a hook that hangs up mid-hold and holds no more within 5 s is gone, and the prompt settles as `keyboard` |
| `POST /permissions/:id/settle` | `{outcome: "keyboard" \| "timeout"}` → `{settled}`: the hook's wait ended without an answer |
| `POST /sessions/:id/permissions/settle` | `{inputHash?}` → `{settled: [ids]}`: the keyboard answered the session's waiting prompt for that input, or all of them without `inputHash` |

Paths are under `/v1`. The one event type today is `answer`. A client skips types it does not
know. The agent keeps answers in the CLI's state file,
so a restart loses nothing unconfirmed.

Features plug in as `Feature`s (`cli/src/agent/server.ts`): routes, the events they hand
sessions, the acks they take, `bye`, a background loop and their part of `status`.
