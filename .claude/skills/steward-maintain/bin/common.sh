#!/usr/bin/env bash
# Shared by the maintainer skill's flows. Source it; don't run it. The scope is fixed here and nowhere else: the engine
# is the checkout this skill lives in, the config is the instance `steward config` names. A flow touches nothing else.
# shellcheck source-path=SCRIPTDIR source=../../../../lib/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/lib/lib.sh"

# shellcheck disable=SC2034 # the flows that source this read these
ENGINE="${REPO_ROOT}"
# shellcheck disable=SC2034
CONFIG="${INSTANCE_ROOT}"
# owner/repo from the engine's origin (https or ssh)
# shellcheck disable=SC2034
ENGINE_SLUG="$(git -C "${ENGINE}" remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
# shellcheck disable=SC2034
PACKAGE="$(node -p "require('${ENGINE}/package.json').name")"
# shellcheck disable=SC2034
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
# shellcheck disable=SC2034
STEWARD="${STEWARD_BIN:-steward}"   # the release channel, as the owner runs it
# shellcheck disable=SC2034
RELEASE_DIR="${STEWARD_RELEASE:-${HOME}/.local/share/workstation-steward/release}"

# answer — the confirmations a steward command asks for, given only after its plan was printed and checked. A command
# that exits without reading them mustn't fail the pipeline under pipefail (SIGPIPE in printf), so that is ignored
answer() { trap '' PIPE; printf 'y\ny\ny\n' 2>/dev/null || true; }

# plan_then(label, upto_date_pattern, cmd…) — print cmd's plan; 0 when it says there's nothing to do, 1 when there is
plan_then() {
  local label="$1" idle="$2" out; shift 2
  log "${label}: plan"
  out="$("$@" 2>&1)" || { printf '%s\n' "${out}"; die "${label}: the plan failed; nothing was changed"; }
  printf '%s\n' "${out}"
  # shellcheck disable=SC2034 # the plan, for the caller to read
  PLAN="${out}"
  if grep -qE "${idle}" <<<"${out}"; then return 0; fi
  return 1
}
