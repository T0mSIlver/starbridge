#!/bin/sh
# UserPromptSubmit hook: a prompt in a session settles the card asked for Claude desktop's
# next-step box there (#2118, `starbridge hook prompt`). The CLI starts only while the config
# folder lists this session with such a card open, or any session where Claude Code names none.
dir=${STARBRIDGE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/starbridge}
[ -s "$dir/next-steps-open" ] || exit 0
if [ -n "${CLAUDE_CODE_SESSION_ID-}" ]; then
  grep -qxF "$CLAUDE_CODE_SESSION_ID" "$dir/next-steps-open" || exit 0
fi
exec sh "$(dirname "$0")/cli.sh" hook prompt --agent claude-code
