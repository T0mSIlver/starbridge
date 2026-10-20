#!/bin/sh
# One-time host setup for starbridge-1, run as root; safe to run again, then through
# `ssh deploy@… sudo sh -s`. Its last step turns root SSH login off, once `deploy` can log in with
# root's keys and use sudo (#1734). The session that runs it stays open; if `deploy` breaks,
# Hetzner's rescue system still reaches the box.
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq docker.io docker-compose-v2 git sqlite3 jq unattended-upgrades age zstd rsync
systemctl enable --now docker

# Security updates every day; reboot at 04:00 when a kernel update needs it.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat > /etc/apt/apt.conf.d/52starbridge-upgrades <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
CONF

# The deploy user logs in with root's key and runs everything through sudo.
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
passwd --lock deploy >/dev/null
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# Only the first time: later, deploy's keys hold the Actions key too (setup-actions-deploy.sh).
[ -s /home/deploy/.ssh/authorized_keys ] ||
  install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
visudo -cq

# Keys only. sshd takes the first value it reads, and this file sorts before cloud-init's. Of
# forwarding, only the tunnel to Umami's dashboard (README.md, "Analytics"); none for agents.
cat > /etc/ssh/sshd_config.d/10-starbridge.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 3
AllowAgentForwarding no
AllowTcpForwarding local
PermitOpen 127.0.0.1:3001
CONF
sshd -t
systemctl reload ssh

install -d -m 700 /etc/starbridge /etc/starbridge/secrets
install -d -m 700 /var/backups/starbridge
install -d -m 755 /opt/starbridge

# Root login goes last, once what a login as `deploy` needs is in place: a key, sudo, and sshd
# taking its key. Then only `deploy` logs in. This file sorts before cloud-init's too.
[ -s /home/deploy/.ssh/authorized_keys ] || { echo "setup.sh: deploy has no SSH key; root login stays on" >&2; exit 1; }
su -s /bin/sh deploy -c 'sudo -n true' || { echo "setup.sh: deploy cannot use sudo; root login stays on" >&2; exit 1; }
sshd -T -C user=deploy,host=localhost,addr=127.0.0.1 | grep -qx 'pubkeyauthentication yes' ||
  { echo "setup.sh: sshd refuses keys for deploy; root login stays on" >&2; exit 1; }
printf 'PermitRootLogin no\nAllowUsers deploy\n' > /etc/ssh/sshd_config.d/11-starbridge-root.conf
sshd -t
systemctl reload ssh
