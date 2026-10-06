#!/bin/bash
# Runs the server and the demo program; when either exits, so does the container, and Docker
# starts it again on an empty database.
set -u
rm -rf /tmp/demo
mkdir -p /tmp/demo
bun /app/server.js &
bun /app/demo.js &
wait -n
exit 1
