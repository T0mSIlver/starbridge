#!/bin/bash
# Nightly (gh-runner-cleanup.timer): Docker's images, containers and build cache unused for three
# days, and every unused one when the disk is 80% full. The slots drop their tool cache themselves
# at that level (slot.sh).
set -u
docker system prune -af --filter until=72h
docker volume prune -af
if [ "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -ge 80 ]; then
  docker system prune -af
  docker builder prune -af
fi
df -h /
