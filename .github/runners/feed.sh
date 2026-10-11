#!/bin/bash
# Gives every empty slot of the CI boxes a single-use runner registration (a JIT config), and
# deletes the boxes' offline registrations that no slot holds. Runs where `gh` is logged in as the
# repository's owner, from a user timer every 15 s; the boxes never hold a GitHub credential.
# A JIT config registers one runner, with labels GitHub fixes when it is made, for one job.
#   feed.sh            one round
#   feed.sh --install  copies itself to ~/.local/lib/starbridge-runners and starts the timer
# See docs/ci.md.
set -uo pipefail
REPO=T0mSIlver/starbridge
# SSH host, runner name prefix, labels. starbridge-ci and starbridge-pr: the labels of the runners
# these replaced, which branches made before the change still ask for.
BOXES=(
  "sb-dell2 dell2 self-hosted,linux,x64,starbridge,trusted,heavy,docker,starbridge-ci"
  "sb-dell3 dell3 self-hosted,linux,x64,starbridge,pr,heavy,docker,starbridge-pr"
  "sb-hp hp self-hosted,linux,x64,starbridge,pr,light,docker,starbridge-pr"
)
# Bounded: a box that reboots mid-call must not hold the round. No shared SSH connection, which
# would outlive a box's reboot.
SSH=(timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=2
  -o ControlMaster=no -o ControlPath=none)
GH=(timeout 30 gh)

if [ "${1:-}" = --install ]; then
  dest=$HOME/.local/lib/starbridge-runners
  units=$HOME/.config/systemd/user
  mkdir -p "$dest" "$units"
  install -m 0755 "$0" "$dest/feed.sh"
  printf '[Unit]\nDescription=Queue runner registrations on the Starbridge CI boxes\n\n[Service]\nType=oneshot\nTimeoutStartSec=3min\nExecStart=%s\n' \
    "$dest/feed.sh" > "$units/starbridge-runner-feed.service"
  printf '[Unit]\nDescription=Queue runner registrations on the Starbridge CI boxes every 15 s\n\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=15s\nAccuracySec=1s\n\n[Install]\nWantedBy=timers.target\n' \
    > "$units/starbridge-runner-feed.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now starbridge-runner-feed.timer
  exit
fi

# One round at a time: two would hand out registrations the other then deletes as leftovers.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/starbridge-runner-feed.lock"
flock -n 9 || exit 0

held=() reached=()
for box in "${BOXES[@]}"; do
  read -r host prefix labels <<<"$box"
  status=$("${SSH[@]}" "$host" sudo /usr/local/lib/gh-runner/queue.sh status) || {
    echo "$host: unreachable" >&2
    continue
  }
  reached+=("$prefix")
  while read -r n next current; do
    # The box's word is checked: a pull request's job could take it over.
    [[ $n =~ ^[0-9]+$ ]] || continue
    held+=("$next" "$current")
    # Only a slot with no runner at all: a registration made ahead of time would show as an
    # offline runner until its slot took it.
    [ "$next" = - ] && [ "$current" = - ] || continue
    name=$prefix-$n-$(date +%s)
    args=(-f "name=$name" -F runner_group_id=1 -f work_folder=_work)
    IFS=, read -ra list <<<"$labels"
    for label in "${list[@]}"; do args+=(-f "labels[]=$label"); done
    config=$("${GH[@]}" api -X POST "repos/$REPO/actions/runners/generate-jitconfig" "${args[@]}" --jq .encoded_jit_config) || {
      echo "$name: registration failed" >&2
      continue
    }
    if printf '%s\n%s\n' "$name" "$config" | "${SSH[@]}" "$host" sudo /usr/local/lib/gh-runner/queue.sh put "$n"; then
      held+=("$name")
      echo "$name: queued"
    fi
  done <<<"$status"
done

# A registration no slot holds is left over: its box restarted, its slot was removed, or handing
# it over failed. Only the boxes reached this round, so an unreachable box keeps its queue.
[ ${#reached[@]} -gt 0 ] || exit 0
pattern="^($(IFS='|'; echo "${reached[*]}"))-[0-9]+-[0-9]+\$"
"${GH[@]}" api --paginate "repos/$REPO/actions/runners?per_page=100" \
  --jq '.runners[] | select(.status == "offline") | "\(.id) \(.name)"' |
  while read -r id name; do
    [[ $name =~ $pattern ]] || continue
    [[ " ${held[*]} " == *" $name "* ]] && continue
    # Fails when GitHub removed the runner meanwhile; the next round tries again otherwise.
    if "${GH[@]}" api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null; then echo "$name: deleted"; fi
  done
