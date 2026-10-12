# starbridge CLI

`starbridge` connects a machine that runs your harnesses to your phone and browsers. Agents use it
to ask you questions and report runs, and it uploads your AI plans' quotas, read from CodexBar.
`starbridge --help` lists every command and flag.

## Install

Linux, macOS or Windows. The script installs into `~/.local/bin` and runs `starbridge setup`
(`STARBRIDGE_NO_SETUP=1` skips it):

```bash
curl -fsSL https://starbridge.run/install.sh | sh
```

On Windows, in PowerShell (into `%USERPROFILE%\.local\bin`, added to your PATH):

```powershell
irm https://starbridge.run/install.ps1 | iex
```

With Homebrew or npm (Node 22 or later), then run `starbridge setup` yourself:

```bash
brew install T0mSIlver/starbridge/starbridge
```

```bash
npm install -g starbridge
```

### What setup does

A rerun repairs only what is missing.

1. Pairs the machine ([Pair](#pair)) with the first of `--server`, `STARBRIDGE_SERVER`, the
   server whose install script you ran, the machine's current server, or https://starbridge.run.
2. Installs Starbridge in each harness it finds
   ([What setup installs](../docs/tell-your-agents.md#what-setup-installs)). A failed install
   prints the command that retries it.
3. Finds CodexBar, or asks to install it (Linux and macOS), then asks which providers' quotas to
   upload. When another machine of your account already sends quotas, it asks first.
4. Installs and starts the background service: a systemd user unit, a launchd agent, or a
   Windows Scheduled Task.
5. Offers to send a test question to your devices.

| Flag | Effect |
|---|---|
| `--yes` | Takes every default and sends no test question; so does running with no terminal. |
| `--no-quota` | Skips step 3, CodexBar included. |
| `--no-service` | Skips step 4. |
| `--no-agents` | Skips step 2. |
| `--agent <name>` | Installs in that harness only: `claude`, `codex`, `pi`, `opencode`, `cursor` or `antigravity`. |
| `--refresh` | Rewrites the files setup put in other tools for this version, sets up a harness installed since, and restarts the background service. |

`starbridge status` prints the same checks.

### Update and uninstall

Once a day the background service reads the latest release; when it is newer, `setup`, `pair`,
`config` and `--version` print a line saying so, and your devices show "Update available".

| Command | Effect |
|---|---|
| `starbridge update` | Installs the latest release over a script install, then runs `setup --refresh` and updates the Claude Code plugins. Homebrew and npm installs update through their manager; then run `setup --refresh`. |
| `starbridge update --codexbar <version>` | When the pinned CodexBar release breaks and your devices show quota errors, installs that release instead, until a later `starbridge update` ([Do you trust CodexBar's code?](../docs/faq.md#do-you-trust-codexbar-s-code)). |
| `starbridge config update-check off` | Stops the daily check; `STARBRIDGE_NO_UPDATE_CHECK=1` silences the line. |
| `starbridge uninstall` | Removes the background service, Starbridge from every harness and the binary, and asks your devices to revoke the machine. Asks before deleting the keys (`--purge` doesn't ask). |
| `starbridge uninstall --agent <name>` | Removes Starbridge from one harness; setup leaves it out until `setup --agent <name>`. |

Setup replaces, and uninstall removes, only files that start with a `Written by starbridge
<version>` line. Remove the line from one to keep it as yours.

### Check a download

The scripts and `starbridge update` install a binary only if its hash is in the release's
`SHA256SUMS` and the release key signed `SHA256SUMS.minisig`. The key, also in
[`minisign.pub`](minisign.pub):

```
RWRT+qMmByDpj/1KhL5yCxdzIkVgZ3NqTrlVIIvhrezr/38FgzBIen0F
```

To check a download by hand:

```bash
minisign -Vm SHA256SUMS -P <key>
sha256sum -c --ignore-missing SHA256SUMS
```

## Commands

Setup covers pairing and the background service. Agents run the other commands themselves; the
Starbridge skill tells them when.

### Pair

`starbridge pair` prints a code, a link and a QR code to approve on a device
([Start](../docs/index.md#start)). `--server <url>` pairs with your own server; `--force` pairs
again after a recovery.

Unless the Android app scanned the QR code, the machine prints a check code: press Enter if the
Android app shows the same one under Devices, `n` if not. With no terminal, answer with
`starbridge pair --confirm` or `--reject`. A different code means a server paired the machine
into an account it controls ([PROTOCOL.md](../PROTOCOL.md#pairing)), and the machine saves
nothing.

### Ask

```bash
starbridge ask --question "Merge #12 now?" --option Merge --option Wait
```

| Command | Effect |
|---|---|
| `starbridge ask` | Posts a question with 2 to 4 `--option`s, or none for a free-text answer, and prints its id. `--wait` then waits for the answer. |
| `starbridge wait <id> [--timeout 5m]` | Prints the answer; exits 2 when the time runs out, 3 when you snoozed the question. `--no-mark` doesn't show "Waiting for you". |
| `starbridge waiting <id>` | Shows "Waiting for you" on every device and notifies you once more. |
| `starbridge working <id>` | Clears "Waiting for you"; the question stays open. |
| `starbridge settle <id>` | Closes a question that no longer needs an answer. |
| `starbridge answers --all --follow` | Prints each answer to this machine's questions as a JSON line, for an orchestrator. `--since 2h` skips older ones. |
| `starbridge decisions --open` | Prints the questions still open, in the same form. |

[What each harness supports](../docs/tell-your-agents.md#what-each-harness-supports) says when
the answer comes back as the session's next prompt and when the agent waits with
`starbridge wait`.

### Runs

```bash
starbridge run --title "Release 1.4" --reason "publishes to npm and Homebrew" -- make release
```

The output passes through unchanged, and `run` exits with the command's code, or 128 + n when
signal n ended it. If the machine is not paired or the server is down, `run` warns once and runs
the command anyway. [Runs](../docs/index.md#runs) says what your devices show.

### Settings

| Command | Effect |
|---|---|
| `starbridge config` | Prints this machine's settings. |
| `starbridge config permissions on` | Sends permission prompts to your devices ([What each harness supports](../docs/tell-your-agents.md#what-each-harness-supports)). |
| `starbridge config presence on` | Counts this machine as a screen you are at ([Quiet other devices while you're at a screen](../docs/notifications.md#quiet-other-devices-while-you-re-at-a-screen)). |
| `starbridge quota push --provider claude` | Uploads a quota snapshot without the background service. |
| `starbridge agent` | The background service. Its flags override `agent.json` in the config directory. |

The background service uploads a quota snapshot every 5 minutes, and the other commands go
through it when it runs (`STARBRIDGE_NO_AGENT=1` bypasses it).

Keys and state live in `~/.config/starbridge` (or `$XDG_CONFIG_HOME/starbridge`, or
`$STARBRIDGE_CONFIG_DIR`), readable only by you.

## What agents parse

Plugins and scripts built on `starbridge` can rely on the commands and output in
[CONTRACT.md](CONTRACT.md), stable from 0.1.0.
