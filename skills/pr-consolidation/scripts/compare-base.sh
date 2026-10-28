#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# compare-base.sh: for each failing check on a PR, show how the same job did on the latest
# completed run of that workflow on the PR's base branch. Read-only. Use it in triage to tell
# bot-caused failures from failures the base branch already has.
#
# Usage:
#   compare-base.sh OWNER/REPO#N [PR-URL ...]
#   compare-base.sh -f prs.txt
#
# Output TSV: repo#pr, base, workflow, job, PR result, base result, base run date, base run id.
#   base result NO_BASE_RUN     the workflow never completed on the base branch (it may run only
#                               on pull_request, or be disabled for inactivity)
#   base result JOB_NOT_IN_RUN  the job didn't run there (path filters, matrix changes)
# Read the date: a base run from weeks ago says little about today, because advisories and
# @latest tools move underneath it.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"
need gh jq

[ $# -gt 0 ] || die "usage: compare-base.sh OWNER/REPO#N ... | -f FILE"

refs=$(read_refs "$@")
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  parsed=$(parse_pr "$ref") || exit 2
  repo=${parsed% *} num=${parsed#* }
  base=$(gh pr view "$num" -R "$repo" --json baseRefName --jq .baseRefName </dev/null)
  # shellcheck disable=SC2016 # $c and $r are jq variables, not shell ones
  failed=$(gh pr view "$num" -R "$repo" --json statusCheckRollup --jq '
    .statusCheckRollup[] | select(.__typename == "CheckRun")
    | select(.conclusion as $c
             | ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"] | index($c))
    | [.workflowName, .name, .conclusion] | @tsv' </dev/null)
  [ -n "$failed" ] || continue
  while IFS="$(printf '\t')" read -r wf job res; do
    run=$(gh run list -R "$repo" --branch "$base" --workflow "$wf" --status completed --limit 1 \
      --json databaseId,createdAt --jq '.[0] // empty | "\(.databaseId) \(.createdAt)"' 2>/dev/null </dev/null || true)
    if [ -z "$run" ]; then
      printf '%s#%s\t%s\t%s\t%s\t%s\tNO_BASE_RUN\t-\t-\n' "$repo" "$num" "$base" "$wf" "$job" "$res"
      continue
    fi
    rid=${run%% *} rdate=${run#* }
    bres=$(gh run view "$rid" -R "$repo" --json jobs </dev/null \
      | jq -r --arg j "$job" '[.jobs[] | select(.name == $j) | .conclusion] | first // "JOB_NOT_IN_RUN" | ascii_upcase')
    printf '%s#%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$repo" "$num" "$base" "$wf" "$job" "$res" "$bres" "$rdate" "$rid"
  done <<EOF
$failed
EOF
done <<EOF
$refs
EOF
