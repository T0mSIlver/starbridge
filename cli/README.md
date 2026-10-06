# starbridge CLI

`starbridge` connects a machine that runs agents to your phone and browsers. Agents use it to ask
you questions and report runs, and it uploads what each AI plan has left, read from CodexBar. It
signs everything with this machine's key and encrypts it for your devices, so the server sees
ciphertext only.

## Install

Linux, macOS or Windows. Pick one.

The install script puts the binary in `~/.local/bin`, then runs `starbridge setup`:

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

Setup asks before each step, and a rerun repairs only what is missing:

1. It pairs the machine with your account.
2. It finds CodexBar, or installs it (Linux and macOS; CodexBar has no Windows build, so a
   Windows machine uploads no quotas): with Homebrew if you have it, else CodexBar's latest
   release tarball from GitHub, checked against the `.sha256` that release publishes, into
   `~/.local/opt/codexbar`. It installs nothing when the checksum is missing or does not match.
3. It asks which providers' quotas to upload.
4. It installs the background service, `starbridge agent`, as a systemd user unit, a launchd
   agent, or on Windows a Scheduled Task that starts at logon without administrator rights and
   logs to `%LOCALAPPDATA%\starbridge\agent.log`.
5. It installs Starbridge in each agent it finds: the Claude Code plugin at user scope, the
   skill in Codex's skills folder, the Starbridge Pi package, and the skill and plugin in
   opencode's config folder. A later setup updates the Codex and opencode files when the CLI
   carries newer ones. Claude Code, Codex and Pi may then run `starbridge ask`, `waiting`,
   `working`, `wait` and `settle` without a permission prompt; `starbridge run` still asks, since
   the command it wraps can be anything. For Pi, setup adds these rules only when
   pi-permission-system is installed; `starbridge config permissions on` offers them later.
6. It uploads a first quota snapshot.

`--yes` takes every default. `--no-quota`, `--no-service` and `--no-plugin` skip a step;
`--no-plugin` skips every agent.
`starbridge status` prints the same checks.

### Update and uninstall

`starbridge update` installs the latest release over a script install, then runs `starbridge
setup --refresh` with it and updates the Claude Code plugins. `--refresh` rewrites the files
setup put into other tools (the agent's service, the Codex skill and rule, opencode's skill and
plugin) for the new version and restarts the agent. Homebrew and npm installs update through
their own manager; then run `starbridge setup --refresh`. Each of those files starts with a
`Written by starbridge <version>` line: setup replaces and uninstall removes only files that have
it, so remove the line from one to keep it as yours.

`starbridge update` then moves a CodexBar that setup installed in `~/.local/opt/codexbar` to
CodexBar's latest release, with the same checksum check; a CodexBar from Homebrew or the macOS
app is left to them (`brew upgrade codexbar`). When a CodexBar release breaks, its providers show
a quota error on your devices; `starbridge update --codexbar 0.71.1` installs that release
instead, until a later `starbridge update` moves it to the latest again.

`starbridge uninstall` removes the agent service, the plugin and the binary, and asks your
devices to revoke the machine. It deletes the keys only when you say so, or with `--purge`.

### Check a download

The scripts and `starbridge update` install a binary only if its hash is in the release's
`SHA256SUMS` and the release key signed `SHA256SUMS.minisig`. `install.ps1` checks the signature
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

Setup covers pairing and the agent. Agents run the other commands themselves; the Starbridge
skill tells them when. `starbridge --help` lists every flag.

### Pair

```bash
starbridge pair
```

It prints a code, a link and a QR code. Open the link in a browser where you are signed in, scan
the QR code with your phone, or type the code in Settings → Devices → Add a device, on your phone
or in the web app. The machine pairs with
https://starbridge.run unless you pass `--server https://starbridge.example` or set
`STARBRIDGE_SERVER`.

### Ask

An agent asks a question with two to four options, or none for a free-text answer:

```bash
starbridge ask --question "Merge #12 now?" \
  --option Merge --option Wait
```

`ask` prints the question's id and how the answer will come back:

- In Claude Code, the answer arrives as the session's next prompt.
- In an interactive Codex session (Codex CLI 0.160 or later), the background service queues it
  into the session.
- Anywhere else, the agent waits for it with `starbridge wait <id> --timeout 5m`, which exits
  with code 2 when the time runs out.

When the agent runs out of other work, `starbridge waiting <id>` shows "Waiting for you" on
every device and notifies you once more. `starbridge working <id>` clears it; the question stays open.

### Runs

`starbridge run` wraps a command you want to follow: a build, a release, an eval, heavy work on
your machine, or a test that takes over the screen or keyboard. Your devices show its title, its
reason, the time elapsed and its progress, then pass or fail:

```bash
starbridge run --title "Release 1.4" \
  --reason "publishes to npm and Homebrew" \
  -- make release
```

The output passes through unchanged, and `run` exits with the command's code, or 128 + n when
signal n ended it. Progress comes from what the output prints: an OSC 9;4 sequence, `[3/7]` or
`42%`. The output goes through a pipe, so tools that print progress only to a terminal show none.
If the machine is not paired or the server is down, `run` warns once and runs the command anyway.

The Starbridge skill has agents wrap, unasked, any command that blocks you or needs you at the machine. To hear about
other commands, such as local inference, say so in their instruction files
([Agent instructions](../docs/tell-your-agents.md)).

### Quotas

The background service runs `codexbar usage --format json` for each provider you picked and uploads a
snapshot every 5 minutes. A provider that fails is sent as an error and never stops the others.
Alerts before a window runs out are off until you turn on "Notify" for a provider in each
device's Settings.

To upload without the service:

```bash
starbridge quota push --provider claude --provider codex
```

### Permission prompts

Permission prompts from Claude Code, opencode and Pi stay at the keyboard until you turn them on,
in setup or with:

```bash
starbridge config permissions on
```

Then each prompt also goes to your devices, where you allow or deny it. The prompt stays open at
the keyboard, and the first answer wins. Only prompts Claude Code still shows reach your devices:
in auto mode, its default, it settles most calls itself. When the keyboard answers first, the
device's card closes once the tool has run, since Claude Code reports the call only then.

opencode's prompts work the same way, from its TUI and `opencode serve`. `opencode run` rejects
every prompt at once, so none reaches your devices.

Pi's prompts come from pi-permission-system (`pi install npm:@gotgenes/pi-permission-system`).
With the Starbridge Pi package installed, the same command offers to add `starbridge` to its
`authorizerChain`, which it needs as well. It also offers allow rules, so that Pi reads the
Starbridge skill without a prompt; the link runs the commands above without one when they stand
alone, never chained to another command. Your devices then allow a call once
or deny it, and "Answer here" in Pi brings back pi-permission-system's own prompt. Asks from its
`path` and `external_directory` rules stay at the keyboard, since it lets no link allow those.

If you use the Claude app, turn off its "Code updates" notifications, which fire at the end of
every turn. Keep "Code permission requests" on, unless you turned on Starbridge's permission
prompts, so that one prompt doesn't notify you twice.

### The background service

`starbridge agent` runs once per machine, as a user service. It holds the keys and the server
connection, uploads quota snapshots and hands each session its answers. The other commands go
through it when it runs, and to the server directly when it doesn't or when
`STARBRIDGE_NO_AGENT=1` is set. Its flags (`--provider`, `--interval`) override `agent.json` in
the config directory.

### Config

Keys and state live in `~/.config/starbridge` (or `$XDG_CONFIG_HOME/starbridge`, or
`$STARBRIDGE_CONFIG_DIR`), readable only by you. `starbridge config` prints this machine's
settings.

The Claude Code plugin's hooks call `starbridge hook …`. One of them turns Claude Code's
`AskUserQuestion` into `starbridge ask`, so the question reaches you away from the terminal; if
the machine is not paired or the server doesn't answer, it lets the question through. The
opencode plugin runs `starbridge hook question --agent opencode` on each call of opencode's
`question` tool: it posts each question to your devices and prints the answers for opencode,
or nothing if the terminal answers first or the server can't be reached.

## What agents parse

Agents, the Starbridge skill, the Claude Code plugins, the Pi extension and the opencode plugin
read the commands below and their output. The plugins update apart from the CLI, so this list is
frozen for every 1.x release: a release may add commands, flags, variables, fields and lines, but
changing or removing anything here takes a new major version. `cli/test/contract.test.ts` pins
the lines; the hook outputs are pinned in `cli/test/permissions.test.ts`.

| Command | Contract |
|---|---|
| `ask` | Flags `--question`, `--context`, `--context-file`, `--option`, `--recommended`, `--waiting`, `--agent`, `--project`, `--session`, `--session-title`, `--session-link`, `--image`, `--link`, `--answer-in`, `--input <path>` (a JSON file with the same fields, `-` for stdin), `--wait`, `--timeout`. Prints the decision id alone on stdout: `d_` and 16 characters from `A-Z a-z 0-9 _ -`. With `--wait`, then what `wait` prints; without it, one line on stderr, either `The answer will come back into this session as a new prompt.` or ``Nothing brings the answer into this session: when only the answer is left, run `starbridge wait <id> --timeout 5m` (again on exit 2).`` |
| `wait [<id>]` | Flags `--timeout`, `--json`. Prints `Answer to <id> (<question>): <choice or text>`, or for an `--answer-in` question the owner marked Done, `Answer to <id> (<question>): answered on its page; read the answer there`; with `--json`, the answer as one JSON object with `decisionId` and `choice`, `text` or `done: true`. Exits 2 when `--timeout` passed. |
| `waiting <id>`, `working <id>` | No output on success. |
| `settle <id>` | Flag `--outcome elsewhere\|withdrawn`. |
| `answers --session <id>` | Flags `--wait <seconds>`, `--ack <ack>`. Prints one JSON object per line: `{"decisionId", "ack", "line"}`, where `line` is the `Answer to` line above. |
| `run` | Flags `--title`, `--reason`, then `--` and the command. Exits with the command's code: 127 when it cannot start, 128 plus the signal when a signal ends it. |
| `hook permission` | Flags `--agent claude-code\|pi\|opencode`, `--wait`. Reads the hook's JSON on stdin and prints the output its harness defines, or nothing to leave the prompt to the keyboard. SIGTERM means the keyboard answered. Exits 0. |
| `hook settle` | Flag `--agent claude-code`. Reads the hook's JSON on stdin. Exits 0. |
| `hook ask-user` | Reads the hook's JSON on stdin; prints a PreToolUse output that answers each question with an instruction to use `starbridge ask` (a denial when it cannot read the input), or nothing to let the question through. Exits 0. |
| `pair` | Prints `Pairing code: <code>` first. |

Codex sessions receive ``Starbridge has the owner's answer to <id>: run `starbridge wait <id>` to read it.``
as a queued prompt. The plugins set `STARBRIDGE_PI_ANSWERS`, `STARBRIDGE_OPENCODE_SESSION`,
`STARBRIDGE_OPENCODE_TITLE` and `STARBRIDGE_OPENCODE_ANSWERS` for the commands their agents run,
and read `STARBRIDGE_CONFIG_DIR`, `STARBRIDGE_AGENT_SOCKET` and `STARBRIDGE_NO_AGENT`.

The hooks exit 1 only when stdin cannot be read. Every other command exits 0 on success and 1 on an error, with the error on stderr after
`starbridge: `. Ctrl-C exits 130.

## Release

One version covers the CLI, the web app, both Claude Code plugins, the mod and the Android app. To release
1.2.3, run `bun cli/scripts/version.ts 1.2.3` from the repository root, merge it in a PR, and tag
the merged commit `v1.2.3`; the workflow refuses a tag that disagrees with the stamped files. The
marketplace installs both plugins from that tag, and setup installs the Pi package at the tag of
the CLI it runs. A release candidate (`1.2.3-rc.1`) leaves the marketplace on the last release.

`bun run build:bin` builds the standalone binaries (Linux, macOS and Windows, x64 and arm64). A
`v*` tag runs `.github/workflows/release.yml`, which attaches them, `install.sh`, `install.ps1`
and the signed
`SHA256SUMS` to a GitHub Release, commits the formula to `T0mSIlver/homebrew-starbridge` and
publishes to npm. The signing key lives in the `MINISIGN_SECRET_KEY` Actions secret and, offline, with the maintainer.
