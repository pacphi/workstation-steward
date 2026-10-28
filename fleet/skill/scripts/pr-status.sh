#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# pr-status.sh: one TSV line of merge and CI state per PR. Read-only.
#
# Usage:
#   pr-status.sh OWNER/REPO#N [PR-URL ...]
#   pr-status.sh -f prs.txt            # one PR reference per line; '-' reads stdin
#
# Columns: url, state, mergeable, mergeStateStatus, reviewDecision, head sha, check count,
#          counts by result (e.g. SUCCESS=12,SKIPPED=2), then every check that is not
#          SUCCESS/SKIPPED/NEUTRAL as "name:RESULT; ...".
# A check run that hasn't completed reports PENDING.
#
# Exit: 0 when every PR was read, 1 when any lookup failed, 2 on usage errors.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"
need gh jq

[ $# -gt 0 ] || die "usage: pr-status.sh OWNER/REPO#N ... | -f FILE"

rc=0
refs=$(read_refs "$@")
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  parsed=$(parse_pr "$ref") || exit 2
  repo=${parsed% *} num=${parsed#* }
  # shellcheck disable=SC2016 # $r is a jq variable, not a shell one
  if ! gh pr view "$num" -R "$repo" \
      --json url,state,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup --jq '
    def res: if .__typename == "CheckRun"
             then (if .status != "COMPLETED" then "PENDING" else (.conclusion // "NONE") end)
             else (.state // "NONE") end;
    [.url, .state, .mergeable, .mergeStateStatus, (if (.reviewDecision // "") == "" then "-" else .reviewDecision end), .headRefOid[0:12],
     (.statusCheckRollup | length | tostring),
     ([.statusCheckRollup[] | res] | group_by(.) | map("\(.[0])=\(length)") | join(",")),
     ([.statusCheckRollup[]
       | select((res) as $r | ["SUCCESS", "SKIPPED", "NEUTRAL"] | index($r) | not)
       | "\(.name // .context):\(res)"] | join("; "))
    ] | @tsv' </dev/null; then
    warn "could not read $ref"
    rc=1
  fi
done <<EOF
$refs
EOF
exit "$rc"
