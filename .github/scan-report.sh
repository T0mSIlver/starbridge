#!/usr/bin/env bash
# scan-report.sh KIND [IMAGE] < scanner JSON: Markdown for scan.yml's summary and issues.
#   trivy IMAGE           every finding in Trivy's JSON, worst first
#   trivy-blocking IMAGE  only high and critical findings with a fixed version; nothing when none
#   osv                   every finding in osv-scanner's JSON; nothing when none
set -euo pipefail
kind=$1
image=${2:-}
case $kind in
  trivy | trivy-blocking)
    rows=$(jq -r --arg kind "$kind" '
      def rank: {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}[.] // 4;
      [.Results[]? | .Target as $t | .Vulnerabilities[]? | . + {Target: $t}]
      | map(select($kind == "trivy" or ((.Severity == "CRITICAL" or .Severity == "HIGH") and (.FixedVersion // "") != "")))
      | unique_by([.VulnerabilityID, .PkgName, .InstalledVersion])
      | sort_by([(.Severity | rank), .PkgName])[]
      | "| \(.Severity) | \(.PkgName) | \(.InstalledVersion) | \(.FixedVersion // "" | if . == "" then "none" else . end) | [\(.VulnerabilityID)](\(.PrimaryURL // "https://osv.dev/\(.VulnerabilityID)")) |"')
    if [ -z "$rows" ]; then
      [ "$kind" = trivy-blocking ] || printf '### %s\n\nNo known vulnerabilities.\n\n' "$image"
      exit 0
    fi
    printf '### %s\n\n| Severity | Package | Installed | Fixed in | Advisory |\n| --- | --- | --- | --- | --- |\n%s\n\n' "$image" "$rows"
    ;;
  osv)
    # A fixed version, when an advisory names one, is the first `fixed` event of its ranges.
    rows=$(jq -r '
      [.results[]? | .source.path as $src | .packages[]? | .package as $p | .groups as $g | .vulnerabilities[]? | .id as $id
        | {id, src: $src, p: $p,
           severity: ([$g[]? | select(.ids | index($id)) | .max_severity][0] // ""),
           fixed: ([.affected[]?.ranges[]?.events[]? | .fixed // empty][0] // "none")}]
      | unique_by([.id, .p.name, .p.version])
      | sort_by(.p.name)[]
      | "| \(.p.ecosystem) | \(.p.name) | \(.p.version) | \(.fixed) | \(.severity) | [\(.id)](https://osv.dev/\(.id)) | \(.src | sub("^/src/"; "")) |"')
    [ -n "$rows" ] || exit 0
    printf '| Ecosystem | Package | Version | Fixed in | CVSS | Advisory | Lockfile |\n| --- | --- | --- | --- | --- | --- | --- |\n%s\n' "$rows"
    ;;
  *)
    echo "scan-report.sh: unknown kind $kind" >&2
    exit 2
    ;;
esac
