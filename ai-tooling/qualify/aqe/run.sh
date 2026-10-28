#!/usr/bin/env bash
# Qualify an AQE release for the shared, patched runtime: the AQE recipe in
# archive/ai-tooling-ownership-and-qualification.md, adopted from the 2026-10-21 lane (continuation-29-aqe), reviewed,
# with its paths taken from steward.toml and ai-tooling.toml.
# Usage: ai-tooling/qualify/aqe/run.sh <version> <step>
#   build    clone the tag, rebuild it unpatched (must match the official tarball), apply patches/, rebuild, pack,
#            stage the release (bin/, runtime/ and models/ from the current release; natives compiled here)
#   smoke    the staged CLI's version and the MCP server's tool list
#   g1 g2 g3g4 g5 g6 g7 g8   the gates (README.md); each writes evidence/
#   receipt  receipt.json from the evidence, with a PASS or FAIL per gate
# Everything happens in the workspace, [paths] cache/qualify/aqe-<version>-local.1: a sandbox HOME per run, an env
# built from scratch, an unreachable proxy and HF_HUB_OFFLINE=1. Nothing is installed and no real store is opened.
# Promotion (into the runtime's releases/, then switching current) is a separate, approved step.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/lib.sh
source "${here}/../../../lib/lib.sh"
version="${1:?usage: run.sh <version> <step>}"; step="${2:?usage: run.sh <version> <step>}"
[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must look like 3.15.12"
release="${version}-local.1"
policy_value() { node -e 'const C=require(process.argv[1]);const v=process.argv[2].split(".").reduce((o,k)=>o[k],C.policy("ai-tooling/ai-tooling.toml"));process.stdout.write(String(v))' "${REPO_ROOT}/lib/config.js" "$1"; }
export QW="${STEWARD_PATHS_CACHE}/qualify/aqe-${release}"
export QSTAGE="${QW}/stage/${release}"
export QCURRENT; QCURRENT="$(policy_value aqe.runtime)/current"
export QNODEBIN; QNODEBIN="$(dirname "$(policy_value launch.node)")"
export STEWARD_POLICY_MIN_RELEASE_AGE_DAYS STEWARD_PATHS_STATE
export QGATES="${here}/gates" QFIX="${here}/fixtures" QVERSION="${version}" QRELEASE="${release}"
mkdir -p "${QW}/evidence" "${QW}/logs" && chmod 700 "${QW}"
log "AQE ${release}: ${step} (workspace ${QW/#${HOME}/~})"
case "${step}" in
  build) exec "${here}/build.sh" ;;
  smoke|g1|g2|g3g4|g5|g6|g7|g8|receipt) exec python3 -I "${here}/gates/${step}.py" "${@:3}" ;;
  *) die "unknown step ${step}" ;;
esac
