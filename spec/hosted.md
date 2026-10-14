# The hosted instance

- **Stack** (`deploy/`): Docker Compose with Caddy on the host network, so rate limits see real
  client addresses. Caddy keeps connections to the server open (`keepalive 25s`, below the
  server's 30 s idle close) so TIME-WAIT sockets don't use up ports (#376). A client has 10 s for
  its TLS handshake and its HTTP/1.1 request headers, since every open connection costs Caddy
  memory, the VPS's first limit (#587). A whole request has 2 minutes (#1737): a machine's 3 MB question
  needs 25 KB/s, and phones post only small answers; long-polls are responses, which it does not
  bound. Caddy compresses every
  response and the web app none: Next's gzip ran on its one thread and filled it near 18 landing
  page visitors a second (#593). Nightly SQLite backups, kept 7 days (#586), and an offsite copy of each, kept 14 days
  on another provider's VM (#1482): encrypted on the VPS to a key that is on neither server, and
  pushed with a key that can add files but not read, replace or delete them, so neither a
  stolen VPS nor a stolen VM loses or leaks the backups. 14 days keeps /privacy's promise that
  deleted data leaves backups within 2 weeks.
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
- **Load regressions** (#1548). The load test runs weekly for an hour and monthly for 24 hours
  on the staging VM, from staging's images, capped to 1.5 cores and 3 GB so staging keeps the
  rest, and its result is compared with a stored baseline; a regression is a card to the owner.
  Capacity was measured by hand twice before launch, while slow leaks and long-poll losses
  show only over hours, and a release changes the server weekly.
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
  or /32 (IPv6) is accepted. The block list and the switch log hold an address until it is
  unblocked, which scrubs both (Caddy's error log can hold others); `/privacy` says so (#1744).
- **Suspending an account** (#785). The owner can suspend one account whose machines flood the
  server (a looping agent, or abuse) without deleting it: its machines' writes get 403
  `account-suspended`, which the CLI prints with its reason, while they still read and wait, and
  its phones and browsers work as before, so its owner can still answer, settle and revoke.
  `bun server.js suspend|unsuspend ACCOUNT`, stored as `accounts.suspended_at` (migration 2).
- **Emptying an account** (#1736). `bun server.js purge ACCOUNT` deletes every item one account
  stores, in the sweep's batches beside the running server, when its items fill the server's
  2 GB; the account and its devices stay, and `suspend` keeps its machines from refilling it.
- **Limits at runtime** (#786). The owner can tighten or loosen a rate window or a cap without a
  deploy (`bun server.js limits set items 60/60`, `set maxMachines 4`, `unset`, `reset`): the
  overrides sit in `limits.json` beside the database, which the server reads every minute, so they
  survive restarts and deploys until unset. Retention periods are left out, since shortening one
  deletes data at the next sweep. A file that does not parse keeps the limits as they were.
- **Service targets** (#1544). `/healthz` answers in 99.5% of each month's 5-minute slots; 99%
  of the outside check's round trips pass (a card, its Web Push, the answer read back); 99% of
  answers reach their machine within 5 s, the p99. A slot counts as down only when every vantage
  that checked in it saw `/healthz` fail, so one checker's network spends no budget. The owner gets
  an alert when a target misses more than twice what it allows over a day, which spends 2 days of
  the month's budget in one: fast enough to act on, slow enough that one failed round trip does not
  page. The checks run from two VMs on another provider, sb-oracle and sb-staging, every 5 minutes,
  and the round trip every 15. Infra alerts and their recoveries go to the owner's Discord, posted
  from sb-oracle, not to Starbridge cards, which are for decisions (#1565).
- **Status page** (#1544). `status.starbridge.run` is a static page on Cloudflare Pages, built on
  sb-oracle from both vantages' checks, so it stays up when the VPS is down and serves any crowd
  without a server of ours. It is uploaded when its content changes or once a day, a few uploads
  a day. It shows each part's state, 30 days of daily bars and the month against its target, and
  publishes booleans and numbers only, never a check's error text, which can hold addresses. A Safari run on a Mac each night loads the landing page, the
  docs and the app's sign-in screen, and registers the service worker, since Safari breaks in ways
  the Firefox and Chromium checks do not see.
- **Releases page** (#1618). `status.starbridge.run/releases` lists, per product (hosted server and
  web page, Android, iPhone, Mac app, CLI, Claude Code plugin) and per public ring (release candidate,
  final), the version, the day it shipped and where it is, each version linking to its GitHub release
  notes. It says the cadence in words and gives no date, since only main's builds come on a fixed rhythm
  and that is not a public ring; a final waits on the owner's yes, which a date would promise. It
  never shows main's or staging's commit (it would reveal unreleased work and unfixed bugs before a
  patch), Android's internal track, rollout percentages, CI state, tester lists or
  unreleased features. Every fact on it is already public on GitHub, npm, Homebrew, Play and
  TestFlight; the rest has one reader, the owner, and lives on cards and in CI. Pages of this kind
  show state, not process, and every version table comes from data (research:
  `research/release-tracking-2026-10`, starbridge-planning). The data is `releases.json` on the
  `releases-data` branch, written by `release.yml`'s last job from the jobs that succeeded; sb-status
  fetches it over HTTPS, so the page holds no credentials and queries no store. It lives on the
  status site rather than the web app so it stays up when the VPS is down and needs no deploy.
- **Ops page** (#1630). `ops.starbridge.run` is the owner's private page for learning how work flows:
  per product, the version, commit and time of main (staging's and starbridge.run's commits from
  `/healthz`, the Android internal build), the newest release candidate and the newest final, and what
  happens next, in Europe/Paris and UTC: how many Android commits wait for a build, how many commits
  staging holds beyond the newest rc, and what promotion still waits on. Unlike the public releases
  page it shows commits, since one person reads it. `ops.yml` builds it from the GitHub API, the
  tags and `releases.json` every 30 minutes and after each deploy, release, internal build and promotion,
  and uploads it to the Pages project `starbridge-ops`, only when its text changed (times round to
  the hour). A GitHub Actions job rather than a VM, so no secret reaches the VMs. Cloudflare Access
  (Zero Trust free plan, one-time PIN to the owner's email) guards the custom domain and the
  `*.pages.dev` addresses, since a Pages project is public until then. The upload token is a secret of
  the `ops-pages` environment, open to main only.
- **Privacy and terms** (`/privacy`, `/terms`). Each claim follows the code: stored columns in
  `server/src/db.ts`, retention in `server/src/limits.ts`, logs and backups in `deploy/`. A change
  to what is stored changes the page, and the Play data-safety form. Contact is
  privacy@starbridge.run; abuse@ appears only in `/terms`. `/privacy` leads each category (what we store, why, who receives it, how long we keep it, rights and contact) with 1 to 3 plain sentences, and keeps the field-level detail in collapsed sections under it, so a visitor reads the gist and an auditor still finds every field (#1789). Both pages promise that changes are posted
  with a new date, so each edit to one adds a dated entry to its Changes list (`changes.ts` beside
  the page), which also sets "Last updated"; a test fails until the entry and the page's hash are
  in (#1620, #1639).
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
  A reviewer who deletes the account, or revokes the demo's device or machine, restarts it
  (#1740).
  It runs on sb-staging, as a project of its own beside staging (#1557), so prod carries one service
  less and prod's releases never restart it. Each staging deploy whose round trip passed rebuilds it
  from that commit of main, which serves every release from the minimum up: deployed by hand, it
  once fell behind prod and rejected the apps' item kinds, so reviewers saw an empty inbox (#1016).
  It restarts only when its image changed, so a reviewer's account survives deploys that leave its
  code alone. Caddy counts
  its `/v1/*` per address as prod's, and it caps machines at its own and pending pairings at
  5,000, what its 64 MB tmpfs holds, since reviewers share one account and one container.
