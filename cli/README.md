# starbridge CLI

`starbridge` connects a machine that runs your harnesses to your phone and browsers. Agents use it
to ask you questions and report runs, and it uploads your AI plans' quotas, read from CodexBar.
`starbridge --help` lists every command and flag, and `starbridge <command> --help` one command's.

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

`starbridge@next` on npm is the newest release candidate.

### What setup does

A rerun repairs only what is missing.

1. Pairs the machine ([Pair](#pair)) with the first of `--server`, `STARBRIDGE_SERVER`, the
   server whose install script you ran, the machine's current server, or https://starbridge.run.
2. Installs Starbridge in each harness it finds
   ([What setup installs](../docs/tell-your-agents.md#what-setup-installs)). A failed install
   prints the command that retries it.
3. Finds CodexBar, or asks to install it (Linux and macOS), then uploads the quotas of every
   provider it can read (`--providers` picks others). When another machine of your account
   already sends quotas, it asks first.
4. Installs and starts the background service: a systemd user unit, a launchd agent, or a
   Windows Scheduled Task. On Linux it turns on lingering so the service runs after you log out.
5. Adds the CLI to your PATH when it isn't there yet.
6. Sends a test question to your devices (Ctrl-C skips it).

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

Once a day the background service reads the latest release. On a script install, a newer one
installs by itself within two hours, while no question, permission prompt or run is in flight; a
failed update keeps the old version and tries again the next day. Otherwise `setup`, `pair`,
`config` and `--version` print a line saying it is out. Your devices show "Update available"
under a machine that is behind, else when it last updated and to what.

The server refuses a CLI before 0.1.1. Its commands say to run `starbridge update`.

| Command | Effect |
|---|---|
| `starbridge update` | Installs the latest release over a script install, then runs `setup --refresh` and updates the Claude Code plugins. Homebrew and npm installs update through their manager; then run `setup --refresh`. |
| `starbridge update --codexbar <version>` | When the pinned CodexBar release breaks and your devices show quota errors, installs that release instead, until a later `starbridge update` ([Do you trust CodexBar's code?](../docs/faq.md#do-you-trust-codexbar-s-code)). |
| `starbridge config updates off` | Stops automatic updates; the line still says when a release is out. |
| `starbridge config update-check off` | Stops the daily check, the line and automatic updates; `STARBRIDGE_NO_UPDATE_CHECK=1` does the same. |
| `starbridge status` | Shows both versions, whether updates are automatic, what holds the next one, and the last update and failure. `~/.config/starbridge/update.log` holds the last automatic update's output. |
| `starbridge uninstall` | Removes the background service, Starbridge from every harness and the binary, and asks your devices to revoke the machine; `starbridge setup` with the kept keys withdraws that card. Asks before deleting the keys (`--purge` doesn't ask). |
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

Unless the Starbridge app scanned the QR code, the machine prints a check code: press Enter if
the Starbridge app shows the same one under Devices, `n` if not. With no terminal, answer with
`starbridge pair --confirm` or `--reject`. A different code means a server paired the machine
into an account it controls ([PROTOCOL.md](../PROTOCOL.md#pairing)), and the machine saves
nothing.

### Cloud sessions

A Claude Code cloud session starts in a new container each time, so it can't pair. Instead, pair
one machine for all your cloud sessions and give them its identity:

1. On a machine with the CLI, pair a machine in a folder of its own:
   `STARBRIDGE_CONFIG_DIR=~/.config/starbridge-cloud starbridge pair --name "Cloud sessions"`.
2. Print its identity: `STARBRIDGE_CONFIG_DIR=~/.config/starbridge-cloud starbridge machine export`.
   The line holds the machine's private keys.
3. In your [cloud environment](https://code.claude.com/docs/en/cloud-environments), set the
   environment variable `STARBRIDGE_MACHINE` to that line, add `npm install -g starbridge` to the
   setup script, and set network access to Custom with `starbridge.run` (or your server) and
   **Also include default list of common package managers** checked.

Where the config folder holds no machine, the CLI uses the one in `STARBRIDGE_MACHINE`. Every
cloud session is that one machine, shown as Cloud sessions under Devices, and removing it there
stops them all: its sessions then say to run `starbridge machine export` on a paired machine and
replace the variable with the new line. No background service runs, so an agent there waits for its answer with
`starbridge ask --wait` or `starbridge wait`. Anyone who can use the environment can read the
variable.

### Ask

```bash
starbridge ask --question "Merge #12 now?" --option Merge --option Wait
```

| Command | Effect |
|---|---|
| `starbridge ask` | Posts a question with 2 to 4 `--option`s, or none for a free-text answer, and prints its id. `--waiting` posts it as "Waiting for you"; `--wait` then waits for the answer. |
| `starbridge wait <id> [--timeout 5m]` | Prints the answer; exits 2 when the time runs out, 3 when you snoozed the question. `--no-mark` doesn't show "Waiting for you". |
| `starbridge waiting <id>` | Shows "Waiting for you" on every device and notifies you once more. Prints the answer if it came in already. |
| `starbridge working <id>` | Clears "Waiting for you"; the question stays open. |
| `starbridge settle <id> --reason <text>` | Closes a question that no longer needs an answer. The reason is one line of at most 120 characters, which History shows. Commands that take an id print the question beside it, and say when the question already closed. |
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
| `starbridge quota push --provider claude --once` | Uploads one quota snapshot without the background service. Without `--once`, it uploads one every 5 minutes until stopped. |
| `starbridge agent` | The background service. Its flags override `agent.json` in the config directory. |

The background service uploads a quota snapshot every 5 minutes, and the other commands go
through it when it runs (`STARBRIDGE_NO_AGENT=1` bypasses it).

### What stays on this machine

Keys and state live in `~/.config/starbridge` (or `$XDG_CONFIG_HOME/starbridge`, or
`$STARBRIDGE_CONFIG_DIR`), readable only by you. They hold this machine's private keys and token,
and in `state.json` each question it asked, in plain text: the question, its options, the answer,
and the asking session's title and project. The CLI deletes a question and its answer 37 days
after it was asked, or 7 days after `starbridge settle` closed it. The hosted server drops a
question after 30 days and keeps an answer for 7 days after it came, so the extra 7 days cover an
answer fetched late. A question still being posted, or whose settled notice has not reached the
server, stays until it does.
`starbridge uninstall` asks before it deletes the keys and state.

### What the server sees of this machine

The machine's name, its CLI release and when that changed, and its public keys. The name is the
host name unless you pass `--name` to `starbridge pair`, and it is not encrypted: the server and
its backups keep it until you delete the account. Questions, answers, permission prompts and quota
windows are sealed before upload ([What does the server see?](../docs/faq.md#what-does-the-server-see)).

## What agents parse

Plugins and scripts built on `starbridge` can rely on the commands and output in
[CONTRACT.md](CONTRACT.md), stable from 0.1.0.
