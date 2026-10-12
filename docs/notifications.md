# Notifications

Starbridge notifies you when an agent asks you something, waits on you, asks permission (once you
[turn permission prompts on](tell-your-agents.md#what-each-harness-supports)), or when a run or a
quota window has news.

## Starbridge's notifications

On Android, Settings → Notifications → Notification settings opens Android's page for the app,
with one category per kind:

| Category | What it carries |
|---|---|
| Waiting for you | Questions an agent stopped to wait for you on. Alerts with a heads-up. |
| Questions | Questions your agents work around until you answer. Sound only. |
| Permission prompts | Agents waiting for you to allow a command or an edit. |
| Join requests | A browser or phone signed in to your account asking to join. |
| Runs | Commands your agents run in `starbridge run`, until they pass or fail. |
| Quotas | The [quota alerts](#quota-alerts) you pick. Silent. |

On the web, pick Turn on notifications in the inbox; turn them off in the browser's site settings
for starbridge.run. A closed browser still gets questions, permission prompts and join requests.
Quota alerts and finished runs notify only while a Starbridge page is open, in the background
too.

Settings → Notifications → Sound for new questions plays a chime in an open Starbridge page, once
notifications are on in that browser and you have clicked the page.

In the Mac app, questions, permission prompts and finished runs play the macOS notification
sound, and quota alerts are silent. Turn sounds off in System Settings → Notifications →
Starbridge. macOS plays them at System Settings → Sound → Alert volume, on the output under Play
sound effects through, which may not be your headphones. If macOS blocks Starbridge's notifications, the app's Settings → Notifications says
so.

### Quiet other devices while you're at a screen

With Settings → Notifications → Quiet other devices while you're at a screen, a question
notifies only the device you are using: a Starbridge page or app you touched in the last minute.
Your other devices notify after the hold time once you leave (30 s by default), if nobody
answered.

A computer counts too while it is unlocked and used in the last minute, once you run
`starbridge config presence on` on it. It tells the server only yes or no, on macOS, Windows,
and Linux under GNOME or X11 with `xprintidle`.

The Mac app counts without the CLI, window open or not. A locked or sleeping Mac never counts.

### Quota alerts

In Settings → Quotas, each quota window has a checkbox per alert:

- **Runs out.** At the rate you have used it since it began, the window runs out before its
  reset. Starbridge judges the rate once 5% of the window has passed.
- **50% left** and **20% left.** Half, or a fifth, of the window is left.
- **Unused.** At that same rate, 30% or more of the window will be left when it resets. It comes
  in the last hour before the reset for a window of a day or less, and in the last day for a
  longer one.

Weekly and monthly windows start with Runs out ticked, and 5-hour and daily windows with nothing.
Each device keeps its own choice.

<a id="which-replaces-which"></a>

## Turn off the duplicates

Your harnesses and their apps notify you too, so the same question can reach you twice. Their
"turn done" notifications often arrive with a question, but turning them off leaves you nothing
for a turn that ends without one. Menu names are from October 2026.

| Starbridge | Replaces |
|---|---|
| Waiting for you, Questions | Claude Code's Push when actions required, Claude Desktop's Question notifications, opencode's question sound, and the harnesses' turn-done notifications |
| Permission prompts, once on | Permission prompt notifications in Claude Code, Claude Desktop, the Codex CLI and opencode |
| Runs, Quotas | Nothing: the harnesses don't notify about these. |

<a id="agents-on-your-machine"></a>

### Harnesses

| Harness | What it notifies | Turn it off |
|---|---|---|
| Claude Code (terminal) | A desktop notification or bell when a permission prompt waits about 6 seconds, or a turn ended about 60 seconds ago and you haven't typed. On by default in Ghostty, Kitty and iTerm2. | `/config` → Local notifications → `notifications_disabled`, or `"preferredNotifChannel": "notifications_disabled"` in `~/.claude/settings.json`. Remove any `Notification` hook you added from `hooks` in the same file. |
| Claude Code, Remote Control | A push to the Claude app for permission prompts and questions, and when Claude decides a finished task is worth one. Off by default. | `/config` → clear Push when actions required and Push when Claude decides. In settings: `inputNeededNotifEnabled` and `agentPushNotifEnabled`. |
| Claude Code in Claude Desktop | A banner when a session asks permission, asks a question, or finishes a task while the app is in the background. | Settings → Permission request notifications, Question notifications and Task complete notifications: set each to Off. A project's sessions follow the project's Notifications, in its sidebar menu. |
| Codex CLI | A terminal notification when a turn ends or asks for approval, on by default. `notify` runs a program you choose when a turn ends. | In `~/.codex/config.toml`, under `[tui]`, `notifications = false`, or `["approval-requested"]` while Starbridge's permission prompts are off. Remove the `notify` line. |
| Codex app | A banner when a turn completes, and when Codex asks permission or a question. | Settings → Notifications: turn completion to Never. Keep the permission and question notifications, which Starbridge doesn't carry. |
| Pi | Nothing built in. The `notify.ts` example extension notifies when the agent is done. | Remove the extension. |
| opencode | Sounds and desktop notifications for questions, permissions, errors and finished sessions, if you turned attention on. Off by default. | In `tui.json`, `"attention": { "enabled": false }`. Remove any plugin you added that notifies on `session.idle`. |

Sources: Claude Code [terminal](https://code.claude.com/docs/en/terminal-config#get-a-terminal-bell-or-notification),
[notification events](https://code.claude.com/docs/en/hooks#notification),
[Remote Control](https://code.claude.com/docs/en/remote-control#mobile-push-notifications) and
[desktop](https://code.claude.com/docs/en/desktop) (Claude Desktop's labels come from the app);
Codex [CLI](https://learn.chatgpt.com/docs/config-file/config-advanced) and
[app](https://learn.chatgpt.com/docs/notifications); opencode [TUI](https://opencode.ai/docs/tui);
Pi's [notify extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/notify.ts).

### Apps and websites

| App | What it notifies | Turn it off |
|---|---|---|
| Claude app (Android, iOS) | Claude Code's Remote Control pushes, and Dispatch sessions finishing or needing approval. | For Remote Control, Claude Code's `/config` toggles. For the rest, the phone's notification settings for the app. |
| ChatGPT on the web | Codex notifications by category, by push, email or SMS. | Settings → Notifications. |
| ChatGPT app (Android, iOS) | Not documented. | the phone's notification settings for the app. |
| Any Android app | Notifications by category, which Android calls channels. | Settings → Notifications → App notifications → the app, then turn off a category. Or touch and hold one of its notifications, tap Settings, and turn off its category. |

Sources: [ChatGPT notifications](https://learn.chatgpt.com/docs/notifications),
[Android notifications](https://support.google.com/android/answer/9079661).
