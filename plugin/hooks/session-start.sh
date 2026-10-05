#!/bin/sh
# SessionStart hook: adds the owner's two standing rules to the session's context: reach them
# through Starbridge, and wrap commands that block them in a run. Anything more personal goes in
# the agent's own instruction files (docs/tell-your-agents.md).
reach='I am often away from this terminal and may not read your final message for hours. Starbridge is how you reach me: use the `starbridge` skill, instead of asking here or with AskUserQuestion, whenever you need a decision that is mine, and before you end a turn on work that waits on me, such as a PR for me to review or merge, or a failure only I can fix. Decide everything else yourself and keep working. Ask here only when `starbridge` fails.'
context="$reach

When a command you are about to run blocks me or needs me at the machine (it takes over the screen, keyboard or session, or holds a device I use), or my instructions ask you to report it, run the whole command, chained or not, through \`starbridge run\` with a title and the reason, as the \`starbridge\` skill says."

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
