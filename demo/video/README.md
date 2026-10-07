# Demo video kit

Renders the demo videos from real takes on a local demo stack. Two cuts:

- **Phone** (`scenario.ts`): Claude Code on "workstation" asks which model a paid eval should
  use; an Android phone answers from the lock screen with one tap; the eval reports its progress.
- **Inbox** (`inbox.ts`): Claude Code on "workstation" and Codex on "build server" ask at once;
  the web inbox shows both and answers each; the eval runs.

The phone or the browser is recorded. The terminals, captions and end card are drawn from the
take's events, so every `starbridge` command, answer and output line on screen is the real one;
the agents' own lines are scripted (`agents.ts`).

Needs bun, ffmpeg, Chromium for Playwright (`bunx playwright install chromium`), and for the
phone cut adb and an Android phone or emulator with the Starbridge app.

1. **Web app** (inbox cut), built against the stack's server:

   ```bash
   STARBRIDGE_SERVER=http://127.0.0.1:8640 pnpm --filter web build
   ```

2. **Stack.** A demo server on 8640 with an empty database, its account, and two paired
   machines, "workstation" and "build server"; the web app on 8641 when built. Notifications need
   FCM: set `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY` as for a server.

   ```bash
   bun demo/video/stack.ts .scratch/demo/stack
   ```

3. **Browser and phone join** the account; the stack approves every join.
   - Browser: `bun demo/video/inbox.ts .scratch/demo/stack --sign-in`.
   - Phone: `adb reverse tcp:8640 tcp:8640`, then in the app: Use your own server,
     `http://127.0.0.1:8640`, owner token `demo-video`, Compare digits, They match. For a clean
     frame: dark theme (`cmd uimode night yes`), no screen lock (`locksettings clear --old
     <pin>`), a dimmed wallpaper (`cmd wallpaper set-dim-amount 0.85`).

4. **Takes.** Each renders the question's image first. Take the inbox cut on a fresh stack: the
   inbox keeps earlier takes' runs for a while. The phone take taps fixed points, measured on a
   1080×2400 emulator at density 420; on another phone set `TAP_EXPAND` and `TAP_ANSWER` to "x,y"
   of the notification's arrow and of its first button.

   ```bash
   bun demo/video/inbox.ts .scratch/demo/stack .scratch/demo/inbox
   bun demo/video/scenario.ts .scratch/demo/stack .scratch/demo/take
   ```

5. **Video.** `demo.mp4` (1920×1080, 30 fps, no audio), `demo.gif` (960 px, 12 fps) and
   `poster.png`, in the take's directory. `OFFSET` shifts the recording against the terminals.
   Headless Chromium crashes, or records only a few seconds, when `/tmp` is full; point `TMPDIR`
   at a short path elsewhere then (Chromium refuses a socket path over 107 bytes).

   ```bash
   bun demo/video/compose.ts video .scratch/demo/inbox
   ```

Words live in `agents.ts` (questions, runs, the agents' lines), the image in `question.html`,
the look in `frame.html`, the layouts in `compose.ts`.

## A take with a person at the phone

`cue.ts` takes the phone cut on any server, the hosted one included, with the owner tapping
instead of adb. It pairs its own "workstation" in a directory of its own, so the owner's real
machines and agents stay out of it. With scrcpy on PATH it records the phone; `compose.ts video`
then works as above.

```bash
bun demo/video/cue.ts pair .scratch/demo/pixel --server https://starbridge.run
bun demo/video/cue.ts take .scratch/demo/pixel .scratch/demo/pixel-take
```

The take waits for Enter, starts recording, asks 3 s later, waits up to 2 minutes for the tap,
then runs the one-minute eval. A dry run against a local stack answers from the stack's browser
instead (steps 1 to 3, no phone needed):

```bash
bun demo/video/cue.ts take .scratch/demo/stack .scratch/demo/dry --dry-run .scratch/demo/stack
```
