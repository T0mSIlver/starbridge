#!/bin/sh
# Run as root on starbridge-1.
set -eu
docker compose -p starbridge exec -T server bun -e "$(cat /opt/starbridge/deploy/host/check-fcm.js)"
