#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# wait-ci.sh: poll PRs until no check is pending, then print their final status. Read-only.
#
# Usage:
#   wait-ci.sh OWNER/REPO#N [PR-URL ...]
#   wait-ci.sh -f prs.txt
#
# Environment:
#   WAIT_CI_INTERVAL   seconds between polls (default 45)
#   WAIT_CI_TIMEOUT    give up after this many seconds (default 2700, i.e. 45 minutes)
#   WAIT_CI_GRACE      seconds to wait before the first poll, so checks can register (default 30)
#
# Output: the pr-status.sh TSV for every PR once nothing is PENDING.
# Exit: 0 all checks passed (SUCCESS/SKIPPED/NEUTRAL), 1 some check failed, 3 timed out,
#       2 usage error.
#
# A workflow that GitHub disabled for inactivity never registers a check, so it can't show up
# here as pending. Compare the check list against .github/workflows before trusting a green run.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/_lib.sh"
need gh jq

[ $# -gt 0 ] || die "usage: wait-ci.sh OWNER/REPO#N ... | -f FILE"
interval=${WAIT_CI_INTERVAL:-45}
timeout=${WAIT_CI_TIMEOUT:-2700}
grace=${WAIT_CI_GRACE:-30}

refs=$(read_refs "$@")
sleep "$grace"
start=$(date +%s)
while :; do
  status=$(printf '%s\n' "$refs" | "$here/pr-status.sh" -f - || true)
  case "$status" in
    *PENDING*) ;;
    *) break ;;
  esac
  if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
    printf '%s\n' "$status"
    warn "timed out after ${timeout}s with checks still pending"
    exit 3
  fi
  sleep "$interval"
done

[ -n "$status" ] || { warn "no PR status could be read"; exit 1; }
printf '%s\n' "$status"
# Column 9 lists the checks that are not SUCCESS/SKIPPED/NEUTRAL; any non-empty value is a failure.
failing=$(printf '%s\n' "$status" | awk -F'\t' '$9 != ""' | wc -l | tr -d ' ')
[ "$failing" -eq 0 ] || exit 1
