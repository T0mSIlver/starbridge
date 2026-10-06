# starbridge CLI

`starbridge` connects a machine that runs agents to your phone and browsers. Agents use it to ask
you questions and report runs, and it uploads what each AI plan has left, read from CodexBar. It
signs everything with this machine's key and encrypts it for your devices, so the server sees
ciphertext only.

## Install

Linux or macOS. Pick one of the three.

The install script puts the binary in `~/.local/bin`, then runs `starbridge setup`:

```bash
curl -fsSL https://starbridge.run/install.sh | sh
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
2. It finds CodexBar, or installs it (with Homebrew if you have it, else from the release
   tarball, checked against pinned hashes, into `~/.local/opt/codexbar`).
3. It asks which providers' quotas to upload.
4. It installs the background service, `starbridge agent`, as a systemd user unit or a launchd
   agent.
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

`starbridge update` installs the latest release over a script install, restarts the agent and
updates the Claude Code plugins; the agent brings the Codex skill up to date when it starts.
Homebrew and npm installs update through their own manager; then run `starbridge setup`, which
restarts the agent on the new version.

`starbridge uninstall` removes the agent service, the plugin and the binary, and asks your
devices to revoke the machine. It deletes the keys only when you say so, or with `--purge`.

### Check a download

The script and `starbridge update` install a binary only if its hash is in the release's
`SHA256SUMS` and the release key signed `SHA256SUMS.minisig`. The key is also in
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
Starbridge skill and runs the commands above without a prompt. Your devices then allow a call once
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

## Release

One version covers the CLI, the web app, both Claude Code plugins, the mod and the Android app. To release
1.2.3, run `bun cli/scripts/version.ts 1.2.3` from the repository root, merge it in a PR, and tag
the merged commit `v1.2.3`; the workflow refuses a tag that disagrees with the stamped files. The
marketplace installs both plugins from that tag, and setup installs the Pi package at the tag of
the CLI it runs. A release candidate (`1.2.3-rc.1`) leaves the marketplace on the last release.

`bun run build:bin` builds the standalone binaries (Linux and macOS, x64 and arm64). A `v*` tag
runs `.github/workflows/release.yml`, which attaches them, `install.sh` and the signed
`SHA256SUMS` to a GitHub Release, commits the formula to `T0mSIlver/homebrew-starbridge` and
publishes to npm. The signing key lives in the `MINISIGN_SECRET_KEY` Actions secret and, offline, with the maintainer.
