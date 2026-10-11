# Keys and trust

- **Libraries.** libsodium sealed boxes (`crypto_box_seal`) and Ed25519: libsodium.js on the web,
  Lazysodium on Android. On the web, sealed boxes open with WebCrypto's X25519 plus HSalsa20 from
  `@noble/ciphers` (audited), since libsodium.js's standard build lacks it. Not libsignal: AGPL,
  and its ratchets solve chat problems Starbridge does not have.
- **Members.** Every device (phone, browser) and machine (where agents run) makes an X25519 and an
  Ed25519 key pair. Private keys never leave it.
- **Sign, then seal.** A signature covers the JSON body text as sent, so nothing re-serializes
  JSON. Each sealed kind has one signing role (`ITEM_KINDS`).
- **The directory** is a hash chain (BLAKE2b) of signed entries that clients pin, so the server
  cannot add its own key or roll the chain back past what a client saw. The recovery key co-signs
  the first entry. Clients refuse a chain with an `op` they don't know rather than skip it, since
  skipping could keep a replaced key or a revoked device trusted: every client must update before
  anyone uses a new `op`.
- **Directory cap** (#260). From entry 200 the server refuses a device-signed `add`
  (`directory-full`) but always takes a revocation and up to 20 recovery entries, so a lost
  machine can still be revoked and an owner can still recover. Recovery entries have caps of
  their own, so the chain stays bounded. No compaction: a checkpoint would need a new trust rule for pins.
- **Pairing.** A pairing code carries an 80-bit secret the server never sees, which keys an HMAC
  on both pairing messages. A device signed in to the account can instead join by digits (a
  6-digit short authentication string with a commitment, as in ZRTP and Matrix SAS), by scanning a
  QR code, or through the link `starbridge pair` prints (#66). Both screens confirm the digits
  (#355): otherwise a server in the middle could forge an approval to the joining device. The CLI
  never joins by digits. The digits derive from the approving device's key, so the joining screen
  shows none until a device already in the account opens the request, and says to open one
  (#1117). A joining phone can also scan a browser's join QR code, which is another request, not
  an approval: the server refuses the second request (`taken`), and the phone says to show a QR
  code from Add a device instead.
- **A machine's check code** (#795). A pairing code that reaches a browser lets a hostile server
  approve the machine into a chain it controls, which no device in that chain can expose. The
  check code, 80 bits of a hash of the machine's `add` entry, tells the chains apart. It covers the
  entry rather than the keys: a pairing request proves no private key, so a stand-in can copy the
  machine's keys, and a fork can keep the owner's entry 0. The entry's `prev` ties it to the
  chain, and its signature, which the server cannot predict, stops a search for two entries that
  match. The machine's QR carries a second secret, the check key, and an Android app that scanned
  it proves with it which entry it wrote, so the machine saves the pairing without asking: the
  code never reached a browser on that path, and the owner should not have to do anything. Every
  other path (a browser, a typed code, Android 0.1.0) ends with the machine showing the whole
  code and asking `Same code? [Y/n]`, Enter for yes, if the Android app shows the same; the
  browser shows it too, after Approve, for an owner with no app. Tom chose one keypress over
  typing a group, and Enter over `y` (2026-10-08), accepting that an agent running setup, or a
  stray Enter, can confirm it. The QR code is text with no scheme, read by the app's own scanner
  as WhatsApp's in-app scan is (#1099): the check key lets the machine skip the question, so it
  must reach that scanner alone, and a phone's camera shows the text instead of opening an app
  with it. An https link would hand the key to the server on a phone without the app (Tom,
  2026-10-08). Without that scanner, the owner opens the printed link or types the code, and the
  machine asks.
  Devices shows a machine's code, as "Same code as on the machine?", only while the machine
  can still ask: for `CHECK_CONFIRM_MS` (10 minutes, in `packages/protocol`) from its `add`
  entry, the time `starbridge pair` waits for an answer (#939). After that the code answers no
  question, and a line nobody needs reads as one to act on.
  A phone without the app opens the printed link or types the code instead, and the machine
  asks. The code stays after `#`, where Android 0.1.0's scanner reads it, so that scanner still
  pairs (and the machine asks); 0.1.0's camera opens nothing until the app updates.
- **The recovery key** is a random 16-byte seed shown as 28 Crockford base32 characters with a
  12-bit check, in seven groups of four, read in any case, with or without dashes (#199). 128 bits
  is Ed25519's own security level; the seed is random, so it needs no slow key derivation:
  BLAKE2b-256 of `"starbridge/v1/recovery-seed" NUL seed` stretches it to an Ed25519 seed. It is not
  shown as words: a new site that shows 12 words and later asks for them back looks like
  seed-phrase phishing, and Chrome flagged starbridge.run for it. No page says "seed" or "phrase".
- **The recovery key can be copied or saved to a password manager, never screenshotted** (#817).
  Android's key screens block screenshots, screen sharing and the recents thumbnail
  (`FLAG_SECURE`): a screenshot lands in the photo library and its cloud backup, where nobody
  looks for a secret. Copy puts the key on the clipboard marked sensitive, so keyboards and the
  clipboard preview hide it, and clears it after a minute if it still holds the key (or if the app,
  in the background, can't tell). Save to password manager goes through Credential Manager, not
  the share sheet: Google Password Manager takes no shared text and Bitwarden turns it into a
  Send, while a saved password reaches all three of Google's, Bitwarden and 1Password. Without
  either, owners had no way to save the key but typing it out. The web already had Copy.
- **The first entry is posted only once the owner confirms the key is saved** (#328, #370). The web
  never stores the key; Android keeps the seed in its encrypted store until that confirmation. A browser marks its device posted before it posts the genesis, so an empty
  directory after that is the server's doing, and the keys stay (#371).
- **Replacing the recovery key** (#348) takes two entries: `recovery` proposes a key, signed by a
  device and the new key; `recovery-confirm` makes it current, signed by the current key and naming
  the key it confirms. It always needs the current key: letting a second device confirm would let
  a stolen phone, which can add a device of its own, take the key over. An owner who lost the key
  keeps their devices and has no key.
- **Recovering** writes a `recover` entry that adds the device and revokes every other member,
  machines included (#363, #364). A recovering device holds no pin, so a server could serve it a
  chain cut short of a revocation; revoking everyone means no fork keeps a revoked member. The
  owner then pairs what they still have again. The recovery key never signs a `revoke` or a plain
  `add`. A retry after a lost reply keeps the first attempt's keys (#274) only while the chain
  lacks that member or a `recover` entry added it: a server holding an old device's key could
  serve a fork where that device added the same member, and skipping the `recover` entry would
  keep it in (#1132).
- **Withheld revocations** (#280, #362). A member cannot tell a current directory from one the
  server cut short, so detection is on contact, both ways. Devices sign the directory head they
  hold into each answer (`dir`); a machine refuses every device answer while an active device has
  signed a head its chain lacks. Machines sign `dir` into every item; a device re-reads the
  directory, then holds every machine's items (shows none, notifies nothing, sends no answer)
  while a machine has signed a head its chain lacks. Machines before #794 also passed on heads
  they got from devices; such a head counts even when the chain doesn't list that device yet.
  The hold names the machine and the device and says to revoke the machine first, since a
  compromised machine can name the owner's own phone. Settings and revoking keep working. A
  machine that knows of a longer head posts nothing (#794). Closing the gap fully needs a
  channel the server does not carry.
- **A revocation ends no hold** (#794, #813). A member signs no head past its own revocation, so
  a chain that revokes the member whose head shows the gap is a fork: a revoked device whose
  revocation the server hides can make one. A head therefore keeps counting while a `revoke`
  names its signer or its `by`; only a `recover` ends it. The way out after revoking a member
  that forged a long head: `starbridge pair --force` on a machine; on a device, revoking from it
  forgets that member's heads, since that device knows its own revocation is real, and any other
  device's hold names who revoked the member and offers "I revoked it: stop waiting". Only the
  owner can tell their revocation from a forged one. Tom chose this over a button on every
  device, or none, on 2026-10-08 (#813).
- **Browser keys** (#8, #116, #274, #283, #354). Non-extractable WebCrypto keys in IndexedDB,
  read back once after writing, with raw libsodium keys where they don't return (WebKit reads an
  X25519 `CryptoKey` back as null). A join or recovery keeps its keys under `pending` until the
  directory lists them, and pins before it saves the device. With no pin, a browser trusts only a
  genesis its own device signed. A browser that signs in again binds the session to its device by
  signing a server nonce.
- **Revoked members.** Only the verified chain revokes a browser (#310): a 401 `revoked` is
  unsigned, so the page keeps its keys. Once the chain shows it revoked, the browser deletes its
  keys, answers and push subscription, keeps the pin, and says which device removed it (#343).
  Android wipes only on a verified chain that revokes the phone (#44). A revoked machine gets 401
  on its next long-poll (#353). A machine drops the answers of a device the chain revokes that its
  sessions have not taken yet, on every poll and before `answers` or `wait` hands one out, against
  a fresh directory or, out of reach of the server, the saved one (#491). The server holds that
  decision answered, so the machine closes it: `wait` says its answer came from a device removed
  since, and `settle` posts nothing (#515). The asking session gets no line, so an agent told its
  answer comes back as a prompt is not told.
- **Android keys** (#9) sit in files wrapped by a Keystore AES key usable while the screen is
  locked, so lock-screen buttons can sign. Signing out revokes the phone unless it is the last
  device.
- **Versions** (#468, #469, #478, #551, #737). 0.1.0-rc.2, for which the hosted database was reset
  before launch, is the compatibility floor, so nothing carries code for a database, stored
  setting, client or server before it: the schema starts at one migration, `ask` refuses
  `--default` and `--default-at` rather than ignoring them, and clients, setup and the CLI dropped
  what served earlier releases. One exception: a CLI state file without `v` still reads as format
  1, since the owner's machines keep such files through the reset. Later compatibility branches
  name the minimum client release that retires them (`// until min cli >= 1.2`). An algorithm
  changes only with a new protocol version (`v: 2`, `starbridge/v2/...`, `/v2` routes) and members
  re-pair; keys change only by revoke and add.
- **Readers keep what newer senders add** (#472; PROTOCOL.md, "What a reader keeps"). A string a
  client only displays reads as its neutral case when unknown: no machine kind, no outcome,
  `working`, no progress, pace `unknown`; an alert of an unknown kind is left out. Readers do this
  on the raw body before the schema check (`readable`, with a Kotlin twin), so the schemas stay
  strict for writers: a missing field or a value of another type still refuses the item on every
  client. Values that gate behaviour stay closed. Reader-side content limits stay until the
  screens cope with longer text. Android keeps a machine's last good quota snapshot when a new
  one fails to open. Android re-checks Allow when a notification's button is tapped, which is not
  about old clients: the owner may turn off sending unseen commands after the post.
- **Signed text is the record** (#476). Android keeps each item's body as the text its machine
  signed and parses it on read; the parsed body is a cache, never written back, so a field a later
  app learns is already in what the phone kept, and nothing re-reads open questions. An item
  whose text no longer parses is dropped at load. The web stores no bodies; the CLI stores only
  bodies it wrote.
- **Nulls** (#505). A `null` in a field the schema does not make nullable refuses the item on every
  client, as zod does. Android, whose classes read null as absent, checks each declared field
  after `readable()` and ignores fields it does not declare, as zod strips them.
- **Local state carries its format** (#473), and a file a client cannot read is kept, never silently
  replaced. The CLI writes `v: 1` into `machine.json`, `directory.json` (`{v, entries}`),
  `agent.json` and `state.json`; a file without `v` is format 1, and one that is not JSON, not an
  object or newer stops the command with its path and what to do; `latest.json`, only a cache of
  GitHub's answer, moves aside instead, as Android's files do (#1174). Android writes `v` into
  `state.bin` and `secrets.bin` and a format byte ahead of the Keystore blob; the two describe one
  device, so when either cannot be read both move to `<name>.unreadable-<time>` and the app starts
  signed out and says so. The iPhone app writes `v` into `saved.json`; when that file cannot be
  decoded, it moves to `saved.json.unreadable-<time>`, the keychain item's secrets move to a second
  item with the same tag, and the app starts signed out and says so. A file it cannot read at all,
  as before the first unlock, or cannot move stays, and the app writes nothing until a launch can
  (#1159). Quota settings write their defaults, so a later default never changes a saved choice. The
  web writes `v` into its localStorage values and leaves a newer format alone; a damaged one, or one
  without `v`, is replaced at the next change, since it holds only display choices. IndexedDB's own
  version is the records' format, and sign-out removes every record kind of the account.
- **Old clients** (#468). Every client names its release in `starbridge-client:
  <name>/<version>` (`cli`, `android`, `web`, `mod`, `desktop`, `ios`; MAJOR.MINOR.PATCH). The server refuses
  releases below `MINIMUM_RELEASES` in `server/src/clients.ts` (empty at launch; a pre-release
  counts below its release) with 426 `client-too-old`, and serves a request without the header,
  so curl and scripts keep working. The CLI then says to run `starbridge update` and exits 1; the
  web shows one "Starbridge was updated" screen with Reload; Android shows an error that names
  Google Play. The server and page deploy from main ahead of any tag, so main serves every release
  from the minimum up and changes the protocol only by adding to it; a minimum rises only to a
  final that has been the latest release for 14 days, once the update nudge has reached machines
  and Play testers have moved past its rcs (#1070). Usage counts each member's first release of the day once
  (`active.clients.<name>.<major>.<minor>`), so made-up versions add one row a day.
