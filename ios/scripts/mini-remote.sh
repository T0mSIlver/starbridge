#!/bin/bash
# Runs on the Mac mini, from mini.sh (see ios/README.md, "Build on the Mac mini"). Never run it
# by hand: mini.sh holds the lock and has synced the tree this script builds.
#
#   mini-remote.sh build KEY TIMEOUT HOLDER RAW KEEPSIM ACTION [xcodebuild args...]
#   mini-remote.sh status
#   mini-remote.sh clean KEY
#
# Everything lives under ~/sb-cache: src/KEY (the synced tree), dd/KEY (DerivedData), spm (one
# SwiftPM clone cache for all keys), sims/KEY (the simulator's UDID), used/KEY (last use), bin
# (XcodeGen), logs/KEY.log (the last run's full output) and locks.
set -u
ROOT="$HOME/sb-cache"
KEEP="${SB_MINI_KEEP:-8}"          # most keys kept
MAX_DAYS="${SB_MINI_MAX_DAYS:-14}" # days unused before a key goes
MAX_GB="${SB_MINI_MAX_GB:-20}"     # src + dd of all keys together
DEVICE="${SB_MINI_DEVICE:-iPhone 17}"
XCODEGEN_VERSION=2.44.1
XCODEGEN_SHA=a2e905fb68446e9bb4008cdfe2e13e3f176d0cbcca828b71770f8e53fca91b73

say() { echo "mini.sh: $*" >&2; }

# Runs "$@" with the key's lock held without waiting; false when a build of that key runs.
with_key_lock() {
  local key=$1; shift
  perl -MFcntl=:flock -e 'open(F, ">>", shift) or exit 1; flock(F, LOCK_EX|LOCK_NB) or exit 1; exit(system(@ARGV) ? 1 : 0)' \
    "$ROOT/locks/key-$key" "$@"
}

remove_key() {
  local key=$1 udid
  with_key_lock "$key" bash -c '
    ROOT=$1; key=$2
    if [ -f "$ROOT/sims/$key" ]; then
      udid=$(cat "$ROOT/sims/$key")
      xcrun simctl shutdown "$udid" 2>/dev/null; xcrun simctl delete "$udid" 2>/dev/null
    fi
    rm -rf "$ROOT/src/$key" "$ROOT/dd/$key" "$ROOT/sims/$key" "$ROOT/used/$key" "$ROOT/logs/$key.log"
  ' _ "$ROOT" "$key" && say "pruned $key"
}

# Keys newest first, by last use.
keys_by_use() { ls -t "$ROOT/used" 2>/dev/null; }

key_kb() { du -sk "$ROOT/src/$1" "$ROOT/dd/$1" 2>/dev/null | awk '{s+=$1} END {print s+0}'; }

prune() {
  local cur=$1 key n=0 now age kb total=0
  now=$(date +%s)
  for key in $(keys_by_use); do
    n=$((n + 1))
    [ "$key" = "$cur" ] && continue
    age=$(( (now - $(stat -f %m "$ROOT/used/$key")) / 86400 ))
    if [ "$n" -gt "$KEEP" ] || [ "$age" -ge "$MAX_DAYS" ]; then remove_key "$key"; fi
  done
  for key in $(keys_by_use); do total=$((total + $(key_kb "$key"))); done
  # Still over the cap: the least recently used keys go, never this run's.
  for key in $(keys_by_use | sed '1!G;h;$!d'); do
    [ "$total" -le $((MAX_GB * 1048576)) ] && break
    [ "$key" = "$cur" ] && continue
    kb=$(key_kb "$key")
    remove_key "$key" && total=$((total - kb))
  done
}

xcodegen_path() {
  local bin="$ROOT/bin/xcodegen/bin/xcodegen" tmp
  if [ ! -x "$bin" ]; then
    say "installing XcodeGen $XCODEGEN_VERSION under $ROOT/bin"
    tmp=$(mktemp -d "$ROOT/bin.XXXXXX") || return 1
    curl -fsSL -o "$tmp/x.zip" "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip" || return 1
    echo "$XCODEGEN_SHA  $tmp/x.zip" | shasum -a 256 -c >/dev/null || { say "XcodeGen's checksum differs"; return 1; }
    unzip -q "$tmp/x.zip" -d "$tmp" || return 1
    mkdir -p "$ROOT/bin" && rm -rf "$ROOT/bin/xcodegen" && mv "$tmp/xcodegen" "$ROOT/bin/xcodegen"
    rm -rf "$tmp"
  fi
  echo "$bin"
}

# This key's simulator: made once, erased before each run so a test starts from a clean device.
simulator() {
  local key=$1 keep=$2 udid=""
  [ -f "$ROOT/sims/$key" ] && udid=$(cat "$ROOT/sims/$key")
  if [ -n "$udid" ] && ! xcrun simctl list devices -j | jq -e --arg u "$udid" '[.devices[][] | select(.udid == $u)] | length > 0' >/dev/null; then
    udid=""
  fi
  if [ -z "$udid" ]; then
    udid=$(xcrun simctl create "sb-$key" "$DEVICE") || { say "cannot create a '$DEVICE' simulator (SB_MINI_DEVICE)"; return 1; }
    echo "$udid" > "$ROOT/sims/$key"
    say "created simulator sb-$key ($udid)"
  elif [ "$keep" != 1 ]; then
    xcrun simctl shutdown "$udid" 2>/dev/null
    xcrun simctl erase "$udid" || return 1
  fi
  echo "$udid"
}

# Runs "$@" in its own process group, and kills the group on the time limit, on SIGHUP or SIGTERM,
# on a closed output pipe (ssh dropped), and when the lock holder (a process on this machine whose
# pid is HOLDER) is gone: no xcodebuild outlives its lock.
run_limited() {
  perl -MPOSIX -e '
    my ($limit, $holder) = (shift, shift); my $pid = fork;
    if (!$pid) { setpgid(0, 0); exec @ARGV or exit 127 }
    my ($why, $rc) = ("", 0);
    my $kill = sub { kill "TERM", -$pid; sleep 3; kill "KILL", -$pid };
    $SIG{$_} = sub { $why ||= "dropped"; $kill->() } for qw(HUP TERM PIPE INT);
    my $end = time + $limit;
    while (1) {
      if (waitpid($pid, WNOHANG) == $pid) { $rc = $? & 127 ? 128 + ($? & 127) : $? >> 8; last }
      if (time >= $end) { $why = "timeout"; $kill->() ; waitpid($pid, 0); last }
      if (!kill(0, $holder)) { $why = "lock lost"; $kill->(); waitpid($pid, 0); last }
      select(undef, undef, undef, 1);
    }
    print STDERR "mini.sh: xcodebuild killed after ${limit}s (--timeout)\n" if $why eq "timeout";
    print STDERR "mini.sh: xcodebuild killed: the lock holder is gone\n" if $why eq "lock lost";
    exit($why eq "timeout" ? 124 : $why ? 143 : $rc);
  ' "$@"
}

cmd_build() {
  local key=$1 limit=$2 holder=$3 raw=$4 keepsim=$5 action=$6; shift 6
  local src="$ROOT/src/$key" xg udid rc t0=$SECONDS
  mkdir -p "$ROOT"/{dd,spm,sims,used,logs,locks} || return 1
  touch "$ROOT/used/$key"
  xg=$(xcodegen_path) || return 1
  cd "$src/ios" || { say "nothing synced at $src"; return 1; }
  "$xg" generate --quiet || return 1
  udid=$(simulator "$key" "$keepsim") || return 1
  say "$action on sb-$key ($udid), DerivedData $(du -sh "$ROOT/dd/$key" 2>/dev/null | cut -f1) kept, full log $ROOT/logs/$key.log"
  if [ "$raw" != 1 ]; then
    filter() {
      awk '/error:|warning: .*(deprecated|unavailable)|Test Case .*failed|Testing failed|xcodebuild: error/ { print; fflush() }
           /Executed [0-9]+ tests?, with/ { last = $0 }
           /\*\* (TEST|BUILD)/ { if (last != "") print last; last = ""; print; fflush() }'
    }
  else
    filter() { cat; }
  fi
  : > "$ROOT/logs/$key.log"
  run_limited "$limit" "$holder" xcodebuild -project Starbridge.xcodeproj -scheme Starbridge \
    -destination "id=$udid" -derivedDataPath "$ROOT/dd/$key" -clonedSourcePackagesDirPath "$ROOT/spm" \
    "$action" "$@" 2>&1 | tee "$ROOT/logs/$key.log" | filter
  rc=${PIPESTATUS[0]}
  xcrun simctl shutdown "$udid" 2>/dev/null
  say "xcodebuild exited $rc after $((SECONDS - t0))s"
  prune "$key"
  return "$rc"
}

cmd_status() {
  local slots=${SB_MINI_SLOTS:-2} i busy=0 key
  mkdir -p "$ROOT"/locks
  for i in $(seq 1 "$slots"); do
    perl -MFcntl=:flock -e 'open(F, ">>", shift); exit(flock(F, LOCK_EX|LOCK_NB) ? 0 : 1)' "$ROOT/locks/slot-$i" || busy=$((busy + 1))
  done
  echo "build slots: $busy of $slots busy"
  printf '%-34s %8s  %s\n' KEY SIZE "LAST USED"
  for key in $(keys_by_use); do
    printf '%-34s %6dMB  %s\n' "$key" $(( $(key_kb "$key") / 1024 )) "$(stat -f %Sm -t '%Y-%m-%d %H:%M' "$ROOT/used/$key")"
  done
  echo "SwiftPM cache: $(du -sh "$ROOT/spm" 2>/dev/null | cut -f1). Prune: newest $KEEP keys, under ${MAX_DAYS} days, $MAX_GB GB of src + dd."
}

case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  status) cmd_status ;;
  clean) remove_key "$2" || say "$2: nothing to clean, or a build of it runs" ;;
  *) echo "usage: see ios/scripts/mini.sh" >&2; exit 2 ;;
esac
