#!/bin/sh
# PostToolUse hook: tells the devices that the keyboard answered a permission prompt
# (`starbridge hook settle`). Starting the CLI costs about 50 ms and 50 MB, so it starts only
# while the CLI marks a prompt open in its config folder (#517), or when there is no mark yet
# beside a state, as from an older CLI. Stop and SessionEnd still settle what is left.
dir=${STARBRIDGE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/starbridge}
if [ -f "$dir/permissions-open" ]; then
  [ -s "$dir/permissions-open" ] || exit 0
elif [ ! -e "$dir/state.json" ]; then
  exit 0
fi
exec starbridge hook settle --agent claude-code
