# Platform facts

What the code relies on, with the versions checked.

- **Claude Code mods** (2.1.286 to 2.1.289): `$.http.fetch` aborts any request without a complete
  answer after 30 s. `$.prompt.submit` starts a turn in an idle session within 0.2 s; mid-turn it
  queues its own turn after the running one, and resolves only when that starts, so a poll loop
  must not await it. Under Claude desktop (2.1.295, an Agent SDK session), a prompt queued
  mid-turn starts only once the mod's open `$.http.fetch` or `$.process.run` returns, not when the
  running turn ends; `$.clock.sleep` holds nothing back. So while a submitted prompt waits for its
  turn, the mod's loop makes only short calls (#1446). On 2.1.296 a `tool.call` hook's `context`
  reaches the model with that tool's result, mid-turn, as a PostToolUse hook's
  `additionalContext` does; the transcript records it as a `hook_additional_context` attachment.
  A plugin's own `prompt.submit` hook never sees the prompts it submits, and `$.session.send` to
  its own session is refused as "no live session" (#1484). On 2.1.296 the queue drops no plugin
  prompt and merges none: in an SDK session a typed or peer prompt dequeues ahead of a waiting
  plugin prompt, which runs after it (the 2.5 min late answer of #1517). An interrupt (Esc, or
  the SDK's) leaves it queued, and a hot reload waits for
  the turn's end and keeps it. A process that exits loses it: `--resume` does not bring it back.
  `turn.start` carries its text, framed as "The <plugin> plugin sent a message:". `$.state`
  keeps a value across a hot reload and starts empty in each process (#1517). Remote Control shows a submitted prompt on the phone. A hot reload aborts the
  mod's requests. `/resume` fires `session.end` with reason `resume` and no `session.start`. Mods
  load only from user or managed settings or an installed plugin, not project settings.
  Starbridge states 2.1.287, the oldest the mod works with, as its minimum, and setup says when
  `claude --version` is older, since an older one may lack mods or `claude plugin list --json`
  (#620).
- **Claude Code sessions**: `~/.claude/sessions/<pid>.json` holds `sessionId`, `name` (the title)
  and, under Remote Control, `bridgeSessionId`; the Remote Control URL is
  `https://claude.ai/code/<bridgeSessionId>`. Records are rewritten in place without truncation,
  so read only the first JSON object (`cli/src/claude.ts`). `nameSource` is `derived`, `auto` or
  `user`, and absent for Claude Desktop's names. The transcript is
  `~/.claude/projects/<cwd, each other character a dash>/<sessionId>.jsonl`; a user line typed by
  a person has no `isMeta` or `isCompactSummary` and no `origin.kind` other than `human`.
- **Claude Code plugins of one name** (2.1.299 and 2.1.301, #2107): `--plugin-dir` folders come
  before `CLAUDE_CODE_PLUGIN_DIRS` ones (read from the process or the user settings' `env`), and
  either replaces the installed plugin of its name whole. Between such folders, the first gives the
  skills, and the first that has hooks gives the hooks, so a hookless copy first leaves a later
  one's hooks running; but a later one's hooks module is refused ("another plugin of that name
  loads first"), and so is a plugin of the name in `~/.claude/skills/<name>`. Claude desktop's
  sessions read `CLAUDE_CODE_PLUGIN_DIRS` from the user settings, and set
  `CLAUDE_CODE_ENTRYPOINT=claude-desktop`; over SSH also `CLAUDE_SSH_DAEMON_CHILD=1`. A hook gets
  `CLAUDE_PID`; a mod's `$.process.run` child has Claude Code as its parent. A hooks module calls
  `on("<event>", hook)` with the event written out and spells `$` only as `$.noun...` at the call:
  a module that spreads arguments into `on` does not load. A plugin's `hooks.json` may hold both
  `hooks` and `modules`.
- **Claude Code hooks** (2.1.289): `PermissionRequest` waits up to 600 s and races the dialog. It
  fires under `--dangerously-skip-permissions` for `ask` rules and for Remote Control's `--print
  --sdk-url` children, not for auto mode's classifier blocks, which reach hooks only as
  `PermissionDenied`. When the keyboard answers Yes first the hook gets no signal; Esc or No sends
  it SIGTERM. In an SDK session with `--permission-prompt-tool=stdio`, as Claude desktop runs, a
  hook's allow sends the host `control_cancel_request` for its open `can_use_tool` request, which
  closes its `AskUserQuestion` picker (2.1.299, 2.1.301). Every `PreToolUse` deny shows as a red "hook error". In cloud sessions only repo hooks
  run, and environment variables are readable by the agent.
- **Codex** (CLI 0.160): the TUI runs sessions in a shared app-server daemon; `codex queue --thread
  <id> --message <text>` starts a turn in an idle session or runs next in a busy one, and starts
  the daemon itself. It takes the message only as an argument and refuses sub-agent threads. An
  exec thread's rollout has `originator: codex_exec`. A thread's title is its last
  `thread_name` in `$CODEX_HOME/session_index.jsonl`, which Codex appends to on each rename, so
  Codex cards and prompts carry it as the other agents' do (#952). `PermissionRequest` runs before the
  approval dialog and blocks it; any deny among its hooks wins, else the last allow, else the
  dialog opens. A hook that times out or fails decides nothing. Interrupting the turn kills a
  running hook with SIGKILL, and `Interrupt` hooks get at most 3 s. New or changed hooks need trust at launch:
  the TUI asks ("Hooks need review"), `codex exec` skips an untrusted hook silently, and the
  trust goes in `config.toml` as `[hooks.state."<plugin>:hooks/hooks.json:<event>:<group>:<handler>"]`
  with a hash of the handler, not of the file. Plugins come from marketplaces, local or Git,
  read from `.agents/plugins/marketplace.json` or `.claude-plugin/marketplace.json`; a plugin's
  hooks run with `${PLUGIN_ROOT}` set. Hook events and outputs follow Claude Code's
  (`SessionStart` `additionalContext`, `PermissionRequest`). The daemon's `turn/steer`
  (`threadId`, `expectedTurnId`, `input`) adds a user message to the running turn; the model reads
  it with the result of the tool call under way, and nothing runs it again after the turn
  (checked with the TUI on a scripted model: 2.4 s after the answer, with the next tool result,
  #1486). `thread/turns/list` with `limit: 1` gives the running turn's id (`status:
  "inProgress"`); with no turn running, `turn/steer` fails with "no active turn to steer".
- **Pi** (0.87.1, 1.0.4, 1.2.0): `pi.sendUserMessage(..., { deliverAs: "followUp" })` behaves like
  `codex queue`; `"steer"` enters a busy run after its current tool calls, before the next model
  call, and skips none of them; an idle session starts a turn either way (1.2.0's
  `agent-loop.js`; checked with the extension on 1.2.0: a steered answer came with the next tool
  result, a follow-up after the run, #1484). Commands get `PI_SESSION_ID`. pi-permission-system (33 to 40) caps every
  authorizer link's allow on `path` and `external_directory` to defer (its ADR 0007; making it
  configurable is its #620). A bash allow pattern is never safe there (#488): before 9.0.1 it
  matched the whole line, so `starbridge ask *` passed `starbridge ask x; curl … | sh`; from 9.0.1
  it matches each command of the line but takes a `VAR=…` prefix off first, so it passed
  `NODE_OPTIONS=--import=data:… starbridge ask`. A bash ask names only the command that asked in
  `command`, the line in its "full command" evidence (26.0.0 on), and a link's allow runs the line. Its dialog appears after 1 s, and a dialog opened over another
  strands it.
- **opencode** (1.18.31, 1.19.0): `promptAsync` into a busy session enters at its next step.
  1.19.0's experimental `POST /api/session/:id/prompt` takes `delivery: "queue"`, but runs it at
  once in a history of its own that the session's messages never show, so nothing queues behind
  a run (#1484). The `permission.ask` hook is declared but never called; prompts publish
  `permission.asked` and take `POST /permission/{id}/reply`. `question.asked` and `POST
  /question/{id}/reply` work the same way. Plugins get an in-process SDK client;
  `experimental.chat.system.transform` is the only hook that adds to the system prompt; `shell.env`
  sees each bash call's session id. Worktrees of one repository share a `projectID`.
- **Cursor** (`cursor-agent` 2026.10.01, read in its bundle): agent commands get `CURSOR_AGENT=1`,
  and from the CLI `CURSOR_CONVERSATION_ID`; hooks get neither, but their input carries
  `conversation_id` and `cursor_version`. Hooks load from `~/.cursor/hooks.json`, project files,
  plugins under `~/.cursor/plugins/local/<name>` and Claude Code's plugins and settings, whose
  events are mapped to Cursor's except `PermissionRequest` and `Notification`. Run: an interactive
  session fires a local plugin's `sessionEnd` but not its `sessionStart` or `stop`, and lists
  none of its skills; `-p` fires its `sessionStart`.
  A hook's `timeout` is in seconds, any positive value. `cli-config.json` sits in
  `$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`; the login sits in
  `$XDG_CONFIG_HOME/cursor` whatever `CURSOR_CONFIG_DIR` says. A `--model` given once stays in
  `cli-config.json` for later runs. The free plan runs only `auto`, and its usage limit stopped
  the skill eval after 7 runs (#964).
- **CodexBar**: `usage --provider <unknown>` exits 0 and prints every provider, so the uploader
  keeps only matching rows. Mistral windows carry no `windowMinutes`, so they get no pace. The
  Claude probe drives `claude /usage` and can take 10 s on a busy machine.
- **Browsers**: WebKit 26 reads an X25519 `CryptoKey` back from IndexedDB as null. iOS gives Web
  Push only to Home Screen apps. Chrome prefixes the app name to an installed window's title
  unless the title starts with it. Umami drops headless browsers' hits as bots.
- **Android**: OkHttp retries a POST whose connection dropped before the reply started, so a
  server may receive it twice. Android 16 draws the notification accent itself. Material 3's
  expanded `SearchBar` passes a screen-filling minimum height to its field (#341).
- **Antigravity** (`agy` 1.3.2): commands the agent runs get `ANTIGRAVITY_CONVERSATION_ID`,
  `ANTIGRAVITY_AGENT=1`, and the language server's `ANTIGRAVITY_LS_ADDRESS` and
  `ANTIGRAVITY_CSRF_TOKEN`; hooks and MCP servers get only the conversation id. A hook runs from
  its `hooks.json`'s folder, as a child of `agy`, whose arguments show `-p`. A plugin folder
  written into `~/.gemini/config/plugins/` loads without `agy plugin install`, its `always_on`
  rule included. `PreToolUse` `deny`, `force_ask` and `overwrite` work; `allow` does not skip the
  prompt, even with `permissionOverrides`. `permissions.allow` entries match words, refuse `;`,
  `&&`, `|`, `$(…)` and redirections, and pass a variable assignment or `env` in front.
  `--sandbox` runs commands without the home folder or the network unless `BypassSandbox`, which
  an allow entry covers. `PreInvocation` drops an injected `toolCall` without a word. A `Stop`
  hook's `continue` reason comes in as a system message, and `agy` cuts off a hook that keeps
  blocking after some continuations. The language server (Connect JSON on loopback, header
  `x-codeium-csrf-token`) takes `SendUserCascadeMessage` with `MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE`:
  the TUI shows it as the user's message and runs it after the current turn, with the session's
  hooks and permissions; without `cascadeConfig.plannerConfig.planModel` the turn fails, and
  `GetCascadeTrajectoryGeneratorMetadata` names the model last run. A pending approval is a
  `WAITING` step whose `requestedInteraction.permission` names the command;
  `HandleCascadeUserInteraction` answers it, and the TUI says "Answered from another device".
- **Skill eval** (#299): what lifted scores was one context line per option starting with its
  label, "no answer is never a yes" placed where the agent waits, and card text in single quotes
  (`$0` in double quotes blanked a Codex card). Records: `evals/skill/results/299`.
  Round 2 (#624): a card that blocks nothing was still marked waiting until the skill said
  "post without `--waiting`" beside `--no-mark`, and GLM Flash put its pick first until "even
  when your pick is not first". Records: `evals/skill/results/624`.
  Cursor and Antigravity (#964), until their plans ran out: Cursor on `auto` passed 99% of checks
  over 7 runs, and on the rerun (#1133) 20 runs on 10 of its 14 situations, until the free plan's
  usage limit again (it states no reset date). The rerun's weak checks: a card's first context line under 120
  characters 9 of 14, answerable cold 11 of 14, the choice readable in one skim 11 of 14. Both
  `force-push` runs waited on their card and pushed only after the answer (#1810; the judge's note
  on rep 2 said otherwise, wrongly). Antigravity on gemini-3.8-flash-medium passed every card check over 4 runs. Three of those 4
  read the eval's scenarios through the CLI shim's path, so the eval now runs a bundle of the CLI
  from its work folder. The rerun (#1133) did 9 runs on 5 of the 14 situations from that bundle and
  passed 154 of 155 checks, until the Google account's individual quota ran out again (2026-10-17,
  resets in a week). The one miss: `failing-test` rep 2 posted two cards and pushed the change to
  `origin/main` before the owner answered. 9 situations are still to run (#1133). Records: `evals/skill/results/964`.
