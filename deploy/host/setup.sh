#!/bin/sh
# One-time host setup for starbridge-1, run as root; safe to run again.
# Leaves root login on: deploy/host/lock-root.sh turns it off once `deploy` logs in.
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq docker.io docker-compose-v2 git sqlite3 jq unattended-upgrades
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
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
visudo -cq

# Keys only. sshd takes the first value it reads, and this file sorts before cloud-init's.
cat > /etc/ssh/sshd_config.d/10-starbridge.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
CONF
sshd -t
systemctl reload ssh

install -d -m 700 /etc/starbridge /etc/starbridge/secrets
install -d -m 700 /var/backups/starbridge
install -d -m 755 /opt/starbridge
