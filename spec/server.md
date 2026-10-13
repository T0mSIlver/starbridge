# Server

- **Bounds** (#65, #260), sized for an orchestrator with 10 sessions asking a few hundred
  questions a day: every route that stores something has a cap or retention, and every write that
  grows it a rate limit. Answered questions and their answers are kept 7 days, unanswered ones and
  quota snapshots 30. An account holding more than 1000 unanswered questions keeps them 7 days
  (#584): a looping agent fills the 10000 cap in under 2 hours, after which every question is
  refused until some expire, and 30 days of that is too long, while a person has a few dozen
  open at most. A snooze in such an account can outlive its question and goes with it. Per account: 10000 questions, 10000 permission prompts, 256 MB, each item
  charged its boxes plus 512 bytes per row: a heavy user, a hundred questions a day with
  screenshots, stores about 80 MB in a week. A full account gets 409 `account-full`, which the
  CLI words as such. The numbers live in `server/src/limits.ts` and
  PROTOCOL.md, "Limits". A post reads counts from a totals table kept by triggers.
- **Retention comes from `ITEM_KINDS`** (#477). Each kind names its `keep`: a day, a week or a
  month after it was received, answered or left unanswered; `withRe` (it goes with the item it
  refers to); `fromActive` (it goes when its machine is revoked). The hourly sweep builds its
  deletes from that table, and a kind without `keep` fails typecheck, so no kind is stored and
  never dropped. The periods are server limits, so tests and self-hosters set their length.
- **Sizes** (#170, #685). A question's boxes and image blobs may hold 2 MB together and one image's
  blob 512 KB of base64url; the request body limit is 3 MB. Each image is encrypted once with a
  random key and stored once; only its key and hash go in each device's box, with the text. Tom's
  first evening of dogfooding stored about 370 KB per question, mostly screenshots sealed once per
  device; one 110 KB screenshot to 3 devices went from 591 KB stored to 152 KB.
- **Runs** are one item the machine re-posts under its id; the server keeps the latest, at most
  500 per account, for a day after the last update.
- **Permission answers** are refused 10 minutes after the prompt arrived, since the server cannot
  read its `expiresAt`.
- **Pairings** (#309, #619). Each address may hold 50 unapproved pairings (IPv6 counted per /48
  on this route), on top of 30 a minute; the server-wide cap of 20000 is the disk bound. Mobile
  carriers that hand out /64s from one /48 share 50, a smaller blast radius than the whole
  server. The server counts them in memory, as every per-address limit, so no address reaches
  the database, and a restart resets the counts (#575).
- **Per-address sign-up limits** (#619). An office or carrier NAT puts many people behind one
  IPv4 address, so the pairing limits above and the 60 GitHub sign-ins a minute leave room for a
  launch-day crowd behind it; at one a second they stay far below the 10 sign-ups and visitors a
  second the load test held.
- **Long-polls** identify their caller again after the wait and answer 401 if the session or token
  was revoked meanwhile (#260). A directory append ends every machine's answer long-poll, and the
  reply carries the directory's length (#158). On SIGTERM the server ends every long-poll as if
  its wait passed.
- **Re-sealing** (#340). Items are sealed to the devices in the directory when posted. When a
  device joins, the machine re-signs its open questions and prompts to the full recipient list and
  re-posts them (`reseal`). The server takes a re-post only from the machine that posted the item,
  only while it is open, keeps its arrival time and pushes only the new recipients. Nothing is
  re-sealed while the machine finds the directory behind. A re-post that fails is tried again on
  the next poll, prompts included: a prompt keeps the devices that hold it apart from those whose
  answers count. Re-sealing stops at its first 429 and waits its Retry-After, so the rest of the
  machine's rate window goes to its own asks (#650). A question's images are scaled at `ask` to
  leave room for its box, with its recipient list grown, for the 64 devices an item can reach,
  since a re-seal keeps the stored images and the 2 MB cap counts them (#720). One the server
  still refuses as too large, as one with a lower cap may, is not re-sent: the machine says so once.
- **Fresh quotas** (#158, #450). The local agent posts a snapshot once its directory holds a new device.
  `POST /quota/ask` wakes the machines and holds until each posted, up to 25 s, under the 30 s at
  which proxies cut long polls; 6 a minute per account, since each runs CodexBar on every machine.
- **Schema migrations** (#470). `PRAGMA user_version` counts the migrations a database has run;
  each runs in one transaction with its version. A server refuses a database newer than it knows,
  so a rollback past a migration fails at start instead of writing rows the newer schema misreads.
  Version 1 is the whole schema: the six migrations before launch were folded into it when the
  hosted database was reset, so `apply.sh` stops a deploy whose database is newer than its server
  before it replaces anything. A migration changes the schema and never rewrites rows, to stay within the 30 s
  Caddy holds requests; backfills run in the hourly sweep. `apply.sh` backs the database up just
  before a new server that migrates further than the database's `user_version` starts, or when
  either number can't be read, and keeps the last two (#586) for 7 days at most, as the nightly
  copies, so deleted data leaves backups within the 2 weeks /privacy promises (#721).
- **Migration rehearsal** (#1543). Each night sb-staging runs main's newest server on a copy of
  prod's schema, filled with synthetic users and items to the 2 GB cap, and posts a card when its
  migrations take over the 30 s or leave a schema other than its own (`evals/migrate/`). It also
  fails when prod's schema differs from what the migrations at prod's revision make. Only the
  schema leaves the VPS, with no rows: no copy of prod's data goes to staging.
- **Server-wide cap** (#586). Machines' items stop at 2 GB stored across accounts, with 503
  `storage-full` and a Retry-After of an hour; answers pass, so questions still close and expire.
  The hosted disk (38 GB, about 10 GB of it system and Docker, an alert at 2 GB free) holds the
  live database plus 7 nightly and 2 per-deploy copies, 10 in all. Copies are `VACUUM INTO`, so
  free pages stay out: 10 × 2 GB, plus SQLite's overhead, is about 21 GB of the 26 GB above the
  alert, the rest for a week of Docker builds between weekly prunes. Eight accounts at their
  256 MB fill it, a risk taken over buying disk before launch.
- **Full disk** (#301). Writes get 503 `storage-full` with `Retry-After`; usage counts and
  housekeeping skip, so a stored item still gets its push.
- **Usage counts** (#140). `server/src/usage.ts` counts requests the server handles anyway. During
  a day `usage_events` holds one row per event, with an account or member id only where a count is
  of distinct ones; each hour finished days fold into `usage_days` and their events are deleted, so
  no per-user row outlives its day. Read with `bun server.js usage [days]` inside the container.
  `/privacy` lists the counts.
