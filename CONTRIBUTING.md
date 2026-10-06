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

## Pull requests

The rules for branches, PRs, tests and where decisions are written down are in
[AGENTS.md](AGENTS.md); they apply to people and agents alike. Report security issues privately,
as [SECURITY.md](SECURITY.md) describes.

By contributing, you agree that your work is released under the [MIT licence](LICENSE).
