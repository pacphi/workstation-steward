#!/usr/bin/env bash
# What's waiting, read-only: the engine checkout against GitHub (the sync and prune-merged plans, which only fetch),
# the engine's open pull requests (release-please's among them), and the config sync plan. The plain
# /steward-maintain shows this and suggests the next flow.
# Usage: status.sh
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

plan_then "engine sync" "already up to date" "${STEWARD}" fleet sync "${ENGINE}" || true
plan_then "engine prune-merged" "nothing to delete" "${STEWARD}" fleet prune-merged "${ENGINE}" || true
log "open pull requests on ${ENGINE_SLUG}"
gh pr list -R "${ENGINE_SLUG}" --json number,title,author,headRefName -q '.[] | "  #\(.number) \(.title) (\(.author.login))\(if (.headRefName | startswith("release-please")) then "  ← the release PR" else "" end)"'
plan_then "config sync" "up to date with [^ ]+; nothing to send" "${STEWARD}" config sync || true
log "installed: $("${STEWARD}" version 2>&1 | head -1); npm latest: $(curl -s "${REGISTRY}/${PACKAGE}" | jq -r '."dist-tags".latest')"
