#!/usr/bin/env bash
# Maintainer flow 1, after a merge: bring the engine checkout in step with GitHub. Fast-forwards main (steward fleet
# sync), deletes branches GitHub has merged or deleted (steward fleet prune-merged), and drops stale worktree records.
# Each steward command prints its plan first and keeps its own receipt; this never resets, rebases or merges.
# A merged release-please PR prints `release: X.Y.Z`, so the release can be watched next (release.sh X.Y.Z).
# Usage: after-merge.sh [<pr-number>…]     with numbers, refuses unless every one of those PRs is merged
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

releases=()
for pr in "$@"; do
  [[ "${pr}" =~ ^[0-9]+$ ]] || die "usage: after-merge.sh [<pr-number>…]"
  read -r state merge title <<<"$(gh pr view "${pr}" -R "${ENGINE_SLUG}" --json state,mergeCommit,title -q '"\(.state) \(.mergeCommit.oid // "-") \(.title)"')"
  [[ "${state}" == MERGED ]] || die "PR #${pr} is ${state}, not merged: nothing done"
  log "PR #${pr} merged as ${merge:0:7}: ${title}"
  [[ "${title}" =~ ^chore\(main\):\ release\ ([0-9]+\.[0-9]+\.[0-9]+)$ ]] && releases+=("${BASH_REMATCH[1]}")
done

if plan_then "sync" "already up to date" "${STEWARD}" fleet sync "${ENGINE}"; then
  log "sync: nothing to do"
else
  answer | "${STEWARD}" fleet sync "${ENGINE}" --apply || die "sync refused (above): nothing more done"
fi

if plan_then "prune-merged" "nothing to delete" "${STEWARD}" fleet prune-merged "${ENGINE}"; then
  log "prune-merged: nothing to do"
else
  answer | "${STEWARD}" fleet prune-merged "${ENGINE}" --apply || die "prune-merged refused (above): nothing more done"
fi

git -C "${ENGINE}" worktree prune -v
log "now"
git -C "${ENGINE}" status --short --branch | head -1
git -C "${ENGINE}" branch --format='  %(refname:short) %(objectname:short)'
git -C "${ENGINE}" worktree list | sed "s#${HOME}#~#"
for v in ${releases[@]+"${releases[@]}"}; do echo "release: ${v}"; done
