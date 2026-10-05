# starbridge CLI

Posts decisions to your Starbridge devices and uploads your AI plans' quota
windows from CodexBar. Everything it sends is signed with this machine's key
and sealed to each of your devices, so the server sees ciphertext only.

## Install

Linux or macOS, into `~/.local/bin`:

```bash
curl -fsSL https://github.com/T0mSIlver/starbridge/releases/latest/download/install.sh | sh
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
starbridge ask --question "Merge #12 now?" --option Merge --option Wait \
  --default Merge --default-at 2h --wait
starbridge wait d_Xk3…             # exit 2: nobody answered in time
starbridge quota push --provider claude --provider codex   # every 5 minutes
```

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

`starbridge permissions enable` sends this machine's Claude Code permission
prompts to your devices too, where they can be allowed or denied; the prompt
stays open at the keyboard and the first answer wins. The `starbridge`
plugin's hooks run `starbridge hook permission` and `starbridge hook settle`,
which do nothing while it is off (PROTOCOL.md, "Permission prompts").

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
