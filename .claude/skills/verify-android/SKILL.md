---
name: verify-android
description: Launch, drive and prove Starbridge's Android app on an emulator, for verifying a PR that changes what the app shows or does (sign-in and join, a question's notification and card, answering, the launcher icon). Use with the global `verify` skill. A cloud session has no emulator: it pushes the branch and reads CI's emulator jobs and the Android evidence comment.
---

# Verify the Android app

The app's release APK runs on an API 36 `google_apis` x86_64 emulator against a
local demo server (the real server on a fresh database), the real CLI as the
agent's machine ("workstation"), and a fake FCM that records what the server
sends. `demo/smoke/android.ts` is the driver and `demo/smoke/lib.ts` its
tools (`see`, `tap`, `replace`, `signInAndJoin`, `evidence`). CI runs it on
every PR that touches `android/` or `demo/smoke/`, and the release runs it
before it publishes.

## What CI already proves

- **The Android evidence comment** (marked `<!-- starbridge-evidence android -->`,
  docs/ci.md "Evidence"): the steps the smoke drove, and each screen that
  changed against main, before and after. The run's
  `android-evidence-<phone|tablet>-<tree>` artifacts hold every screenshot
  (empty inbox, the notification, the card, the app drawer; light and dark)
  with its UI dump:

  ```bash
  gh run download <run id> -R T0mSIlver/starbridge -p 'android-evidence-*' -D <scratch>/evidence
  ```

  Check the comment's commit is the PR's head before you judge it.
- The jobs `emulator (phone)` and `emulator (tablet)`: both must be green. On a
  failure the `emulator-failure-<profile>` artifact holds the screen, its UI
  dump, the server's log and the whole logcat.

In a cloud session that is all there is: push the branch, wait for those jobs,
read the comment and every image. Drive the app yourself only for what the
smoke doesn't cover, and only on a box with an emulator.

## Launch

On a box with the Android SDK, an AVD from the API 36 `google_apis` x86_64 image,
`/dev/kvm`, Bun and `pnpm install` done:

```bash
ANDROID_HOME=<sdk> ANDROID_SERIAL=emulator-<port> ADB=$ANDROID_HOME/platform-tools/adb \
  NO_FIREBASE=1 ANSWER="Ship tonight" EVIDENCE=<scratch>/evidence PROFILE=phone \
  bun demo/smoke/android.ts <apk> <scratch>/out
```

- `<apk>`: a release APK (`./gradlew assembleRelease`, or CI's `starbridge-apk`
  artifact). A build with no `google-services.json` gets made-up Firebase
  values: set `NO_FIREBASE` for it, or the app never gets an FCM token and the
  run stops at "the app's push subscription". Leave it unset with the real file.
- The emulator must be running (`emulator -avd <name> -no-window -no-snapshot
  -no-audio -gpu swiftshader_indirect`; `sg kvm -c` where the shell lacks the
  kvm group). The script waits for boot, then reinstalls the app, so every run
  starts signed out.
- `EVIDENCE` keeps the screens; `ANSWER` taps that option on the card and reads
  the answer on the machine's side. Both optional.
- The server runs on port `PORT` (default 8411): one run at a time per box.

It prints `[smoke] passed: notification shown, card opened with its context`,
or `[smoke] FAILED: <why>` with `failure.png`, `failure.xml` and `logcat.txt`
in the out dir. It stops the server and the fake FCM it started; it leaves the
emulator running.

## Doctor

`adb devices` shows exactly the `emulator-…` you mean in state `device`,
`getprop sys.boot_completed` is `1`, and `getprop ro.build.version.sdk` is `36`.
The home screen is showing (`input keyevent KEYCODE_HOME`; `cmd statusbar
collapse` if a killed run left the shade open: the next run then fails at "Use
your own server"). `curl -s 127.0.0.1:8411/healthz` must fail before a run: a
server already there is not ours.

## Drive

`lib.ts` finds things by text or content description from `uiautomator dump`,
never by coordinates: `see("Inbox")`, `tap("Sign in")`,
`replace("Owner token", token)`. Add steps to a copy of `android.ts` in
`demo/smoke/` (its imports are relative), delete the copy afterwards, and quote
the steps in the verdict. `shell("input keyevent …")`, `shell("cmd statusbar
expand-notifications")` and `adb("exec-out", "screencap", "-p")` cover the rest.
The keyboard drops keys on a slow emulator: re-read a field before trusting it.

## Fake users

The run makes one account, the demo owner device (`demo-owner`), the machine
`workstation` and the app as a second device, joined by comparing digits.
More machines: `pair(dir, server, device)` in `lib.ts` with another name.
Another phone: a second emulator with its own `ANDROID_SERIAL` and `PORT`.

## Evidence

- `evidence(name)` writes `<name>.png` and `<name>.xml`; `EVIDENCE` keeps the
  stops in both schemes (`<profile>-<stop>-<scheme>.png`).
- The side effects: the server's FCM message for the question (the fake FCM
  records it), the notification (`dumpsys notification --noredact`), the
  machine's answer (the CLI's `wait <id>` prints `Answer to d_…`), and
  logcat (`Starbridge:W`, the crash buffer).
- Look at every image you rely on, at full size, with the Read tool, and write
  what it shows and whether it is right.

## Peers and matrix

- A phone (`pixel_7`) and a tablet (`pixel_tablet`, 2560x1600; software
  rendering may never boot it on a small box: CI's runner does), light and dark.
- The launcher icon in the app drawer beside Settings, TMobile and the stock
  apps: the same circle size, the arch and dot centred. On the tablet the swipe
  up shows the home screen with the dock instead of the drawer; compare the
  dock's icons there.
- A card's buttons against the notification's actions (same labels, same
  default first).

## Cleanup

Kill only what you started: the server and fake FCM end with the script. An
emulator you started: `adb -s emulator-<port> emu kill`, or by its PID.
Never `pkill -f`. The out dir and `EVIDENCE` folder stay.

## Rules

- The smoke fails on a crash in logcat or a caught `push failed`.
- Never weaken a step to make it pass: a missing precondition is a reported
  failure.
- The evidence build's Firebase values are made up, so it proves the app's
  screens and handling of a push, not its FCM registration; the release smoke
  proves that.

## Features

[features/README.md](features/README.md) indexes one file per feature.
