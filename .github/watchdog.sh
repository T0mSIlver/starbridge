#!/usr/bin/env bash
# watchdog.sh SECONDS COMMAND...: runs COMMAND in its own process group. If it is still running
# after SECONDS, prints what each of its processes is doing and which sockets they hold, then
# stops the group, so a hung run fails with the state it hung in instead of holding a runner.
set -u
seconds=$1
shift
setsid "$@" &
pid=$!
# A cancelled job stops the group too.
trap 'kill -TERM -- "-$pid" 2>/dev/null' INT TERM
for _ in $(seq "$seconds"); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  echo "::error::$* still running after ${seconds}s; its processes and sockets follow"
  # wchan: the kernel function a sleeping process waits in.
  ps -o pid,ppid,etime,time,stat,wchan:24,args --forest -s "$pid"
  pids=$(ps -o pid= -s "$pid" | tr -d ' ' | paste -sd '|')
  ss -tanpH | grep -E "pid=($pids)," || true
  kill -TERM -- "-$pid"
  sleep 10
  kill -KILL -- "-$pid" 2>/dev/null
  wait "$pid"
  exit 124
fi
wait "$pid"
