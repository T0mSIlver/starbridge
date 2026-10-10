#!/bin/sh
# SessionStart hook: adds the owner's two standing rules (rule.md, which the Pi extension adds
# too) to the session's context: reach them through Starbridge, and wrap commands that block them
# in a run. Anything more personal goes in the agent's own instruction files
# (docs/tell-your-agents.md). With `cursor`, Cursor's sessionStart hook (#954): Cursor's output
# shape, `additional_context` at the top.
context=$(cat "$(dirname "$0")/rule.md")

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
  if [ "${1-}" = cursor ]; then
    printf '{"additional_context":"%s"}\n' "$escaped"
  else
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$escaped"
  fi
}
