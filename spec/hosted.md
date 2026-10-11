# The hosted instance

- **Stack** (`deploy/`): Docker Compose with Caddy on the host network, so rate limits see real
  client addresses. Caddy keeps connections to the server open (`keepalive 25s`, below the
  server's 30 s idle close) so TIME-WAIT sockets don't use up ports (#376). A client has 10 s for
  its TLS handshake and its HTTP/1.1 request headers, since every open connection costs Caddy
  memory, the VPS's first limit (#587). Caddy compresses every
  response and the web app none: Next's gzip ran on its one thread and filled it near 18 landing
  page visitors a second (#593). Nightly SQLite backups, kept 7 days (#586).
- **Per-address pages and sign-ups** (#787). Caddy takes 600 page requests a minute per address
  outside `/v1` and `/_next/static`: each is Next rendering, 10 to 17 ms of CPU, and a visit with
  its link prefetches makes a few dozen. The server makes at most 30 new accounts an hour per
  address: each account may store 256 MB, so many GitHub accounts behind one script could fill
  the server's 2 GB, while an office or a carrier's NAT signs up a handful an hour.
- **Ready for Cloudflare's proxy** (#799). starbridge.run's DNS is on Cloudflare in DNS-only
  mode; its proxy is the emergency answer to a flood from many addresses, which no per-address
  rule stops. So that turning it on changes nothing else: Caddy takes the client's address from
  `CF-Connecting-IP` only on requests from Cloudflare's published ranges, and every rate limit,
  the block list, the server's per-address limits (through `X-Forwarded-For`, which Caddy sets to
  that address alone) and Umami use it; and long-polls return within 90 s, under the proxy's
  100 s cut. Clients already treat a cut long-poll, or Cloudflare's 524, as a reconnect.
- **Per-address reads** (#582). Caddy counts every `/v1` request per address, 3000 a minute
  (IPv6 per /64): most reads count against no account, so this keeps a looping client or script
  to about 2% of a core. A visible page with a prompt waiting and a run live makes about 200 a
  minute and a heavy user about 600, so five heavy users can share an office's address.
- **Capacity** (#301, #625). On the production stack capped to the VPS's two cores and 4 GB,
  memory runs out first: each signed-in user with a machine and an open page holds two
  long-polls, which cost about 300 KB in Caddy, 60 KB in the server and 55 KB in docker-proxy
  (Caddy's hop to the server's published port), so about 5000 such users fit; CPU stays under
  one core. A new visitor to the landing page costs about 50 ms of CPU across Next and Caddy
  once Caddy compresses (#593), so the VPS serves 15 to 20 a second.
- **Machines** (#658). A hosted account takes 3 machines, the computers that run agents, and any
  number of phones and browsers; self-hosting sets its own (`MAX_MACHINES`, default 5). Each
  machine holds a long-poll, about 200 KB on the VPS, and 3 covers a laptop, a desktop and a
  server. Raising it later is a setting nobody notices; lowering it would strand accounts above
  it. Devices need no cap of their own: the directory holds at most 200 entries, an account's
  pages hold at most 16 join-list long-polls, and Caddy limits each address's requests (#582).
  Every item's text is sealed once per device, so its size grows with their number: a run update
  is capped per device for that reason, and a question with 8000 characters of context fits up to
  about 140 devices in its 2 MB. Its pictures are stored once whatever the number (#685), and
  shrink only to leave the boxes room.
- **Watching it** (#782). Caddy keeps no access log, so the server logs one line a minute of its
  refusals by status, error code and route, with the accounts refused most, and never an
  address. Per-address request and 429 counts stay in its memory, like the rate limits, and only
  the host reads them, through the container's own loopback (port 8081, `GET /watch`). The launch watcher (`deploy/watch/`) reads
  those, `ss`, `docker` and `bun server.js top` over SSH every few minutes and names an address
  only when it holds over 200 connections or is being rate-limited (the owner's rule): at
  Caddy's cap of 3000 `/v1` requests a minute (2900 seen by the server, since Caddy logs no
  refusal), or refused with 429 by the server: an HTTP/2 client can flood over few connections, and every
  other visitor's address would end up in the on-call session's transcript.
- **Blocking an address** (#783). The owner can refuse an address or range at Caddy, by a reload
  that keeps open connections (`deploy/host/switch.sh`), with a 403 that names abuse@. An IPv6
  address is blocked as its /64, as the rate limits count it, and nothing wider than a /8 (IPv4)
  or /32 (IPv6) is accepted. The block list is the one place an address is written to disk, until
  it is unblocked; `/privacy` says so.
- **Suspending an account** (#785). The owner can suspend one account whose machines flood the
  server (a looping agent, or abuse) without deleting it: its machines' writes get 403
  `account-suspended`, which the CLI prints with its reason, while they still read and wait, and
  its phones and browsers work as before, so its owner can still answer, settle and revoke.
  `bun server.js suspend|unsuspend ACCOUNT`, stored as `accounts.suspended_at` (migration 2).
- **Limits at runtime** (#786). The owner can tighten or loosen a rate window or a cap without a
  deploy (`bun server.js limits set items 60/60`, `set maxMachines 4`, `unset`, `reset`): the
  overrides sit in `limits.json` beside the database, which the server reads every minute, so they
  survive restarts and deploys until unset. Retention periods are left out, since shortening one
  deletes data at the next sweep. A file that does not parse keeps the limits as they were.
- **Privacy and terms** (`/privacy`, `/terms`). Each claim follows the code: stored columns in
  `server/src/db.ts`, retention in `server/src/limits.ts`, logs and backups in `deploy/`. A change
  to what is stored changes the page, and the Play data-safety form. Contact is
  privacy@starbridge.run; abuse@ appears only in `/terms`.
- **Analytics** (#141). Umami, self-hosted, on the landing page, the docs, `/privacy` and `/terms`
  only. No cookie, no stored IP, a daily salt, Do Not Track honoured, so no consent banner. The
  Android app sends none (Play data safety form); the server sends a new account's launch funnel
  steps, whichever app took them (below). Caddy rate-limits its open endpoint, and an hourly
  timer keeps each table to 180 days and a million rows, so it cannot fill the disk (#574).
- **Launch funnel** (#559, #590). The landing page sends its view and a sign-in click. The server
  sends a new account's steps: first sign-in (with the app it came from), recovery key saved,
  first machine, second device, first answer (with the app that sent it). The server sees each
  step whichever app takes it, and no blocker stands between it and Umami: when the page sent
  them, accounts made on Android or the desktop app, or behind a blocker, sent nothing, and 3 of 5
  accounts at launch were missing. The server posts them to Umami's collect endpoint, only during
  an account's first two days and not for a request that sends Do Not Track, with `/` as the page
  and, as Umami's visitor id, a hash of the account id, so each account's steps of a day form one
  visit; nothing else about the account goes with them (`server/src/funnel.ts`). These visits
  are not joined to the landing visit, so the funnel has two parts. Since the server knows when
  each account was created, the operator could match the first sign-in to the account; `/privacy`
  says so. For every signed-in user the page sends only which error screen showed and an install
  as an app. Owner's view: an Umami share link on `stats.starbridge.run`,
  where Caddy passes only GET requests and blocks the login. A password (user `tom`) guards the
  whole host, since the link alone would open it to whoever saw it; bcrypt cost 10 and a limit of
  300 requests a minute per address keep its checks from spending the box's CPU (#595). With no
  password set, the pages and the API both stay shut (#717).
- **Demo server** (#423). Play reviewers cannot pass GitHub's new-device check and cannot be given
  a recovery key, so `demo.starbridge.run` is a self-hosted server with an owner token, and
  `demo/` is its first device and machine. It approves every join by digits without comparing,
  so a reviewer walks the same screens as a real second phone. The server refuses `DEMO=1` beside
  a starbridge.run `PUBLIC_URL`, GitHub sign-in or relay mode. A restart is a fresh account.
  Every prod deploy rebuilds it from the same commit (#1016): deployed by hand, it once fell behind
  prod and rejected the apps' item kinds, so reviewers saw an empty inbox. It restarts only when its
  image changed, so a reviewer's account survives deploys that leave its code alone. Caddy counts
  its `/v1/*` per address as prod's, and it caps machines at its own and pending pairings at
  5,000, what its 64 MB tmpfs holds, since reviewers share one account and one container.
