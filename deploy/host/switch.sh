#!/bin/sh
# The launch's response switches (#783), run as root on starbridge-1; deploy/switch.sh runs it
# from the operator's machine. Each one is undone by its pair, and each change is a line in
# /var/log/starbridge/switches.log: when, who (the sudo user), what.
#
#   switch.sh block ADDRESS|CIDR     refuse it at Caddy with a 403, by a reload: no restart
#   switch.sh unblock ADDRESS|CIDR
#   switch.sh blocked                list what is blocked
#   switch.sh log                    the switch log
#   switch.sh signups|suspend|unsuspend|limits ...
#                                    the server's own switches, `bun server.js <args>` (#784-#786)
#
# The denylist holds one address or range per line until it is unblocked; the privacy page
# says so. An IPv6 address is blocked as its /64, as the rate limits count it.
set -eu
# Overridable only for tests on a local stack.
dir=${DENYLIST_DIR:-/etc/starbridge/caddy}
list=$dir/denylist
log=${SWITCH_LOG:-/var/log/starbridge/switches.log}
caddyfile=${CADDYFILE:-/opt/starbridge/deploy/Caddyfile}
admin=${CADDY_ADMIN:-http://127.0.0.1:2019}
compose="docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml"

note() {
  mkdir -p "$(dirname "$log")"
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SUDO_USER:-root}" "$*" >> "$log"
}

# The address or range as Caddy matches it, or exit 2.
range() {
  python3 -c '
import ipaddress, sys
try:
    n = ipaddress.ip_network(sys.argv[1], strict=False)
except ValueError:
    sys.exit("not an address or CIDR: " + sys.argv[1])
if n.version == 6 and n.prefixlen > 64:
    n = n.supernet(new_prefix=64)
if n.prefixlen < (8 if n.version == 4 else 32):
    sys.exit("refusing a range that wide: " + str(n))
print(n)
' "$1" || exit 2
}

# Writes the snippet the Caddyfile imports from the list, and loads the Caddyfile into the
# running Caddy through its admin API, as a deploy does (apply.sh). A load Caddy refuses puts
# the previous list back.
apply() {
  {
    echo "# Made by deploy/host/switch.sh from $list; edit that list, not this file."
    if [ -s "$list" ]; then
      printf '@denied client_ip'
      while read -r entry; do printf ' %s' "$entry"; done < "$list"
      printf '\n'
      echo 'handle @denied {'
      echo '	respond "This address is blocked for abuse of starbridge.run. If that is a mistake, write to abuse@starbridge.run." 403'
      echo '}'
    fi
  } > "$dir/denylist.caddy.tmp"
  mv "$dir/denylist.caddy.tmp" "$dir/denylist.caddy"
  [ "${1:-}" = "--no-load" ] && return 0
  curl -fsS -X POST -H 'Content-Type: text/caddyfile' \
    --data-binary "@$caddyfile" "$admin/load"
}

case ${1:-} in
block | unblock)
  [ $# -eq 2 ] || { echo "usage: switch.sh $1 ADDRESS|CIDR" >&2; exit 2; }
  r=$(range "$2")
  umask 077
  mkdir -p "$dir"
  touch "$list"
  cp "$list" "$list.prev"
  if [ "$1" = block ]; then
    grep -qxF "$r" "$list" && { echo "$r is already blocked"; exit 0; }
    echo "$r" >> "$list"
  else
    grep -qxF "$r" "$list" || { echo "$r is not blocked" >&2; exit 1; }
    grep -vxF "$r" "$list.prev" > "$list" || true
  fi
  if ! apply; then
    mv "$list.prev" "$list"
    apply --no-load
    echo "Caddy refused the new config; the denylist is as it was" >&2
    exit 1
  fi
  note "$1 $r"
  echo "${1}ed $r"
  ;;
blocked) cat "$list" 2>/dev/null || true ;;
log) cat "$log" 2>/dev/null || true ;;
--regenerate)
  # apply.sh, before it loads the Caddyfile: the snippet exists even with no list.
  mkdir -p "$dir"
  touch "$list"
  apply --no-load
  ;;
"") sed -n '2,14p' "$0" >&2; exit 2 ;;
signups | suspend | unsuspend | limits)
  out=$($compose exec -T server bun server.js "$@")
  echo "$out"
  note "$*"
  ;;
*) echo "switch.sh: unknown switch $1" >&2; exit 2 ;;
esac
