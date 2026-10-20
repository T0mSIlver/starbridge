# Releases, deploys and CI

- **Releases** (#64). A `v1.2.3` or `v1.2.3-rc.4` tag runs `release.yml`: the APK and AAB signed
  with the release key, six CLI binaries (Linux and macOS, and Windows `.exe`, each x64 and
  arm64, cross-compiled by Bun on Linux), `SHA256SUMS` signed with minisign in CI (public key in
  `cli/minisign.pub`), `install.sh`, `install.ps1`, and the notes below. `-rc` tags are prereleases and go
  to npm under `next`. Non-rc tags commit the formula to `T0mSIlver/homebrew-starbridge`. npm
  takes the package through Trusted Publishing: the `npm` job trades its GitHub OIDC token for a
  publish token, so no npm token exists to leak or expire, and `npm publish --provenance` adds
  provenance. npm's trusted publisher must allow `npm publish`, not only staging. When a tag's npm
  job fails, a manual run with `npm_only` publishes that tag to npm alone (#820). npm accepts OIDC
  only from GitHub's runners, so that job ignores `vars.RUNNER` (#146).
  versionCode is `2000000 + MAJOR*1000000 + MINOR*10000 +
  PATCH*100` plus the rc number or 99, so release candidates sort first; the 2000000 keeps 0.1.0
  above 1.0.0-rc.1 (1000001), which Play's closed test already had (#551). Play App Signing keeps the release
  key, so Play and GitHub builds share one signature (#148).
- **Build provenance** (#1831). Each tag's APK, App Bundle, macOS DMG and zip, and CLI binaries
  carry a GitHub artifact attestation (SLSA build provenance, `actions/attest` in the `release`
  job): it names the `release.yml` run and the commit that built the file, which the minisign
  signature does not. It is made before the GitHub Release, so a failed attestation publishes
  nothing, and only on tags, so dry runs leave no public record. Every file it covers is built on
  GitHub's runners (#1825), so the provenance names the machine that built it. To check a
  downloaded file (gh 2.68 or later):
  `gh attestation verify starbridge-1.2.3.apk --repo T0mSIlver/starbridge --signer-workflow T0mSIlver/starbridge/.github/workflows/release.yml --source-ref refs/tags/v1.2.3`.
- **Release candidates first** (#1004). v0.1.3 crashed on every card with context: Android's ICU
  regex refused `(?U)`, which the JVM's regex, and so unit tests and Robolectric, accept. A tag is
  live at once, so the release publishes nothing until the release APK passes a smoke test on an
  emulator (`demo/smoke/android.ts`, GitHub's runner, since dell2 has no KVM): it signs in to a
  local demo server, gets a question with context through an FCM message from a fake FCM, shows
  the notification and opens the card. Delivering that message needs a root shell, so the image is
  `google_apis`. Release builds allow plain HTTP to `127.0.0.1` and `localhost` only, for this
  test; that traffic stays on the phone and items are end-to-end encrypted. Every release starts
  as an rc the maintainer installs; the final tag must be its newest rc plus the version stamp
  (`version.ts --final`), keeping the rc's CodexBar pin, so it ships what was tried.
- **rcs for testers, finals for everyone** (#1070). Testers already run each rc, so a final
  changes nothing for them; it is the release for everyone else. An rc reaches the GitHub
  prerelease, npm's `next`, Play's Alpha track and Mac apps set to follow release candidates; a
  final also reaches GitHub's latest release, which Obtainium, `install.sh`, `install.ps1`,
  `starbridge update`, the update nudge and other Mac apps read, npm's `latest`, Homebrew, and
  Play production once open. The hosted page and server deploy with each rc (below), so a final
  ships code starbridge.run already runs and deploys nothing. A final is promoted, not cut: `promote.yml` stamps the newest rc's
  commit on a commit of its own, tags it and runs the release on that tag, so main never stops
  merging between an rc and its final, then pushes a branch that points main's marketplace at the
  final. The owner approves each promotion (see Cadence), and the workflow also checks that no
  issue labelled `regression` is open. Waiting N days instead was rejected: with five testers, no
  report is weak evidence, and v0.1.3 shipped broken without one.
- **Cadence** (#1538, #1698). An rc is cut on demand, when a batch of merges lands or the owner
  asks, and at least one a day while main has changes since the last rc. An rc is also what puts
  server changes on starbridge.run. About 4 hours after an rc is cut, if no issue labelled
  `regression` is open, the orchestrator sends the owner a card to promote it, and the owner's yes
  runs `promote.yml`. The owner's devices run the tip ring (below), which already holds the rc's
  code, so 4 hours covers their own use; testers' silence is weak evidence. While a promotion
  card is open, no new rc is cut except a fix to that rc, since a new rc restarts the 4 hours. A
  final is always the newest rc: promoting an older one would move testers on a newer rc back to
  older code.
  Channels stay: Android rcs and finals to Play's Alpha track and GitHub (production once Play's
  12-tester test is passed), the desktop app's finals for everyone, rcs for apps on Release candidates
  and main's builds for apps on Tip, the CLI's rcs to npm's `next` and finals to `latest` and
  Homebrew, the plugin marketplace on finals. The iPhone app follows Android once Apple's export
  compliance code arrives: rcs to TestFlight, finals to the App Store.
- **Bugs by the release they were found in** (#1890). `regression` blocks a promotion but said
  nothing about which rc a bug came from, and a bug fixed in the next rc left no trace. The bug
  form has a required Version field, and `found-in.yml` turns it into a `found-in:<version>` label
  (`found-in:unknown` when the field holds no version), so the version is the reporter's word and
  the label is derived from it, not typed twice. Fixed-in is not stored, since it is a fact of git:
  the first tag that holds the commit that closed the issue, which the ops page computes. The page
  lists each version's bugs, open or fixed in a tag, and the open `regression` issues. The label
  `regression` stays a person's call, since it blocks the owner's yes.
- **Three rings: tip, rc, final** (#1540). The owner's devices run the tip ring, every
  change on main (Android's internal track per Android merge and rc tag, #1691; the Mac's Tip
  channel, #1692; the dev box through staging); testers and
  starbridge.run run rcs, everyone else finals, and a change never skips a ring: v0.1.3 broke every
  tester's app before the owner had run it. The dev box's CLI, agent, plugin and mod follow the
  server its machine is paired with, staging. The Android app's build of main goes to Play's
  internal testing track (`internal.yml`) on every merge that touches what the app is built from
  (`android/`, the protocol's test vectors) and on each rc tag, so the owner's phone holds the
  newest code within minutes and updates from Play, and never older code than an rc (#1690; it was
  nightly, #1540, until rcs were cut on demand). An rc tag builds as a main build: the tagged
  commit, with main's versionCode scheme. Since the rc's commit can
  be older than main's, or replace a waiting main build in the queue, a tag run ends by starting
  a run on main when main's app differs from the tag's. Builds queue one at a time: a running upload is never
  cancelled, and of the runs waiting the newest wins. A commit the track already holds or is
  ahead of (a rebuild, an rc cut from a commit main has passed) takes no slot. Play gives a phone
  the highest versionCode it may install, so main's builds take slots 50 to 98 of the version
  under way (the next patch once its final is tagged, refs/tags/v<base>, as the Mac's tip reads it;
  main keeps the rc version after promotion, #1731), each the next free one above the track's highest
  code, between its rcs (1 to 49) and its final (99): the owner's phone takes main over an rc and
  the final over both. When the 49 slots are spent the build is skipped, with a warning and a
  line in the job summary; the next rc or the final opens new slots, and the owner can run the
  workflow by hand then. The nightly run remains only for the iPhone app. Its versionName names its commit,
  `0.1.7-rc.2+main.7e56e958`, which Play's About this app shows (#1610); the app's
  `starbridge-client` header leaves that part out, so servers read the version as the rc's. A Google
  account in internal testing is no longer eligible for closed testing, so the owner joins it with a
  second account and stays one of the 12 closed testers. The iPhone app follows to TestFlight's
  internal testers once Apple's export compliance code arrives (`IOS_MAIN_TESTFLIGHT`).
- **The Mac app's tip** (#1692). The owner's Mac follows main as his phone does, by Android's rules:
  every push to main that touches what the app is built from (desktop.yml's paths: `desktop/`, the
  lockfile, the workflow; the app embeds no other package) builds it, one at a time, a running
  build never cancelled and the newest waiting run winning, and a commit the tip already contains
  takes no build. The build is signed and notarized like a release's, and its files replace those
  of the one release `tip` of the public repository `T0mSIlver/starbridge-tip`, as Ghostty's tip
  does; the previous build's stay, so an app that read the last `latest-mac.yml` can still
  download its zip. Never a release in this repository: Obtainium users with prereleases on would
  get every merge. Its version is `<version under way>-tip.<n>`, the version under way as for
  Android's builds of main and `n` the number of commits on main that changed the app's paths,
  which grows with every build and reads no state: semver puts `0.1.7-tip.80` above `0.1.7-rc.3`
  ("tip" sorts after "rc") and below `0.1.7`, so the final passes it. A separate Linux job publishes,
  holding a fine-grained token that writes that repository only (`TIP_RELEASE_TOKEN`, in
  `desktop-release`), so the token never shares a job with the build's third-party packages; one
  publish runs at a time, and one whose commit the tip already contains is dropped, so the tip never
  goes back. CI reads what the tip holds (`tip.json`) through the API: the download URL kept
  answering 404 from a cache for minutes after the file existed. The cost is a macOS runner for about 15 minutes per desktop merge, which #1684 had cut
  while no app updated from main.
- **A record of what shipped** (#1618). The last job of `release.yml` writes the version, the
  release's date and which channels its jobs reached (GitHub, npm, Homebrew, the desktop app, Play's
  track and versionCode, TestFlight's build) to `releases.json` on the `releases-data` branch, only
  for a job that succeeded, so a re-run of a failed job fills in the rest. It stores no commit,
  rollout or CI state, because the public releases page (`spec/hosted.md`) reads it. promote.yml
  needs no step of its own: it runs release.yml on the final's tag.
- **Play's Alpha track from CI** (#1024). Testers fell behind while each App Bundle went to Play
  Console by hand. Once the release is published, the `play` job uploads the tag's AAB to Alpha
  through the Play Developer API (`cli/scripts/play.ts`), status `completed`, with the GitHub
  release's Android section as notes in the listing's default language, cut to Play's 500 characters.
  rcs go too: Alpha is the testers' track, and the final's higher versionCode replaces its rc
  there. Once Play opens production (12 testers for 14 days) and the `PLAY_PRODUCTION` variable is
  true, finals go to production at 100% instead (#1070): Alpha testers get the higher versionCode
  from there, and a staged rollout means nothing at this many users, while Play can still halt one. Committing the edit sends it for review, and with managed publishing off, testers get it
  once Play approves; the cost is that any other change Play approves also goes live at once. A
  draft would add a console step for nothing. No key exists: the organization policy forbids
  service account keys, so Google's workload identity federation trades the job's GitHub OIDC
  token for a short-lived token of the `starbridge-play` service account, trusting only this
  repository's `play-release` environment, open to main and `v*` tags (repository variables
  `PLAY_WIF_PROVIDER` and `PLAY_SERVICE_ACCOUNT`). Without them the job skips with a notice; a
  failed upload fails the run after the release is out. Run by hand on main, the job asks Play to
  validate the edit and discards it; when Play refuses only because main's versionCode is not above the
  track's, the job reports that and passes (#1530).
- **Play listing images without the console** (#1436). Play Console's "Send changes for review" can
  fail with an HTTP 400 and no reason. The `play-listing` workflow, run by hand from main
  (`gh workflow run play-listing.yml --ref main`), replaces the en-US icon and feature graphic with
  `android/store/` (drawn by `web/scripts/icons.ts --play`) through the Play Developer API, signing
  in as the `play` job does, and commits the edit, which sends it for review; on failure it prints
  Play's error body.
- **The iPhone app on TestFlight** (#1397). Once the release is out, the `testflight` job archives
  the app on GitHub's macOS runner with the newest Xcode and uploads it to TestFlight, rcs and
  finals alike: App Store review needs a sign-in besides GitHub's (guideline 4.8), so testers are
  the only users yet. xcodebuild's own Apple sign-in refuses the App Store Connect API key (the
  `ASC_API_KEY_P8` secret of the `ios-release` environment, open to main and `v*` tags; variables
  `ASC_KEY_ID` and `ASC_ISSUER_ID`) that the REST API takes, so the job signs through the REST API
  (`ios/scripts/asc-signing.rb`, #1419): it registers the App IDs and their capabilities when
  missing, and makes an App Store profile per App ID, deleted at its end. It signs with one stored
  Apple Distribution certificate, its .p12 and password the `IOS_DISTRIBUTION_P12` and
  `IOS_DISTRIBUTION_P12_PASSWORD` secrets of the same environment (#1479): a certificate made and
  revoked per run had Apple email the owner on every release. When that secret is missing, or Apple
  no longer lists the certificate or it expires within a day, the run makes its own from a key made
  on the runner and revokes it at its end, with a warning. The stored one is issued off CI with
  `asc-signing.rb issue` and lasts a year; the run warns 30 days before. Uploaded builds stay valid
  past either, since the App Store re-signs them. The archive
  builds unsigned and `ios/scripts/adhoc-sign.sh` signs it ad hoc with each target's entitlements,
  which the export keeps (#1415); altool uploads with the same key. App Groups need the group
  registered once by hand, which the REST API cannot do. The key needs the Admin role, which
  creating certificates takes (#1409). Before signing, `ios/scripts/asc-check.rb` signs in with it
  and says why App Store Connect refuses it, with the public key's SHA-256 to compare with the
  .p8 kept offline. The marketing version is the tag's without `-rc.N`, since Apple
  takes three numbers only; the build number is the run's number and attempt, unique per upload.
  Run by hand on main, the job archives and exports without uploading, or with `testflight_only`
  builds the app alone and uploads it.
- **Signing and deploy secrets in environments** (#1121). The Android keystore, its password and
  alias, `google-services.json`, the minisign key and the Homebrew tap key are secrets of the
  `release` environment, open to main and `v*` tags; the `android`, `release` and `homebrew` jobs
  name it. The deploy key and starbridge.run's host key are secrets of the `starbridge.run`
  environment, open to main only. As repository secrets, a workflow run on any branch could read
  them. The cost: a `release.yml` run dispatched from a branch fails its Android job, so dry runs
  go from main. The jobs that read them run on GitHub's runners (#1825, CI runners below), so
  staging's and prod's SSH take connections from any address, key only: a firewall that limited
  port 22 to the home network would stop every deploy.
- **Owner review of .github/ and deploy/** (#1833). The keys sit in environments that admit main
  and `v*` tags only, and ask for no approval: a tap per signing job, several per rc and one per
  app merge for the internal track, would train the owner to tap without reading. What a key can
  do is set by main's workflows and deploy scripts, so the owner reviews changes to those instead:
  a pull request that changes `.github/` or `deploy/` gets the label `owner-review`, and the
  commit status `owner review`, which main's ruleset requires, passes only once it also carries
  `owner-ok`. The orchestrator sets that label after the owner's yes on a card, for the commit the
  pull request then holds; a push removes it, and the status belongs to one commit anyway.
  `owner-review.yml` runs on `pull_request_target`, so main's copy judges every pull request,
  including one that edits it, and runs nothing from the pull request. Admins cannot bypass the
  environments' branch and tag policies (`.github/owner-gates.sh`). It stops a mistaken merge,
  not a holder of the owner's token, who can set the label too.
- **Release notes by product** (#1057). A list of PR titles told users little. Each PR body has
  a "Release notes" section, one `Product: line` per product a user sees change (Android, iOS since TestFlight takes every tag (#1451), Web,
  Desktop, CLI, Server, Docs) or `None`, optionally `None: why`, written by whoever knows the change; it can be edited
  after merge until the tag. `cli/scripts/release-notes.ts` renders a section per product, empty
  ones omitted, then every PR inside a folded `<details>`. Grouping by paths was rejected: tests
  and internal changes in `web/` or `cli/` would read as product changes. A final covers
  everything since the previous final; an rc only what is new since the tag before it, which is
  what Alpha testers have not seen.
- **The desktop app's release** (#886). Once the repository variable `DESKTOP_RELEASE` is true,
  the tag also builds the macOS app on GitHub's macOS runner, signed with the Developer ID and
  notarized, its secrets in the `desktop-release` environment, and adds its DMGs, zips and
  `latest-mac.yml` to the Release. Every 6 hours and at start, the app reads that file from the
  release it follows, downloads the zip (or waits for the rail's Update available, with Settings' "Download updates
  automatically" off), and installs it on quit or from the rail's Restart to update (#1398). It
  follows the channel in Settings → Updates (#1692): Stable, GitHub's latest release; Release
  candidates, the newest rc when that is newer (#1071); Tip, also the tip build (below) when that is
  newer still, read from `T0mSIlver/starbridge-tip`. An app installed from an rc starts on Release
  candidates, one from a tip build on Tip, the only way to reach Tip: it is the owner's ring
  (spec/desktop.md). electron-updater never downgrades, so a lower channel
  holds the installed version until it passes it, which Settings says under the choice. Moving
  down cancels a download the new channel does not offer; one already downloaded still installs
  on quit, since Squirrel holds it. Settings from before the channel keep their meaning, and the
  bridge still reads and takes the old switch, since starbridge.run's page moves only with an rc. The app picks the
  release from the `releases/latest` redirect and the releases feed: electron-updater's own GitHub
  lookup keeps an app installed from an rc on rcs and never offers it a final, and GitHub's API
  allows 60 requests an hour per address. macOS
  installs an update only with the running app's Developer ID, so ad hoc builds never update.
  The tip build (above) also catches a signing or notarization break before the rc tag.
- **One version everywhere** (#471). `bun cli/scripts/version.ts <version>` stamps the version
  into `cli/package.json`, `web/package.json`, `desktop/package.json`, both `plugin.json`, the mod's `VERSION`, Android's
  default `versionName` and the marketplace's two `ref`s, in a PR; the merged commit is tagged,
  and the release workflow refuses a tag that disagrees (`--check`, also a test on every PR). The
  marketplace lists both plugins as `git-subdir` sources at that tag, over https so no SSH key is
  needed, so a hook merged on main never reaches users before the CLI that supports it. A release
  candidate moves every version but the marketplace refs. Setup and `starbridge update` install
  the Pi package at the CLI's own tag. The mod keeps its own copy of the agent API revision, since
  Claude Code installs only `mod/`.
- **Deploys** (#26, #150, #260, #1094, #1538). Main deploys to staging only; starbridge.run, the
  server and the page, takes a commit when an rc is tagged, and only one staging passed. Every merge
  used to reach users within minutes, so they ran code no tester had, between releases, and v0.1.3's
  kind of break could reach them before its rc did. Now `release.yml` dispatches `deploy.yml` with
  each rc tag's commit, and the owner dispatches a hotfix the same way (`gh workflow run deploy.yml
  -f sha=<commit>`); a final is its rc plus the version stamp, so promotion deploys nothing. The
  cost is that a server fix waits for an rc or a hotfix dispatch. The server keeps serving every
  release from the minimum up (`spec/keys-and-trust.md`), so apps older than the page keep working.
  A deploy goes over SSH to a forced command that deploys only main's head or a commit on main
  containing the deployed one; the box fetches it itself. The box also checks the gate the
  workflow checked, from GitHub's public API without a token (#1714): prod, that staging passed
  the commit, staging, that CI passed it on main. So a stolen deploy key cannot skip either, and
  the boxes get no GitHub credential. Rollbacks go through their own key (Rollback, below). The server and web images are built once per commit of
  main in `deploy.yml`, for amd64 and arm64, each on a runner of its architecture, and pushed to
  ghcr.io, public, tagged by commit (#1518); a commit that changes nothing they are built from
  reuses the previous commit's under its own tag, and the deployed commit, not the built one, is
  what `/healthz` names. A tag can be pushed again, so prod runs the digests staging ran (#1715):
  staging pins the digests its tag gave it and the run names them in step names, which prod's box
  reads with the staging pass and pulls by. The box pulls them rather than building, so staging, prod and a failover
  host run the same build, and the box keeps its CPU for users. It keeps the newest 5 releases'
  images for a rollback. Caddy's image is still built on the box, by the hash of its Dockerfile, and
  the demo server's on sb-staging (`spec/hosted.md`), where it restarts only when its code changed,
  which a new image per commit would break. The deploy fails unless the live server reports that commit or a later one
  (`x-starbridge-revision`). That header, and `starbridge-deploy`'s argument, are refused unless
  they are 40 lowercase hex characters (#467), since the workflow puts the revision in an API path.
  Then sb-oracle, the outside check's VM, runs one round trip on its test account (#1522): a
  healthy server that cannot push or answer fails the run at once, rather than at the check's next
  round trip up to 15 minutes later. Its key's forced command only asks for that round trip and
  prints the result. Both boxes run one set of deploy scripts, and what differs between them is a
  settings file per box (`deploy/host/prod.env`, `deploy/staging/staging.env`), since copies drifted
  and the same fix landed four times (#1663, #1675, #1953).
  The deploy waits for the owner's review on the `starbridge.run` environment (#2009), so the
  release waits for it up to 12 hours, not 2, and ends its wait when the deploy run does, and the dispatch posts the owner a card with the run's
  link; the card does not approve, a review stays the one gate (#2076).
- **Rollback** (#1520, #1828). `rollback.yml`, dispatched with a box and a commit, redeploys a
  commit that box ran before, so prod rolls back without the owner's full-sudo key, which was the
  only way before. It logs in with a second key per box, whose forced command runs only
  `starbridge-deploy --rollback <commit>`: the box keeps a record of every commit it ran
  (`/var/lib/starbridge/deployed`) and refuses any other, and keeps every other check of a deploy
  (on main, and on prod passed by staging, with the digests staging ran). A second key rather than
  a mode of the deploy key, so a leaked deploy key still cannot go back to an older, weaker
  release, and the rollback key appears only in rollback runs. Staging has the same, which is
  where the path is tested; prod is never a test. `deploy/rollback.sh`, the owner's, stays as the
  way around every check: it deploys the release before the running one, or a
  commit given, from the images the box holds, so it needs no download or build; the box keeps
  five releases, about 2.5 GB. It deploys that commit's whole tree, not only its images, so the
  compose file and Caddyfile match the server. It stops at a database migrated past that server
  (`apply.sh`), so a rollback past a migration also restores that deploy's backup and loses the
  writes since. Clients have no such switch, so a bad release is undone per channel:
  - GitHub: mark the final a prerelease, so `releases/latest`, which Obtainium, `install.sh`,
    `starbridge update`, the update nudge and the Mac app read, goes back to the previous final,
    as for v0.1.3 (#1004). A bad rc is replaced by the next rc.
  - npm: `npm dist-tag add starbridge@<previous> latest` (or `next` for an rc).
  - Homebrew: revert the formula's commit in `T0mSIlver/homebrew-starbridge`.
  - Android: Play cannot install a lower versionCode. Halt the release in Play Console, then
    ship the last good code as a new rc, whose versionCode is higher.
  - Mac app: covered by GitHub's latest; an app that already installed the bad one updates to
    the next release.
  - iPhone: expire the build in TestFlight.
  - A server change that clients rely on stays: the server serves every release from the minimum
    up (`spec/keys-and-trust.md`), so rolling a client back never needs the server rolled back.
- **Staging** (#1526). `staging.starbridge.run`, on sb-staging, an Oracle ARM VM, takes every
  commit of main, with prod's images, compose file and Caddyfile, so a deploy that breaks shows
  there first. Its data is synthetic, made through the real flows by the
  load test's setup: a copy of prod's would be ciphertext plus GitHub ids and push endpoints on a
  second host, which `/privacy` does not allow. It has its own OAuth app and VAPID pair and no
  FCM or APNs key: phones get its pushes through starbridge.run's relay, as from a self-hosted
  server, so the owner's real app works against it and the self-host push path gets used (#1540);
  it relays for nobody. Only listed GitHub users can make an account
  (`SIGNUP_GITHUB_IDS`, #1524) and the owner token makes the owner account the app check uses
  (#1621), and nothing is indexed. Its key's forced command deploys only
  a commit of main. ARM staging beside amd64 prod leaves architecture bugs to prod's smoke.
- **Prod waits for staging** (#1528). After each deploy, staging runs one round trip on its own test
  account (a card, its Web Push, an answer read back) and sets the commit's `staging` status; prod
  deploys only a commit whose status is success, waiting up to an hour for it, as an rc tag can
  follow its merge by minutes. A commit staging skipped, being older than the one it runs, never
  passes. A release that cannot push stops on staging. Any workflow can post a status, so prod's
  box trusts it only as a pointer: the run it names must be main's deploy.yml, whose staging job
  ran a step named after the commit that only a pass runs (#1714). `deploy/deploy.sh` stays the
  owner's way around it.
- **The apps run against staging** (#1621). The round trip above has no app in it, so a server
  change the apps cannot take (a field, a header, a push that never arrives) reached an rc unseen,
  as v0.1.3's regex did for the Android build. Every night `staging-app.yml` runs main's apps on
  staging: the release APK on an emulator, built with Firebase's config, and the iPhone app's
  `InboxTests` on a simulator, one after the other. Each signs in with the staging
  environment's owner token (`OWNER_TOKEN`, which a server with `SIGNUP_GITHUB_IDS` accepts for the
  owner account, `spec/sign-in.md`), so a run needs no GitHub login, which an emailed code guards,
  and no key outlives it: it starts from an empty owner account, deleting a failed run's, and deletes
  the account at the end. The Android run is the real path: a machine asks a question with
  context, staging pushes it through starbridge.run's relay and FCM to the emulator's Play
  services (no token is injected), the app shows it, opens the card and answers, and the machine
  reads the answer. A simulator gets no push from APNs, so the iPhone run covers sign-in, sync,
  answering and the machine's read, not the push. Nightly, not per deploy: main deploys 60 to 120
  times a day, a run takes about 20 minutes, and both apps share the one owner account. It sets
  the `staging-app` status on the commit staging runs and keeps one `staging-app` issue open
  while it fails. Prod's deploy does not read it yet: a new check that flakes would stop
  hotfixes, so it gets a fortnight of nightly results first; to gate, `deploy.yml` reads the
  status as it reads `staging`. The apps' own tests run against a server started in CI; this is the
  only check of the deployed one.
- **No downtime** (#150, #508). The page runs as two copies; a deploy starts the idle one, waits
  for its health, then stops the other, and Caddy sends every request to the first healthy copy.
  The server stays one instance, since it holds the long-polls and SQLite; Caddy holds requests up
  to 30 s while it restarts, which takes about 1 s. The Caddyfile reloads through Caddy's admin
  API. Only a change to `deploy/caddy.Dockerfile` recreates Caddy and drops connections: its image
  is tagged by a hash of that file, which pins every input, and built only when no image has the
  tag, since a rebuild after the build-cache prune yields a new image even from the same file.
- **Pinning** (#361, #423, #426). Actions are pinned by commit SHA and images by digest, so a
  dependency changes only in a Dependabot PR. Gradle checks every Android dependency against its
  sha256 in `android/gradle/verification-metadata.xml` (#1716), since the Android runner resolves
  through the home mirror over plain HTTP; builds that sign with the release key skip that mirror
  too. A workflow writes the file into Dependabot's Gradle PRs: the job that runs Gradle on the new
  artifacts has a read-only token, and the one that pushes runs no Gradle. A job's image goes in a Dockerfile, not `container:`,
  since Dependabot reads only Dockerfiles (#1172). A workflow writes `pnpm-lock.yaml` into
  Dependabot's security PRs, which update `package.json` alone, then dispatches CI, since a push
  with `GITHUB_TOKEN` starts no workflow; that run sets the PR's `CI` status, failed when any job
  fails or skips, Windows, macOS and Linux ARM64 on a private repository aside (#1161). The images install pnpm
  with `npm install -g` at `packageManager`'s version, since node slim images ship no corepack
  (#430).
- **CI** (#380). Main runs one at a time; a newer merge replaces the waiting run, and the head's
  deploy covers the merges in between. A run tests only the jobs its files can affect, a pull
  request's against its base and a push's against the commit before it (#1094); skipped jobs still
  report success. The e2e runs under `.github/watchdog.sh`. A merge to main skips the e2e when a run
  from this repository already passed it on the same git tree, most often the pull request's last
  run on its merge with the commit main then held (#878): a tree fixes every file, `ci.yml`
  included, so that run tested what main now holds. Each of the e2e's three parts uploads an
  artifact named after its part and tree when it passes (`e2e-passed-<part>-<tree>`, #1094), kept 7
  days; when none is found or the lookup fails, it runs. Code in a pull request's jobs can upload any name, so an artifact
  counts only when its CI run tested this commit or the merged pull request's head, that run's
  job for the part passed, and the commit the artifact holds has the tree and is that head or
  GitHub's merge of it (#1732). A fork's runs do not count, since a fork's
  pull request runs its own `ci.yml`. Tests point `TMPDIR` at one directory per run and remove it
  (`test-tmp.ts`, #313). A `windows-latest` job (#552) starts a built `.exe` and runs the whole CLI
  suite, which must pass (#884). A private repository skips it, since GitHub's Windows runners need
  a public one or paid minutes. A `macos-latest` job (#877), skipped the same way, starts a built
  binary and runs the whole CLI suite, which must pass: the launchd service and the screen readers
  run only on a Mac, so the real launchd starts and stops the agent there. A `ubuntu-24.04-arm` job (#1481), skipped the same way, does the same for the
  linux-arm64 binary. All three jobs run each test file in its own process, two at a time, and kill one that hangs (`cli/scripts/test-each.ts`, #862, #1916).
- **Evidence** (#1826). Agents prove a pull request from what the product shows, not from its
  diff: the icon passed review four times while it sat low (#1477, #1453, #1564, #1713). The
  web e2e, set to keep evidence, also shoots at 360, 768 and 1280 px in light and dark, and keeps
  a Playwright trace per browser and the steps it drove. A job on this repository's pull requests
  compares each screenshot with main's at the base and keeps one comment: the steps, the changed
  screens before and after, or "No visual change". Times, dates and made-up codes are left out of
  the comparison, since they change from run to run. The changed pairs go on the `pr-shots`
  branch, never into the pull request. A pull request that touches the Android app gets the same
  from the release smoke on an emulator, a phone and a tablet in light and dark, with the app
  drawer showing our icon beside the stock apps' (#1844), and one that touches the desktop app gets
the window's screens in light and dark from its end-to-end run (#1846). No model or Claude credential runs in CI: an agent reads
  the evidence and judges it. A fork's pull request gets no comment, since the job writes to the
  repository.
- **CI runners** (#146, #1204, #1213, #1638). Self-hosted Linux runners in two pools that never
  share a box: `trusted` runs main's tests, the release's version
  check and the nightly flaky-test count (#1657); `pr` runs the
  test and image jobs of a pull request from this repository's own branches, so they start sooner
  than on GitHub's runners. The e2e stays on GitHub's runners: its three parts per run queued a
  median 4 min, p90 22 min, behind the PR pool's two heavy slots. Each job names its pool through a repository variable holding a JSON array
  of labels, and falls back to GitHub's runner when it is unset (docs/ci.md). Dependabot's and
  forks' pull requests stay on GitHub's runners, and so do the desktop e2e (Electron's libraries),
  Windows and macOS. Main's unsigned Android build uses its own runner, `ANDROID_RUNNER`.
  Every job that reads a signing or deploy key, or builds a file a release signs (the APK and App
  Bundle, the CLI binaries, the minisign signature, the Homebrew formula, the internal track's
  build, staging's and prod's deploys), or builds or picks the server and web images prod runs
  (#1839), runs on GitHub's runners (#1825), so a compromised box on the home network reaches
  neither a key nor the bytes a key vouches for or prod runs. Each Android push to main also builds on GitHub's runner, to save the Gradle
  cache that pull requests restore there (#1662). The PR pool holds no secrets, and no pull
  request job reaches the other two.
  Each runner registers for one job, and its slot wipes that job's folders before the next;
  Docker, which makes a job root on its box, and what a job leaves outside its folders outlive it,
  hence the separate boxes (#1718). A fork's pull request runs its
  own `ci.yml`, which could name any label, so a fork's run is never approved.
- **Monitoring.** `uptime.yml` checks `/healthz`, `/healthz/backup` (fails when the last nightly
  backup is over 26 h old) and `/healthz/disk` (under 2 GB free), and opens one `outage` issue. It runs on GitHub's runner, never on a self-hosted pool: a monitor
  must not share the network of the boxes it watches (#2010, dark for 2.9 days in the 15 to 18 Oct
  fibre outage). sb-ops-watch on sb-oracle alerts when it has finished no run for 3 hours.
- **Vulnerability scans** (#1542). `scan.yml` runs Trivy on the server and web images that
  starbridge.run and staging serve, as their `/healthz` names them, after every deploy run that
  was not skipped and weekly, since advisories appear after a build. Not the deploy run's own commit, which can be
  newer than the one it deployed (#1560). A high or critical vulnerability with a fixed version fails the run; the
  rest are not reported, since an advisory without a fix gives nothing to do. Both images
  take Debian's updates at build time, on a layer the commit id keeps out of the build cache, and the web
  image drops npm, which it never runs. osv-scanner reads the lockfiles weekly and reports every
  finding. Each scan keeps one issue open while it finds something and closes it once a run finds
  nothing. The image and lockfile scans keep theirs in the private T0mSIlver/starbridge-security
  repository and write no finding to this public repository's run summaries or logs, since a public
  list of prod's open vulnerabilities saves an attacker the work (#2205). Their token,
  `SECURITY_ISSUES_TOKEN`, writes issues there only; without it the run fails rather than post here. Dependabot's alerts cover the Gradle catalog, which osv-scanner cannot read. The tools
  pinned by hand (the two scanners, the runner, Node, minisign, swift-sodium's commit) are in no file
  Dependabot reads, so the same weekly run compares each with its latest release and keeps a
  `tool-pins` issue open while one trails (#2026).
- **Licences** (#2024). CI fails when a runtime dependency, npm (`ci.yml`) or the Android release
  classpath (`android.yml`), has a licence that is not permissive (MIT, Apache-2.0, ISC, BSD, 0BSD, CC0 and
  the like) unless `scripts/licenses/allow.json` lists the package with that same licence and a
  reason, so a Dependabot bump that adds copyleft, CC-BY, vendor terms or an unnamed licence is
  seen. An allowed package that changes licence fails again. The web and server images carry the
  licence texts of their dependencies (`THIRD-PARTY-NOTICES.txt`, generated in the image build),
  and the Android app a list of its libraries and licences in its assets, which `android.yml`
  checks is current. The desktop app and the CLI carry none yet.
