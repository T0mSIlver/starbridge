#!/bin/sh
# SessionStart hook: adds the owner's rules to the session's context. The decision rule always;
# the run rules from rules.md in the Starbridge config directory, the CLI's (cli/src/config.ts),
# when that file has any.
dir="${STARBRIDGE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/starbridge}"
rules="$dir/rules.md"

context='Whenever you need me to decide something, use the `starbridge` skill.'
if [ -f "$rules" ] && grep -q '[^[:space:]]' "$rules"; then
  context="$context

When a command you are about to run matches one of my rules below, run the whole command, chained or not, through \`starbridge run\` with a title and the reason, as the \`starbridge\` skill says.

My rules for runs ($rules):
$(cat "$rules")"
fi

# JSON-escape: backslashes, quotes, tabs, carriage returns, drop other control characters, then
# join lines with \n.
printf '%s' "$context" | awk '
  BEGIN { ORS = "" }
  {
    gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r")
    gsub(/[\001-\010\013\014\016-\037\177]/, "")
    if (NR > 1) print "\\n"
    print
  }
' | {
  IFS= read -r escaped || true
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$escaped"
}
