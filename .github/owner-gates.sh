#!/bin/sh
# The repository settings behind the owner's review (#1833), for the owner to run once, with a gh
# login that can administer the repository:
#   .github/owner-gates.sh            prints what it would change, and changes nothing
#   .github/owner-gates.sh --apply    changes it
# 1. Every environment: admins can no longer bypass its protection rules, so an admin's token
#    cannot run a branch's workflow with main's secrets. Each keeps its branch and tag policy, wait
#    timer and reviewers as they are.
# 2. The ruleset on main: the `owner review` commit status (owner-review.yml) becomes a required
#    check, beside the ones it has.
set -eu
repo=${REPO:-T0mSIlver/starbridge}
apply=
case ${1:-} in
--apply) apply=1 ;;
"") ;;
*) echo "usage: .github/owner-gates.sh [--apply]" >&2; exit 2 ;;
esac

# An assignment, so a failed read stops the script rather than leaving the loop empty.
envs=$(gh api "repos/$repo/environments" --paginate --jq '.environments[].name')
[ -n "$envs" ] || { echo "no environments read" >&2; exit 1; }
for env in $envs; do
  cur=$(gh api "repos/$repo/environments/$env")
  # PUT replaces the environment's settings, so it carries back every one it keeps.
  body=$(printf '%s' "$cur" | jq '{
      wait_timer: ([.protection_rules[] | select(.type == "wait_timer") | .wait_timer][0] // 0),
      prevent_self_review: ([.protection_rules[] | select(.type == "required_reviewers") | .prevent_self_review][0] // false),
      reviewers: ([.protection_rules[] | select(.type == "required_reviewers") | .reviewers[]
        | {type, id: .reviewer.id}] | if length == 0 then null else . end),
      deployment_branch_policy,
      can_admins_bypass: false
    }')
  if [ "$(printf '%s' "$cur" | jq .can_admins_bypass)" = false ]; then
    echo "environment $env: admins cannot bypass already"
  elif [ -n "$apply" ]; then
    printf '%s' "$body" | gh api -X PUT "repos/$repo/environments/$env" --input - >/dev/null
    echo "environment $env: admins can no longer bypass"
  else
    echo "environment $env: would PUT $(printf '%s' "$body" | jq -c .)"
  fi
done

id=$(gh api "repos/$repo/rulesets" --jq '.[] | select(.target == "branch" and .name == "protect main") | .id')
[ -n "$id" ] || { echo "no branch ruleset named \"protect main\"" >&2; exit 1; }
cur=$(gh api "repos/$repo/rulesets/$id")
if printf '%s' "$cur" | jq -e '.rules[] | select(.type == "required_status_checks")
    | .parameters.required_status_checks[] | select(.context == "owner review")' >/dev/null; then
  echo "ruleset protect main: owner review is required already"
  exit 0
fi
# From any source: a token that can set the status can set owner-ok too, so naming GitHub Actions
# as its source would guard nothing more.
body=$(printf '%s' "$cur" | jq '{name, target, enforcement, conditions, bypass_actors,
    rules: [.rules[] | if .type == "required_status_checks"
      then .parameters.required_status_checks += [{context: "owner review"}]
      else . end]}')
printf '%s' "$body" | jq -e '[.rules[] | select(.type == "required_status_checks")] | length == 1' >/dev/null ||
  { echo "ruleset protect main has no single required_status_checks rule" >&2; exit 1; }
if [ -n "$apply" ]; then
  printf '%s' "$body" | gh api -X PUT "repos/$repo/rulesets/$id" --input - >/dev/null
  echo "ruleset protect main: owner review is now required"
else
  echo "ruleset protect main: would require owner review; checks after:"
  printf '%s' "$body" | jq -c '.rules[] | select(.type == "required_status_checks") | [.parameters.required_status_checks[].context]'
fi
