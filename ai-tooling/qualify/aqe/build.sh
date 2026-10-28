#!/usr/bin/env bash
# The build step of run.sh (its environment: QW, QSTAGE, QCURRENT, QNODEBIN, QVERSION, QRELEASE).
# 1. clone the upstream tag; rebuild it unpatched and pack it: the tarball should be byte-identical to the official
#    one from the registry (the 10-21 lane's was), which shows the build reproduces upstream's
# 2. apply patches/ (git apply --check first), rebuild, pack; diff the statements against the official package
# 3. stage the release like the current one: artifacts/<tgz>, the current release's package.json with agentic-qe
#    pointing at the new tarball, its bin/, runtime/ and models/ unchanged, and npm install with the allowScripts
#    the package.json names, compiling natives against this Node's headers
# 4. check the stage: every newly resolved package is past the release-age gate, the installed dist matches the
#    packed tarball, and bin/aqe reports the version
# The build runs with HOME, npm's cache and its user config inside the workspace, and no XDG variables.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${QW:?run through run.sh}"
# shellcheck source=lib/lib.sh
source "${here}/../../../lib/lib.sh"   # log (timed headings), quiet (a live timer for the slow, silent npm steps)
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR FORCE_COLOR
mkdir -p "${QW}/home-build"
export HOME="${QW}/home-build" npm_config_cache="${QW}/npm-cache" npm_config_userconfig="${QW}/home-build/.npmrc"
export PATH="${QNODEBIN}:/usr/bin:/bin:/usr/sbin:/sbin"
tag="v${QVERSION}" logs="${QW}/logs"
say() { log "$@"; }
fail() { die "$@"; }
logged() { local f="$1"; shift; "$@" >"${f}" 2>&1; }   # logged FILE CMD…: CMD's output into the workspace log
in_dir() { local d="$1"; shift; (cd "${d}" && "$@"); }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

say "upstream ${tag}"
[[ -d "${QW}/src" ]] || quiet "clone ${tag}" git clone -q --depth 1 --branch "${tag}" https://github.com/proffesor-for-testing/agentic-qe.git "${QW}/src"
git -C "${QW}/src" rev-parse HEAD > "${QW}/evidence/source-commit.txt"
mkdir -p "${QW}/official"
[[ -f "${QW}/official/agentic-qe-${QVERSION}.tgz" ]] || quiet "download the official tarball" logged "${logs}/official-pack.log" in_dir "${QW}/official" npm pack "agentic-qe@${QVERSION}"
want="$(npm view "agentic-qe@${QVERSION}" dist.shasum)"
[[ "$(shasum "${QW}/official/agentic-qe-${QVERSION}.tgz" | cut -d' ' -f1)" == "${want}" ]] || fail "official tarball doesn't match the registry's shasum"

say "unpatched rebuild"
git -C "${QW}/src" checkout -q -- .
quiet "npm ci (the tag's dev dependencies)" logged "${logs}/src-npm-ci.log" in_dir "${QW}/src" npm ci
quiet "npm run build (unpatched)" logged "${logs}/baseline-build.log" in_dir "${QW}/src" npm run build
mkdir -p "${QW}/baseline-pack"
quiet "npm pack (unpatched)" logged "${logs}/baseline-pack.log" in_dir "${QW}/src" npm pack --ignore-scripts --pack-destination "${QW}/baseline-pack"
same=false; [[ "$(sha "${QW}/baseline-pack/agentic-qe-${QVERSION}.tgz")" == "$(sha "${QW}/official/agentic-qe-${QVERSION}.tgz")" ]] && same=true
echo "${same}" > "${QW}/evidence/baseline-identical-to-official.txt"
say "unpatched rebuild byte-identical to the official tarball: ${same}"

say "patches"
for p in "${here}"/patches/*.patch; do
  git -C "${QW}/src" apply --check "${p}" || fail "$(basename "${p}") doesn't apply to ${tag}: re-fit it, or drop it if upstream superseded it"
  git -C "${QW}/src" apply "${p}"
  echo "$(basename "${p}") $(sha "${p}")" >> "${QW}/evidence/patches-applied.txt"
done
git -C "${QW}/src" diff > "${QW}/evidence/patched-source.diff"
quiet "npm run build (patched)" logged "${logs}/patched-build.log" in_dir "${QW}/src" npm run build
mkdir -p "${QW}/patched-pack"
quiet "npm pack (patched)" logged "${logs}/patched-pack.log" in_dir "${QW}/src" npm pack --ignore-scripts --pack-destination "${QW}/patched-pack"
for k in official patched-pack; do mkdir -p "${QW}/unpacked/${k}" && tar -xzf "${QW}/${k}/agentic-qe-${QVERSION}.tgz" -C "${QW}/unpacked/${k}"; done
python3 -I "${here}/gates/stmt_diff.py" "${QW}/unpacked/official/package" "${QW}/unpacked/patched-pack/package" > "${QW}/evidence/statement-diff-official-vs-patched.json"
python3 -I "${here}/gates/stmt_diff_norm.py" "${QW}/evidence/statement-diff-official-vs-patched.json" > "${QW}/evidence/statement-diff-normalised.json"

say "stage ${QSTAGE/#${QW}/<workspace>}"
[[ -e "${QSTAGE}" ]] && fail "${QSTAGE} exists: remove the workspace to rebuild"
mkdir -p "${QSTAGE}/artifacts"
cp "${QW}/patched-pack/agentic-qe-${QVERSION}.tgz" "${QSTAGE}/artifacts/"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));p.dependencies["agentic-qe"]="file:artifacts/agentic-qe-"+process.argv[2]+".tgz";fs.writeFileSync(process.argv[3],JSON.stringify(p,null,2)+"\n")' \
  "${QCURRENT}/package.json" "${QVERSION}" "${QSTAGE}/package.json"
cp -R "${QCURRENT}/bin" "${QCURRENT}/runtime" "${QCURRENT}/models" "${QSTAGE}/"
before="$(date -u -v-"${STEWARD_POLICY_MIN_RELEASE_AGE_DAYS:-3}"d +%Y-%m-%dT%H:%M:%SZ)"
npm_config_build_from_source=true npm_config_nodedir="$(dirname "${QNODEBIN}")" \
  quiet "npm install the stage (natives compiled here)" logged "${logs}/stage-npm-install.log" in_dir "${QSTAGE}" npm install --before="${before}" \
  || fail "stage npm install failed: ${logs}/stage-npm-install.log"
quiet "release-age check of the stage's new packages" logged "${QW}/evidence/stage-lock-age.json" node "${here}/lock-age.js" "${QSTAGE}/package-lock.json" "${STEWARD_POLICY_MIN_RELEASE_AGE_DAYS:-3}" "${QCURRENT}/package-lock.json" \
  || fail "a newly resolved package is under the release-age gate: ${QW}/evidence/stage-lock-age.json"
python3 -I "${here}/gates/dist_matches.py" "${QW}/unpacked/patched-pack/package" "${QSTAGE}/node_modules/agentic-qe" > "${QW}/evidence/stage-dist-matches-pack.json" \
  || fail "the installed dist differs from the packed tarball"
mkdir -p "${QW}/proj-version"   # AQE binds to the folder it runs in: never this repo or HOME
got="$(cd "${QW}/proj-version" && "${QSTAGE}/bin/aqe" --version 2>/dev/null | tail -1)"
[[ "${got}" == *"${QVERSION}"* ]] || fail "staged bin/aqe reports '${got}', not ${QVERSION}"
say "staged ${QRELEASE}: bin/aqe --version → ${got}"
