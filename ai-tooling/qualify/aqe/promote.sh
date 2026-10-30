#!/usr/bin/env bash
# Promote a qualified AQE release into the shared runtime (the recipe's steps 4-6), after the owner's yes.
# Usage: ai-tooling/qualify/aqe/promote.sh <version>        (DRY_RUN=1: the checks and the plan, no changes)
#        ai-tooling/qualify/aqe/promote.sh --rollback <receipt.json>   point current back at the previous release
# 1. refuse unless the workspace receipt says every gate passed
# 2. back up every AQE store of the registry's AQE projects: an APFS clone of memory.db, -wal and -shm, taken only
#    while no process holds it, and compared byte for byte (never opened as a database)
# 3. install the stage as <runtime>/releases/<release> (a clone; its tree hash must equal the stage's)
# 4. switch <runtime>/current to it in one rename, and write a receipt (kind aqe-promote: it starts a soak)
# Rollback: --rollback relinks current to the receipt's previous release; releases and backups stay.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/lib.sh
source "${here}/../../../lib/lib.sh"
policy_value() { node -e 'const C=require(process.argv[1]);const v=process.argv[2].split(".").reduce((o,k)=>o[k],C.policy("ai-tooling/ai-tooling.toml"));process.stdout.write(String(v))' "${REPO_ROOT}/lib/config.js" "$1"; }
runtime="$(policy_value aqe.runtime)"
tree() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }
relink() { # relink <release name>: current -> releases/<name>, by renaming a new link over the old one
  ln -s "releases/$1" "${runtime}/current.promote-$$"
  mv -h "${runtime}/current.promote-$$" "${runtime}/current"
}

if [[ "${1:-}" == "--rollback" ]]; then
  rc="${2:?usage: promote.sh --rollback <receipt.json>}"
  prev="$(node -p 'require(process.argv[1]).previous' "${rc}")"
  [[ -d "${runtime}/releases/${prev}" ]] || die "releases/${prev} is gone"
  log "current: $(readlink "${runtime}/current") -> releases/${prev}"
  confirm "Relink current to ${prev}?" || { log "nothing changed"; exit 0; }
  [[ "${DRY_RUN}" == 1 ]] || relink "${prev}"
  log "current -> $(readlink "${runtime}/current")"; exit 0
fi

version="${1:?usage: promote.sh <version>}"; release="${version}-local.1"
ws="${STEWARD_PATHS_CACHE}/qualify/aqe-${release}" stage="${STEWARD_PATHS_CACHE}/qualify/aqe-${release}/stage/${release}"
[[ "$(node -p 'require(process.argv[1]).allPass' "${ws}/receipt.json" 2>/dev/null)" == true ]] || die "no passing qualification receipt in ${ws/#${HOME}/~} (run.sh ${version} receipt)"
prev="$(basename "$(readlink "${runtime}/current")")"
# a run that stopped part-way leaves evidence: refuse it with the step that finishes the job, never build on top of it
# (a rerun would copy the stage INTO a leftover releases/<r>.partial, and the tree hash would never match)
part="${runtime}/releases/${release}.partial"
[[ -e "${part}" ]] && die "a previous promote of ${release} stopped while installing it; current still -> ${prev}. Remove the leftover, then run this again: rm -rf ${part/#${HOME}/~}"
if [[ -e "${runtime}/releases/${release}" ]]; then
  [[ "${prev}" == "${release}" ]] && die "${release} is already promoted (current -> releases/${release})"
  # kept by a rollback (promote.sh --rollback keeps releases), or installed by a promote that stopped before the switch
  die "releases/${release} exists but current -> ${prev} (a rollback keeps it; or a promote stopped before switching). This won't overwrite it: to reinstall, remove it first (rm -rf ${runtime/#${HOME}/~}/releases/${release})"
fi
stores=()
while IFS= read -r f; do stores+=("${f}"); done < <(node -e '
const P=require(process.argv[1]),fs=require("fs"),path=require("path");
for(const r of P.loadRegistry().filter(r=>r.decision==="onboarded"&&(r.ai||[]).includes("aqe")&&P.exists(r.abs)))
  for(const f of ["memory.db","memory.db-wal","memory.db-shm"]){const p=path.join(r.abs,".agentic-qe",f);if(fs.existsSync(p))console.log(p)}' "${REPO_ROOT}/lib/projects.js")
log "promote AQE ${release}: current ${prev} -> ${release}; ${#stores[@]} store file(s) to back up"
held=()
for f in ${stores[@]+"${stores[@]}"}; do lsof -t -- "${f}" >/dev/null 2>&1 && held+=("${f/#${HOME}/~}"); done
[[ ${#held[@]} -eq 0 ]] || die "held open by a running process (close it first): ${held[*]}"
[[ "${DRY_RUN}" == 1 ]] && { log "dry run: nothing changed"; exit 0; }
confirm "Back up ${#stores[@]} store file(s), install ${release} and switch current?" || { log "nothing changed"; exit 0; }

dir="$(node -e 'process.stdout.write(require(process.argv[1]).newBackupDir("aqe-promote"))' "${REPO_ROOT}/lib/config.js")"
log "store backups → ${dir/#${HOME}/~}/stores"
i=0
for f in ${stores[@]+"${stores[@]}"}; do
  i=$((i + 1)); [[ -t 2 ]] && printf '\r\033[2K   … store %s/%s' "${i}" "${#stores[@]}" >&2
  rel="${f#"${HOME}"/}" dst="${dir}/stores/${f#"${HOME}"/}"
  mkdir -p "$(dirname "${dst}")"
  cp -c -p "${f}" "${dst}"
  cmp -s "${f}" "${dst}" || die "backup of ~/${rel} differs from its source: stopping before anything is switched"
done
[[ -t 2 ]] && printf '\r\033[2K' >&2
chmod -R go-rwx "${dir}"
log "install releases/${release}"
quiet "clone the stage into releases/" cp -c -R "${stage}" "${runtime}/releases/${release}.partial"
quiet "hash the stage" tree "${stage}"; want="${QUIET_OUT}"
quiet "hash the installed copy" tree "${runtime}/releases/${release}.partial"
[[ "${QUIET_OUT}" == "${want}" ]] || die "installed tree differs from the stage"
mv "${runtime}/releases/${release}.partial" "${runtime}/releases/${release}"
chmod 700 "${runtime}/releases/${release}"
mkdir -p "${ws}/proj-relocation"
got="$(cd "${ws}/proj-relocation" && "${runtime}/releases/${release}/bin/aqe" --version 2>/dev/null | tail -1)"
[[ "${got}" == *"${version}"* ]] || die "installed bin/aqe reports '${got}'"
relink "${release}"
node -e 'const fs=require("fs");const [f,rel,prev,ws,n,tree]=process.argv.slice(1);fs.writeFileSync(f,JSON.stringify({kind:"aqe-promote",at:new Date().toISOString(),release:rel,previous:prev,qualification:ws+"/receipt.json",storeFiles:Number(n),treeSha256:tree,files:[]},null,1)+"\n",{mode:0o600})' \
  "${dir}/receipt.json" "${release}" "${prev}" "${ws}" "${#stores[@]}" "${want}"
log "current -> $(readlink "${runtime}/current"); receipt ${dir/#${HOME}/~}/receipt.json"
log "rollback: ai-tooling/qualify/aqe/promote.sh --rollback ${dir/#${HOME}/~}/receipt.json"
