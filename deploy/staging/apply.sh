#!/bin/sh
# host/apply.sh with staging's settings. The deploy command runs this path on sb-staging
# (staging.env's APPLY): a rollback can unpack a commit from before the shared scripts, whose own
# staging/apply.sh then runs.
export DEPLOY_ENV=staging/staging.env
exec "$(dirname "$0")/../host/apply.sh"
