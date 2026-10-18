#!/usr/bin/env bash
# pinned-tools.sh: Markdown rows, one per hand-pinned tool that trails its latest release; nothing
# when all are current. Dependabot reads no version of these, so scan.yml runs this weekly and
# keeps one issue open while the output is not empty (#2026). Needs GH_TOKEN, curl and jq.
set -euo pipefail
cd "$(dirname "$0")/.."

# behind NAME PINNED LATEST WHERE: a row when LATEST is newer than PINNED.
behind() {
  [ -n "$3" ] || { echo "pinned-tools.sh: no latest version for $1" >&2; exit 1; }
  [ "$2" = "$3" ] && return 0
  [ "$(printf '%s\n%s\n' "$2" "$3" | sort -V | tail -1)" = "$3" ] || return 0
  printf '| %s | %s | %s | %s |\n' "$1" "$2" "$3" "$4"
}
release() { gh api "repos/$1/releases/latest" --jq .tag_name; }
pinned() { grep -oE -m1 "$1" "$2" | head -1; }

trivy=$(pinned 'aquasec/trivy:[0-9.]+' .github/workflows/scan.yml); trivy=${trivy#*:}
osv=$(pinned 'osv-scanner:v[0-9.]+' .github/workflows/scan.yml); osv=${osv#*:v}
runner=$(pinned '^RUNNER_VERSION=[0-9.]+' .github/runners/setup.sh); runner=${runner#*=}
node=$(pinned '^NODE_VERSION=[0-9.]+' .github/runners/setup.sh); node=${node#*=}
minisign=$(pinned 'minisign/releases/download/[0-9.]+' .github/workflows/release.yml); minisign=${minisign##*/}
sodium=$(pinned 'swift-sodium", revision: "[0-9a-f]{40}' ios/StarbridgeProtocol/Package.swift); sodium=${sodium##*\"}
for v in "$trivy" "$osv" "$runner" "$node" "$minisign" "$sodium"; do
  [ -n "$v" ] || { echo "pinned-tools.sh: a pin was not found; its file changed shape" >&2; exit 1; }
done

# Plain assignments, so a failed lookup stops the script (set -e) instead of passing an empty version.
trivy_latest=$(release aquasecurity/trivy)
osv_latest=$(release google/osv-scanner)
runner_latest=$(release actions/runner)
minisign_latest=$(release jedisct1/minisign)
# The newest release of the major line the boxes run.
node_latest=$(curl -fsS https://nodejs.org/dist/index.json |
  jq -er --arg major "v${node%%.*}." '[.[] | select(.version | startswith($major))][0].version')
# swift-sodium is pinned by commit: its last tag is from 2020.
ahead=$(gh api "repos/jedisct1/swift-sodium/compare/$sodium...master" --jq .ahead_by)

rows=$(
  behind Trivy "$trivy" "${trivy_latest#v}" ".github/workflows/scan.yml"
  behind osv-scanner "$osv" "${osv_latest#v}" ".github/workflows/scan.yml"
  behind "Actions runner" "$runner" "${runner_latest#v}" ".github/runners/setup.sh"
  behind minisign "$minisign" "$minisign_latest" ".github/workflows/release.yml, cli/install.ps1"
  behind Node "$node" "${node_latest#v}" ".github/runners/setup.sh"
  [ "$ahead" = 0 ] || printf '| swift-sodium | %s | master, %s commits ahead | ios/StarbridgeProtocol/Package.swift |\n' "${sodium:0:7}" "$ahead"
)
[ -z "$rows" ] || printf '| Tool | Pinned | Latest | Pinned in |\n|---|---|---|---|\n%s\n' "$rows"
