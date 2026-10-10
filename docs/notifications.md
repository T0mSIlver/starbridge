# One notification per question

Your agents and their apps notify you too: a terminal bell when Claude Code waits, a push from the
Claude app, a banner from the Codex app. With Starbridge on, the same question can then reach you
twice. Here is what each tool sends and how to turn it off once Starbridge covers it.

Starbridge notifies when an agent asks you something, waits on you, or asks permission (once you
[turn permission prompts on](tell-your-agents.md#what-each-agent-supports)). An agent that asks
through Starbridge often ends its turn to wait, so a tool's "turn done" notification arrives with
the question. Turning those off leaves Starbridge alone, but you then hear nothing about a turn
that ends without a question. `starbridge setup` changes none of these settings.

Menu names come from each tool's documentation in October 2026 and may have moved since.

## Agents on your machine

| Agent | What it notifies | Turn it off |
|---|---|---|
| Claude Code (terminal) | A desktop notification or bell when a permission prompt waits about 6 seconds, or a turn ended about 60 seconds ago and you haven't typed. Desktop notifications are on by default in Ghostty, Kitty and iTerm2. | `/config` → Local notifications → `notifications_disabled`, or `"preferredNotifChannel": "notifications_disabled"` in `~/.claude/settings.json`. A `Notification` hook you added still runs: remove it from `hooks` in the same file. |
| Claude Code, Remote Control | A push to the Claude app for permission prompts and questions, and when Claude decides a finished task is worth one. Both are off by default. | `/config` → clear Push when actions required (permission prompts and questions) and Push when Claude decides (finished tasks). In settings: `inputNeededNotifEnabled` and `agentPushNotifEnabled`. |
| Claude Code in Claude Desktop | A banner when a session asks permission, asks a question, or finishes a task while the app is in the background. | Settings → Permission request notifications, Question notifications and Task complete notifications: set each to Off. Sessions in a project follow the project's Notifications instead, in the project's sidebar menu. |
| Codex CLI | A terminal notification when a turn ends or asks for approval, on by default. `notify` runs a program you choose when a turn ends. | In `~/.codex/config.toml`, `notifications = false` under `[tui]`, or `["approval-requested"]` while Starbridge's permission prompts are off. Remove the `notify` line. |
| Codex app | A banner when a turn completes, and when Codex asks permission or a question. | Settings → Notifications: turn completion to Never. Keep the permission and question notifications, which Starbridge doesn't carry. |
| opencode | Sounds and desktop notifications for questions, permissions, errors and finished sessions, only if you turned attention on. Off by default. | In `tui.json`, `"attention": { "enabled": false }`. A plugin you added that notifies on `session.idle`: remove it from your plugins folder. |
| Pi | Nothing built in. The `notify.ts` example extension, if you installed it, notifies when the agent is done. | Remove the extension. |

Sources: Claude Code [terminal](https://code.claude.com/docs/en/terminal-config#get-a-terminal-bell-or-notification),
[notification events](https://code.claude.com/docs/en/hooks#notification),
[Remote Control](https://code.claude.com/docs/en/remote-control#mobile-push-notifications) and
[desktop](https://code.claude.com/docs/en/desktop); Codex
[CLI](https://learn.chatgpt.com/docs/config-file/config-advanced) and
[app](https://learn.chatgpt.com/docs/notifications); opencode
[TUI](https://opencode.ai/docs/tui); Pi's
[notify extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/notify.ts).
Claude Desktop's labels come from the app, as its documentation doesn't name them.

## Apps and websites

| App | What it notifies | Turn it off |
|---|---|---|
| Claude app (Android, iOS) | The Remote Control pushes above, and Dispatch sessions finishing or needing approval. | For Remote Control, the `/config` toggles above. The Claude app's own notification settings aren't documented; use the phone's settings below. |
| ChatGPT on the web | Codex notifications by category, by push, email or SMS depending on the category. | Settings → Notifications. The documentation doesn't list the categories. |
| ChatGPT app (Android, iOS) | Not documented. | The phone's settings below. |
| Any Android app | Notifications by category, which Android calls channels. | Settings → Notifications → App notifications → the app, then turn off a category. Or touch and hold one of its notifications, tap Settings, and turn off its category. |

Sources: [ChatGPT notifications](https://learn.chatgpt.com/docs/notifications),
[Android notifications](https://support.google.com/android/answer/9079661).

## Starbridge's own

On Android, Settings → Notifications → Notification settings opens Android's page for the app,
with one category per kind:

| Category | What it carries |
|---|---|
| Waiting for you | Questions an agent stopped to wait for you on. Alerts with a heads-up. |
| Questions | Questions your agents work around until you answer. Sound only. |
| Permission prompts | Agents waiting for you to allow a command or an edit. |
| Join requests | A browser or phone signed in to your account asking to join. |
| Runs | Commands your agents run that your rules name, until they pass or fail. |
| Quotas | Quota windows running low, running out or resetting unused, as you pick them. Silent. |

On the web, notifications are on once you pick Turn on notifications in the inbox, and off in the
browser's site settings for starbridge.run. A closed browser gets questions, permission prompts and
join requests. Quota alerts show only while a Starbridge page is open, and runs only in the inbox,
never as a notification. Settings → Notifications → Sound for new questions plays a chime, off by default.

In Settings → Quotas, each quota window has a checkbox per alert: runs out before its reset, 50%
left, 20% left, or resets with headroom unused. Weekly and monthly windows start with runs out
ticked, and 5-hour and daily windows with nothing. These settings belong to each device.

Permission prompts reach your devices only after you run `starbridge config permissions on` on the
machine, and stop with `starbridge config permissions off`.

Settings → Notifications → Hold while you’re at a screen keeps a question off your other devices
while you use Starbridge: a page or the app you touched in the last minute. They stay quiet for as
long as you are there, then for the hold time after you leave (30 s by default), and notify if
nothing answered it. A computer counts too once you run
`starbridge config presence on` on it: unlocked and used in the last minute. In the Mac app,
Settings → Notifications → Count any app on this Mac does the same without the CLI, window
closed or not. A locked or sleeping Mac never counts.

## Which replaces which

| Starbridge | Replaces |
|---|---|
| Waiting for you, Questions | Push when actions required in Claude Code, Question notifications in Claude Desktop, opencode's question sound, and the turn-done notifications above |
| Permission prompts, once on | Permission prompt notifications in Claude Code, Claude Desktop, the Codex CLI and opencode |
| Runs, Quotas | Nothing: the tools above don't notify about these. |
