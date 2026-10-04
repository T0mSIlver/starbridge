# Starbridge for Android

Inbox, Quotas, and Devices and machines, against a Starbridge server. Kotlin,
Jetpack Compose, Material 3 Expressive, Hilt and Navigation 3, as vidtheque.

- `protocol/`: packages/protocol in Kotlin (sign, seal, open, the directory
  chain, pairing, recovery words), checked against its test vectors.
- `data/`: the server API and `ServerStore`, which verifies the directory
  against its pin and every item against the directory before showing it.
  Private keys, the session and the decrypted state are wrapped by an Android
  Keystore key that does not need an unlocked screen, so notification buttons
  answer from the lock screen.
- `push/`: FCM (data field `p`) or UnifiedPush, picked under Devices; the
  notification's buttons sign and send the answer. Colours, type and spacing
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

Cryptography is libsodium through Lazysodium. `ProtocolVectorsTest` runs it on
the JVM through `lazysodium-java` against `../packages/protocol/vectors`.

Firebase: the build reads `google-services.json` from
`~/.config/starbridge/secrets/`, else from `app/` (gitignored), and turns it
into the string resources Firebase reads. Without it the app builds with FCM
off and offers UnifiedPush.

Debug builds allow plain HTTP, for a local server reached through `adb reverse
tcp:8080 tcp:8080` at `http://127.0.0.1:8080`. `docs/e2e/` holds screenshots
from an emulator run against one: GitHub sign-in through a stand-in OAuth
server, first-device setup, pairing `starbridge pair`, and answering
`starbridge ask --wait` from the locked screen through UnifiedPush (ntfy).

Fonts: Google Sans Flex and Google Sans Code, under the SIL Open Font License
(`licenses/`). `res/font/google_sans_flex.ttf` is the google/fonts file
instanced to its weight (300 to 800) and optical size (12 to 36) axes, with
grade, roundness, slant and width pinned to their defaults, which cuts it from
4.1 MB to 410 KB:

```bash
fonttools varLib.instancer "GoogleSansFlex[GRAD,ROND,opsz,slnt,wdth,wght].ttf" GRAD=0 ROND=0 slnt=0 wdth=100 wght=300:800 opsz=12:36 -o google_sans_flex.ttf
```
