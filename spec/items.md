# Items

## Questions

- Fields: `question`, `context`, `options` (2 to 4, or none for a typed answer), `recommended`,
  `source` (machine, project, session, its title and links, `machineKind`), `agent`, `images`,
  `links`, `answerIn`, `done`, `replies`.
- **The first option is the agent's default** (#191), its proposal with no timer: listed first,
  the one amber button. `recommended` names it when it isn't first.
- **Typed replies** (#201). Every question with options also takes a typed reply, as a steer to act
  on. It goes alone, with no choice. Its field is always open under the options, in the detail
  (web) and the sheet (Android), so typing costs one tap, as a pick does (#849): the owner often
  steers an agent this way ("show me two other mockups"), and a Reply button that opened the field
  made it a second-class answer. Cards in the list keep only the options, so they stay one-tap
  and short. The owner chose this from mockups over a full-width Reply button and a mic in the
  field; the field reads "Your answer" on both clients.
- **One call's questions keep its order** (#1079). Claude Code's `AskUserQuestion`, opencode's
  `question` and Codex's `request_user_input` ask several questions at once, and the CLI posts one
  card for each. Their `createdAt` is the call's time plus each question's index in milliseconds,
  so every inbox, which lists oldest first, shows them together in the agent's order. Posted in
  parallel and stamped in whole seconds, they tied and came in any order. Clients compare times as
  instants, since whole-second and millisecond stamps sort differently as text.
- **Images** (#62, #170, #685): at most 4, PNG or JPEG, never SVG. The CLI keeps a file as is up
  to a 3000 px edge and 384 KB, so a phone screenshot reaches every device unchanged and viewers can zoom into real
  pixels. Android and the iPhone app decode by the image's real size, drop one larger than
  declared or 8192 px a side, and hold at most 4096² pixels in a decode (#360).
- **Links** (#171) are what the agent wants the owner to see before answering: a Claude artifact, a
  PR, a doc. They never answer the question. Each has a `title`. Clients show them as chips after
  the context, each ending in an arrow out. A claude.ai link opens in the browser, where the owner
  is signed in; the Claude app shows artifacts only in its in-app browser.
- **GitHub links** (#971). Agents send PRs, issues, Actions runs and releases, and only PRs and
  issues were recognised. Now a GitHub link leads with GitHub's Octicon for its kind (pull
  request, issue, discussion, Actions run, release, commit, else the GitHub mark) and reads as its
  reference: `#123`, a release's tag, a commit's short hash, led by the repo only when it isn't
  the session's (`CodexBar#412`). The icon says what the number is, so the agent's title gives
  way to it. A run reads as its title, else "Actions run"; other GitHub pages as their title, else
  their path. No chip says "Open": the arrow does, and the word cost room on every chip.
- **`answerIn`** names a page (a Claude artifact whose button messages the agent) where the
  question is answered. It has no options; the schema refuses both. It closes when the agent runs
  `starbridge settle`, or when the owner taps Done beside the page's link (#539): an agent that
  forgot to settle left the card in Needs you. Done is an answer that carries no pick, so it closes
  the card on every device and reaches the agent as `answered on its page; read the answer
  there`; the page stays the one place the owner answers. Clients show Done only when the
  machine says it takes one (`done`).
- **Waiting state** (#122, #191, #202). A `waiting` item says whether the agent is blocked on the
  question. A flip either way pushes, so the phone moves the notification between channels. `ask
  --waiting` posts the question quietly and lets its `waiting` item push, so the first
  notification already says waiting.
- **Settling** (#62, #405). `settle` closes a question as `elsewhere` or `withdrawn`. It never
  withdraws one whose answer reached the agent, since devices would hold both. `settle --session`
  and `settle --all` close every open question of a session or of the machine (#584), so a
  flood has a way out; `--all` asks first, with the count. Each is one settled notice, posted at
  the pace the machine's rate limit allows, waiting out each 429: the server needs no bulk
  route, and the notices still reach devices one per question.
- **A withdrawal says why** (#1008). `settle <id> --outcome withdrawn` takes `--reason`, one line
  of at most 120 characters, and refuses to withdraw without it: a card that vanished from Needs
  you with no word left the owner guessing whether the agent gave up, found the answer or forgot.
  The settled notice carries it, sealed like the rest. The skill asks for a brief one ("Fixed it
  myself after rereading the logs"), and the SessionStart rule asks agents to withdraw a card the
  owner answered in the terminal: the skill never loads when no card is to be posted, and Haiku
  5.5 withdrew it in 0 of 3 runs without the rule's sentence, 3 of 3 with it
  (`evals/skill/results/1008`). Withdrawals the CLI makes itself give their own: a harness's
  picker that can no longer take the answer, a skipped `setup` test. `settle --session` and
  `--all` take one too but need none, since they clear a flood.
- **Snoozing** (#571). The owner can put a question off: "not now, show me this again at 18:00".
  A snooze is not an answer, so #122 holds: for the agent it means what no answer means. Its job
  is less clutter, in the inbox and in the owner's head. Agents are never woken by one; when an
  agent would block, `waiting` and `wait` say until when, and `wait` exits 3 once per snooze, so
  a polling agent stops paying for the wait. The server brings the question back at its time
  from a plain-text hint, so the web, whose service worker cannot schedule, notifies as Android
  does; it learns only that some question was put off until then. Permission prompts and runs
  can't be snoozed: a prompt's answer window is 10 minutes and the keyboard already takes it.
  Agent-suggested times and event snoozes ("until the run ends") were dropped: a snooze is when
  the owner has time; when the agent needs the answer is its waiting state.
- **Who won a race** (#330). Answers are sealed only to the asking machine, so once it accepts one
  it posts a `settled` notice with the device and its choice or text, sealed to every device. The
  losing device then says "Answered on Pixel: Later".

## Permission prompts

- **Allow covers what the owner saw** (#274, #356). A prompt's `summary` is capped at 200
  characters, so a command could hide a tail past it. The detail and sheet show the whole redacted
  input and enable Allow once its end has been on screen. A row, card or notification allows
  directly only when the whole input fits its one line; otherwise Allow opens the sheet. A
  notification's line counts at most 400 dp, a phone's in portrait: on a tablet, a foldable or in
  landscape the shade is a fixed-width panel or a split column, narrower than the display (#490).
- **Lock screen** (#389). Deny answers from there. Allow asks for the unlock, then opens the
  prompt's sheet. "Allow from notifications" in Settings (off, labelled unsafe) sends at once instead (#390).
- **Escapes** (#357, #410). Control and format characters show as escapes (`‮`), on the
  machine before sealing and again in every client, so a bidi override cannot reorder the command.
  An input with two keys that read alike once redacted or escaped stays at the keyboard.
- **Redaction** (#358, #359). The summary and description are cut from the input after
  redaction. A private key's lines go also when they carry a diff's `+`, `-` or space (#489).
  `inputHash` is keyed under the machine's signing key, so a device holding the redacted input
  cannot test guesses for a short redacted value.
- **Title and command** (#805). A prompt's title is what the agent says the call does (Claude
  Code's `description`), else the tool, on every surface; the command shows under it in a dark
  terminal block. Allow covers the command, never the description: the agent writes the
  description, so it can mislead. A notification draws the block in its expanded view only, a
  decorated custom view, since the standard templates strip a background colour from text.
- History says how and where a prompt was answered ("Denied · on Pixel"), from the machine's
  `settled` notice (#349).

## Runs

- `starbridge run --title <t> --reason <r> -- <command>` (#60). The reason is required: it tells
  the owner why this run is theirs to watch. The run posts its start, its first progress right
  after it, later progress at most every 10 s, a heartbeat every minute and its exit; a first
  progress held back 10 s left a run that opens on `[0/5]` with an indeterminate bar (#828).
  Each update's `at` carries milliseconds (#867): devices keep the update with the latest `at`,
  and with whole seconds the start and the first progress tied, so a phone that got the start's
  push first kept it and showed no step until the next progress, 10 s later.
  Output goes through a pipe, so tools that print progress only to a terminal show none.
- Devices call a run lost 3 minutes after its last update (#190, #249); the server cannot read a
  sealed run, so this is client-side. A lost run shows "Lost, no news for 3 min 37 s" and no
  elapsed time, since its last news may predate most of its life. A run with no progress shows an
  indeterminate bar.
- Runs sit above the questions in their own section, open by default, which each device
  remembers open or closed like Snoozed and History (#835): many runs at once pushed the
  questions off the first screen. Closed, its head still counts the runs and names failed and
  lost ones, failed in red, so closing it never hides a failure.
- Finished, failed and lost runs stay 30 minutes, unless the owner dismisses one (#827).
  Dismissing deletes it from the server, so it leaves every device on its next read; a running
  run offers no Dismiss, and one whose machine posts again comes back. Android also keeps a
  dismissed run out locally until a newer update, so a server without the route still hides it
  on that phone.
- Android shows a notification per run, a Live Update on Android 16; dismissing a run closes it.
  Its progress ("34 of 120", "40%") leads the title: at the end, a long title's ellipsis hid it,
  and the collapsed notification shows no text line under a progress bar (#826).
  The web polls every 2 s while a run is live and the page is visible, else every 10 s.
- The web and the Mac app notify once when a run passes or fails, with the system's sound, as
  Android's Runs channel does (#1064). A run that ends is news whoever is at a screen, so the
  presence hold leaves it alone there too, and a lost run notifies nothing on any device. Runs
  skip Web Push and the server cannot read whether one ended, so an open page notifies, polling
  every 10 s while hidden if this device's notifications are on. An account's first read on a
  page only notes the runs that already ended, and a run that ended more than 30 minutes ago
  never notifies, so opening a page never replays old results.

## Quotas

- **The uploader** in the local agent runs CodexBar for every provider at once, every 5 minutes
  and on request, and computes pace and alerts (`packages/protocol`), so clients only render.
- **Which providers** (#963). Setup probes the providers turned on in CodexBar and the plan of
  each agent it finds: Claude Code, Codex, Cursor (`~/.cursor` or `cursor-agent`), Antigravity
  (`agy` or `~/.gemini/antigravity*`) and, on macOS only, opencode (OpenCode and OpenCode Go).
  CodexBar finds those two plans on its own only in browser cookies, which it imports only on
  macOS; elsewhere they need a key or cookie in CodexBar's config, which turns them on anyway.
  The ones that read windows are the default. Pi has no plan of its own, and most opencode users
  pay their model's provider: that provider counts when CodexBar has it turned on. A main window
  that repeats a named one, as Antigravity's do, shows once under the name.
- **Alerts** (#115): `low` at CodexBar's defaults (50% and 20% left), and pace: unused headroom of
  30% one hour before the reset for windows of a day or less, one day before for longer ones. Only
  a new alert notifies; every other snapshot is posted quiet. The thresholds are fixed, since
  devices' settings never reach the uploader: each device picks which alerts it shows, per window
  ("Quota alerts per window").
- **Window names** (#914). CodexBar calls Claude's and Codex's 5-hour window "Session", and a
  notification titled "claude Session resets with headroom unused" read as the weekly limit
  (#844). The uploader names such a window by its length ("5-hour"), as z.ai's already is; other
  labels stay CodexBar's, since Claude has two weekly windows that only their labels tell apart. A reset that moves by less than half its window is
  the same cycle, as in CodexBar.
- **A failing provider** (#397, #450) is asked once more, then keeps its last good windows, sent
  with the error and when they were read. Kept windows raise no alerts and go once their reset
  passes. A provider with nothing to keep shows only its error. Devices get a short error; the CLI
  logs CodexBar's whole. The run timeout is 120 s.
- **Another machine already sends them** (#748). Two machines often read the same accounts, so
  when another active machine of the account posted a snapshot in the last day, setup names it
  and asks whether to send from this machine too, Enter saying no: `devbox already sends quotas.
  Send from this machine too? [y/N]` under the Quotas title. The server says which machines post snapshots and
  when (`GET /v1/quota/senders`), never what they hold. A machine that already sends, or a
  `--providers` list, skips the question. Telling identical accounts apart across machines waits
  for a CodexBar account fingerprint.
- **No snapshot yet** (#661). A snapshot is sealed to the devices active when it is taken, so a
  device that just joined reads none until the next upload, and quota items send no push. The
  agent posts one when it sees a device join; the Quotas screen with nothing to show also asks
  the machines once, as a pull does, and says "Loading quotas from <machines>…" meanwhile. Only
  when nothing comes back does it give the setup line, and with no machine it says to add one.

## Quota settings follow CodexBar

A curated set of CodexBar's own settings, with CodexBar's meaning, per device (#115): bars show
used (the default; CodexBar defaults to remaining) or remaining; reset times relative or as a
clock time; workday ticks on weekly bars (off, 4, 5 or 7 days); per provider show and order. Cost
tracking and menu-bar-only settings stay out, and so does the tick style (#914): its "Hidden" was
ticks off, and Android never had the row. Android shows quota notifications on a low-importance
channel; the web shows them only while a page is open, since quota snapshots skip Web Push.

## Quota alerts per window

Each window picks any of four alerts (#914): Runs out (at this pace, before its reset), 50% left,
20% left, and Unused at reset (it resets within the hour, or the day for longer windows, with 30%
or more unused). A window nobody set follows its length: 5-hour and daily windows (a day or less)
notify about nothing, weekly and monthly ones (and those of unknown length) about Runs out. A
5-hour window that runs out resets within hours, so its alert was noise; a weekly one costs days.

- **One table** (#925). Settings → Quotas holds everything about quotas in one box: how bars read,
  Running out first, then each provider in its order, with its drag handle and an eye that shows
  or hides it, and under it its windows, a checkbox per alert. A hidden provider folds to its name.
  Each change is one click. The owner chose this from mockups over separate Quota alerts, Per
  window and Providers sections, an expand-and-pick row per window (Default, Custom or Off, then
  chips, CodexBar's model), and a menu per window: those cost two to four clicks and much UI for
  a few providers. Default rows ("every weekly or monthly window") were dropped too, since few
  people have many providers and they confused the table; the defaults by length stay, unseen,
  for windows nobody set. A window with no box ticked is off.
- **Android puts the alerts a tap away** (#930). On a phone the one table read badly: Running
  out first sat alone, the column names floated in a tile of their own, off their checkboxes, and
  each provider row looked like a second header. So Settings → Quotas ends with Alerts, a page
  with one card, the column names once over a row per shown window; Order holds Running out first
  and the providers, each with its handle and eye. Columns are 56 dp, and each line of a column
  name shrinks rather than breaks inside a word, as the rail's tab labels do: "Unused" broke at
  font scale 1.3. The owner chose this from mockups over the names repeated in each provider's
  card; the web keeps the one table.
- **Settings' section names on the web** (#930). Beside the rail, a 1200 px window (the desktop
  app's) gave the names a 220 px column and pushed the boxes off to the right. From 1440 px the
  names keep that column; from 1100 px they take 160 px and the page a smaller margin; narrower,
  each name sits over its box.
- **Filtering on the device.** The uploader still raises every alert, and each device shows the
  ones its settings pick, so the server and the uploader learn nothing of them.
  `packages/protocol/src/quotaAlerts.ts` holds the rule and `quota-alerts.json` its vectors, which
  Android's port checks. `alertsFor` raises only the lowest level reached, so a window that skips
  past a level picked still notifies at the next one down.
- **Migration.** These replace the bell per provider and the two switches that gated every
  provider's alerts ("Warn when a window runs low", and "Warn before a window runs out", which also
  covered unused headroom). A device whose bell was on for a provider keeps what its switches let
  through, as one key for the provider, which becomes a key per window the first time one of them
  is set. A device with no bell on gets the defaults.
- **The hidden page polls.** A web page that is hidden reads quotas each minute while any window
  can notify, as it did while any provider's bell was on; with the defaults that is every page.

## Quota order

One rule on both clients (#159, #162). Hidden providers drop out; the rest go in the order set in
Settings (unlisted ones after, in the uploader's order), each provider's windows in the uploader's
order. "Running out first", on by default, then moves windows that will run out or ran out, and
have not reset, above the others. Windows are grouped by provider (#160); groups follow their
first window, so a provider with a window running out leads.
