#!/bin/sh
# Antigravity runs this before each command its agent runs, from this folder. Starting the CLI
# costs about 50 ms and 50 MB, so only a call that names starbridge starts it; the CLI decides
# how the starbridge commands the skill runs pass, and prints nothing for the rest (#959).
input=$(cat)
case $input in
*starbridge*) printf '%s\n' "$input" | exec sh ./cli.sh hook pre-tool --agent antigravity ;;
esac
