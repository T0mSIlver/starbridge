#!/bin/bash
# deploy/test/trace.sh BEFORE [AFTER]: what the deploy scripts of two commits would run on each box,
# and the diff. AFTER defaults to the working tree. For prod and staging, it runs each version's
# apply.sh as a first deploy, then the deploy command it installed on a newer commit, then a
# rollback, and again with Docker failing the first `compose up` as in #1663; then server-env.sh
# and push-secrets.sh. Every command that reaches past the box's files (docker, git, curl, ssh,
# systemctl and the like) is a stub that logs its arguments; the box's own folders are a copy of
# /etc and empty /opt, /usr/local/sbin, /run, /var/lib, /var/backups and /var/log in a throwaway
# mount namespace, so nothing touches this machine or a real box. Needs unprivileged user namespaces and overlayfs (Linux). It prints the
# diff of each run's commands, output and resulting files; empty means the same.
#   deploy/test/trace.sh origin/main
# The deploy command and its mixes with the other version's tree (a deploy right after the change,
# a rollback to before it) run too: an old command on a new tree, and a new command on an old one.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: deploy/test/trace.sh BEFORE [AFTER]" >&2; exit 2; }
top=$(git rev-parse --show-toplevel)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
tree() {
  mkdir -p "$W/trees/$1"
  if [ "$2" = . ]; then
    cp -r "$top/deploy" "$W/trees/$1/"
  else
    git -C "$top" archive "$2" deploy | tar -x -C "$W/trees/$1"
  fi
}
tree before "$1"
tree after "${2:-.}"
R0=1111111111111111111111111111111111111111
R1=2222222222222222222222222222222222222222

# The stubs: each logs its name and arguments to $TRACE, then answers as the box would.
mkdir -p "$W/stubs"
stub() { { echo '#!/bin/bash'; echo 'printf "%s\n" "$(basename "$0") $*" >> "$TRACE"'; cat; } > "$W/stubs/$1"; chmod +x "$W/stubs/$1"; }
for c in systemctl apt-get chown flock scp sb-check-now; do stub $c < /dev/null; done
stub sleep < /dev/null
stub date <<'EOF'
echo 20261018T000000
EOF
stub timeout <<'EOF'
shift
exec "$@"
EOF
stub install <<'EOF'
exec /usr/bin/install "$@"
EOF
stub ssh <<'EOF'
[ -t 0 ] || tar -tf - 2>/dev/null | sort | sed 's/^/  stdin: /' >> "$TRACE"
EOF
stub sqlite3 <<'EOF'
case "$*" in
*user_version*) echo 41 ;;
*integrity_check*) echo ok ;;
*"VACUUM INTO"*) f=${2#VACUUM INTO \'}; touch "${f%\'}" ;;
esac
EOF
stub git <<'EOF'
[ "$1" = -C ] && shift 2
case $1 in
init) mkdir -p "${@: -1}" ;;
rev-parse) echo "$R1" ;;
archive) tar -C "$TREES/$TREE" -cf - . ;;
esac
EOF
stub docker <<'EOF'
a="$*"
case $a in
*" up "*)
  if [ -n "${FAIL_UP_ONCE:-}" ] && [ ! -e "$STATE/up-failed" ]; then
    touch "$STATE/up-failed"
    echo "Error response from daemon: removal of container 0123456789ab is already in progress" >&2
    exit 1
  fi ;;
*" ps -q --status running web-a") echo 0a1b2c3d ;;
*"schema check") echo ok ;;
*"server.js schema") echo 42 ;;
"container inspect "*) exit 1 ;;
"volume inspect "*) echo /var/lib/test-volumes/$5 ;;
"image inspect -f "*)
  n=${*: -1}
  case $n in *server*) d=a ;; *) d=b ;; esac
  echo "${n%:*}@sha256:$(printf "%064d" 0 | tr 0 $d)" ;;
"image inspect starbridge-caddy:"*) exit 1 ;;
"image ls ghcr.io/"*) for i in 1 2 3 4 5 6 7; do printf '2026-10-0%s\t%s:tag%s\n' $i "$3" $i; done ;;
"image ls starbridge-caddy "*) printf 'starbridge-caddy:latest\nstarbridge-caddy:0123456789abcdef\n' ;;
esac
exit 0
EOF
stub curl <<'EOF'
out= url=
while [ $# -gt 0 ]; do
  case $1 in
  -o) out=$2; shift 2 ;;
  -H | -X | --retry | --retry-delay | --max-time | --unix-socket | -D | --data-binary | -d) shift 2 ;;
  -*) shift ;;
  *) url=$1; shift ;;
  esac
done
digest() { printf "%064d" 0 | tr 0 $1; }
body=
case $url in
*/actions/workflows/ci.yml/runs*)
  sha=${url#*head_sha=}; sha=${sha%%&*}
  body=$(jq -nc --arg r "$sha" '{workflow_runs: [{path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: $r, conclusion: "success", head_repository: {full_name: "T0mSIlver/starbridge"}}]}') ;;
*/commits/*/statuses*)
  sha=${url#*/commits/}; echo "${sha%%/*}" > "$STATE/rev"
  body='[{"context":"staging","state":"success","target_url":"https://github.com/T0mSIlver/starbridge/actions/runs/123"}]' ;;
*/actions/runs/123/jobs*)
  body=$(jq -nc --arg r "$(cat "$STATE/rev")" --arg s "$(digest a)" --arg w "$(digest b)" '{jobs: [{name: "staging", steps: [
    {name: ("Staging ran server@sha256:" + $s), conclusion: "success"}, {name: ("Staging ran web@sha256:" + $w), conclusion: "success"},
    {name: ("Staging passed " + $r), conclusion: "success"}]}]}') ;;
*/actions/runs/123)
  body='{"path":".github/workflows/deploy.yml","event":"workflow_run","head_branch":"main","head_repository":{"full_name":"T0mSIlver/starbridge"}}' ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; elif [ -n "$body" ]; then printf '%s' "$body"; fi
exit 0
EOF

# Inside the namespace: copies of the box's folders, its secrets, and the steps.
cat > "$W/inner.sh" <<'EOF'
set -u
# A copy of /etc this namespace's root owns, and empty folders for the rest.
mount --bind "$ETC" /etc || exit 1
for d in /opt /usr/local/sbin /run /var/lib /var/backups /var/log; do mount -t tmpfs tmpfs "$d" || exit 1; done
P=$PROJECT
mkdir -p /etc/$P/secrets /opt/$P /var/lib/test-volumes/${P}_data /etc/systemd/system /usr/local/sbin
echo $R0 > /opt/$P/REVISION
touch /var/lib/test-volumes/${P}_data/starbridge.db
s=/etc/$P/secrets
if [ "$BOX" = prod ]; then
  for f in github-oauth-client-secret vapid-public-key vapid-private-key apns-key-id apple-signin-key-id; do echo "fake-$f" > $s/$f; done
  printf -- '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n' | tee $s/apns-key.p8 > $s/apple-signin-key.p8
  echo '{"project_id":"p","client_email":"e@p","private_key":"-----BEGIN-----\nfake\n-----END-----\n"}' > $s/fcm-service-account.json
  echo '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234' > /etc/starbridge/secrets/stats-password-hash
else
  for f in github-oauth-client-id github-oauth-client-secret vapid-public-key vapid-private-key owner-token; do echo "fake-$f" > $s/$f; done
  echo '1 2 3' > $s/signup-github-ids
  mkdir -p /etc/starbridge-demo $ROUND_TRIP_DIR
  echo x > /etc/starbridge-demo/demo.env
  echo done > $ROUND_TRIP_DIR/setup-state
  cp "$STUBS/sb-check-now" /usr/local/sbin/sb-check-now
fi
step() { echo "== $*" | tee -a "$TRACE"; }
step "first deploy: $APPLY of $CMDVER, as deploy.sh or the deploy before"
rm -rf /opt/$P/deploy && cp -r "$TREES/$CMDVER/deploy" /opt/$P/
REVISION=$R0 DEPLOY_LOGS=stderr /opt/$P/$APPLY 2>&1
echo "exit $?"
step "deploy $R1 with the command it installed, unpacking $TREE"
/usr/local/sbin/$COMMAND $R1 2>&1
echo "exit $?"
step "roll back to $R0"
/usr/local/sbin/$COMMAND --rollback $R0 2>&1
echo "exit $?"
cp /usr/local/sbin/$COMMAND "$RUN/command"
# What the run left on the box.
for d in /etc/$P /etc/starbridge-demo /etc/systemd/system /var/lib/$P /var/backups /usr/local/sbin /opt/$P/REVISION /opt/$P/deploy/.env; do
  [ -e "$d" ] || continue
  find "$d" -newer "$RUN/start" \( -type f -o -type d \) | sort | while read -r f; do
    if [ -d "$f" ]; then echo "$f $(stat -c %a "$f")/"
    elif [ "$f" = /usr/local/sbin/$COMMAND ]; then echo "$f $(stat -c %a "$f") (the deploy command)"
    elif [ "${f##*/}" = stats-auth ]; then echo "$f $(stat -c %a "$f") $(cut -d' ' -f1-3 "$f")"
    # Passwords made afresh on a box without them (host/umami-env.sh).
    elif [ "${f##*/}" = umami.env ] || [ "${f##*/}" = umami-db.env ]; then echo "$f $(stat -c %a "$f") (random)"
    else echo "$f $(stat -c %a "$f") $(sha256sum < "$f" | cut -c1-16)"; fi
  done
done > "$RUN/files"
cp /etc/$P/server.env "$RUN/server.env"
EOF

run() { # NAME BOX CMDVER TREE [FAIL_UP_ONCE]
  local name=$1 box=$2 cmdver=$3 tree=$4 fail=${5:-}
  RUN=$W/runs/$name
  mkdir -p "$RUN/state"
  cp -a --no-preserve=ownership /etc "$RUN/etc" 2>/dev/null || true
  touch -d '1 minute ago' "$RUN/start"
  case $box in
  prod) set -- PROJECT=starbridge COMMAND=starbridge-deploy APPLY=deploy/host/apply.sh ;;
  staging) set -- PROJECT=starbridge-staging COMMAND=starbridge-staging-deploy APPLY=deploy/staging/apply.sh ;;
  esac
  env "$@" BOX=$box CMDVER=$cmdver TREE=$tree FAIL_UP_ONCE=$fail RUN="$RUN" ETC="$RUN/etc" STATE="$RUN/state" TRACE="$RUN/trace" \
    TREES="$W/trees" STUBS="$W/stubs" R0=$R0 R1=$R1 ROUND_TRIP_DIR=/var/lib/sb-check-staging \
    PATH="$W/stubs:$PATH" unshare -mr --propagation private bash "$W/inner.sh" > "$RUN/output" 2>&1 || true
  # Temp names and the work folder change from run to run.
  sed -i -E -e "s|$W|W|g" -e 's|/tmp/tmp\.[A-Za-z0-9]+|TMP|g' -e 's|\.push\.[A-Za-z0-9]+|.push.X|g' \
    -e 's|server\.env\.[A-Za-z0-9]{6}|server.env.X|g' "$RUN/trace" "$RUN/output" "$RUN/files"
}
compare() { # LABEL A B
  local d
  for f in trace output files server.env; do
    d=$(diff -u --label "$2/$f" --label "$3/$f" "$W/runs/$2/$f" "$W/runs/$3/$f") || { echo "### $1: $f"; echo "$d"; }
  done
}
for box in prod staging; do
  run $box-before $box before before
  run $box-after $box after after
  run $box-before-retry $box before before 1
  run $box-after-retry $box after after 1
  # Right after the change: the old command on the new tree; a rollback to before it: the reverse.
  run $box-oldcmd-newtree $box before after
  run $box-newcmd-oldtree $box after before
done
for box in prod staging; do
  echo "######## $box: before vs after"
  compare "$box" $box-before $box-after
  echo "######## $box: before vs after, with Docker failing the first compose up"
  compare "$box retry" $box-before-retry $box-after-retry
  echo "######## $box: the old command deploying the new tree, vs before"
  compare "$box" $box-before $box-oldcmd-newtree
  echo "######## $box: the new command deploying the old tree, vs before"
  compare "$box" $box-before $box-newcmd-oldtree
  echo "######## $box: commands run, after"
  grep -c . "$W/runs/$box-after/trace"
done

# push-secrets.sh, before and after, for each box, with fake secrets in a throwaway HOME.
H=$W/home
mkdir -p "$H/.config/starbridge/secrets/staging" "$H/.ssh"
for f in github-oauth-client-secret fcm-service-account.json vapid-public-key vapid-private-key stats-password-hash backup-age.pub; do
  echo "fake-$f" > "$H/.config/starbridge/secrets/$f"
done
for f in github-oauth-client-id github-oauth-client-secret vapid-public-key vapid-private-key signup-github-ids owner-token; do
  echo "fake-$f" > "$H/.config/starbridge/secrets/staging/$f"
done
push() { # NAME SCRIPT ARGS...
  local name=$1
  shift
  : > "$W/push-$name"
  env HOME="$H" TRACE="$W/push-$name" PATH="$W/stubs:$PATH" sh "$@" >> "$W/push-$name" 2>&1 || echo "exit $?" >> "$W/push-$name"
}
push prod-before "$W/trees/before/deploy/push-secrets.sh"
push prod-after "$W/trees/after/deploy/push-secrets.sh"
push prod-named-before "$W/trees/before/deploy/push-secrets.sh" vapid-public-key stats-password-hash
push prod-named-after "$W/trees/after/deploy/push-secrets.sh" vapid-public-key stats-password-hash
push staging-before "$W/trees/before/deploy/staging/push-secrets.sh"
push staging-after "$W/trees/after/deploy/push-secrets.sh" staging
push staging-wrong-before "$W/trees/before/deploy/staging/push-secrets.sh" fcm-service-account.json
push staging-wrong-after "$W/trees/after/deploy/push-secrets.sh" staging fcm-service-account.json
for p in prod prod-named staging staging-wrong; do
  echo "######## push-secrets.sh, $p: before vs after"
  sed -i "s|$W|W|g" "$W/push-$p-before" "$W/push-$p-after"
  diff -u "$W/push-$p-before" "$W/push-$p-after" || true
done

# The command each box's deploy runs next: what apply.sh installed, after.
for box in prod staging; do
  echo "######## $box: the deploy command apply.sh installs, after: its settings, then host/deploy-rev.sh"
  if [ "$box" = prod ]; then env=host/prod.env; else env=staging/staging.env; fi
  { echo '#!/bin/sh'; cat "$W/trees/after/deploy/$env" "$W/trees/after/deploy/host/deploy-rev.sh"; } |
    cmp - "$W/runs/$box-after/command" && echo same
done
