#!/bin/sh
# remote.sh NAME [SCRIPT ARGS...], for the starbridge-remote plugin that setup builds on a machine
# Claude desktop reaches over SSH (#2107). Claude desktop starts such a session with --plugin-dir
# copies of the plugins installed on its own computer, synced without hooks/, and each replaces
# this machine's plugin of its name. So starbridge-remote carries this machine's hooks and mod
# under another name, and acts only where plugin NAME is such a copy: then this runs SCRIPT with
# ARGS, or exits 0 without one. Elsewhere it exits 0 with SCRIPT (the installed plugin acts) and
# 1 without.
name=$1
shift
# A hook gets CLAUDE_PID, else runs under a shell Claude Code starts. The mod's check runs
# straight from Claude Code, its parent, and may have inherited another session's CLAUDE_PID.
if [ $# -gt 0 ]; then
  pids=${CLAUDE_PID:-$PPID $(ps -o ppid= -p "$PPID" 2>/dev/null)}
else
  pids=$PPID
fi
nl='
'
found=
for pid in $pids; do
  if [ -r "/proc/$pid/cmdline" ]; then
    args=$(tr '\0' '\n' <"/proc/$pid/cmdline")
  else
    args=$(ps -o args= -p "$pid" 2>/dev/null | tr ' ' '\n')
  fi
  IFS=$nl
  next=
  for a in $args; do
    if [ -n "$next" ]; then
      dir=$a
      next=
    else
      case $a in
        --plugin-dir) next=1 && continue ;;
        --plugin-dir=*) dir=${a#--plugin-dir=} ;;
        *) continue ;;
      esac
    fi
    [ -f "$dir/hooks/hooks.json" ] && continue
    n=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$dir/.claude-plugin/plugin.json" 2>/dev/null |
      head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
    if [ "$n" = "$name" ]; then
      found=1
      break
    fi
  done
  unset IFS
  [ -n "$found" ] && break
done
if [ -z "$found" ]; then
  [ $# -gt 0 ] && exit 0
  exit 1
fi
[ $# -gt 0 ] || exit 0
exec sh "$@"
