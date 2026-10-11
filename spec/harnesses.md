# Harnesses

## How an answer comes back

An agent posts a question, keeps working and ends its turn; the answer arrives as a new prompt.
Where nothing can deliver a prompt, the agent runs `starbridge wait <id> --timeout 5m` before
ending its turn. `ask` prints which of the two applies (#203). `wait <id>` marks the decision
waiting, which notifies the owner once more; `wait --no-mark` collects the answer to a question
that blocks nothing yet, such as one for tomorrow, without that (#603). A `wait` without an id, run in an
agent's session, takes only that session's answers (#324). `ask` promises a prompt in Claude Code
only when that session's mod called the local agent within the last 45 s (#537); after `/clear` the mod's
hello under the new id names the old one (`replaces`), which then no longer counts. An installed plugin is no proof,
since a session started before it, or one whose mod failed to load, has none; without an agent,
the poller's lease says only that some session runs a mod. When unsure, `ask` prints the `wait`
line, the safe side: at worst a prompt repeats an answer the agent already read.

| Harness | Delivery |
|---|---|
| Claude Code: terminal, desktop app's Code tab, IDEs | The mod (`mod/`) long-polls the local agent's socket in 25 s cycles and submits each answer with `$.prompt.submit` |
| `claude -p`, Agent SDK scripts | `wait`: the run ends with its last turn, so the mod starts no loop there (#321) |
| Codex TUI | The local agent runs `codex queue --thread <id>`; the message only says to run `starbridge wait <id>`, since other local users can read process arguments (#274). Retried each minute, 30 times |
| `codex exec` | `wait`: nothing runs a queued message once exec returns. The thread's rollout tells exec apart (#245) |
| Pi TUI and RPC | The Pi extension (`mod/pi`) calls `pi.sendUserMessage(text, { deliverAs: "followUp" })` (#232) |
| opencode TUI and `serve` | The opencode plugin (`mod/opencode`) calls `client.session.promptAsync`, one loop per session (#300) |
| `pi -p`, `opencode run`, subagents | `wait` |
| Antigravity, interactive | The local agent sends the answer to the conversation's language server, at the address and token `ask` saw, with `SendUserCascadeMessage` run when idle. Retried each minute, 30 times (#961) |
| `agy -p` | `wait`: its language server ends with the run |
| `cursor-agent` | Setup's `stop` hook holds up to 10 minutes while the conversation has a question open and returns the answer as `followup_message`, Cursor's next user message (#956) |
| `cursor-agent -p` | `wait`: it runs no stop hook |
| Cursor IDE | `wait`: its commands get no conversation id |

- **The mod** (#7, #35, #48, #68). Why a mod and not Claude Code channels: channels need launch
  flags and an allowlist. A mod cannot listen on a port and its `$.http.fetch` aborts after 30 s,
  hence the short cycles. The CLI hands an answer again until the mod acks it, and the mod
  re-reads the session id before submitting, so an answer that arrives during `/clear` waits for
  the session that asked; `/resume` keeps polling under the resumed id. Without a local agent the mod
  falls back to polling through the CLI, and both paths share the set of submitted lines.
- **Which sessions run the mod's loop** (#863). Claude Code tells a mod whether a person is at
  the prompt, and says no both for `claude -p` and for sessions a host such as Claude desktop's
  Code tab or an IDE runs through the SDK. The mod tells them apart by `CLAUDE_CODE_ENTRYPOINT`:
  it starts its loop in an interactive session, or one whose entry point is set and is not
  `sdk-cli` (`claude -p`), `sdk-ts` or `sdk-py` (Agent SDK scripts). A loop in a run that ends
  early costs nothing, since `ask` still prints the `wait` line for an unattended session.
  `starbridge status` run from a session whose mod never called says so.
- **Which harness asked** (#319, #320). Harnesses pass their variables to processes they start, so
  `ask` takes Codex, Pi or opencode over Claude Code when both are set, unless Claude Code runs as `claude
  -p`, the only way Codex and Pi start it. A Codex sub-agent asks under its root thread, since
  `codex queue` refuses sub-agent threads. Antigravity gives commands `ANTIGRAVITY_CONVERSATION_ID`
  and ranks after Codex, Pi and opencode, which sessions start for reviews, and before Claude Code;
  its card title is the one Antigravity generates, read from
  `~/.gemini/<product>/annotations/<id>.pbtxt` (#960).
- **A Claude Code session's name** (#970, #1181). `ask` sends the name the owner or Claude Desktop
  gave the session. Claude Code names the rest itself: `<directory>-<hex>` (`nameSource:
  "derived"`, `bridge-cse-<id>` under Remote Control), which says nothing, and later sometimes the
  first prompt cut at about 50 characters with "..." (`"auto"`). For those and for an unnamed
  session, `ask` titles the card with the first sentence of the session's first prompt, cut on a
  word boundary to 60 characters, read from its transcript past command, system, tool-result,
  compaction and peer lines. It reads up to that line and sends nothing else from the prompt.
- **Cursor** (#955) gives its agent's commands `CURSOR_AGENT=1`, so `ask` names the agent
  `cursor`. `cursor-agent` also gives them `CURSOR_CONVERSATION_ID`, the session; the IDE does
  not (2026.10), so a question from an IDE chat names no session. Codex, Pi, opencode and
  Antigravity win over Cursor, as over Claude Code: their variables name the session that runs
  the command.
- **Cursor's stop hook** (#956). Nothing else puts a message into a live Cursor chat: deeplinks
  only prefill the box, `--resume -p` runs in another process, and the Cloud Agents API is for
  cloud agents. So the hook holds while the conversation has a question open, through the local
  agent's session events as the mod reads them, or the server without one. The chat shows busy
  while it holds, and the owner may stop it there. The hold stops at 10 minutes, so a forgotten
  question does not keep a chat busy for good; then it returns the `wait` line as the follow-up,
  and the agent waits as anywhere else. `ask` promises a prompt only for a conversation whose
  `sessionStart` or `stop` hook greeted the local agent and whose `sessionEnd` has not said
  goodbye: a chat started before setup, or a resumed one before its first stop, gets the `wait`
  line, and so does `cursor-agent -p`, which runs sessionStart but no stop hook, so the hook greets
  nothing when `cursor-agent`'s arguments hold `-p`. A stopped or failed turn holds nothing.
  `cursor-agent` 2026.10.01 runs each stop hook twice at once with the same input, so a hold first
  claims the turn (conversation, generation and loop count) with an exclusive file; the other
  returns at once. Checked in a signed-in `cursor-agent` on 2026-10-09: the follow-up arrives as
  the next prompt.
- **Antigravity** (#961). Its commands get the language server's address and CSRF token, which
  `ask` hands to the local agent with the question. That server is internal and changed in
  1.2.2, but it is the only way into an idle conversation: its documented `Stop` hook can only
  hold a turn's end, keeping the session busy. So `ask` promises a prompt only when the agent
  reaches that server, never in `agy -p`, which it tells by its parent process's arguments. The
  plugin's `Stop` hook stays as the fallback: it hands over answers that came in, and holds the
  end of a turn up to 10 minutes for a question marked waiting that has no route. While the agent
  runs, it leaves out an answer the agent sends through the language server, until the agent
  gives up on it, or the answer would arrive twice (#1278); and it marks answers taken only once
  it printed them, so a hook cut short loses none (#1287). The token stays in the machine's state
  file, readable by its owner only, like the process it came from.
- **Pi and opencode** append their rule (`plugin/rules/pi.md`, `opencode.md`) to the system prompt and run the mod's own
  answer loop (`agent.ts`, `poller.ts`, `switch.ts`). opencode gives commands no session id, so
  its plugin sets `STARBRIDGE_OPENCODE_SESSION` through `shell.env`. After opencode restarts, the
  plugin resumes the loops of sessions still expecting an answer (#398); two processes showing one
  session claim each answer with an exclusive file before submitting (#399). A loop confirms an
  answer only once opencode took it, and a claim never marked submitted, left by a process that
  died, is taken over after a minute.

## Skill and rule

- The `starbridge` plugin's `SessionStart` hook adds the rule as context, so setup edits no
  instruction file. Codex gets it the same way from the Starbridge Codex plugin (#949), which
  replaced pasting the rule into `AGENTS.md`. Codex 0.160 installs plugins only from a
  marketplace, so setup writes a local one in `$CODEX_HOME/starbridge` and runs `codex plugin
  marketplace add` and `codex plugin add starbridge@starbridge-cli`. The hook runs the script in
  that folder, not the copy in Codex's plugin cache: Codex asks the owner to trust each new or
  changed hook, so a release that changes the rule rewrites the script and keeps the trusted
  hook. A change to the plugin's `hooks.json` raises its version, and `setup --refresh`
  reinstalls it. Antigravity has no session-start hook; its plugin carries the rule as an
  `always_on` rule in `rules/`, which loads in every conversation (#959). Starbridge is how an
  agent reaches its user: a card for a decision that is
  theirs, a question before ending a turn on work that waits on them, `starbridge run` around commands
  that block them. Everything else the agent decides. It asks in the terminal only when
  `starbridge` fails (#121). A quick question may use the harness's own ask tool where it races
  the devices (#848), which the harness's rule names; a decision read cold, or needing links or
  images, stays a card (#911). That question becomes the card's title, and with no context field
  agents put their findings in it, so the hook cut it at 300 characters and repeated it in the
  context (#1084). Agents still write long ones: of 314 questions on the dev box, 61% passed 70
  characters and 12% passed 300. So for a question past 70 characters, from the question tool of
  any harness, the hook titles the card with its last sentence that asks within 70 characters,
  and the whole question leads the context, read as written (#1085, Tom's pick). That titled 125
  of the 191 long ones. A question with no such sentence stays the title, cut at 300 as before.
  The hook refuses no question: a refusal also closes the terminal picker and costs the agent a
  retry. The rule of each harness with an ask tool says to end its question with such a sentence.
- One skill, a rule per harness (#1063). Every harness reads the same `SKILL.md`, which names no
  harness: an agent in one never reads another's lines, the eval tests one text, and the file
  stays plain agentskills.io for any harness that reads it. What differs by harness reaches the
  agent in one of two places. What it must know before its first call goes in its session-start
  rule: `plugin/rules/template.md` with only that harness's ask tool (none for Cursor, whose
  `askQuestion` fires no hooks), rendered by `bun cli/scripts/rules.ts` into the committed `plugin/hooks/rule.md` (Claude Code's plugin) and
  `plugin/rules/<harness>.md`, which setup, the Pi package and the opencode plugin read; a test
  checks that they match the template and that none names another harness. The rest comes from
  the CLI's output when it applies, at no standing cost: `ask` prints how this session gets the
  answer, Codex's queued prompt names the command that prints it, `ask --answer-in` says to
  settle when the page answers, and `run` in Codex's sandbox (`CODEX_SANDBOX_NETWORK_DISABLED=1`)
  starts nothing and says to run it again with escalated permissions, so a command that takes
  over the screen runs once. Per-harness skills, or reference files per harness, would cost the
  same or one more read per use, and multiply what the eval must cover.
- A question answers cold: its options answer it, and its context runs two to five lines, the fact
  that forces the choice, then one line per option saying what it changes. Links and images only
  when they help; one question per card. The first option is
  the agent's default (#191).
- A card reads in seconds on a phone (#969): the owner should decide in one read, without a
  scroll. On a 360 px screen the context runs about 40 characters a line and about 450 fit above
  the options, and a notification shows only the question and the context's first line. So the
  question stays within 70 characters, the context within 450, starting with the fact that
  forces the choice; each option gets a line led by its label in bold unless the line would say
  nothing (names to pick from), and labels stay within 18 characters, where buttons still sit
  side by side. Plain words and numbers, after Tom's unslop rules. In 225 cards agents posted before this, the context's median was 430 characters and
  one in ten hid its options.
- A reworded or reposted card withdraws the one it replaces in the same step, and a typed reply
  that is itself a question gets a new card restating the choice, never one about "the last
  card": a week's transcripts (2026-10-04 to 10-10) left about 8 superseded cards open, and one
  question asked 4 times in 7 minutes (#1068).
- Agents also wrap, unasked, any command that blocks the owner or needs them at the machine, and
  always give a reason (#60).
- A card cannot approve an action the agent's own guidelines say needs the owner's yes in the
  chat (account settings, external messages, purchases, deleting data): its answer reaches the
  agent as tool output. The agent asks in the chat, or the card says the yes must come there
  (#680).
- Cursor (#954): a `sessionStart` entry that setup adds to `~/.cursor/hooks.json` runs the same
  script, copied to `~/.cursor/starbridge`, with `cursor`, which prints `{"additional_context":
  <plugin/rules/cursor.md>}`; Cursor adds it to the session's context. Setup merges its entries into the
  owner's file and knows them by that folder in their command; uninstall removes only those. A
  file that does not parse, such as one with comments, is left as it is, and setup prints what to
  add. Cursor's rule names no ask tool: its `askQuestion` fires no hooks, so `starbridge ask`
  stays the way to the phone.
- `cursor-agent` also runs installed Claude Code plugins' hooks, Starbridge's among them (#958).
  Their input is Cursor's and carries `cursor_version`, which Claude Code never sends, so the
  Claude Code plugin's hooks step aside there and setup's Cursor hooks run: the rule comes once, and
  no Claude Code settle runs for a Cursor conversation.
- There is no Starbridge rules file (#126). Users tell agents what else to ask or report in the
  agents' own instruction files; `docs/tell-your-agents.md` says where.
- `evals/skill` checks the skill with real sessions of each harness on the smallest models.

## The harness's own ask tool

- Claude Code (#848): the picker races the devices, as permission prompts do. The question shows
  in Claude Code's own picker (terminal, desktop app, the Claude app through Remote Control) and
  on the devices at once; the first answer wins and the other side is settled `elsewhere`. Until
  #848 a `PreToolUse` hook answered the call with "ask through `starbridge ask`" (#121, #200), so a
  quick question at the desk still went only to the phone. The picker is a permission dialog, so
  the plugin's `PermissionRequest` hook takes it whatever the permissions setting: one waiting
  card per question, held from the session's answer loop, and once each has a device's answer it
  allows the call with those answers, which closes the picker (a multi-select answer
  comma-joined, as Claude Code's own). An answer in the picker sends the hook nothing, so
  `PostToolUse` on `AskUserQuestion` settles the cards; Esc sends SIGTERM, as does Claude Code's
  hook timeout, so the hook has its own entry with a day's timeout and withdraws its cards 10
  minutes before it, when no answer could reach the picker any more. The generic
  `PermissionRequest` entry excludes `AskUserQuestion` by its matcher. The `PreToolUse` entry
  stays one release and the new CLI's `hook ask-user` prints nothing, so a newer plugin over an
  older CLI still redirects, and a newer CLI under an older plugin races through the generic
  entry, withdrawing its cards after 570 s.
- opencode (#345): each `question` call becomes one Starbridge question per question, already
  waiting, and the answers go back into the call through `POST /question/{id}/reply`. The first
  answer, on a device or at the keyboard, wins; the other side is settled `elsewhere`. A question
  with more than 4 options or a label over 100 characters takes a typed reply.
- Codex (#951): `request_user_input`, which 0.160 offers only in Plan mode, races the devices
  as Claude Code's picker does. Codex's hooks cannot answer it, but the TUI runs its sessions in
  the app-server daemon, which sends the picker's `item/tool/requestUserInput` to every client of
  the thread, replays a pending one to a client that joins later, and takes the first answer.
  So the plugin's `PreToolUse` hook on the tool starts a detached `hook question --agent codex
  --race` and returns: a hook that held would hold the picker back. The race joins the thread
  over the daemon's control socket (WebSocket JSON-RPC), only when the daemon has it loaded, since
  resuming a `codex exec` thread there would load it. It posts one waiting card per question,
  held from the session's answer loop, and answers the request once each has a device's answer,
  a typed reply as the TUI's `user_note:`. `serverRequest/resolved` first, or the end of the
  turn, settles the cards `elsewhere`. A secret question stays at the keyboard, and so does every
  question on Windows, where Node reads a socket path as a named pipe.
- Pi has no built-in ask tool. Most Pi users add `ask_user_question` from
  @juicesharp/rpiv-ask-user-question (#966), whose `rpiv:ask-user:prompt` event posts each
  question, already waiting, as opencode's do. The tool returning, whoever answered, settles the
  questions still open as answered elsewhere. The package takes no answer from outside
  (juicesharp/rpiv-mono#207 proposes it, and its maintainer merges little), so the Pi extension
  wraps `ctx.ui.custom`, which Pi shares among extensions, and keeps the `done` of the dialog the
  package opens right after its `rpiv:ask-user:blocked` event: a device answer closes it as a
  keyboard submit does. Arming on that event, not on the prompt, leaves other extensions' dialogs
  alone. Where no such
  dialog opens (Pi's RPC mode), the answer reaches the agent as a follow-up message once the
  questionnaire closes at the keyboard.
- Antigravity (#962): each `ask_question` call becomes one Starbridge question per question,
  through `hook question` as opencode's, and the answers go back into the waiting step through
  its language server; a reply that names no option becomes the write-in. The first answer wins,
  as with its approvals below.

## Permission prompts

Off by default (#124): the Claude app already shows prompts for Remote Control sessions, and the
gain is every session, machine and agent in one place. `starbridge config permissions on|off`.

**Cursor prompts are impossible today** (#957). Cursor's `beforeShellExecution`, `beforeMCPExecution`
and `preToolUse` hooks may answer `allow`, `deny` or `ask`, but `cursor-agent` 2026.10.01 honours
only `deny` and `ask`: after an `allow` it still shows its own "Run this command?" dialog, and
`-p` still rejects the call (run 2026-10-09, signed in). A device could block a call but never
approve one, and its dialog opens only once the hook lets go, so the two cannot race either.
Cursor's prompts stay at the keyboard, and Starbridge adds no hook before every call. A device
that can only deny would need cards without Allow, which no client has.

What else Cursor does not allow (2026.10), so it stays short of Claude Code: answering Cursor's
own `askQuestion` from a device, since it runs no hooks; delivering an answer into a chat except
when its turn ends (`stop`), and in `cursor-agent -p`, which runs no stop hook, not at all; and
naming the conversation from a command the IDE runs, which gets no conversation id. Not checked:
the Cursor IDE, which this machine does not run.

- **Claude Code** (#57). A `PermissionRequest` command hook (600 s) races the dialog. Its input has
  no `tool_use_id`, so the hook settles a call by the hash of its `tool_input` on `PostToolUse`,
  `PostToolUseFailure` and `PermissionDenied` (a call that runs and fails fires only
  `PostToolUseFailure`, #847), and all of a session's prompts on `Stop` and `SessionEnd`. A Yes at
  the keyboard tells the hook nothing until the call ends, so a long command left its card
  answerable on the phone for the whole run (#866): while it holds a Bash prompt, the hook watches
  for the call's shell (a process under Claude Code started after the prompt, whose arguments
  carry the command as `eval '…'`) and settles the prompt when it starts. Other tools, and
  Windows, still settle when the call ends. Both
  tool hooks run a shell check that starts the CLI only while the CLI marks an unexpired prompt
  open (`<config>/permissions-open`, written with the state): starting it on every tool call cost
  about 50 ms and 50 MB, prompts on or off (#517). "This session" and "always" are offered only
  for `addRules` and `addDirectories` suggestions whose rules fit in full; a `setMode` suggestion
  changes more than the call, so it stays at the keyboard. A deny with no message tells the agent
  the owner denied it.
- **Codex** (#950), through the Starbridge Codex plugin's `PermissionRequest` hook (600 s), whose
  output schema is Claude Code's. Codex runs the hook before its own dialog and opens the dialog
  only once the hook returns without a decision, so the two cannot race. The hook hands over to
  the keyboard instead, by presence (#848): with the owner at this machine it returns at once and
  posts nothing; otherwise it holds the prompt for the devices and lets go, settled `keyboard`,
  as soon as the owner sits down, within the agent's 10 s presence read. Without presence, or
  without the agent, it holds until its 570 s run out and the dialog opens; `config permissions
  on` says so. Interrupting the turn kills the hook, so the plugin's `Interrupt` and `Stop` hooks
  settle the session's prompts. Codex rejects `updatedPermissions` from this hook, so devices
  offer Allow once and Deny. A Codex `apply_patch` shows the files it touches.
- **Pi** (#232, #288), through pi-permission-system's authorizer chain: the link `starbridge`,
  once the owner names it in `authorizerChain`. A link cannot allow for the session, so devices
  offer Allow and Deny. Asks on the `path` and `external_directory` families stay at the keyboard,
  since pi-permission-system drops a link's allow there. The devices see the whole command line
  an Allow runs, not only the command of it that asked (#488). While the devices hold the prompt
  Pi shows "Answer here", which takes it back.
- **opencode** (#300): every prompt publishes `permission.asked`, and the plugin answers through
  `POST /permission/{id}/reply`. The first answer wins. `opencode run` rejects every prompt itself.
  The devices see what an Allow approves (#489): an `edit`, which its edit, write and apply_patch
  tools ask, as `{file_path, diff}`, the path first so it stays the summary and naming where an
  apply_patch move takes a file and which files it deletes; an `external_directory` ask from the
  shell as its directories and command; any other permission with its metadata. An MCP call shows
  only the tool's name, since the event carries none of its arguments.
- **Antigravity** (#962). Its `PreToolUse` hook cannot approve (Platform facts), so the local
  agent does it the way Antigravity's own other devices do: it reads, every second, the newest
  steps of each running conversation on the language servers it has a route to, and posts a
  step waiting for an approval through `hook permission`, a command shown as Claude Code's Bash
  is. A device's answer goes back through `HandleCascadeUserInteraction`, once only, since a
  scope beyond the call would need Antigravity's own rule syntax; a keyboard answer ends the step,
  which stops the hook as SIGTERM does. A route comes from any `starbridge` command run in that
  Antigravity process (`ask` included), since only commands get the token, and a hook cannot make
  a session run one (`PreInvocation` drops an injected `toolCall`). So with prompts on, until a
  conversation has run one, the plugin's `PreInvocation` hook tells the agent at each turn's start
  to run `starbridge hello`, and its `PreToolUse` denies the first other command once with the
  same words, which a model that passed over the first has to read (#962; the owner chose this
  over waiting for the session's first `ask`). One extra command per conversation; with no local
  agent, or prompts off, neither happens. The app and the IDE are untested.
- **A stalled server never holds a prompt** (#260): deadlines and SIGTERM cut every request the
  hook makes. When a hook dies mid-hold, the local agent settles its prompt as answered at the keyboard
  (#400).
