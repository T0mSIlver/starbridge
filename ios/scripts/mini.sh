#!/usr/bin/env bash
# Builds and tests the iPhone app on the Mac mini, from the dev box: the one way agents do it.
# ios/README.md, "Build on the Mac mini", says what it keeps and why.
#
#   ios/scripts/mini.sh [options] ACTION [xcodebuild arguments...]
#   ios/scripts/mini.sh status | clean
#
# ACTION is what xcodebuild takes: test, build, build-for-testing, test-without-building.
#   --key K        cache key (default: this worktree's name and a hash of its path)
#   --timeout S    kill xcodebuild after S seconds (default 1500)
#   --reverse P    forward the mini's port P to this machine's, for a test server
#                  (TEST_RUNNER_* variables here reach the tests)
#   --raw          show xcodebuild's whole output, not only errors and test results
#   --keep-sim     do not erase the simulator first
#   SB_MINI_HOST (default mini), SB_MINI_SLOTS (default 2) and the SB_MINI_* limits of
#   mini-remote.sh apply.
set -uo pipefail

host=${SB_MINI_HOST:-mini}
slots=${SB_MINI_SLOTS:-2}
timeout=1500 raw=0 keepsim=0 key="" reverse=""

while [ $# -gt 0 ]; do
  case $1 in
    --key) key=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --reverse) reverse=$2; shift 2 ;;
    --raw) raw=1; shift ;;
    --keep-sim) keepsim=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) break ;;
  esac
done
action=${1:-}
[ -n "$action" ] || { sed -n '2,19p' "$0" >&2; exit 2; }
shift

script_dir=$(cd "$(dirname "$0")" && pwd)
remote_script=$script_dir/mini-remote.sh
repo=$(git -C "$script_dir" rev-parse --show-toplevel) || exit 1

q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
say() { echo "mini.sh: $*" >&2; }

if [ -z "$key" ]; then
  base=$(basename "$repo" | tr -c 'A-Za-z0-9._\n-' '_' | cut -c1-24)
  key=$base-$(printf %s "$repo" | sha1sum | cut -c1-8)
fi

# status and clean need no tree; the script comes over standard input (nothing reads it after).
case $action in
  status) exec ssh "$host" bash -s -- status < "$remote_script" ;;
  clean) exec ssh "$host" bash -s -- clean "$(q "$key")" < "$remote_script" ;;
esac

# The lock holder: waits for this key's lock and a free build slot, says so while it waits, prints
# LOCKED, then holds both until its input closes (we exit, or ssh drops), with a lease that ends it
# anyway. Locks are flocks on files under ~/sb-cache/locks, which the kernel releases with the process.
holder_perl='
  use Fcntl qw(:flock); $| = 1;
  my ($key, $slots, $lease) = @ARGV;
  system("mkdir", "-p", "$ENV{HOME}/sb-cache/locks", "$ENV{HOME}/sb-cache/src");
  my $dir = "$ENV{HOME}/sb-cache/locks";
  open(K, ">>", "$dir/key-$key") or die "lock: $!";
  my $said = 0;
  until (flock(K, LOCK_EX | LOCK_NB)) {
    print "mini.sh: another run of this worktree ($key) holds the cache, waiting\n" unless $said++;
    sleep 3;
  }
  my ($got, $last) = (0, 0);
  until ($got) {
    for my $i (1 .. $slots) {
      open(my $s, ">>", "$dir/slot-$i") or die "lock: $!";
      if (flock($s, LOCK_EX | LOCK_NB)) { $got = $s; last }
      close $s;
    }
    last if $got;
    if (time - $last >= 30) { print "mini.sh: all $slots build slots on the Mac mini are busy, waiting\n"; $last = time }
    sleep 2;
  }
  alarm $lease;
  print "LOCKED $$\n";
  1 while sysread(STDIN, my $b, 4096);
'

t_start=$SECONDS
coproc LOCK { exec ssh -o ServerAliveInterval=15 "$host" perl -e "$(q "$holder_perl")" "$(q "$key")" "$slots" "$((timeout + 900))"; }
lock_pid=$LOCK_PID
lock_in=${LOCK[1]} lock_out=${LOCK[0]}
trap 'kill "$lock_pid" 2>/dev/null' EXIT
trap 'exit 130' INT TERM HUP

locked=0
while IFS= read -r line <&"$lock_out"; do
  case $line in LOCKED\ *) locked=1; holder=${line#LOCKED }; break ;; esac
  echo "$line" >&2
done
if [ $locked != 1 ]; then say "could not reach $host or take the lock"; exit 1; fi
t_locked=$SECONDS

# Only what a build and its tests read, not the .build of the Swift package or generated files.
rsync -a --delete \
  --exclude=.build --exclude=.DS_Store --exclude=xcuserdata \
  --exclude=/ios/Starbridge.xcodeproj --exclude=/ios/build \
  --exclude=/ios/Starbridge/Info.plist --exclude=/ios/Starbridge/Starbridge.entitlements \
  --exclude=/ios/Notifications/Info.plist --exclude=/ios/Notifications/StarbridgeNotifications.entitlements \
  --include=/ios/ --include='/ios/***' \
  --include=/packages/ --include=/packages/protocol/ --include=/packages/protocol/vectors/ --include='/packages/protocol/vectors/***' \
  --exclude='*' \
  "$repo/" "$host:sb-cache/src/$key/" || { say "rsync failed"; exit 1; }
t_synced=$SECONDS

# TEST_RUNNER_* variables reach the test process; pass them on.
envs=()
while IFS='=' read -r name value; do
  case $name in TEST_RUNNER_*) envs+=("$(q "$name=$value")") ;; esac
done < <(env)

ssh_opts=(-o ServerAliveInterval=15)
if [ -n "$reverse" ]; then
  # A -R tunnel on the shared connection outlives this script; a connection of its own does not.
  ssh_opts+=(-o ControlMaster=no -o ControlPath=none -R "$reverse:localhost:$reverse")
fi
args=""
for a in "$@"; do args+=" $(q "$a")"; done

ssh "${ssh_opts[@]}" "$host" "env ${envs[*]:-} bash $(q "sb-cache/src/$key/ios/scripts/mini-remote.sh") build $(q "$key") $timeout $holder $raw $keepsim $(q "$action")$args" < /dev/null
rc=$?
say "lock wait $((t_locked - t_start))s, sync $((t_synced - t_locked))s, build and test $((SECONDS - t_synced))s, exit $rc (key $key)"
exit "$rc"
