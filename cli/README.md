# starbridge CLI

Posts decisions to your Starbridge devices and uploads your AI plans' quota
windows from CodexBar. Everything it sends is signed with this machine's key
and sealed to each of your devices, so the server sees ciphertext only.

```bash
npm install -g starbridge          # needs Node 22 or later
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

`quota push` runs `codexbar usage --format json` for each provider, or once
for every enabled provider when none is named. A provider that fails or is
missing from the output is logged and sent as an error; it never stops the
loop. `starbridge --help` lists every flag.

Standalone binaries come from `bun run build:bin` (Linux and macOS, x64 and
arm64); the `cli release` workflow attaches them to a GitHub release on a
`cli-v*` tag.
