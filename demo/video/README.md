# Demo video kit

Renders the README's demo video from one real take: the CLI on a machine named "workstation"
asks a question with an image, an Android phone answers it from the lock screen with one tap,
and a run reports its progress. The phone is recorded; the terminal, captions and end card are
rendered from the take's events, so the CLI's answer and output on screen are the real ones.

Needs bun, ffmpeg, adb and an Android phone or emulator with the Starbridge app.

1. **Stack.** A demo server on 8640 with an empty database, its account and two paired machines,
   "workstation" and "build server". Notifications need FCM, so set `FCM_PROJECT_ID`,
   `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY` as for a server.

   ```bash
   bun demo/video/stack.ts .scratch/demo/stack
   ```

2. **Phone.** `adb reverse tcp:8640 tcp:8640`, then in the app: Use your own server,
   `http://127.0.0.1:8640`, owner token `demo-video`, Compare digits, They match (the stack
   approves every join). For a clean frame: dark theme (`cmd uimode night yes`), no screen lock
   (`locksettings clear --old <pin>`), a dimmed wallpaper (`cmd wallpaper set-dim-amount 0.85`).

3. **Take.** The phone's lock screen must show nothing else. The scenario taps fixed points,
   measured on a 1080×2400 emulator at density 420; on another phone set `TAP_EXPAND` and
   `TAP_ANSWER` to "x,y" of the notification's arrow and of "Standard".

   ```bash
   bunx playwright install chromium
   bun demo/video/compose.ts image .scratch/demo/take
   bun demo/video/scenario.ts .scratch/demo/stack .scratch/demo/take
   ```

4. **Video.** `demo.mp4` (1920×1080, 30 fps, no audio), `demo.gif` (960 px, 12 fps) and
   `poster.png`, in the take's directory. `PHONE_OFFSET` shifts the phone against the terminal.
   Headless Chromium crashes when `/tmp` is full; point `TMPDIR` elsewhere then.

   ```bash
   bun demo/video/compose.ts video .scratch/demo/take
   ```

The scenario's words live in `scenario.ts` (the question, the run), the terminal's in
`frame.html`, the question's image in `question.html`.
