#!/usr/bin/env bash
# scan-issue.sh LABEL TITLE INTRO FOUND [fail]: keeps one open issue labelled LABEL while FOUND,
# the scan's Markdown, is not empty, and closes it once a run finds nothing. With `fail`, a finding
# also fails the step. Needs GH_TOKEN and GH_REPO, as uptime.yml's outage issue does. With either
# unset it fails: scan.yml's vulnerability scans pass a secret for a private repository, and an
# empty one must not fall back to gh's default, this public repository (#2205).
set -euo pipefail
[ -n "${GH_TOKEN:-}" ] && [ -n "${GH_REPO:-}" ] || { echo "::error::GH_TOKEN or GH_REPO is not set; no issue written."; exit 1; }
label=$1 title=$2 intro=$3 found=$4 fail=${5:-}
now=$(date -u '+%Y-%m-%d %H:%M UTC')
run="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
issue=$(gh issue list --label "$label" --state open --json number --jq '.[0].number // empty')
if [ -n "$found" ]; then
  # An issue body holds 65536 characters.
  [ ${#found} -le 60000 ] || found="${found:0:60000}"$'\n\n'"(Cut short at 60000 characters.)"
  body=$(printf '%s Last seen %s.\n\n%s\n\nRun: %s\n' "$intro" "$now" "$found" "$run")
  if [ -z "$issue" ]; then
    gh label create "$label" --color D93F0B --description "Opened and closed by scan.yml" 2>/dev/null || true
    gh issue create --label "$label" --title "$title" --body "$body"
  else
    # Editing the body sends no email; only opening and closing do.
    gh issue edit "$issue" --body "$body"
  fi
  [ "$fail" != fail ] || exit 1
elif [ -n "$issue" ]; then
  gh issue close "$issue" --comment "Nothing found at $now: $run"
fi
