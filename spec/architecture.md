# Architecture

```
agent sessions --CLI--> starbridge agent (one per machine) --HTTPS--> server <-- web page
  ^ mod, plugin or extension:          runs CodexBar                    |
    answers come back as prompts                                       +--> push relay --> FCM --> Android
```

| Path | What |
|---|---|
| `packages/protocol` | zod schemas, signing and sealing on libsodium, quota pace and alerts, JSON test vectors the Kotlin and Swift ports also pass, but for pace.json: only the local agent computes pace and alerts, so neither port has them (#1147) |
| `server` | Hono on Bun with `bun:sqlite`, one Docker image; `RELAY_MODE` also makes it the push relay |
| `cli` | the `starbridge` command and `starbridge agent` |
| `plugin`, `mod` | Claude Code's two plugins: `starbridge` (skill and hooks) and `starbridge-mod`, split so that builds refusing mods keep the rest. `mod/pi` and `mod/opencode` hold the Pi extension and opencode plugin |
| `web` | Next.js; decrypts in the browser |
| `android` | Kotlin and Compose |
| `ios` | the SwiftUI app (XcodeGen) on `StarbridgeProtocol`, the Swift port of `packages/protocol` |
| `deploy` | the hosted instance |
| `demo` | the program behind the Play reviewers' demo server |
| `evals` | the skill eval and the load test |
| `docs` | pages served under `/docs` |

Why this stack: one TypeScript schema serves the server, CLI and mods, and Claude Code mods are
TypeScript already. Bun gives `bun build --compile` binaries; npm gets a Node 22+ bundle, so the
CLI uses no Bun global without a guard. SQLite is enough because the server stores ciphertext,
public keys and the directory's names and times. Design tokens are generated from `DESIGN.md` to CSS and Kotlin, so both clients
share colours and type.

**CodexBar** (github.com/steipete/CodexBar) is read, never embedded. Its maintainers want
integrations beyond macOS to consume `codexbar usage --json` or `codexbar serve`, and declined a
stable snapshot interface, so the uploader reads its JSON and tolerates schema changes. CodexBar's
provider plugins add providers, not panels.
