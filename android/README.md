# Starbridge for Android

Inbox, Quotas, Devices and machines, and first-device setup, on fake data
(`data/Fake.kt`) until the server lands. Kotlin, Jetpack Compose, Material 3
Expressive, Hilt and Navigation 3, as vidtheque. Colours, type and spacing
come from `ui/theme/Tokens.kt`, generated from the repo's `DESIGN.md`; don't
edit it, run `bun web/scripts/tokens.ts`.

## Build

JDK 21 and an Android SDK with platform 37, then:

```bash
./gradlew assembleRelease
```

Screenshots render on the JVM through Roborazzi: `./gradlew
recordRoborazziDebug` writes `app/screenshots/`, light and dark, and
`verifyRoborazziDebug` fails when a screen drifts from them.

Cryptography is libsodium through Lazysodium. Unit tests run it on the JVM
through `lazysodium-java`; once #1 lands them, they also check the protocol's test vectors in
`../packages/protocol/vectors`.

Fonts: Archivo and JetBrains Mono, under the SIL Open Font License
(`licenses/`).
