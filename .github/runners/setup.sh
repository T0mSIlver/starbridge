#!/bin/bash
# Sets up a CI box for Starbridge's self-hosted runners, or brings one up to date; safe to run
# again. From a checkout:
#   scp -r .github/runners <box>:gh-runner-setup && ssh <box> sudo bash gh-runner-setup/setup.sh <slots>
# The box holds no GitHub credential: feed.sh, on the machine with the owner's GitHub login, hands
# each idle slot a single-use runner registration. See docs/ci.md.
set -euo pipefail
slots=${1:?usage: setup.sh <number of runner slots>}
here=$(dirname "$(readlink -f "$0")")
RUNNER_VERSION=2.338.0
RUNNER_SHA256=af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32
NODE_VERSION=24.18.0
# From https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt, whose detached signature (SHASUMS256.txt.sig)
# checks against a key in https://github.com/nodejs/release-keys/blob/main/keys.list. Change both together.
NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
# Docker's apt signing key, from https://docs.docker.com/engine/install/debian/.
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
export DEBIAN_FRONTEND=noninteractive

# Docker from Docker's own repository.
if [ ! -f /etc/apt/sources.list.d/docker.sources ]; then
  apt-get update -q
  apt-get install -yq ca-certificates curl gpg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc.part
  # Exactly one primary key, and it is Docker's.
  fprs=$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc.part | awk -F: '$1=="pub"{p=1; next} $1=="fpr"&&p{print $10; p=0}')
  if [ "$fprs" != "$DOCKER_KEY_FPR" ]; then
    echo "setup.sh: Docker's apt key has fingerprint '$fprs', not $DOCKER_KEY_FPR" >&2
    rm -f /etc/apt/keyrings/docker.asc.part
    exit 1
  fi
  mv /etc/apt/keyrings/docker.asc.part /etc/apt/keyrings/docker.asc
  . /etc/os-release
  printf 'Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: %s\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
    "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.sources
fi
apt-get update -q
apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  git gh jq curl xvfb xauth unzip zstd

# Node for the steps that run the box's own.
if [ "$(/usr/local/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  node_tar=$(mktemp)
  curl -fsSL -o "$node_tar" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $node_tar" | sha256sum -c - || { rm -f "$node_tar"; exit 1; }
  tar xJf "$node_tar" -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
  rm -f "$node_tar"
fi

# The jobs' user: in the docker group, no sudo.
id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner
usermod -aG docker runner

# One copy of the runner per slot, since a runner keeps its state in its own folder.
tarball=/var/cache/gh-runner/actions-runner-$RUNNER_VERSION.tgz
if [ ! -f "$tarball" ]; then
  mkdir -p /var/cache/gh-runner
  curl -fsSL -o "$tarball.part" \
    "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-linux-x64-$RUNNER_VERSION.tar.gz"
  echo "$RUNNER_SHA256  $tarball.part" | sha256sum -c -
  mv "$tarball.part" "$tarball"
fi
for n in $(seq 1 "$slots"); do
  dir=/home/runner/slots/$n
  if [ "$(cat "$dir/.setup-version" 2>/dev/null)" != "$RUNNER_VERSION" ]; then
    install -d -o runner -g runner "$dir"
    sudo -u runner tar xzf "$tarball" -C "$dir"
    echo "$RUNNER_VERSION" | sudo -u runner tee "$dir/.setup-version" >/dev/null
  fi
done

install -d /usr/local/lib/gh-runner
install -m 0755 "$here/slot.sh" "$here/queue.sh" "$here/cleanup.sh" /usr/local/lib/gh-runner/
echo 'd /run/gh-runner 0750 runner runner -' > /etc/tmpfiles.d/gh-runner.conf
systemd-tmpfiles --create /etc/tmpfiles.d/gh-runner.conf

cat > /etc/systemd/system/gh-runner@.service <<'UNIT'
[Unit]
Description=GitHub Actions runner slot %i for T0mSIlver/starbridge
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=runner
ExecStart=/usr/local/lib/gh-runner/slot.sh %i
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=5min

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/gh-runner-cleanup.service <<'UNIT'
[Unit]
Description=Prune Docker and the runner slots' caches

[Service]
Type=oneshot
ExecStart=/usr/local/lib/gh-runner/cleanup.sh
UNIT
cat > /etc/systemd/system/gh-runner-cleanup.timer <<'UNIT'
[Unit]
Description=Nightly cleanup of the CI box

[Timer]
OnCalendar=*-*-* 03:30
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now docker gh-runner-cleanup.timer
for n in $(seq 1 "$slots"); do systemctl enable --now "gh-runner@$n"; done
# Slots past the requested number, from an earlier larger setup.
for unit in $(systemctl list-units 'gh-runner@*' --all --plain --no-legend | awk '{print $1}'); do
  n=${unit#gh-runner@}; n=${n%.service}
  if [ "$n" -gt "$slots" ]; then systemctl disable --now "$unit"; rm -rf "/home/runner/slots/$n" "/run/gh-runner/$n".*; fi
done
