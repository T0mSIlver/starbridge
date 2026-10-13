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
  final. The owner approves each promotion, after the rc has run on the maintainer's phone and no issue
  labelled `regression` is open, which the workflow also checks. Waiting N days instead was
  rejected: with five testers, no report is weak evidence, and v0.1.3 shipped broken without one.
- **Cadence** (#1538). An rc whenever a batch of merges lands, about daily, since it is also what
  puts server changes on starbridge.run; the owner promotes it once they have used it a day.
  Channels stay: Android rcs and finals to Play's Alpha track and GitHub (production once Play's
  12-tester test is passed), the desktop app's finals for everyone and rcs for apps installed from
  an rc or with Get Release Candidates on, the CLI's rcs to npm's `next` and finals to `latest` and
  Homebrew, the plugin marketplace on finals. The iPhone app follows Android once Apple's export
  compliance code arrives: rcs to TestFlight, finals to the App Store.
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
  go from main.
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
  follows GitHub's latest release, or with Settings' "Release candidates" on, the newest
  rc when that is newer (#1071); an app installed from an rc starts with it on. Turning it off cancels
  an rc download under way; one already downloaded still installs on quit, since Squirrel holds it. The app picks the
  release from the `releases/latest` redirect and the releases feed: electron-updater's own GitHub
  lookup keeps an app installed from an rc on rcs and never offers it a final, and GitHub's API
  allows 60 requests an hour per address. macOS
  installs an update only with the running app's Developer ID, so ad hoc builds never update.
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
  containing the deployed one; the box fetches it itself. Rollbacks are the owner's
  (`deploy/rollback.sh`, `deploy/deploy.sh`). The server and web images are built once per commit of
  main in `deploy.yml`, for amd64 and arm64, each on a runner of its architecture, and pushed to
  ghcr.io, public, tagged by commit (#1518); a commit that changes nothing they are built from
  reuses the previous commit's under its own tag, and the deployed commit, not the built one, is
  what `/healthz` names. The box pulls them rather than building, so staging, prod and a failover
  host run the same build, and the box keeps its CPU for users. It keeps the newest 5 releases'
  images for a rollback. Caddy's and the demo server's images are still built on the box: Caddy's by
  the hash of its Dockerfile, and the demo's restarts only when its code changed, which a new image
  per commit would break. The deploy fails unless the live server reports that commit or a later one
  (`x-starbridge-revision`). That header, and `starbridge-deploy`'s argument, are refused unless
  they are 40 lowercase hex characters (#467), since the workflow puts the revision in an API path.
  Then sb-oracle, the outside check's VM, runs one round trip on its test account (#1522): a
  healthy server that cannot push or answer fails the run at once, rather than at the check's next
  round trip up to 15 minutes later. Its key's forced command only asks for that round trip and
  prints the result.
- **Rollback** (#1520). `deploy/rollback.sh` deploys the release before the running one, or a
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
  second host, which `/privacy` does not allow. It has its own OAuth app, VAPID pair and no
  FCM or APNs key, so it pushes to no phone; only listed GitHub users can make an account
  (`SIGNUP_GITHUB_IDS`, #1524), and nothing is indexed. Its key's forced command deploys only
  a commit of main. ARM staging beside amd64 prod leaves architecture bugs to prod's smoke.
- **Prod waits for staging** (#1528). After each deploy, staging runs one round trip on its own test
  account (a card, its Web Push, an answer read back) and sets the commit's `staging` status; prod
  deploys only a commit whose status is success, waiting up to an hour for it, as an rc tag can
  follow its merge by minutes. A commit staging skipped, being older than the one it runs, never
  passes. A release that cannot push stops on staging. `deploy/deploy.sh` stays the owner's way
  around it.
- **No downtime** (#150, #508). The page runs as two copies; a deploy starts the idle one, waits
  for its health, then stops the other, and Caddy sends every request to the first healthy copy.
  The server stays one instance, since it holds the long-polls and SQLite; Caddy holds requests up
  to 30 s while it restarts, which takes about 1 s. The Caddyfile reloads through Caddy's admin
  API. Only a change to `deploy/caddy.Dockerfile` recreates Caddy and drops connections: its image
  is tagged by a hash of that file, which pins every input, and built only when no image has the
  tag, since a rebuild after the build-cache prune yields a new image even from the same file.
- **Pinning** (#361, #423, #426). Actions are pinned by commit SHA and images by digest, so a
  dependency changes only in a Dependabot PR. A job's image goes in a Dockerfile, not `container:`,
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
  days; when none is found or the lookup fails, it runs. A fork's runs do not count, since a fork's
  pull request runs its own `ci.yml`. Tests point `TMPDIR` at one directory per run and remove it
  (`test-tmp.ts`, #313). A `windows-latest` job (#552) starts a built `.exe` and runs the whole CLI
  suite, which must pass (#884). A private repository skips it, since GitHub's Windows runners need
  a public one or paid minutes. A `macos-latest` job (#877), skipped the same way, starts a built
  binary and runs the whole CLI suite, which must pass: the launchd service and the screen readers
  run only on a Mac, so the real launchd starts and stops the agent there. A `ubuntu-24.04-arm` job (#1481), skipped the same way, does the same for the
  linux-arm64 binary. All three jobs run each test file alone and kill one that hangs (`cli/scripts/test-each.ts`, #862).
- **CI runners** (#146, #1204, #1213). Self-hosted Linux runners in two pools that never share a
  box: `trusted` runs main's tests, deploys, uptime checks and releases; `pr` runs the test, e2e
  and image jobs of a pull request from this repository's own branches, so they start sooner than
  on GitHub's runners. Each job names its pool through a repository variable holding a JSON array
  of labels, and falls back to GitHub's runner when it is unset (docs/ci.md). Dependabot's and
  forks' pull requests stay on GitHub's runners, and so do the desktop e2e (Electron's libraries),
  Windows and macOS. Android builds on main and in releases use their own runner,
  `ANDROID_RUNNER`. The PR pool holds no secrets, and no pull request job reaches the other two.
  Each runner registers for one job, so every job starts clean. A fork's pull request runs its
  own `ci.yml`, which could name any label, so a fork's run is never approved.
- **Monitoring.** `uptime.yml` checks `/healthz`, `/healthz/backup` (fails when the last nightly
  backup is over 26 h old) and `/healthz/disk` (under 2 GB free), and opens one `outage` issue.
- **Vulnerability scans** (#1542). `scan.yml` runs Trivy on the server and web images that
  starbridge.run and staging serve, as their `/healthz` names them, after every deploy run and
  weekly, since advisories appear after a build. Not the deploy run's own commit, which can be
  newer than the one it deployed (#1560). A high or critical vulnerability with a fixed version fails the run; the
  rest are listed in its summary, since an advisory without a fix gives nothing to do. Both images
  take Debian's updates at build time, on a layer the commit id keeps out of the build cache, and the web
  image drops npm, which it never runs. osv-scanner reads the lockfiles weekly and reports every
  finding. Each scan keeps one issue open while it finds something and closes it once a run finds
  nothing. Dependabot's alerts cover the Gradle catalog, which osv-scanner cannot read.
