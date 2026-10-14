# Contributing

Open an issue before a large change, so we agree on the approach first. Small fixes can go
straight to a pull request.

## Develop

You need Bun 1.4 and pnpm 11, plus Node 24 for the web end-to-end runs. For Android, JDK 21
and an Android SDK with platform 37.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

`pnpm install` also copies `.githooks/` into the repository's hooks, which every worktree shares:
before a commit, Biome formats the staged files; a push that would drop commits from a branch is
refused; a commit message that credits an AI is refused.

For Android, in `android/`:

```bash
./gradlew assembleRelease lintDebug verifyRoborazziDebug
```

Each package's README says how to run it: [server](server/README.md#run-from-source),
[web](web/README.md), [CLI](cli/README.md), [mod](mod/README.md#develop),
[desktop](desktop/README.md#develop), [Android](android/README.md#build) and
[iPhone](ios/README.md#build-and-test); agents on the dev box build it on the Mac mini with
`ios/scripts/mini.sh` ([how](ios/README.md#build-on-the-mac-mini)).
[PROTOCOL.md](PROTOCOL.md) holds the wire format, [DESIGN.md](DESIGN.md) the look, [SPEC.md](SPEC.md) indexes the decisions, one file per area under `spec/`, and
[cli/CONTRACT.md](cli/CONTRACT.md) the CLI commands and output that plugins and agents rely on.

## Release

One version covers the CLI, the web app, both Claude Code plugins, the Claude Code mod, the Android app
and the desktop app. A release starts as a release candidate for testers and becomes the final for
everyone by promotion, unchanged:

| | rc (`v1.2.3-rc.1`) | final (`v1.2.3`) |
|---|---|---|
| GitHub Release | prerelease | latest: Obtainium, `install.sh`, `install.ps1`, `starbridge update` and its nudge |
| npm | `next` | `latest` |
| Homebrew | — | the tap's formula |
| Google Play | Alpha | Alpha, or production once `PLAY_PRODUCTION` is true |
| Desktop app | apps set to follow release candidates | every app |
| iPhone app | TestFlight | TestFlight |

Main deploys to staging only. An rc tag deploys its commit to starbridge.run, once staging passed
it, and the release waits until starbridge.run runs it; a final deploys nothing, as starbridge.run
already runs its rc. A hotfix between rcs: `gh workflow run deploy.yml -f sha=<commit>`, a commit
of main that staging passed.

1. Run `bun cli/scripts/version.ts 1.2.3-rc.1` from the repository root, merge it in a PR, and tag the merged
   commit `v1.2.3-rc.1`. The marketplace stays on the last final.
2. The maintainer installs the rc's APK on their phone and uses it. A fix means another rc (`-rc.2`). A
   bug that an earlier release did not have gets the `regression` label.
3. Once the maintainer approves, run the `promote` workflow with `1.2.3`
   (`gh workflow run promote.yml -f version=1.2.3`). It refuses while a `regression` issue is open, stamps the
   newest rc's commit as `1.2.3` on a commit of its own, tags it `v1.2.3` and runs the release on that tag, so
   main keeps merging meanwhile. The final keeps the rc's CodexBar pin, and the workflow refuses any change
   since the rc beyond the version stamp. Then open the pull request of the `marketplace/v1.2.3` branch it
   pushed, which points main's marketplace at the final (`version.ts --marketplace`). With `dry_run` it pushes
   nothing.

The workflow refuses a tag that disagrees with the stamped files, and publishes nothing until the
APK passes the Android smoke test (`demo/smoke/android.ts`): on an emulator, the release APK signs in
to a local demo server, gets a question with context through an FCM message, shows its notification
and opens its card. To run it locally, start a rootable emulator (a `google_apis` image, not
`google_apis_playstore`) and run `bun demo/smoke/android.ts <apk> [out dir]`.

`version.ts` also pins CodexBar's latest release, the one setup and `starbridge update` install,
in `cli/src/setup/codexbar-pin.json`. If an open `codexbar` issue says that release fails the daily
check, pin the last good one with `bun cli/scripts/codexbar-pin.ts <version>`. The
marketplace installs both plugins from the final tag, and setup installs the Pi package at the tag of
the CLI it runs.

`bun run build:bin`, in `cli/`, builds the standalone binaries (Linux, macOS and Windows, x64 and
arm64). A `v*` tag runs `.github/workflows/release.yml`, which attaches them, the signed APK and
App Bundle, `install.sh`, `install.ps1` and the signed `SHA256SUMS` to a GitHub Release,
commits the formula to `T0mSIlver/homebrew-starbridge` and publishes to npm through Trusted Publishing, with no npm token. The signing key lives in the `MINISIGN_SECRET_KEY` secret of the `release` environment and, offline, with the maintainer.
Then it uploads the App Bundle to Google Play's Alpha track, rcs included, or a final to production once
the `PLAY_PRODUCTION` repository variable is true, signing in through
workload identity federation with no key, once the `PLAY_WIF_PROVIDER` and `PLAY_SERVICE_ACCOUNT`
repository variables are set; without them, upload the bundle in Play Console. Run by hand on main with a version above the last one Play has, the
workflow only asks Play to validate the upload. The iPhone app goes to TestFlight, signed through the App
Store Connect API key in the `ios-release` environment. To upload one build alone, from main:
`gh workflow run release.yml --ref main -f version=1.2.3 -f testflight_only=true`.

The release notes come from `cli/scripts/release-notes.ts`: a section per product, from the
"Release notes" section of each pull request's body (one `Product: line` per product, or `None`),
then every pull request, folded. A final covers everything since the previous final; an rc covers
what is new since the tag before it. A pull request without the section shows only in the folded
list; edit its body before tagging to fix that. Play gets the Android section alone, cut to its
500 characters.

The maintainer's dogfood APKs are debug builds signed with the Android release key, so that
starbridge.run's App Links, which list only that key, open them. To build one, add this line to
`android/local.properties`, which git ignores:

```properties
starbridge.dogfoodSigning=true
```

The build then reads `~/.config/starbridge/secrets/release.jks` and the password in
`release-keystore-password` beside it, and fails where `CI` is set. Without the line, debug builds
sign with the debug key. A phone with a debug-signed build must uninstall it once before it takes a
release-signed one, since Android refuses an update signed with another key. Keep release-signed
APKs out of folders that CI runners can read.

## Pull requests

The rules for branches, PRs, tests and where decisions are written down are in
[AGENTS.md](AGENTS.md); they apply to people and agents alike. Report security issues privately,
as [SECURITY.md](SECURITY.md) describes.

By contributing, you agree that your work is released under the [MIT licence](LICENSE).
