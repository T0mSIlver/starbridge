#!/bin/bash
# The slots' registration queue, for feed.sh over SSH (as root).
#   queue.sh status   one line per slot: "<n> <next runner name or -> <current runner name or ->"
#   queue.sh put <n>  stores the registration on stdin (a name line, then the JIT config line)
set -euo pipefail
q=/run/gh-runner
case ${1:-} in
  status)
    for dir in /home/runner/slots/*/; do
      n=$(basename "$dir")
      systemctl is-enabled -q "gh-runner@$n" || continue
      next=-; cur=-
      [ -s "$q/$n.next" ] && next=$(head -1 "$q/$n.next")
      [ -s "$q/$n.current" ] && cur=$(head -1 "$q/$n.current")
      echo "$n $next $cur"
    done ;;
  put)
    n=${2:?slot}
    [[ $n =~ ^[0-9]+$ ]] && [ -d "/home/runner/slots/$n" ] || { echo "no slot $n" >&2; exit 1; }
    tmp=$(mktemp "$q/.put.XXXXXX")
    cat > "$tmp"
    chown runner:runner "$tmp"; chmod 600 "$tmp"
    mv "$tmp" "$q/$n.next" ;;
  *) echo "usage: queue.sh status | put <n>" >&2; exit 2 ;;
esac
