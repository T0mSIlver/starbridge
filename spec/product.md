# What it is

One person supervises their coding agents from an Android app and a web page with the same
features:

- **Questions.** An agent asks for a decision that is the owner's; the owner answers with one tap
  on the phone or in a browser, and the answer reaches the waiting session as its next prompt.
- **Runs.** Anything an agent starts that the owner wants to follow because it affects them: heavy
  work on their machine, a build, a release, an eval, a test that takes over the screen. Its
  progress stays on the lock screen until it passes or fails.
- **Permission prompts**, opt-in: allow or deny an agent's tool call from the devices.
- **Quotas**: what's left on each AI plan, read from CodexBar, with optional alerts.

The server at starbridge.run is free; anyone can self-host the same image. MIT licence.

## Principles

- **Agents never answer for the owner** (#122). A question has no default time, and nothing
  happens when nobody answers. A blocked agent works on something else, builds both options when
  that is cheap and asks which to keep, or waits.
- **Build on the harnesses, don't replace them** (#58). Session controls were dropped: a list of
  20 or more live sessions costs a write per change, for a setting only an orchestrator needs.
- **A question stands alone.** The owner reads it on a lock screen, away from the code, so it
  carries everything needed to decide.
- **One question, one answer surface** (#62). A question is answered in Starbridge or on the page
  it names (`answerIn`), never both.
- **The server reads nothing.** Questions, answers, prompts, runs and quotas are end-to-end
  encrypted; only the owner's devices and machines hold keys.
- **No new cryptography.** Audited libraries only.
- **Web and Android have the same features.**
- **No client telemetry** (#140). The server counts only requests it handles anyway.

## Positioning

The landing page, docs, README and store listing sell questions and runs, each by why it matters
to the reader. The hero: "Know the moment your agent is stuck" (#448). Quotas get one line: users
don't launch agents from Starbridge, and the power users it targets don't check quotas by hand.
Alerts are opt-in, so copy never says they are on. Permission prompts are secondary and opt-in.
Copy says "on each machine that runs agents", never "on each machine" alone. The subtitle under
the hero sells questions and that every agent on every machine reaches you in one place; the
feature row below names runs, quotas and permission prompts, since a list in the subtitle repeats
it (#801). The line under the hero's buttons, with end-to-end encryption, shows on phones too.

## Platforms

The web app ships first wherever it can: installed to the home screen on iOS (Web Push works for
home-screen web apps since iOS 16.4) and as an installed app on desktop browsers. Android is a
native app.

A native iPhone app is on its way (owner, 2026-10-10, now that a tester has a device): SwiftUI on
a Swift port of `packages/protocol`, the same pattern as Android, because answering from a
notification with buttons and a typed reply is the product, and the home-screen web app offers
neither, nor widgets. Kotlin Multiplatform and Compose Multiplatform lost on experimental crypto
bindings, risk to the Android app, and Material controls on an iPhone. Its first piece is
`ios/StarbridgeProtocol` (#1083): it ports the protocol by hand on swift-sodium, the libsodium both
other ports call, and passes every vector file, so the three clients agree byte for byte; its tests
fail when a vector file goes unread. It builds and tests on Linux as well, where agents develop
it. The app on top of it (#1105) so far signs in and joins the account as Android does
(sign-in.md), and sets type in SF Pro, not Google Sans Flex (DESIGN.md). Until the app ships, the home-screen web app is the iOS path. The plan and the approaches
weighed are in the planning repo's
[research/ios-app.md](https://github.com/T0mSIlver/starbridge-planning/blob/main/research/ios-app.md).

The desktop app is Electron, loading the configured server's web page (owner, 2026-10-08). The
page stays the device: it signs in, pairs and keeps its keys as in a browser, so every web release
reaches the app without an app update. The app adds what a browser cannot: an amber light in the
menu bar while something needs you, notifications with the options as buttons and a typed reply,
delivery while no browser runs, `starbridge://` links, and later presence (#848). Electron is the only stack with
all of these on macOS and Windows; Tauri would need a static export of a web app that renders
per request, and it has no typed reply nor idle and lock detection. The cost is a ~150 MB
download. The comparison is in the planning repo's
[research/desktop-app.md](https://github.com/T0mSIlver/starbridge-planning/blob/main/research/desktop-app.md).

The CLI runs on Linux, macOS and Windows (#552, decided 2026-10-06 for launch). On Windows,
CodexBar has no build, so a Windows machine uploads no quotas and setup says so; questions,
runs and permission prompts work as elsewhere. The CLI reads `Path` as `PATH`, takes `HOME` from
`USERPROFILE`, finds commands by `PATHEXT`, and starts an npm `.cmd` shim through cmd.exe with
every argument escaped as cross-spawn does it, so no argument runs as a command.

## Brand

The mark is an arch from the machine (its wide leg) to the phone (its slim leg), with an amber dot
crossing it: a question or an answer (#1366). It replaced a space elevator (#32), which a tester
could not name. Stars and letter marks were ruled out, stars as a cliché of AI tools. The name stands on the mark's baseline in every lockup.
Beacon (#49): soft black and neutral greys, and amber as the only accent, meaning "needs you".
Provider colours are CodexBar's, adjusted per scheme only as far as 3:1 contrast needs (#72).
Tokens, type and components: `DESIGN.md`.
