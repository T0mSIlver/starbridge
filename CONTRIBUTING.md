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

For Android, in `android/`:

```bash
./gradlew assembleRelease lintDebug verifyRoborazziDebug
```

Each package's README says how to run it: [server](server/README.md#run-from-source),
[web](web/README.md), [CLI](cli/README.md), [mod](mod/README.md#develop),
[desktop](desktop/README.md#develop) and [Android](android/README.md#build).
[PROTOCOL.md](PROTOCOL.md) holds the wire format, [DESIGN.md](DESIGN.md) the look, [SPEC.md](SPEC.md) every decision with its date, and
[cli/CONTRACT.md](cli/CONTRACT.md) the CLI commands and output that plugins and agents rely on.

## Release

One version covers the CLI, the web app, both Claude Code plugins, the Claude Code mod and the Android app. A
tag is live the moment it is pushed: Obtainium, `install.sh`, npm and Homebrew read GitHub Releases. So each
release starts as a release candidate, which the maintainer installs before the final tag is cut:

1. Run `bun cli/scripts/version.ts 1.2.3-rc.1` from the repository root, merge it in a PR, and tag the merged
   commit `v1.2.3-rc.1`. It publishes a GitHub prerelease and npm's `next` tag, and leaves the marketplace and
   Homebrew on the last release.
2. The maintainer installs the rc's APK on their phone and uses it. A fix means another rc (`-rc.2`).
3. Once they say it works, run `bun cli/scripts/version.ts 1.2.3`, merge it, and tag `v1.2.3`. The
   workflow refuses a final tag without an rc, or with any change since the newest rc beyond the
   version stamp: if anything else merged meanwhile, cut another rc. The final keeps the rc's CodexBar pin.

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
commits the formula to `T0mSIlver/homebrew-starbridge` and publishes to npm through Trusted Publishing, with no npm token. The signing key lives in the `MINISIGN_SECRET_KEY` Actions secret and, offline, with the maintainer.
Then it uploads the App Bundle to Google Play's Alpha track, rcs included, once the
`PLAY_SERVICE_ACCOUNT_JSON` secret is set in the `play-release` environment; without it, upload the
bundle in Play Console. Run by hand on main with a version above the last one Play has, the
workflow only asks Play to validate the upload.

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
