#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# merge-and-close.sh: merge one consolidation PR, then deal with the PRs it supersedes, by bot.
# ORCHESTRATOR ONLY. The consolidating agent never runs this.
#
# Usage:
#   merge-and-close.sh [options] OWNER/REPO#N
#     --superseded N[,N...]   the PRs this one supersedes. Give them explicitly: never derive the
#                             list from the PR body, which also names deferred majors that must
#                             stay open (ampel#86 lists #82, emailibrium#308 lists #296).
#     --execute               actually merge and close. Without it the script only prints the plan.
#     --merge-commit          merge with a merge commit and keep the head branch (a develop -> main
#                             release PR). The default is --squash --delete-branch.
#     --ignore-check NAME     merge even though check NAME is red (a pre-existing failure the owner
#                             accepted). Repeatable. Pending checks always block.
#
# What it does:
#   1. Refuses unless every check is SUCCESS/SKIPPED/NEUTRAL (apart from --ignore-check names).
#   2. gh pr merge --squash --delete-branch --match-head-commit <head sha>, then confirms MERGED.
#      Already-merged PRs skip this step, so a re-run only handles the superseded PRs.
#   3. For each superseded PR, by author:
#        app/dependabot  close with the comment "Superseded by #N."
#        app/renovate    NOT closed. Closing a Renovate PR by hand makes Renovate ignore that
#                        version (or the whole major). Renovate autocloses obsolete PRs on its next
#                        run; the script prints the command to check. See bots.md.
#        anyone else     not touched; reported.
#
# Exit: 0 done (or plan printed), 1 refused or a step failed, 2 usage error.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/_lib.sh"
need gh jq

execute=0 method=squash superseded="" ignore="" ref=""
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) execute=1; shift ;;
    --merge-commit) method=merge; shift ;;
    --superseded) superseded=$(printf '%s' "${2:?--superseded needs a list}" | tr ',' ' '); shift 2 ;;
    --ignore-check) ignore="$ignore${2:?--ignore-check needs a name}
"; shift 2 ;;
    -h|--help) awk 'NR > 2 && /^#/ {sub(/^# ?/, ""); print; next} NR > 2 {exit}' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$ref" ] || die "one PR at a time"; ref=$1; shift ;;
  esac
done
[ -n "$ref" ] || die "usage: merge-and-close.sh [--execute] [--superseded N,N] [--merge-commit] OWNER/REPO#N"
parsed=$(parse_pr "$ref") || exit 2
repo=${parsed% *} num=${parsed#* }

run() { # print the command; run it only with --execute
  printf '  $ %s\n' "$*"
  [ "$execute" -eq 1 ] || return 0
  "$@"
}

info=$(gh pr view "$num" -R "$repo" --json state,headRefOid,baseRefName,title)
state=$(printf '%s' "$info" | jq -r .state)
sha=$(printf '%s' "$info" | jq -r .headRefOid)
base=$(printf '%s' "$info" | jq -r .baseRefName)
printf '%s#%s [%s] -> %s: %s\n' "$repo" "$num" "$state" "$base" "$(printf '%s' "$info" | jq -r .title)"
[ "$execute" -eq 1 ] || printf '(dry run: pass --execute to act)\n'

case "$state" in
  MERGED) printf 'already merged; handling superseded PRs only\n' ;;
  OPEN)
    status=$("$here/pr-status.sh" "$repo#$num")
    bad=$(printf '%s' "$status" | cut -f9 | tr ';' '\n' | sed 's/^ *//' | awk 'NF')
    blocking=""
    if [ -n "$bad" ]; then
      while IFS= read -r chk; do
        name=${chk%:*} res=${chk##*:}
        if [ "$res" != PENDING ] && printf '%s' "$ignore" | awk -v n="$name" '$0 == n {f=1} END {exit !f}'; then
          printf 'ignoring red check (owner-accepted): %s\n' "$chk"
        else
          blocking="$blocking  $chk
"
        fi
      done <<EOF
$bad
EOF
    fi
    if [ -n "$blocking" ]; then
      printf 'refusing to merge; these checks are not green:\n%s' "$blocking" >&2
      exit 1
    fi
    if [ "$method" = squash ]; then
      run gh pr merge "$num" -R "$repo" --squash --delete-branch --match-head-commit "$sha"
    else
      run gh pr merge "$num" -R "$repo" --merge --match-head-commit "$sha"
    fi
    if [ "$execute" -eq 1 ]; then
      after=$(gh pr view "$num" -R "$repo" --json state --jq .state)
      [ "$after" = MERGED ] || { warn "PR is $after after the merge call"; exit 1; }
      printf 'merged\n'
    fi ;;
  *) warn "PR is $state; nothing to merge"; exit 1 ;;
esac

rc=0
for s in $superseded; do
  case "$s" in ''|*[!0-9]*) warn "skipping bad PR number: $s"; continue ;; esac
  sinfo=$(gh pr view "$s" -R "$repo" --json state,author,title,headRefName) || { warn "can't read #$s"; rc=1; continue; }
  sstate=$(printf '%s' "$sinfo" | jq -r .state)
  author=$(printf '%s' "$sinfo" | jq -r .author.login)
  title=$(printf '%s' "$sinfo" | jq -r .title)
  branch=$(printf '%s' "$sinfo" | jq -r .headRefName)
  printf '#%s [%s] %s: %s\n' "$s" "$sstate" "$author" "$title"
  case "$author" in
    app/dependabot|dependabot)
      if [ "$sstate" = OPEN ]; then
        run gh pr close "$s" -R "$repo" --comment "Superseded by #$num." || rc=1
      fi ;;
    app/renovate|renovate)
      if [ "$branch" = renovate/configure ]; then
        printf '  onboarding PR: not part of any consolidation; left alone\n'
      elif [ "$sstate" = OPEN ]; then
        printf '  left open for Renovate to autoclose on its next run (closing it by hand makes Renovate ignore it).\n'
        printf '  check later: gh pr view %s -R %s --json state,title\n' "$s" "$repo"
      else
        case "$title" in
          *" - autoclosed") printf '  autoclosed by Renovate\n' ;;
          *) printf '  %s without the autoclosed marker; check whether someone closed it by hand\n' "$sstate" ;;
        esac
      fi ;;
    *) printf '  not a bot PR: not touched\n' ;;
  esac
done
exit "$rc"
