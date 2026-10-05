#!/bin/sh
# SessionStart hook: adds the owner's rules to the session's context: reach them through Starbridge,
# wrap commands that block them in a run, and their own run rules from rules.md in the Starbridge
# config directory, the CLI's (cli/src/config.ts), when that file has any.
dir="${STARBRIDGE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/starbridge}"
rules="$dir/rules.md"

reach='I am often away from this terminal and may not read your final message for hours. Starbridge is how you reach me: use the `starbridge` skill, instead of asking here or with AskUserQuestion, whenever you need a decision that is mine, and before you end a turn on work that waits on me, such as a PR for me to review or merge, or a failure only I can fix. Decide everything else yourself and keep working. Ask here only when `starbridge` fails.'
blocks='blocks me or needs me at the machine (it takes over the screen, keyboard or session, or holds a device I use)'
run='through `starbridge run` with a title and the reason, as the `starbridge` skill says.'
if [ -f "$rules" ] && grep -q '[^[:space:]]' "$rules"; then
  context="$reach

When a command you are about to run $blocks, or matches one of my rules below, run the whole command, chained or not, $run

My rules for runs ($rules):
$(cat "$rules")"
else
  context="$reach

When a command you are about to run $blocks, run the whole command, chained or not, $run"
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
