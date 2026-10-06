#!/usr/bin/env bash
# Installs N self-hosted GitHub Actions runners for T0mSIlver/starbridge as system units that run
# as this user, in their own slice (needs sudo).
#
# CPU: the agent sessions' builds run in login sessions' scopes under user.slice, and anything in
# user.slice, the user manager's units included, shares that slice's CPU with them. ci.slice sits
# beside user.slice at CPU weight 400 to its 100 (and system.slice's 100), so CI gets 67-80% of a
# contended box and gives it all back when idle (#380). CPU_WEIGHT changes it.
set -euo pipefail
VER=2.337.0
REPO=T0mSIlver/starbridge
BASE=$HOME/.local/opt/gh-runners
N=${N:-3}
CPU_WEIGHT=${CPU_WEIGHT:-400}
# One Gradle home for all runners: Gradle locks its caches for concurrent builds, and android.yml
# turns off setup-gradle's cache restore on these runners, which used to overwrite files in use.
GRADLE_HOME=$BASE/gradle
mkdir -p "$BASE" "$GRADLE_HOME"
TAR=$BASE/actions-runner-linux-x64-$VER.tar.gz
[ -f "$TAR" ] || curl -fsSL -o "$TAR" "https://github.com/actions/runner/releases/download/v$VER/actions-runner-linux-x64-$VER.tar.gz"
for i in $(seq 1 "$N"); do
  d=$BASE/starbridge-$i
  if [ ! -f "$d/.runner" ]; then
    mkdir -p "$d"
    tar -xzf "$TAR" -C "$d"
    tok=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)
    (cd "$d" && ./config.sh --unattended --url "https://github.com/$REPO" --token "$tok" \
      --name "devbox-$i" --labels starbridge-devbox --work _work --replace)
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
Description=GitHub Actions runner devbox-$i for $REPO
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
# was busy. A job GitHub assigns in the second between the check and the stop is cancelled.
busy() { gh api "repos/$REPO/actions/runners" --jq ".runners[] | select(.name == \"devbox-$1\") | .busy"; }
for i in $(seq 1 "$N"); do
  unit=gh-runner-starbridge-$i.service
  if [ -f "$HOME/.config/systemd/user/$unit" ]; then
    if [ "$(busy "$i")" != false ]; then
      echo "devbox-$i is running a job; rerun when it is idle to move it" >&2
      continue
    fi
    systemctl --user disable --now "$unit"
    rm "$HOME/.config/systemd/user/$unit"
  fi
  sudo systemctl enable --now "$unit"
done
systemctl --user daemon-reload
systemctl --no-pager status 'gh-runner-starbridge-*' | grep -E 'gh-runner|Active'
