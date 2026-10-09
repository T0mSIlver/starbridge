#!/bin/sh
# Antigravity runs this before each model call, from this folder. Starbridge answers a
# conversation's prompts only once one of its commands handed over the language server's key;
# until then, at the start of each turn, the CLI may ask the agent to run `starbridge hello`
# (#962). Once the conversation's flag exists, the CLI never starts.
input=$(cat)
case $input in
*'"invocationNum":0'*) ;;
*) echo '{}'; exit 0 ;;
esac
id=$(printf '%s' "$input" | sed -n 's/.*"conversationId":"\([A-Za-z0-9_-]*\)".*/\1/p')
dir=${STARBRIDGE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/starbridge}
if [ -z "$id" ] || [ -e "$dir/antigravity/$id" ]; then
  echo '{}'
  exit 0
fi
printf '%s\n' "$input" | exec sh ./cli.sh hook pre-invocation --agent antigravity
