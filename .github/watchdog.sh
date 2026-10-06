#!/usr/bin/env bash
# watchdog.sh SECONDS COMMAND...: runs COMMAND in its own process group. If it is still running
# after SECONDS, prints what each of its processes is doing and which sockets they hold, then
# stops them, so a hung run fails with the state it hung in instead of holding a runner.
set -u
seconds=$1
shift
setsid "$@" &
pid=$!
# By parent, not by group: Playwright starts Firefox in a session of its own.
tree() { echo "$1"; for c in $(ps -o pid= --ppid "$1"); do tree "$c"; done; }
# A cancelled job stops them too.
trap 'kill -TERM $(tree "$pid") 2>/dev/null' INT TERM
for _ in $(seq "$seconds"); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  pids=$(tree "$pid")
  echo "::error::$* still running after ${seconds}s; its processes and sockets follow"
  # wchan: the kernel function a sleeping process waits in.
  ps -o pid,ppid,etime,time,stat,wchan:24,args --forest -p "$(echo $pids | tr ' ' ,)"
  ss -tanpH | grep -E "pid=($(echo $pids | tr ' ' '|'))," || true
  kill -TERM $pids 2>/dev/null
  sleep 10
  kill -KILL $pids 2>/dev/null
  kill -KILL -- "-$pid" 2>/dev/null
  wait "$pid"
  exit 124
fi
wait "$pid"
