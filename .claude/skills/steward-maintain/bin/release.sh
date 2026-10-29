#!/usr/bin/env bash
# Maintainer flow 2, a release: wait for the release run of vX.Y.Z to finish and npm to list it, then verify what was
# published: npm's latest is X.Y.Z, its provenance names this repository's release workflow and the tag's own commit,
# and the GitHub release is published. Read-only.
# Usage: release.sh <X.Y.Z> [--verify-only]       exit 0 verified, 1 a check failed, 2 timed out
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

[[ $# -ge 1 && "${1#v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: release.sh <X.Y.Z> [--verify-only]"
version="${1#v}"; tag="v${version}"
wait_s="${RELEASE_WAIT_SECONDS:-30}"; tries="${RELEASE_WAIT_TRIES:-80}"
tag_commit() { gh api "repos/${ENGINE_SLUG}/commits/${tag}" --jq .sha 2>/dev/null || true; }

if [[ "${2:-}" != --verify-only ]]; then
  log "waiting for ${tag} and its release run"
  sha="" run=""
  for ((i = 0; i < tries; i++)); do
    sha="$(tag_commit)"
    [[ -n "${sha}" ]] && run="$(gh run list -R "${ENGINE_SLUG}" --workflow release.yml --commit "${sha}" --json databaseId,status,conclusion -q '.[0] | "\(.databaseId) \(.status) \(.conclusion)"')"
    case "${run}" in
      *" completed success") log "release run ${run%% *} succeeded"; break ;;
      *" completed "*) die "release run ${run%% *} ended ${run##* }: gh run view ${run%% *} -R ${ENGINE_SLUG} --log-failed" ;;
    esac
    sleep "${wait_s}"
  done
  [[ "${run}" == *" completed success" ]] || { warn "the release run for ${tag} didn't finish in time (${run:-not found})"; exit 2; }
  log "waiting for npm to list ${version}"
  for ((i = 0; i < tries; i++)); do
    [[ "$(curl -s "${REGISTRY}/${PACKAGE}" | jq -r '."dist-tags".latest')" == "${version}" ]] && break
    sleep "${wait_s}"
  done
fi

latest="$(curl -s "${REGISTRY}/${PACKAGE}" | jq -r '."dist-tags".latest')"
[[ "${latest}" == "${version}" ]] || { warn "npm's latest is ${latest}, not ${version}"; [[ "${2:-}" == --verify-only ]] && exit 1; exit 2; }
published="$(curl -s "${REGISTRY}/${PACKAGE}" | jq -r --arg v "${version}" '.time[$v]')"
sha="$(tag_commit)"; [[ -n "${sha}" ]] || die "no ${tag} on ${ENGINE_SLUG}"
read -r prov_repo prov_flow prov_commit <<<"$(curl -s "${REGISTRY}/-/npm/v1/attestations/${PACKAGE}@${version}" \
  | jq -r '.attestations[] | select(.predicateType | test("slsa")) | .bundle.dsseEnvelope.payload' | base64 -d \
  | jq -r '.predicate.buildDefinition | "\(.externalParameters.workflow.repository) \(.externalParameters.workflow.path) \(.resolvedDependencies[0].digest.gitCommit)"')"
[[ "${prov_repo}" == "https://github.com/${ENGINE_SLUG}" ]] || die "provenance names ${prov_repo}, not ${ENGINE_SLUG}"
[[ "${prov_flow}" == .github/workflows/release.yml ]] || die "provenance names workflow ${prov_flow}, not release.yml"
[[ "${prov_commit}" == "${sha}" ]] || die "provenance commit ${prov_commit:0:7} is not ${tag}'s commit ${sha:0:7}"
rel="$(gh release view "${tag}" -R "${ENGINE_SLUG}" --json isDraft,isPrerelease -q '"\(.isDraft) \(.isPrerelease)"')"
[[ "${rel}" == "false false" ]] || die "GitHub release ${tag} is a draft or a prerelease (${rel})"
log "verified ${PACKAGE}@${version}: npm latest (published ${published}), provenance ${ENGINE_SLUG} release.yml ${sha:0:7} = ${tag}, GitHub release published"
