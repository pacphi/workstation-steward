#!/usr/bin/env bash
# Maintainer flow 3, a repin: point the release channel (`steward`) at vX.Y.Z, only after release.sh verifies it. Backs
# up both launchers and writes a receipt naming the owner's words as the gate exception, then runs
# tools/release-worktree and checks `steward version` and `steward check`.
# Usage: repin.sh <X.Y.Z> --why "<the owner's words>"
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

[[ $# -eq 3 && "${1#v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$2" == --why && -n "${3// /}" ]] \
  || die 'usage: repin.sh <X.Y.Z> --why "<the owner'"'"'s words>" (a repin is the owner'"'"'s call: quote it)'
version="${1#v}"; tag="v${version}"; why="$3"

"$(dirname "$0")/release.sh" "${version}" --verify-only || die "${tag} isn't verified: no repin"
git -C "${ENGINE}" fetch -q origin tag "${tag}"
from_tag="$(git -C "${RELEASE_DIR}" describe --tags --always 2>/dev/null || echo none)"
from_commit="$(git -C "${RELEASE_DIR}" rev-parse HEAD 2>/dev/null || echo none)"
to_commit="$(git -C "${ENGINE}" rev-parse "${tag}^{commit}")"

backup="${STEWARD_PATHS_STATE}/backups/repin-release-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${backup}"
for f in steward steward-dev; do [[ -e "${HOME}/.local/bin/${f}" ]] && cp -p "${HOME}/.local/bin/${f}" "${backup}/"; done
published="$(curl -s "${REGISTRY}/${PACKAGE}" | jq -r --arg v "${version}" '.time[$v]')"
# shellcheck disable=SC2016 # a JavaScript template literal, not shell
node -e 'const [f, ft, fc, tt, tc, why, pub] = process.argv.slice(1); require("fs").writeFileSync(f, JSON.stringify({
  kind: "release-worktree", at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  from: { tag: ft, commit: fc }, to: { tag: tt, commit: tc },
  gate_exception: `the owner: "${why}". npm publish ${pub}; provenance and GitHub release verified (release.sh)`,
  backups: ["steward", "steward-dev"], rollback: `just release-worktree ${ft} (in the clone), or copy these launchers back`,
}, null, 1) + "\n");' "${backup}/receipt.json" "${from_tag}" "${from_commit}" "${tag}" "${to_commit}" "${why}" "${published}"
log "backup and receipt: ${backup/#${HOME}/~}"

answer | "${ENGINE}/tools/release-worktree" "${tag}"
got="$("${STEWARD}" version 2>&1 | head -1)"
[[ "${got}" == *"release ${version} "* ]] || die "after the repin, steward says: ${got} (roll back: just release-worktree ${from_tag})"
"${STEWARD}" check || die "steward check failed after the repin (roll back: just release-worktree ${from_tag})"
log "repinned: ${got}"
