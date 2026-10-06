#!/bin/sh
# Runs the Starbridge CLI with these arguments. Claude Code started from the Dock or a terminal
# without ~/.local/bin on its PATH has no `starbridge` (#612), so this takes the path setup
# recorded in the config folder, then the PATH, then the folders the installers use.
dir=${STARBRIDGE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/starbridge}
cli=
[ -r "$dir/cli-path" ] && read -r cli <"$dir/cli-path"
if [ -z "$cli" ] || [ ! -x "$cli" ]; then
  cli=$(command -v starbridge 2>/dev/null) || cli=
fi
if [ -z "$cli" ]; then
  for c in "$HOME/.local/bin/starbridge" "$HOME/.local/bin/starbridge.exe" \
    /opt/homebrew/bin/starbridge /usr/local/bin/starbridge /home/linuxbrew/.linuxbrew/bin/starbridge; do
    if [ -x "$c" ]; then
      cli=$c
      break
    fi
  done
fi
if [ -z "$cli" ]; then
  echo "starbridge: the Starbridge CLI is not installed, or not where setup recorded it: run \`starbridge setup\`" >&2
  exit 1
fi
exec "$cli" "$@"
