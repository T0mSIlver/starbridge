# starbridge CLI

`starbridge` connects a machine that runs your harnesses to your phone and browsers. Agents use it to ask
you questions and report runs, and it uploads what each AI plan has left, read from CodexBar. It
signs everything with this machine's key and encrypts it for your devices, so the server sees
ciphertext only. CodexBar is optional: setup asks before installing it, `--no-quota` skips it,
and questions, runs and permission prompts work without it.

## Install

Linux, macOS or Windows. Pick one.

The install script puts the binary in `~/.local/bin`, then runs `starbridge setup` when it has a
terminal (`STARBRIDGE_NO_SETUP=1` skips it):

```bash
curl -fsSL https://starbridge.run/install.sh | sh
```

On Windows, the PowerShell script does the same, with `%USERPROFILE%\.local\bin`, which it adds
to your user PATH:

```powershell
irm https://starbridge.run/install.ps1 | iex
```

Homebrew:

```bash
brew install T0mSIlver/starbridge/starbridge
```

npm, with Node 22 or later:

```bash
npm install -g starbridge
```

After Homebrew or npm, run setup yourself:

```bash
starbridge setup
```

### What setup does

Setup asks only before installing CodexBar, which providers to send, whether the background
service runs after you log out, whether to add the CLI to your PATH, and whether to send a test
question; steps 1 and 3 say when it asks more. A rerun repairs only what is missing:

1. It pairs the machine with your account (see [Pair](#pair)), with the first server named by
   `--server`, `STARBRIDGE_SERVER`, the install script (each server's own names that server),
   or the machine's pairing, else https://starbridge.run. It asks only when the machine is
   already paired with another server, and Enter keeps that one.
2. It installs Starbridge in each harness it finds and prints one line per harness: the Claude Code
   plugin at user scope, the skill and sandbox rule in Codex's folders, the Starbridge Pi
   package, the skill and plugin in opencode's config folder, the skill and hooks in Cursor's
   folder, and the Starbridge plugin in Antigravity's
   ([What setup installs](../docs/tell-your-agents.md#what-setup-installs)). A failed install prints its
   reason and the command that retries it, and setup goes on. A later setup updates the Codex,
   opencode, Cursor and Antigravity files when the CLI carries newer ones. The Claude Code plugin needs Claude Code
   2.1.287 or later; setup says when it is older. In Claude Code, Codex, Pi, `cursor-agent` and
   `agy`, `starbridge ask`, `waiting`, `working`, `wait` and `settle` then run without a permission prompt;
   `starbridge run` still asks, since the command it wraps can be anything. For Pi, setup adds
   these rules only when pi-permission-system is installed.
3. When another machine of your account sent quotas in the last day, it says which and asks
   whether to send them from this one too; Enter says no. Otherwise it finds CodexBar, or asks
   to install it (Linux and macOS; CodexBar has no Windows build, so a Windows machine uploads
   no quotas): with Homebrew if you have it, else the CodexBar release this Starbridge release
   pins, from GitHub, checked against the SHA-256 the pin names, into `~/.local/opt/codexbar`.
   It installs nothing when the checksum does not match. Then it asks which
   providers' quotas to upload.
4. It installs and starts the background service, `starbridge agent`, as a systemd user unit, a
   launchd agent, or on Windows a Scheduled Task that starts at logon without administrator
   rights and logs to `%LOCALAPPDATA%\starbridge\agent.log`.
5. It uploads a first quota snapshot, then offers to send a test question to your devices and
   prints your answer.

[Permission prompts](#permission-prompts) stay in the terminal unless you turn them on with
`starbridge config permissions on`; setup's last lines say so, with the commands that check and
remove the setup.

`--yes`, or running with no terminal, takes every default and sends no test question.
`--no-quota` skips step 3, CodexBar included; `--no-service` skips step 4; `--no-agents` skips
step 2. `starbridge status` prints the same checks, and names a harness installed since setup,
which `starbridge setup --refresh` then sets up.

`starbridge uninstall --agent <name>` (`claude`, `codex`, `pi`, `opencode`, `cursor` or
`antigravity`) removes Starbridge from one harness. Setup and `--refresh` then leave that harness alone, until `starbridge setup
--agent <name>` installs it there again.

### Update and uninstall

Nothing updates the CLI by itself. Once a day the agent reads the latest release from GitHub,
and when it is newer, `setup`, `pair`, `config` and `--version` end with one line on stderr:
`Starbridge 0.2.0 is out (you have 0.1.4): run starbridge update`, or the Homebrew or npm
command for those installs. `starbridge status` shows both versions, and your devices show
"Update available" under the machine. `starbridge config update-check off` stops the check
and the line; `STARBRIDGE_NO_UPDATE_CHECK=1` silences the line.

The agents' integrations follow the CLI: `update` runs `setup --refresh`, which brings each
agent's files to the new version, and the Claude Code plugins update themselves from the
Starbridge marketplace.

`starbridge update` installs the latest release over a script install, then runs `starbridge
setup --refresh` with it and updates the Claude Code plugins. `--refresh` rewrites the files
setup put into other tools (the background service's unit, the Codex skill and rule, opencode's
skill and plugin, the Cursor files, the Antigravity plugin) for the new version and restarts the
background service. Homebrew and npm installs update through
their own manager; then run `starbridge setup --refresh`. Each of those files starts with a
`Written by starbridge <version>` line: setup replaces and uninstall removes only files that have
it, so remove the line from one to keep it as yours.

`starbridge update` then moves a CodexBar that setup installed in `~/.local/opt/codexbar` to the
release the new Starbridge release pins, with the same checksum check, and keeps one that is
newer; a CodexBar from Homebrew or the macOS app is left to them (`brew upgrade codexbar`). When a
CodexBar release breaks, its providers show a quota error on your devices; `starbridge update
--codexbar 0.71.1` installs that release instead, checked only against the `.sha256` published
beside it, until a later `starbridge update` moves an older one back to the pinned release.

`starbridge uninstall` removes the background service, Starbridge from every harness and the binary,
and asks your devices to revoke the machine. It deletes the keys only when you say so, or with
`--purge`; `--yes` takes every default without asking.

### Check a download

The scripts and `starbridge update` install a binary only if its hash is in the release's
`SHA256SUMS` and the release key signed `SHA256SUMS.minisig`. `install.sh` checks the signature
with minisign, else OpenSSL 3, else Python 3, which every RHEL 8 has for dnf; with none of them it
stops and gives the command that installs minisign. `install.ps1` checks the signature
with minisign's own Windows build, pinned by its hash, since Windows has no Ed25519 check. The key is also in
[`minisign.pub`](minisign.pub):

```
RWRT+qMmByDpj/1KhL5yCxdzIkVgZ3NqTrlVIIvhrezr/38FgzBIen0F
```

To check a download by hand:

```bash
minisign -Vm SHA256SUMS -P <key>
sha256sum -c --ignore-missing SHA256SUMS
```

## Use

Setup covers pairing and the background service. Agents run the other commands themselves; the Starbridge
skill tells them when. `starbridge --help` lists every flag.

### Pair

```bash
starbridge pair
```

It prints a code, a link and a QR code. Scan the QR code with the Starbridge Android app, open
the link on your phone or in a browser where you are signed in, or type the code in
Settings → Devices → Add a device, on your phone or in the web app, which works from a machine
with no browser. The code expires in 10 minutes.

The QR code is text that only the Android app's scanner reads, and it carries a check key with
which the app confirms the machine's check code by itself. Approved any other way, the machine prints its check
code and asks whether the Android app shows the same beside it under Devices: press Enter if so, `n` if not.
Where setup runs with no terminal, run `starbridge pair --confirm`, or `starbridge pair --reject`
if the codes differ. A code that differs means a server read your pairing code and paired the
machine into an account it controls ([PROTOCOL.md](../PROTOCOL.md#pairing)); the machine then
saves nothing.

The machine pairs with
https://starbridge.run unless you pass `--server https://starbridge.example` or set
`STARBRIDGE_SERVER`.

### Ask

An agent asks a question with two to four options, or none for a free-text answer:

```bash
starbridge ask --question "Merge #12 now?" \
  --option Merge --option Wait
```

`ask` prints the question's id and how the answer will come back:

- In an interactive session of a harness setup installed in, your answer comes back as the
  session's next prompt.
- In a headless run, the Cursor IDE or any other harness, the agent waits with
  `starbridge wait <id> --timeout 5m`, which exits with code 2 when the time runs out.

[What each harness supports](../docs/tell-your-agents.md#what-each-harness-supports) says which
runs are headless.

To check the path to your devices yourself, ask and wait in one command:

```bash
starbridge ask --question "Does this reach me?" --option Yes --option No --wait
```

When the agent runs out of other work, `starbridge waiting <id>` shows "Waiting for you" on
every device and notifies you once more. `starbridge working <id>` clears it; the question stays open.
`starbridge wait <id>` marks the question waiting the same way; with `--no-mark` it only collects
the answer, for a question that blocks nothing yet.
When you snooze a question, `waiting` and `wait` tell the agent no answer comes before then, and
`wait` exits 3; nothing wakes an agent that is not asking.

### Follow every answer

An orchestrator that supervises other sessions can follow your answers to all of them:

```bash
starbridge answers --all --follow
```

It prints one JSON line per answer, with the question, the session and the project that asked,
then each new one until interrupted. `--since 2h` or `--since 2026-10-06T21:00Z` skips older ones.
It only reads: each answer still comes back into the session that asked.

`starbridge decisions --open` lists the questions still open, in the same form, so an orchestrator
can check that no session already asked what it is about to ask.

### Runs

`starbridge run` wraps a command that blocks you or needs you at the machine, and reports it to
your devices ([Runs](../docs/index.md#runs) says what they show and how progress is read):

```bash
starbridge run --title "Release 1.4" \
  --reason "publishes to npm and Homebrew" \
  -- make release
```

The output passes through unchanged, and `run` exits with the command's code, or 128 + n when
signal n ended it. If the machine is not paired or the server is down, `run` warns once and runs
the command anyway.

### Quotas

The background service runs `codexbar usage --format json` for each provider you picked and uploads a
snapshot every 5 minutes. A provider that fails is sent as an error and never stops the others.
Each device picks its own quota alerts, per window, in Settings → Quotas
([Notifications](../docs/notifications.md) lists them).

To upload without the service:

```bash
starbridge quota push --provider claude --provider codex
```

### Quiet your other devices while you're here

On a desktop or laptop you work at, turn on presence:

```bash
starbridge config presence on
```

While this machine's screen is unlocked and had keyboard or mouse input in the last minute, your
other devices stay quiet, and for the hold time after you leave (Settings → Notifications → Quiet
other devices while you’re at a screen, 30 s by default). They notify only if the question is
still open, so one you answer here doesn't buzz them.
The question itself shows everywhere at once. The machine reads its lock and idle time itself
and tells the server only yes or no. It works on macOS, Windows, and Linux under GNOME
or X11 with `xprintidle`; a machine with no screen sends nothing.

### Permission prompts

Permission prompts stay at the keyboard until you run:

```bash
starbridge config permissions on
```

Your devices can then allow a call once or deny it. In Claude Code, opencode and Antigravity, each
prompt shows at the keyboard and on your devices at once, and the first answer wins. Codex and Pi
send it to one place at a time, and Cursor's stay at the keyboard;
[What each harness supports](../docs/tell-your-agents.md#what-each-harness-supports) has each.

Only prompts Claude Code still shows reach your devices:
in auto mode, its default, it settles most calls itself. When the keyboard answers first, the
device's card closes once the tool has run, since Claude Code reports the call only then.

`opencode run` rejects every prompt itself, so none reaches your devices.

Pi's prompts come from pi-permission-system (`pi install npm:@gotgenes/pi-permission-system`).
With the Starbridge Pi package installed, the same command offers to add `starbridge` to its
`authorizerChain`, which it needs as well. It also offers allow rules, so that Pi reads the
Starbridge skill without a prompt; the link runs the commands above without one when they stand
alone, never chained to another command. "Answer here" in Pi brings the prompt back to the
keyboard. Prompts from its `path` and `external_directory` rules stay at the keyboard.

[One notification per question](../docs/notifications.md) says which of Claude Code's and the
Claude app's notifications to turn off so that one prompt doesn't notify you twice.

### The background service

`starbridge agent` runs once per machine, as a user service. It holds the keys and the server
connection, uploads quota snapshots and hands each session its answers. The other commands go
through it when it runs, and to the server directly when it doesn't or when
`STARBRIDGE_NO_AGENT=1` is set. Its flags (`--provider`, `--interval`, `--codexbar`, `--no-quota`, `--log`)
override `agent.json` in the config directory.

### Config

Keys and state live in `~/.config/starbridge` (or `$XDG_CONFIG_HOME/starbridge`, or
`$STARBRIDGE_CONFIG_DIR`), readable only by you. `starbridge config` prints this machine's
settings.

The Claude Code plugin's hooks call `starbridge hook …`. When Claude Code opens its
`AskUserQuestion` question picker, `starbridge hook permission` posts the question to your
devices. Each question shows at the keyboard and on your devices at once, and the first answer
wins. If the machine is not paired or the server can't be reached, only the picker asks. The
opencode plugin runs `starbridge hook question --agent opencode` on each call of opencode's
question picker, `question`, the same way.

## What agents parse

Plugins and scripts built on `starbridge` can rely on the commands and output in
[CONTRACT.md](CONTRACT.md), stable from 0.1.0.
