#!/bin/sh
# Runs one of the launch's response switches on starbridge-1 (deploy/host/switch.sh, #783):
#   deploy/switch.sh block 198.51.100.7     deploy/switch.sh unblock 198.51.100.7
#   deploy/switch.sh blocked                deploy/switch.sh log
# Each changes prod: the owner approves it first.
set -eu
exec ssh -i ~/.ssh/starbridge_ed25519 deploy@starbridge.run sudo /opt/starbridge/deploy/host/switch.sh "$@"
