#!/bin/sh
# PostToolUse hook: tells the devices that the keyboard answered a permission prompt
# (`starbridge hook settle`). Starting the CLI costs about 50 ms and 50 MB, so it starts only
# while the CLI marks a prompt open in its config folder (#517); Stop and SessionEnd still settle
# what is left.
dir=${STARBRIDGE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/starbridge}
[ -e "$dir/permissions-open" ] || exit 0
exec starbridge hook settle --agent claude-code
