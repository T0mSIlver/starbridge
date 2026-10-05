#!/bin/sh
# Stands in for `codexbar usage --format json [--provider <name>]`, replaying recorded output.
dir=$(dirname "$0")/codexbar
provider=all
while [ $# -gt 0 ]; do
  [ "$1" = "--provider" ] && provider=$2
  shift
done
case $provider in
  signedout) echo '[{"provider":"signedout","error":{"message":"No available fetch strategy for signedout.","code":1,"kind":"provider"},"source":"auto"}]'; exit 1 ;;
  broken) echo "Error: provider not configured" >&2; exit 1 ;;
  garbage) echo "Fetching usage..."; exit 0 ;;
  nosuch) provider=all ;;
esac
cat "$dir/$provider.json"
