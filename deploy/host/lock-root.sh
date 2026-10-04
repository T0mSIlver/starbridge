#!/bin/sh
# Turns root login off. Run it through `sudo` from a working `deploy` login, never as the
# only open root session.
set -eu
cat > /etc/ssh/sshd_config.d/11-starbridge-root.conf <<'CONF'
PermitRootLogin no
CONF
sshd -t
systemctl reload ssh
