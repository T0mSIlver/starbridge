#!/bin/sh
# Antigravity runs this before each command its agent runs, from this folder. Starting the CLI
# costs about 50 ms and 50 MB, so it starts only for a call that names starbridge, whose
# commands it lets through (#959), or in a conversation that has not handed Starbridge its key
# yet (#962); it prints nothing for the rest.
input=$(cat)
id=$(printf '%s' "$input" | sed -n 's/.*"conversationId":"\([A-Za-z0-9_-]*\)".*/\1/p')
dir=${STARBRIDGE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/starbridge}
case $input in
*starbridge*) ;;
*) if [ -z "$id" ] || [ -e "$dir/antigravity/$id" ]; then exit 0; fi ;;
esac
printf '%s\n' "$input" | exec sh ./cli.sh hook pre-tool --agent antigravity
