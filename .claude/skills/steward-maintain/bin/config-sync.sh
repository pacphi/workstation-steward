#!/usr/bin/env bash
# Maintainer flow 4, config sync: take what GitHub has for the config repo (a pull, or finishing a merged send) with
# steward config sync, which fast-forwards only, writes a receipt, offers mise install and runs steward check. Sending
# local edits opens a PR, which is outside this flow: a plan that would send stops here for the owner.
# Usage: config-sync.sh
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

if plan_then "config sync" "up to date with [^ ]+; nothing to send|waiting for you to merge" "${STEWARD}" config sync; then
  log "config sync: nothing to take"
  exit 0
fi
if grep -qE '^ +send ' <<<"${PLAN}"; then
  die "the plan sends local edits as a PR, which this flow doesn't do: run steward config sync --apply yourself"
fi
answer | "${STEWARD}" config sync --apply || die "config sync refused or failed (above)"

branch="$(git -C "${CONFIG}" branch --show-current)"
[[ "${branch}" == main ]] || die "after the sync the config is on ${branch}, not main"
# Edits the plan said it would carry over (a `stays` or `keeps` line) are still local after a good sync; anything else is not
if [[ -n "$(git -C "${CONFIG}" status --porcelain)" ]]; then
  grep -qE '^ +(stays|keeps) ' <<<"${PLAN}" || die "after the sync the config has uncommitted changes: git -C ${CONFIG/#${HOME}/~} status"
  log "your local edits were carried over and stay local; sending them opens a PR, which is yours: steward config sync --apply"
fi
[[ ! -f "${CONFIG}/mise/mise.lock" ]] || node "${ENGINE}/supply-chain/bin/lock-check.js" "${CONFIG}/mise/mise.lock"
log "config in step: $(git -C "${CONFIG}" log --oneline -1)"
