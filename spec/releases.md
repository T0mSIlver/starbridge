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
  Play production once open. The hosted page and server are on neither path: they deploy from
  main, so every tag waits until starbridge.run runs its commit (its final, its rc's), which also
  rebuilt the demo server. A final is promoted, not cut: `promote.yml` stamps the newest rc's
  commit on a commit of its own, tags it and runs the release on that tag, so main never stops
  merging between an rc and its final, then pushes a branch that points main's marketplace at the
  final. The owner approves each promotion, after the rc has run on the maintainer's phone and no issue
  labelled `regression` is open, which the workflow also checks. Waiting N days instead was
  rejected: with five testers, no report is weak evidence, and v0.1.3 shipped broken without one.
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
  validate the edit and discards it.
- **Signing and deploy secrets in environments** (#1121). The Android keystore, its password and
  alias, `google-services.json`, the minisign key and the Homebrew tap key are secrets of the
  `release` environment, open to main and `v*` tags; the `android`, `release` and `homebrew` jobs
  name it. The deploy key and starbridge.run's host key are secrets of the `starbridge.run`
  environment, open to main only. As repository secrets, a workflow run on any branch could read
  them. The cost: a `release.yml` run dispatched from a branch fails its Android job, so dry runs
  go from main.
- **Release notes by product** (#1057). A list of PR titles told users little. Each PR body has
  a "Release notes" section, one `Product: line` per product a user sees change (Android, Web,
  Desktop, CLI, Server, Docs) or `None`, written by whoever knows the change; it can be edited
  after merge until the tag. `cli/scripts/release-notes.ts` renders a section per product, empty
  ones omitted, then every PR inside a folded `<details>`. Grouping by paths was rejected: tests
  and internal changes in `web/` or `cli/` would read as product changes. A final covers
  everything since the previous final; an rc only what is new since the tag before it, which is
  what Alpha testers have not seen.
- **The desktop app's release** (#886). Once the repository variable `DESKTOP_RELEASE` is true,
  the tag also builds the macOS app on GitHub's macOS runner, signed with the Developer ID and
  notarized, its secrets in the `desktop-release` environment, and adds its DMGs, zips and
  `latest-mac.yml` to the Release. Every 6 hours and at start, the app reads that file from the
  release it follows, downloads the zip, and installs it on quit or from Restart to Update. It
  follows GitHub's latest release, or with Get Release Candidates checked in its menu, the newest
  rc when that is newer (#1071); an app installed from an rc starts checked. Unchecking it cancels
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
- **Deploys** (#26, #150, #260, #1094). A merge to main deploys from Actions once CI passes, unless
  no file the box builds from changed since the revision it runs, over SSH to a forced command that
  deploys only main's head or a commit on main containing the deployed one; the box fetches it
  itself. Rollbacks are manual (`deploy/deploy.sh`). The deploy fails unless the live server reports
  that commit or a later one (`x-starbridge-revision`). That header, and `starbridge-deploy`'s
  argument, are refused unless they are 40 lowercase hex characters (#467), since the workflow puts
  the revision in a `gh api` path.
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
  fails or skips, Windows and macOS on a private repository aside (#1161). The images install pnpm
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
  run only on a Mac, so the real launchd starts and stops the agent there. Both jobs run each test
  file alone and kill one that hangs (`cli/scripts/test-each.ts`, #862).
- **CI runners** (#146, #1204). Three self-hosted pools, one repository variable each: `RUNNER`
  (`starbridge-ci`) runs main's tests, deploys and uptime checks; `ANDROID_RUNNER`
  (`starbridge-android`) the Android builds; `PR_RUNNER` (`starbridge-pr`) the test and e2e jobs of
  a pull request from this repository's own branches, so they start sooner than on GitHub's
  runners. Dependabot's pull requests and forks' stay on GitHub's runners, and so does every other
  pull request job: the desktop e2e needs Electron's libraries, the image builds Docker, and
  Android, Windows and macOS their own systems. The PR pool holds no secrets, and no pull request
  job reaches the other two pools, which run the deploy and the release. A fork's pull request
  runs its own `ci.yml`, which could name any label, so a fork's run is never approved.
- **Monitoring.** `uptime.yml` checks `/healthz`, `/healthz/backup` (fails when the last nightly
  backup is over 26 h old) and `/healthz/disk` (under 2 GB free), and opens one `outage` issue.
