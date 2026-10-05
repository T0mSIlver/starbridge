# starbridge CLI

Posts decisions to your Starbridge devices and uploads your AI plans' quota
windows from CodexBar. Everything it sends is signed with this machine's key
and sealed to each of your devices, so the server sees ciphertext only.

## Install

Linux or macOS, into `~/.local/bin`:

```bash
curl -fsSL https://starbridge.run/install.sh | sh
```

or `brew install T0mSIlver/starbridge/starbridge`, or `npm install -g starbridge`
(Node 22 or later). `starbridge update` installs the latest release over a
script install, and `starbridge uninstall` removes the binary; brew and npm
installs update and uninstall through their manager.

The script and `starbridge update` accept a binary only if its hash is in the
release's `SHA256SUMS` and `SHA256SUMS.minisig` is signed by the release key
(also in [`minisign.pub`](minisign.pub)):

```
RWRT+qMmByDpj/1KhL5yCxdzIkVgZ3NqTrlVIIvhrezr/38FgzBIen0F
```

To check a download by hand: `minisign -Vm SHA256SUMS -P <key>`, then
`sha256sum -c --ignore-missing SHA256SUMS`.

## Use

```bash
starbridge pair --server https://starbridge.example
```

`pair` prints a code; type it under Devices on your phone or the web page.
Keys and state live in `~/.config/starbridge` (or `$XDG_CONFIG_HOME`,
`$STARBRIDGE_CONFIG_DIR`), mode 0600.

```bash
starbridge ask --question "Merge #12 now?" --option Merge --option Wait
starbridge waiting d_Xk3…          # out of other work: "Waiting for you" on every device
starbridge wait d_Xk3… --timeout 1h   # exit 2: nobody answered in time
starbridge quota push --provider claude --provider codex   # every 5 minutes
```

`starbridge run` wraps a command the owner wants to hear about. Agents wrap,
unasked, any command that blocks the owner or needs them at the machine (e2e
tests that take over the screen, keyboard or session, anything that holds a
device they use), and any command the owner's rules (below) name. The owner's devices show its title, its reason, the time
elapsed and the progress its output prints (an OSC 9;4 sequence, `[3/7]`,
`42%`), then pass or fail with the exit code and duration:

```bash
starbridge run --title "Mac e2e" --reason "uses your session and keyboard" \
  -- bash -c 'make build && make e2e'
```

The output passes through unchanged, and `run` exits with the command's code,
or 128 + n when signal n ended it. Nothing stops the command: when the
machine is not paired or the server is down, `run` warns once and goes on.
The command's output is a pipe, not a terminal; tools that print progress
only to a terminal print none here.

To have agents report other commands too, such as local inference, tell them
in their own instruction files (`docs/tell-your-agents.md`). That adds to the
default above, never replaces it.

`starbridge answers` is for the Claude Code mod (`mod/README.md`): it hands a
session the answers to the decisions it asked.

`starbridge agent` runs once per machine, as a user service. It holds the
keys and the server connection, uploads quota snapshots every interval
(`--provider`, `--interval`, or `agent.json` in the config directory), and
hands each Claude Code session its answers over a unix socket
(PROTOCOL.md, "Local agent API"). Every command goes through it when it runs
and to the server directly when it does not, or with `STARBRIDGE_NO_AGENT=1`.

`starbridge setup` does the rest in one run, and a rerun repairs only what is
missing. It pairs the machine and finds CodexBar. When CodexBar is missing,
setup installs it: Homebrew if present, else the release tarball, checked
against pinned hashes and unpacked to `~/.local/opt/codexbar`. It then probes
each provider and lets you pick which to upload, and writes `agent.json`. The
agent goes in as a systemd user unit or a launchd agent. The Claude Code
plugins install at user scope. Setup also replaces a hand-written `starbridge
quota push` unit and a copied mod or skill, then uploads a first snapshot.
`--yes` takes every default; `--no-quota`, `--no-service` and `--no-plugin`
skip a step. `starbridge status` prints the same checks. `starbridge
uninstall` removes the service, the plugins and then the binary, asks your devices to revoke
the machine, and deletes the keys only when you say so (`--purge`).

If you use the Claude app, turn off its "Code updates" notifications, which fire at the end of
every turn, and keep "Code permission requests" on. If you turn on Starbridge's own permission
prompts (below), turn "Code permission requests" off too, so one prompt does not notify twice.

Permission prompts stay at the keyboard unless you say yes in setup or run
`starbridge config permissions on`; the Claude app already shows them for
Remote Control sessions. When on, this machine's Claude Code prompts also go to
your devices, where they can be allowed or denied; the prompt stays open at the
keyboard and the first answer wins. The `starbridge` plugin's hooks run
`starbridge hook permission` and `starbridge hook settle`, which exit at once
while it is off (PROTOCOL.md, "Permission prompts").

The plugin's `PreToolUse` hook runs `starbridge hook ask-user` on Claude Code's
`AskUserQuestion`: it turns the question away and tells the agent to post it with `starbridge
ask`, so it reaches you away from the terminal. When the machine is not paired or the server
does not answer, the hook lets the question through.

`quota push` runs `codexbar usage --format json` for each provider, or once
for every enabled provider when none is named. A provider that fails or is
missing from the output is logged and sent as an error; it never stops the
loop. `starbridge --help` lists every flag.

Standalone binaries come from `bun run build:bin` (Linux and macOS, x64 and
arm64). A `v*` tag runs `.github/workflows/release.yml`, which attaches them,
`install.sh` and the signed `SHA256SUMS` to a GitHub Release, commits the
formula to `T0mSIlver/homebrew-starbridge` and publishes to npm. The signing key
lives in `~/.config/starbridge/secrets/minisign.key` on the dev box and in the
`MINISIGN_SECRET_KEY` Actions secret.
