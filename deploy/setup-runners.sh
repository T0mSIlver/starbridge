#!/usr/bin/env bash
# Installs N self-hosted GitHub Actions runners for T0mSIlver/starbridge as user systemd units.
set -euo pipefail
VER=2.337.0
REPO=T0mSIlver/starbridge
BASE=$HOME/.local/opt/gh-runners
N=${N:-3}
# One Gradle home for all runners: Gradle locks its caches for concurrent builds, and android.yml
# turns off setup-gradle's cache restore on these runners, which used to overwrite files in use.
GRADLE_HOME=$BASE/gradle
mkdir -p "$BASE" "$GRADLE_HOME" "$HOME/.config/systemd/user"
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
  cat > "$HOME/.config/systemd/user/gh-runner-starbridge-$i.service" <<EOF
[Unit]
Description=GitHub Actions runner devbox-$i for $REPO
After=network-online.target

[Service]
WorkingDirectory=$d
ExecStart=$d/run.sh
Restart=always
RestartSec=10
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=5min
Nice=5

[Install]
WantedBy=default.target
EOF
done
systemctl --user daemon-reload
for i in $(seq 1 "$N"); do systemctl --user enable --now "gh-runner-starbridge-$i.service"; done
systemctl --user --no-pager status 'gh-runner-starbridge-*' | grep -E 'gh-runner|Active'
