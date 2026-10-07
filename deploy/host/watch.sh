#!/bin/sh
# The launch watcher's reading of starbridge-1 (#782): prints one JSON object of facts and
# changes nothing. deploy/watch/watch.ts runs it over SSH every few minutes and judges it
# against the thresholds:
#   ssh deploy@starbridge.run sudo sh -s -- --since 2026-10-08T13:00:00Z < deploy/host/watch.sh
# --since   count log lines since then (the previous run); default 5 minutes ago
# --conns   name an address holding over this many connections to Caddy now (default 200)
# --over    name an address that made at least this many /v1 requests in a minute (default 2000)
# Addresses are read at this instant from `ss` and the server's memory (its loopback port 8081), and only
# those past a threshold or refused with 429 are named: nothing here is written to disk.
set -eu
since=$(date -u -d '-5 min' +%Y-%m-%dT%H:%M:%SZ) conns=200 over=2000
while [ $# -gt 0 ]; do
  case $1 in
  --since) since=$2; shift 2 ;;
  --conns) conns=$2; shift 2 ;;
  --over) over=$2; shift 2 ;;
  *) echo "watch.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
compose="docker compose -p starbridge -f /opt/starbridge/deploy/compose.yaml"
# Logs are read up to this instant, which the reading names, so the next run starts there.
until=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# CPU steal over 2 seconds, in percent of all CPU time: /proc/stat's 8th value is steal.
cpu() { awk '/^cpu /{t=0; for (i=2; i<=NF; i++) t+=$i; print t, $9}' /proc/stat; }
set -- $(cpu); t0=$1 s0=$2
sleep 2
set -- $(cpu); t1=$1 s1=$2
steal=$(awk -v t="$((t1 - t0))" -v s="$((s1 - s0))" 'BEGIN{printf "%.1f", (t > 0 ? 100 * s / t : 0)}')

read -r load1 load5 load15 _ < /proc/loadavg
mem_total=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
disk_free=$(df -B1 --output=avail / | tail -1 | tr -d ' ')

# Memory and CPU per container, and restarts and OOM kills since each started.
stats=$(docker stats --no-stream --format '{{json .}}' | jq -sc '
  def mb: capture("^(?<n>[0-9.]+)(?<u>[A-Za-z]+)") | (.n|tonumber) *
    ({"B":1/1048576,"KiB":1/1024,"kB":1/1000,"MiB":1,"MB":1,"GiB":1024,"GB":1000}[.u] // 1);
  map({key: .Name, value: {memMB: (.MemUsage | split(" / ")[0] | mb | floor), cpu: (.CPUPerc | rtrimstr("%") | tonumber)}}) | from_entries')
states=$(docker inspect -f '{{json .}}' $(docker ps -aq) | jq -sc '
  map({key: (.Name | ltrimstr("/")), value: {restarts: .RestartCount, oomKilled: .State.OOMKilled, running: .State.Running, startedAt: .State.StartedAt}}) | from_entries')
oom=$(journalctl -k -q --since "$since" --until "$until" 2>/dev/null | grep -ciE 'oom-kill|out of memory' || true)

# The server's log since the last run: its minute lines of refusals summed, and error lines.
logs=$($compose logs --no-log-prefix --since "$since" --until "$until" server 2>/dev/null || true)
count() { printf '%s\n' "$logs" | grep -cE "$1" || true; }
refusals=$(printf '%s\n' "$logs" | sed -n 's/^refusals //p' | jq -sc '
  {counts: (map(.counts | to_entries[]) | group_by(.key) | map({key: .[0].key, value: (map(.value) | add)}) | from_entries),
   accounts: (map(.accounts | to_entries[]) | group_by(.key) | map({key: .[0].key, value: (map(.value) | add)}) | sort_by(-.value) | .[:5] | from_entries)}')
caddy_errors=$($compose logs --no-log-prefix --since "$since" --until "$until" caddy 2>/dev/null | grep -c '"logger":"http.log.error' || true)

# The database and its WAL, in the server's volume.
vol=$(docker volume inspect -f '{{.Mountpoint}}' starbridge_data)
db_bytes=$(stat -c %s "$vol/starbridge.db" "$vol/starbridge.db-wal" 2>/dev/null | awk '{s+=$1} END{print s+0}')

# Connections at this instant. Caddy runs on the host network, so clients are peers of :443
# and the server's long-polls are Caddy's connections to 127.0.0.1:8080.
# Caddy's own; docker-proxy's onward connections to the container go to its address instead.
to_server=$(ss -Htn state established dst 127.0.0.1:8080 | wc -l)
# Per address, an IPv6 client counted as its /64, as the rate limits count it.
# Addresses already blocked (host/switch.sh) are not named again.
conn_json=$(ss -Htn state established '( sport = :443 )' | python3 -c '
import collections, ipaddress, json, sys
n = collections.Counter()
for line in sys.stdin:
    peer = line.split()[3].rsplit(":", 1)[0].strip("[]")
    a = ipaddress.ip_address(peer)
    a = getattr(a, "ipv4_mapped", None) or a
    n[str(a) if a.version == 4 else str(ipaddress.ip_network(f"{a}/64", strict=False))] += 1
c = int(sys.argv[1])
try:
    blocked = [ipaddress.ip_network(l.strip()) for l in open(sys.argv[2]) if l.strip()]
except OSError:
    blocked = []
def free(k):
    net = ipaddress.ip_network(k)
    return not any(net.version == b.version and net.subnet_of(b) for b in blocked)
print(json.dumps({"total": sum(n.values()), "addresses": len(n), "busiest": max(n.values(), default=0),
                  "named": {k: v for k, v in n.most_common(40) if v > c and free(k)}}))
' "$conns" /etc/starbridge/caddy/denylist)
addresses=$($compose exec -T server bun -e "
  const r = await fetch('http://127.0.0.1:8081/watch?over=$over', { signal: AbortSignal.timeout(5000) });
  if (!r.ok) process.exit(1);
  console.log(await r.text());" 2>/dev/null || echo null)

top=$($compose exec -T server bun server.js top 5 --json 2>/dev/null || echo null)

jq -nc \
  --arg at "$until" --arg since "$since" \
  --argjson load "[$load1,$load5,$load15]" --argjson steal "$steal" \
  --argjson memTotalMB "$mem_total" --argjson memAvailMB "$mem_avail" --argjson diskFree "$disk_free" \
  --argjson containers "$stats" --argjson states "$states" --argjson oom "$oom" \
  --argjson refusals "$refusals" --argjson caddyErrors "$caddy_errors" \
  --argjson stackTraces "$(count '^([A-Za-z]*Error|error): ')" --argjson sqlite "$(count 'SQLITE_')" \
  --argjson diskFull "$(count '^disk full')" --argjson pushQueueFull "$(count '^push queue full')" \
  --argjson pushFailed "$(count '^push (to [a-z]+ )?failed')" --argjson github "$(count '^GitHub sign-in:')" \
  --argjson dbBytes "$db_bytes" --argjson connections "$conn_json" --argjson toServer "$to_server" \
  --argjson addresses "$addresses" --argjson top "$top" \
  '{at: $at, since: $since, load: $load, steal: $steal, memTotalMB: $memTotalMB, memUsedMB: ($memTotalMB - $memAvailMB),
    diskFree: $diskFree, containers: ($states * $containers), kernelOom: $oom,
    logs: {refusals: $refusals, stackTraces: $stackTraces, sqlite: $sqlite, diskFull: $diskFull,
      pushQueueFull: $pushQueueFull, pushFailed: $pushFailed, githubSignIn: $github, caddyErrors: $caddyErrors},
    dbBytes: $dbBytes, connections: ($connections + {toServer: $toServer}), addresses: $addresses, top: $top}'
