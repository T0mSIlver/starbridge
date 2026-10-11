#!/bin/bash
# One runner slot (the gh-runner@<n> unit): runs one job at a time, each on a single-use runner
# registration that feed.sh leaves in /run/gh-runner/<n>.next, and wipes what the job left before
# taking the next.
set -u
n=$1
dir=/home/runner/slots/$n
q=/run/gh-runner

# Everything a job leaves goes except the tool cache, _work/_tool: Node, Bun, pnpm's store and
# Firefox, which jobs look up by version or hash. A container can leave root's files behind, which
# only a container can delete.
wipe() {
  local keep=_tool
  [ "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -ge 80 ] && keep=
  mkdir -p "$dir/_work"
  find "$dir/_work" -mindepth 1 -maxdepth 1 ! -name "${keep:-.}" -exec rm -rf {} + 2>/dev/null ||
    docker run --rm -v "$dir/_work:/w" busybox find /w -mindepth 1 -maxdepth 1 ! -name "${keep:-.}" -exec rm -rf {} +
  rm -rf "$dir/home" "$dir/tmp" "$dir/.runner" "$dir/.credentials" "$dir/.credentials_rsaparams" 2>/dev/null ||
    docker run --rm -v "$dir:/s" busybox rm -rf /s/home /s/tmp
  mkdir -p "$dir/home" "$dir/tmp"
  find "$dir/_diag" -type f -mtime +3 -delete 2>/dev/null
}

while true; do
  wipe
  rm -f "$q/$n.current"
  until [ -s "$q/$n.next" ]; do sleep 2; done
  mv "$q/$n.next" "$q/$n.current"
  { read -r name; read -r config; } < "$q/$n.current"
  echo "slot $n: runner $name"
  # A home and temp folder of its own, so jobs side by side on one box share neither.
  HOME=$dir/home TMPDIR=$dir/tmp "$dir/run.sh" --jitconfig "$config"
  echo "slot $n: runner $name exited $?"
done
