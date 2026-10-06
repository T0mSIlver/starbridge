#!/usr/bin/env bash
# Installs self-hosted GitHub Actions runners for T0mSIlver/starbridge as system units that run
# as this user, in their own slice (needs sudo).
#
# RUNNERS lists one name:labels pair per runner; the Nth pair lives in starbridge-N and runs as
# gh-runner-starbridge-N. Labels only apply at registration: change a registered runner's labels
# with the GitHub API. The defaults are the dev box's runners. The CI host (#392):
#   RUNNERS="dell2-1:starbridge-android dell2-2:starbridge-devbox" \
#   GRADLE_PROPS="org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8
#   org.gradle.workers.max=4" deploy/setup-runners.sh
# A host without gh takes a registration token in RUNNER_TOKEN, fetched just before with
#   gh api -X POST repos/T0mSIlver/starbridge/actions/runners/registration-token --jq .token
#
# CPU: the agent sessions' builds run in login sessions' scopes under user.slice, and anything in
# user.slice, the user manager's units included, shares that slice's CPU with them. ci.slice sits
# beside user.slice at CPU weight 400 to its 100 (and system.slice's 100), so CI gets 67-80% of a
# contended box and gives it all back when idle (#380). CPU_WEIGHT changes it.
set -euo pipefail
VER=2.337.0
REPO=T0mSIlver/starbridge
BASE=$HOME/.local/opt/gh-runners
RUNNERS=${RUNNERS:-devbox-1:starbridge-devbox devbox-2:starbridge-devbox devbox-3:starbridge-devbox}
CPU_WEIGHT=${CPU_WEIGHT:-400}
# One Gradle home for all runners: Gradle locks its caches for concurrent builds, and android.yml
# turns off setup-gradle's cache restore on these runners, which used to overwrite files in use.
GRADLE_HOME=$BASE/gradle
mkdir -p "$BASE" "$GRADLE_HOME"
# Gradle reads its user home's gradle.properties over the project's: a host sizes builds to its memory.
[ -z "${GRADLE_PROPS:-}" ] || printf '%s\n' "$GRADLE_PROPS" > "$GRADLE_HOME/gradle.properties"
TAR=$BASE/actions-runner-linux-x64-$VER.tar.gz
[ -f "$TAR" ] || curl -fsSL -o "$TAR" "https://github.com/actions/runner/releases/download/v$VER/actions-runner-linux-x64-$VER.tar.gz"
i=0
for r in $RUNNERS; do
  i=$((i + 1))
  [[ $r == ?*:?* ]] || { echo "RUNNERS entry '$r' is not name:labels" >&2; exit 1; }
  name=${r%%:*} labels=${r#*:}
  d=$BASE/starbridge-$i
  if [ ! -f "$d/.runner" ]; then
    mkdir -p "$d"
    tar -xzf "$TAR" -C "$d"
    tok=${RUNNER_TOKEN:-$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)}
    (cd "$d" && ./config.sh --unattended --url "https://github.com/$REPO" --token "$tok" \
      --name "$name" --labels "$labels" --work _work --replace)
  fi
  # Hosted-runner equivalents the workflows expect. Temp files go to the job's temp folder, which
  # the runner empties after each job, instead of /tmp, a small RAM disk that tests filled.
  # JAVA_TOOL_OPTIONS moves java.io.tmpdir there too: Robolectric unpacks ~200 MB per test JVM.
  cat > "$d/.env" <<EOF
LANG=C.UTF-8
TMPDIR=$d/_work/_temp
JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=$d/_work/_temp
GRADLE_USER_HOME=$GRADLE_HOME
ANDROID_HOME=$HOME/.local/opt/android-sdk
ANDROID_SDK_ROOT=$HOME/.local/opt/android-sdk
PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF
  sudo tee "/etc/systemd/system/gh-runner-starbridge-$i.service" >/dev/null <<EOF
[Unit]
Description=GitHub Actions runner $name for $REPO
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
Group=$(id -gn)
Slice=ci.slice
WorkingDirectory=$d
ExecStart=$d/run.sh
Restart=always
RestartSec=10
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=5min

[Install]
WantedBy=multi-user.target
EOF
done
sudo tee /etc/systemd/system/ci.slice >/dev/null <<EOF
[Unit]
Description=CI runners, ahead of the agent sessions' builds

[Slice]
CPUWeight=$CPU_WEIGHT
EOF
sudo systemctl daemon-reload
# Until #380 the runners were user units. Each moves only while idle; rerun the script for one that
# was busy. A runner runs a job exactly while its Runner.Worker process exists; a job that starts in
# the second between the check and the stop is cancelled.
for j in $(seq 1 "$i"); do
  unit=gh-runner-starbridge-$j.service
  if [ -f "$HOME/.config/systemd/user/$unit" ]; then
    if pgrep -f "$BASE/starbridge-$j/bin/Runner.Worker" >/dev/null; then
      echo "runner $j is running a job; rerun when it is idle to move it" >&2
      continue
    fi
    systemctl --user disable --now "$unit"
    rm "$HOME/.config/systemd/user/$unit"
  fi
  sudo systemctl enable --now "$unit"
done
systemctl --user daemon-reload
systemctl --no-pager status 'gh-runner-starbridge-*' | grep -E 'gh-runner|Active'
