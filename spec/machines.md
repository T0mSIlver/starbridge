# Machines

- **The local agent**, `starbridge agent` (#68), one per machine as a user service (systemd, launchd, or a Scheduled Task on Windows), owns the
  keys and the server connection, uploads quotas, and routes answers, prompts and runs to sessions
  over HTTP on a unix socket (PROTOCOL.md, "Local agent API"). Every CLI command asks the local
  agent first and talks to the server itself when none listens or it answers 426; once it has
  answered it never falls back, so nothing posts twice. `wait` is the exception (#548): the agent
  marks an answer seen only for a client still listening, so when it restarts under a wait, the
  wait asks the new one, and after 30 s with no agent it waits at the server. Answers stay in the CLI's state file,
  so both paths share one store. A session with no mod whose wait died still never notices its
  answer; `starbridge status` lists the answers no session has taken, with the `wait` that prints
  each (#557).
- **Files** in `~/.config/starbridge` (or `$XDG_CONFIG_HOME`, `$STARBRIDGE_CONFIG_DIR`): 0600 in a
  0700 directory. A `.lock` guards every read-modify-write (#33). A directory refresh keeps the
  longer of the fetched and saved chains, each required to extend the other's pin.
- **The socket** is bound under a 077 umask (#95). There is no peer uid check, since neither Bun
  nor Node exposes `SO_PEERCRED`. The local agent runs only the CodexBar binary its own config names,
  never a path a client sends, and for a Codex session's answer only the `codex` setup recorded
  with its `CODEX_HOME` (`starbridge update` records it again), for that home or the agent's own
  (#1757). `ask --input` sets no delivery route or session kind (`codex`, `antigravity`,
  `extensionAnswers`, `headless`, `held`, `picker`, `subagent`): those come from the asking
  process's environment, since an agent writes the file.
- **One agent per config folder** (#1966). Two homes of one user share `$XDG_RUNTIME_DIR`, so a
  test home's `uninstall` once posted 8 cards through the owner's agent, as his machine. The
  default folder's socket there is `agent-<key>.sock`, the key hashed from the folder's path, and
  a client sends its key, which an agent of another folder refuses (421), in case an address
  still collides. A client that `$STARBRIDGE_AGENT_SOCKET` sent is served as before. Across the
  upgrade nothing listens on the old `agent.sock`: a mod or extension from before, or a new one
  whose agent has not restarted yet, finds no agent and answers through the CLI until
  `starbridge update` has moved both, since an agent that also listened there would serve the
  other home's old clients again. A new agent does not start while an older one serves its
  machine on `agent.sock`, so one machine never runs two agents.
- **On Windows** (#552) the agent listens on loopback TCP with a per-start token in `agent.port`
  in the config directory (PROTOCOL.md, "Local agent API"). A named pipe was the other choice:
  libuv creates one with the default DACL, which lets other users open it for reading, and Bun's
  named-pipe `listen` has crashed in Claude Code's own use. The token never crosses the wire:
  each call and each answer proves it over a fresh nonce, so a process that takes the port of a
  stopped agent can neither use what it hears nor answer. A client still sends its call before
  it sees the answer's proof, and a dead agent's port shows in `netstat` to every local user, so
  the CLI, the mod and the Pi and opencode extensions send nothing while the file's `pid` runs no
  more (#570). Windows never runs the agent's shutdown when the task is stopped, since that
  terminates it, so the agent also removes the file on SIGHUP (its console closing), SIGBREAK and
  any exit, and setup removes it after ending the agent; a stale `agent.port` stays possible
  after a hard kill, which the `pid` check covers.
  `icacls` gives the file to its user only, as the 0600 mode does the socket; when it fails, the
  agent does not serve (#1209). The service is a Scheduled Task at the user's logon, registered from a marked XML file in `%LOCALAPPDATA%\starbridge` with the
  ScheduledTasks cmdlets: it needs no administrator, unlike a Windows service, and restarts on
  failure, unlike the `Run` registry key. It runs the agent under `conhost.exe --headless`, since
  a console program opens a window, with no time limit, since a task stops after 3 days by
  default, and logs to `agent.log` beside the XML. A second trigger starts it every 5 minutes
  when it is not running, since conhost may not pass a crash on as a failure. Stopping the task
  ends conhost, so setup also ends the agent, by the pid the agent reports through a proven
  call, never a pid read from the file. A task carries no environment of its own, so the agent
  reads the user's: `STARBRIDGE_CONFIG_DIR` and `CODEX_HOME` reach it only as user environment
  variables. Windows has no SIGTERM: a stopped hook dies without settling its prompt, and the
  next `Stop` hook settles it.
- **Presence** (#848), opt-in per machine with `starbridge config presence on`, since a machine
  reports when its owner is at it: every 10 s the agent reads the screen's lock and the time
  since its last input, the number the OS keeps for its screensaver, and sends the server only
  "present" (unlocked, input in the last minute) or not, again every 30 s while present. macOS
  reads `ioreg` (`CGSSessionScreenIsLocked`, `HIDIdleTime`); Windows keeps one PowerShell
  running, since each start costs about a second of CPU, for `GetLastInputInfo` and whether the
  lock screen (`LogonUI`) runs in its session; Linux takes logind's active graphical session and
  its `LockedHint`, and GNOME's idle monitor or `xprintidle`, since logind's `IdleHint` flips only
  after the desktop's idle delay, minutes. A headless box finds no graphical session and sends
  nothing. Nothing reads what is typed. The desktop app reads the same on a Mac without the CLI,
  under its own switch ("Desktop", "Presence").
- **Answers on the machine** (#260). A machine accepts an answer only from a device the question
  was sealed to, only while it is open, and for an `answerIn` question only a Done, when it asked
  for one (#539). A settled question's
  answer is never delivered, since a server could hold an answer back until the agent moved on.
- **Following every answer** (#629). `answers --all --follow` gives an orchestrator the owner's
  answers to every session's questions, so it no longer depends on each session relaying them or
  reads the state file. It is an observer: it marks no answer seen and no decision waiting, so
  each answer still reaches its session. It lists an answer whose question was settled since,
  which is still the owner's word (#1575). The machine keeps each decision's project and session
  title, like its question, after the answer drops its body. `decisions --open` lists the
  questions still open, so one question has one asker: the orchestrator checks it before
  asking, since the owner once got the same question from it and from a session.
- **A decision id is three words** (#1697): `d_amber-otter-lantern`. The random id gave nobody
  a cue that a card was stale, and an orchestrator pointed Tom at one already answered. Three BIP-39
  words are 33 bits, enough because the id gates nothing: every read takes a signed-in device or
  machine and its own box (PROTOCOL.md, "Item ids"). `ask` mints again on a 409 `duplicate-id`.
  Old ids keep working.
- **Pairing a machine.** `pair` uses starbridge.run unless `--server` or `STARBRIDGE_SERVER` says
  otherwise (#154). `pair --force` keeps the machine's server and name (#245) and leaves the old
  pairing active, so Devices shows the added time on rows that share a name (#287). `pair` and
  `setup` guess `machineKind` (cloud, laptop with a battery, server with no display, else desktop);
  `config machine-kind` corrects it.
- **Cloud sessions** (#1818) run no local agent and no setup: the environment installs the CLI
  and carries the machine (Keys and trust, "A machine for cloud sessions"). `ask` posts to the
  server itself, and the answer reaches the session only through `wait` or `ask --wait`, which
  poll the server, since no plugin or mod hands it over as a prompt. Each session keeps its own
  state, so it hears only of the questions it asked. The machine saved from the variable is a
  `cloud` machine for its icon. When the owner revokes it, the error says to run
  `starbridge machine export` on a paired machine and replace the variable, since `pair --force`
  has no folder to keep its keys in (#1838).
- **Setup names no server question** (#749). Almost everyone uses starbridge.run, and
  `Starbridge server: [https://starbridge.run]` did not read as "Enter for the default". Setup
  takes the first of `--server`, `STARBRIDGE_SERVER`, the server baked into the install script,
  the machine's pairing, and starbridge.run, and prints `Pairing with <host>`. It asks only when
  the machine is paired with another server, since it would otherwise switch silently; Enter
  keeps the pairing.
- **The pairing link** `https://starbridge.run/pair#CODE`, which `pair` prints and a device shows
  as a QR code, is also an App Link (#611): a phone's camera hands links to apps, not to a browser
  that would first ask to become a device itself. A machine's QR code is text only the app's
  scanner reads instead (#795, #1099). The app
  opens Add a device with the code looked up, once the phone is in the account; a phone signed in
  but not in the account yet offers to join with it instead, as another device's "Scan with the
  new phone" code asks, and joins once the owner taps Add this phone (Keys and trust, "Pairing"). Without the app,
  or on a self-hosted server, which the APK cannot claim, the link opens the web page as before,
  and a phone signed in to another server than starbridge.run hands a starbridge.run link to the
  browser, since its own server would know no such code (#722); where both the installed web app and the app claim it, Android opens the verified app.
  A link from another server that this one doesn't know names that server, "This code is from
  starbridge.run, and this phone is signed in to …", instead of "No pairing with this code"
  (#671). Only a failed lookup says it, since a server can answer under several names.
- **The empty inbox pairs the first machine** (#610, #1367). While the account has no machine,
  the inbox shows "Add a machine" with the install command in place of "Nothing needs you", and
  under it the way to pair the machine that setup then shows: Scan a QR code on Android and the
  iPhone (#1370), then Other ways to add a device, and Add a device on the web, which has no scanner. Each opens the
  same Add a device as Devices, with the same words. Android's text says to scan the QR code from
  the terminal: a tester pointed his camera at it, which reads no app's code (#795), then had to
  find the scanner under Settings, then Devices. The text gives only the instruction (owner's
  rule): the screen needs no why.
- **Setup** (`cli/src/setup/`; #68, #239, #245) installs the CodexBar release this Starbridge
  release pins, taking the static musl build where the glibc one would not start, and
  `starbridge update` moves that install to the new binary's pin (#568). Each release PR pins
  CodexBar's latest release, which `version.ts` writes with each tarball's SHA-256 into
  `cli/src/setup/codexbar-pin.json`, so the signed binary carries them. Checking a tarball against
  the `.sha256` of its own release (#530) caught only a damaged download: whatever CodexBar's
  account published, or replaced, since its release job uploads with `--clobber`, ran on every
  machine at its next update. CodexBar's releases carry no signature or build attestation.
  The pin costs no work per CodexBar release, which ships almost daily; users get CodexBar's
  fixes with the next Starbridge release, or sooner with `update --codexbar <version>`, which
  checks only the release's own `.sha256` and which `update` does not undo while the pin is
  older. A CodexBar from Homebrew follows steipete's tap, as the user's `brew upgrade` does. The
  download says its size and how far it got every 5 s, since the Linux tarball is 170 MB (#618).
  `update` goes on to CodexBar when its own download fails, offline say, but not when a release
  does not check out (#617).
  `update --codexbar <version>` installs one release, for when the pinned one breaks; a broken
  CodexBar already shows as each provider's quota error, so there is no other rollback. A daily
  workflow installs CodexBar's latest release and reads its output without credentials, and opens
  an issue when it breaks, so a release does not pin a broken one. A provider works when `usage
  --provider X` returns windows; CodexBar exits 1 with the reason in its JSON row, so setup reads
  the row. The unit runs the `starbridge` on the PATH when that is the running binary, since that
  path survives brew upgrades. Setup installs the Claude Code plugins from a marketplace it writes
  from the binary into `~/.claude/starbridge-marketplace`, each plugin pinned to the release's
  commit, which the release workflow records in the binary, and the Pi package at that commit
  (#1768): the binary is signed, but the repository's marketplace follows its default branch and
  a tag can move, so both installed code the signature does not cover. A build from source pins
  its version's tag. Setup fetches only that commit into Pi's checkout before `pi install`, whose
  own `git clone` would take the whole history, over 800 MB (#2039). `starbridge update`'s refresh moves both to the new commit; it replaces the
  repository's marketplace that earlier setups added, which also served only this repository
  (#274). Setup turns on plugin auto-update through `extraKnownMarketplaces`, and uninstall
  removes only its own marketplace, so a developer's own `starbridge` marketplace survives;
  both, and `starbridge update`'s plugin update, run `claude` from the home directory, so no
  repository's `.claude` settings are read or edited (#762, #1919). Setup installs Codex's skill and rule, opencode's plugin and skill and the
  Antigravity plugin from copies the CLI carries so versions match. The local agent rewrites outdated copies when it starts.
- **Setup asks little** (#750). Each question was one more Enter between a new user and their
  first answer, and nearly everyone said yes. Setup installs Starbridge in every agent it finds
  and starts the service without asking, one line per agent with what it installed; for Codex,
  whose new hook runs only once trusted, it says at the end that Codex will ask, with the
  commands, so nothing mid-output reads as a prompt. Claude Code and Pi, whose installs run for seconds, first print
  `installing…` (#773). It still asks before installing CodexBar, a
  third-party binary (with #748, only when no other machine sends quotas), which providers to
  send, whether to linger, and whether to send a test decision. Permission prompts and presence
  stay off and unasked; the summary names `starbridge config permissions on`, on a desktop or
  laptop `starbridge config presence on`, `starbridge status`,
  `starbridge uninstall --agent <name>` and `starbridge uninstall`. With no terminal every
  question takes its default, so nothing waits on input. A failed install prints its reason and
  `starbridge setup --agent <name>`, and setup goes on. Every step after pairing needs the
  server, so setup checks the server and the pairing first (#774): a machine the server no
  longer lists, revoked or lost with the server's database, is offered to pair again (`[Y/n]`,
  what `pair --force` does), and an unreachable server stops setup with the command to retry.
  A machine the server still lists is in use again, so setup withdraws the "Revoke <name>? It
  was uninstalled." cards an earlier `uninstall` left open: their advice would cut it off (#1907).
  `uninstall --agent` records the agent,
  and setup and `--refresh` leave it out until `setup --agent` brings it back. An
  agent installed after setup gets nothing in the background: `status` names it, and `setup
  --refresh`, which `update` runs, installs it. The output is plain and lined up, as
  well-known install scripts print theirs: a blank line before each title, a mark in column 1
  (✓ done, ✗ failed, – skipped), agent names in one column, commands on their own line.
- **The CLI's path** (#612). Hooks and plugins start the CLI from an agent whose PATH may lack
  the install folder: on macOS `~/.local/bin` is not on the default PATH, and Claude Code opened
  from the Dock has no shell profile. So setup and `update` record the binary's absolute path in
  the config folder (`cli-path`); the Claude Code hooks (`plugin/hooks/cli.sh`), the mod, and the
  Pi and opencode plugins start that one, else `starbridge` on the PATH, and `cli.sh` then tries
  the installers' folders. They take the recorded path only when it is absolute and both it and
  `cli-path` belong to the user or root and are writable by no one else (#1748), since whoever
  can write either picks what the hooks run; setup writes `cli-path` 0600. When the binary's folder is not on the PATH, setup offers to add it to
  the shell's startup file (`--yes` adds it), and its last lines say to open a new terminal or what to add, since
  install.sh's own hint scrolls away under setup. Windows gets the folder on the PATH from
  install.ps1. Uninstall, when it deletes the binary, takes that line and its marker comment out
  of every shell's startup file while they are still as setup wrote them, and deletes a file left
  empty (#1494).
- **Files setup writes into other tools** (#474) start with one marker line, ``Written by
  starbridge <version>; `starbridge uninstall` removes it.``, in the file's comment syntax: the
  systemd unit, the launchd plist, the Codex rule, the opencode entry, the Antigravity plugin's
  rule and the copied skills (a YAML
  comment first in the front matter). A file is Starbridge's only when it has the marker: setup
  replaces it when it differs from this release's, uninstall removes it, and any other file at
  those paths is left alone, even a skill named `starbridge`, which another skill manager may have
  installed (#538). An owner who
  deletes the line keeps the file. Setup and uninstall remove only the files they write, then a
  folder left empty: a file the owner put beside them, such as a skill's `references/`, stays,
  and uninstall says so (#1324). The empty parents go too, up to the tool's own folder (`~/.codex`,
  `~/.cursor`, `~/.config` for the unit, `~/.local` for the binary), so a fresh HOME ends as it
  began (#2098); `cli/test/walk.test.ts` checks that, and that the owner's settings keep their keys
  in order. A settings file of another tool that setup or uninstall edits is
  rewritten through a temporary file and a rename, keeping its mode and any symbolic link to it, so
  a crash never leaves it half written (#1749). A settings or hooks file that uninstall's edits leave holding
  nothing, such as an allow list setup created, is deleted rather than left as `{}`: an empty file
  and none mean the same to its tool (#1494). Uninstall turns systemd lingering off only when setup
  turned it on, which setup records, so lingering the owner had before stays (#2040),
  and removes the agent's log with the service on macOS and Windows (#2041). `starbridge update` runs the new binary's `setup --refresh`,
  which rewrites the marked files that differ and restarts the local agent; Homebrew and npm users
  run it after upgrading, and the local agent refreshes the skills and rule when it starts.
  The refresh moves every harness integration to the new version, the Pi package included: Pi
  pins the package to a release tag, so without it an update left Pi on an extension that no
  longer matched the CLI (v0.1.1's crashed Pi, #1365). A failed move prints why and does not fail
  the refresh (#1417).
- **Allow rules** (#245, #322, #443, #488). So a new user's first question needs no prompt and no
  sandbox flag, setup allows `starbridge ask`, `waiting`, `working` and `wait`, and `settle <id>` where a rule can name the id (Claude Code's `settle d_*`, Pi's link), never `settle --all` or `--session`, which close many cards (internal audit 2026-10-14, #1761): Claude
  Code allow rules, a Codex execpolicy file (`~/.codex/rules/starbridge.rules`) that runs them
  outside the sandbox, and for Pi the Starbridge link in pi-permission-system's `authorizerChain`
  plus its `skill` and `read` gates for the Starbridge skill, after the owner's own patterns since
  the last match wins. Pi gets no bash pattern, since none is safe there (Platform facts): the link
  allows a bash ask itself when the whole typed line, from the ask's "full command" evidence, is
  one of those commands with only words, flags, quoted strings and line-joining backslashes; an ask
  without evidence, or from a shell tool under another name, goes to the owner. For `agy`, setup
  adds `command(starbridge ask)`, `waiting`, `working` and `wait`, with `hello` (#962), to `permissions.allow` in
  `~/.gemini/antigravity-cli/settings.json`, since `agy` still prompts after a hook's `allow`. Such
  an entry also passes `LD_PRELOAD=… starbridge ask` and `env … starbridge ask`, so the
  plugin's `PreToolUse` hook on `run_command` returns `force_ask` for any line that names `starbridge`
  once quotes and backslashes are removed and that the Pi check (`mod/hooks/own.ts`) rejects,
  since `"starbridge" ask` and `star""bridge ask` may pass an entry too (internal audit
  2026-10-14), and for one it accepts sets `BypassSandbox`:
  `--sandbox` hides the home folder and the network (#959). Every command passes that hook, so a
  shell check starts the CLI only for one that names `starbridge`, quotes and backslashes removed. Since only that hook narrows
  the entries, setup adds them only while the plugin there is Starbridge's and turned on, and takes
  them out otherwise. The app and the IDE keep their settings elsewhere; setup adds nothing there. `starbridge run` is left out,
  since the command it wraps is the agent's own. So Codex asks at the keyboard to run it outside
  the sandbox: run in the sandbox first, the command ran unreported, then again once approved
  (#831), so `run` there now refuses before the command starts and says to escalate (#1063). A `prompt` rule only adds an approval: Codex
  still runs the command in the sandbox first. `cursor-agent` gets `Shell(starbridge ask)` and the
  four others in `cli-config.json`'s `permissions.allow`; each matches the command and what starts
  with it plus a space, and a compound line runs without a prompt only when each of its commands
  is allowed (2026.10.01). The IDE does not read that file. Uninstall removes exactly what setup added.
- **Cursor** (#953) gets the skill in `~/.cursor/skills/starbridge`. Not a local plugin under
  `~/.cursor/plugins/local`, which would keep everything in one folder: `cursor-agent` 2026.10.01
  loads a local plugin's skill and hooks in `-p` but, in an interactive session, neither its skill
  nor its `sessionStart` and `stop` hooks (run 2026-10-09). Cursor also reads `~/.codex/skills`,
  so with Codex set up too it lists the skill twice; both copies are the same. Setup finds Cursor
  by `cursor-agent` on the PATH or a `~/.cursor` folder. Its entries in `~/.cursor/hooks.json`
  are known by the exact commands setup writes, so refresh and uninstall leave an owner's entry
  that runs a script of `~/.cursor/starbridge` its own way (#1493).
- **Docs** (#211) at `/docs` are the repository's Markdown files listed in `web/src/lib/docs.ts`,
  rendered by the web page. Links between them become `/docs` links; other relative links go to
  GitHub. Images are screenshots under `web/public`, served from the site root, so GitHub shows
  the same file; a `-light` one comes with its `-dark` twin, shown by the page's theme (#558). The Overview's Start ends at a
  first question answered from an agent, and the FAQ page holds the launch questions (#558).
- **The CLI's agent-facing contract is stable from 0.1.0** (#475, #551): the commands, flags,
  output lines and exit codes in `cli/CONTRACT.md`, kept apart from the user-facing CLI page
  (#565), pinned by
  `cli/test/contract.test.ts`. A release may add to it; changing or removing anything listed comes
  only after a release that deprecates it, since the plugins, the Pi extension and agents'
  instructions update apart from the CLI. `--json` always means an output format (`wait --json`); `ask` reads its input with
  `--input <path>`.
- **Install and update.** `https://starbridge.run/install.sh` is `cli/install.sh` as the web
  page serves it, so each deploy serves its own revision's script. Each server writes its
  `PUBLIC_URL` into its copy, and install.ps1's (#749), so `curl -fsSL https://my.host/install.sh
  | sh` pairs with my.host, and a self-hosted landing page shows its own commands. The web
  container reads `PUBLIC_URL` when it runs, so one image serves any server; only a plain
  http(s) origin goes into the script. It checks `SHA256SUMS` with
  minisign, else OpenSSL 3, else Python 3 (#1032): RHEL 8 ships OpenSSL 1.1.1, whose command line
  has no Ed25519 check, and no minisign, but always a Python for dnf. With none of them it stops
  and prints the command that installs minisign on that distribution; no flag skips the check.
  The signature's trusted comment must name the version it installs: `STARBRIDGE_VERSION`, else the
  tag `releases/latest` redirects to. A version older than the installed copy is refused unless
  `STARBRIDGE_DOWNGRADE=1` (#1748), since a served `latest` could otherwise roll a machine back to
  a signed release with known bugs; `update` already installs only a newer one. Downloads go over HTTPS only, but from a mirror on the
  machine itself. `update`'s downloads give up after 30 s for the checksums and 15 minutes for the binary, and past
  1 MB and 256 MB, so a stalled or endless answer cannot hold the update (#1749). `starbridge update` replaces script installs
  and points Homebrew and npm installs at their manager. Windows refuses to replace or delete a
  running `.exe` but lets it be renamed, so `update` moves it aside to `starbridge.exe.old` and
  the next update removes that; `uninstall` deletes the binary from a detached cmd.exe two seconds
  after it exits (#552).
- **Small bounds on local state** (#1763, internal audit 2026-10-14). A timestamp dated in the future
  counts as stale for the update check and the last failed try. A run id belongs to the session
  that started it, for a day after its last update. The agent forgets a mod's session, and the
  Antigravity hook a conversation's marker, a day after the last sign of it; a Cursor
  conversation, greeted only by its hooks, stays until its `sessionEnd`. Cursor's stop hook
  prints at most 3 "No answer yet" follow-ups per conversation until an answer comes. Setup
  replaces `~/.local/bin/codexbar` only when it links into Starbridge's tarball install or a
  CodexBar app. The installers take `http://` only for a host that parses as this machine, never
  `http://localhost:80@host`.
- **Saying a release is out** (#1050). Before it, users learned of a new CLI only from the
  server's 426 once a release was forced. Homebrew and npm installs, and script installs with
  automatic updates off (below), get this nudge only. Once a day
  the local agent reads GitHub's `releases/latest` (no drafts or pre-releases), unauthenticated
  with the ETag of its last answer, since a 304 costs nothing from the 60 requests an hour an
  address gets, and a 10 s timeout; a failure changes nothing and is tried an hour later. It
  keeps the answer in `latest.json`, so commands read it without the network; an unreadable
  one moves to `latest.json.unreadable-<time>` and is read again, since it is only a cache and a
  kept one would stop the check for good (#1174). `setup`, `pair`,
  `config`, `--version` and help, run in a terminal, end with one line on stderr when it is
  newer, naming `starbridge update` or brew's or npm's command; hooks, `ask`, `wait` and every
  other command an agent runs never print it, nor does any command whose stderr is not a
  terminal. `status` shows both versions. The machine also tells the server its release and the
  latest it read (`PUT /release`), and Devices shows "Update available" under a machine that is
  behind, with no notification. Self-hosted machines read GitHub too, not their server:
  `update` installs from GitHub's releases whatever the server, the server's own version says
  nothing about the CLI's, and a server would need a GitHub client and a route to relay what
  every machine can read itself. `config update-check off` stops the check and the line, and the
  machine then reports no latest; `STARBRIDGE_NO_UPDATE_CHECK=1` does the same wherever it is
  set, which for the agent means its service's environment.
- **Automatic updates** (#1266). The nudge left users on the release they first installed: gh,
  npm and Docker only notify, and their users fall behind the same way, while Claude Code,
  Homebrew, VS Code and Chrome update by default. So a script install (install.sh, install.ps1)
  installs each final by itself, on by default; setup asks nothing and lists
  `starbridge config updates off` in its closing commands. Homebrew and npm installs keep the
  nudge, since their manager owns the binary. Finals only: testers get rcs from the prerelease
  and npm's `next`. The local agent installs when the latest release it read is newer than its
  own, a random 0 to 2 hours after it first saw it, so machines that read it at the same hour do
  not all download at once, and only while nothing is in flight on the machine: no question
  asked in the last day still open, no permission prompt held, no run unfinished that reported in
  the last 3 minutes. An update restarts the agent and replaces the binary hooks run, which would
  cut those short. A question older than a day does not hold it, or one forgotten card would stop
  updates for good. Held, it looks again every 10 minutes. It runs `starbridge update` itself,
  the same signed download, `setup --refresh` and restart, so it writes nothing that command
  does not, and runs it outside its own service (`systemd-run --user` under systemd, a detached
  process elsewhere), since the refresh restarts the service and the manager would stop a child
  with it. The agent records each try in `update.json` and the command's output goes to
  `update.log`, both in the config folder; `update` records its outcome there too, whoever runs
  it. A failure keeps the old binary, as `update` does, and the next try comes a day after the
  last. `status` says whether updates are automatic, what holds one, the last update (from, to,
  when) and the last failure with its reason. The server stamps the time a machine reports a
  release other than the one before (`updatedAt` in `GET /releases`), so Devices says "Updated
  to 0.1.6 on Oct 11" under it, whatever installed it. `config update-check off` stops the read,
  and with it the updates.
- **The CLI bounds what it reads from outside** (#1762, internal audit 2026-10-14). A picture is
  refused by its header past 50 megapixels or 30 MB, before a decoder allocates it. A `[n/total]`
  in run output counts only for safe integers and a total up to 10 000. A server's error text
  goes through `visible()` and stops at 200 characters; a success body stops at 32 MB, an error
  body at 64 KB, a `Retry-After` at 300 s, a page of answers at 1000 entries of 4 MB and a cursor
  at 256 characters, and the `/answers` poll gives up 30 s after the wait it asked for. A CodexBar
  run ends when its process exits, is killed with its process group on a timeout or past 1 MB of
  output, and yields at most 20 providers with 20 extra windows each, without control characters.
- **The state file forgets what the server forgot** (#2017). A question the machine asked, with its
  answer, options and session title, leaves `state.json` 37 days after it was asked (`RETENTION_DAYS.month` plus `week`: a
  device may answer on day 29, and the server keeps that answer 7 days),
  or 7 days after `settle` closed it, and never while its post or settled notice is owed, in the same write that updates the state: the server deletes
  it then, and a plaintext history that outlives the server's copy is a privacy cost with no reader.
  The machine's name defaults to the host name and goes to the server unencrypted, which
  `cli/README.md` says.
