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
./gradlew assembleRelease verifyRoborazziDebug
```

Each package's README says how to run it: [server](server/README.md#run-from-source),
[web](web/README.md), [CLI](cli/README.md), [mod](mod/README.md#develop) and
[Android](android/README.md#build). [PROTOCOL.md](PROTOCOL.md) holds the wire format,
[DESIGN.md](DESIGN.md) the look, and [SPEC.md](SPEC.md) every decision with its date.

## Release

One version covers the CLI, the web app, both Claude Code plugins, the Claude Code mod and the Android app. To release
1.2.3, run `bun cli/scripts/version.ts 1.2.3` from the repository root, merge it in a PR, and tag
the merged commit `v1.2.3`; the workflow refuses a tag that disagrees with the stamped files. The
marketplace installs both plugins from that tag, and setup installs the Pi package at the tag of
the CLI it runs. A release candidate (`1.2.3-rc.1`) leaves the marketplace on the last release.

`bun run build:bin`, in `cli/`, builds the standalone binaries (Linux, macOS and Windows, x64 and
arm64). A `v*` tag runs `.github/workflows/release.yml`, which attaches them, `install.sh`,
`install.ps1` and the signed `SHA256SUMS` to a GitHub Release, commits the formula to `T0mSIlver/homebrew-starbridge` and
publishes to npm. The signing key lives in the `MINISIGN_SECRET_KEY` Actions secret and, offline, with the maintainer.

## Pull requests

The rules for branches, PRs, tests and where decisions are written down are in
[AGENTS.md](AGENTS.md); they apply to people and agents alike. Report security issues privately,
as [SECURITY.md](SECURITY.md) describes.

By contributing, you agree that your work is released under the [MIT licence](LICENSE).
