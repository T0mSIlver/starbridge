#!/bin/bash
# Runs the server and the demo program; when either exits, so does the container, and Docker
# starts it again on the same volume (#2049).
set -u
bun /app/server.js &
bun /app/demo.js &
wait -n
exit 1
