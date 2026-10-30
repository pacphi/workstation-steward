#!/usr/bin/env bash
# Shared helpers for workstation-steward scripts. Source it; don't run it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC2034 # SC_ROOT (the engine's supply-chain scripts) is read by supply-chain/bin/*
SC_ROOT="${REPO_ROOT}/supply-chain"
# Locations come from steward.toml (or $STEWARD_CONFIG) over built-in defaults: lib/config.js, D10.
# shellcheck disable=SC2034 # set for scripts that check an add-on (the Node plan reads config.js itself, R5c)
STEWARD_PATHS_STATE="" STEWARD_PATHS_CACHE="" STEWARD_PATHS_MISE_CONFIG_DIR="" STEWARD_PROFILES_AI_TOOLING="" STEWARD_INSTANCE_ROOT="" STEWARD_ENGINE_VERSION=""
# shellcheck disable=SC2034 # read by supply-chain/bin/{node-patch,prune,retire-hybrid}
STEWARD_PATHS_MISE_DATA_DIR="" STEWARD_PATHS_RUFLO_CONFIG_DIR="" STEWARD_PROJECTS_MAX_DEPTH=""
# shellcheck disable=SC2034 # exported with the rest of the config; the IOC sweep reads it in Node (supply-chain/checks/)
STEWARD_PROJECTS_EXCLUDE=() STEWARD_IOC_EXTRA_ROOTS=()
eval "$(node "${REPO_ROOT}/lib/config.js" --shell)"
# Fail here as Node does, not later on a missing file (a $STEWARD_INSTANCE without a steward.toml prints nothing above)
[[ -n "${STEWARD_INSTANCE_ROOT}" ]] || { printf '\033[1;31mERROR\033[0m steward config failed (see the error above)\n' >&2; exit 1; }
# The instance (D39): steward.toml and the policy files, at the same relative paths as here. SC_ROOT stays the engine's
# supply-chain folder (its bin/); SC_INSTANCE is where host.toml, hybrids.toml, verify.tsv and vendor/ live.
INSTANCE_ROOT="${STEWARD_INSTANCE_ROOT}"
SC_INSTANCE="${INSTANCE_ROOT}/supply-chain"
MISE_CONFIG="${STEWARD_PATHS_MISE_CONFIG_DIR}/config.toml"
BACKUP_DIR="${STEWARD_PATHS_MISE_CONFIG_DIR}/backups"
DRY_RUN="${DRY_RUN:-0}"

# Progress (lib/progress.js is the same for Node): every heading shows the time since the command started, so long
# commands report timed milestones; quiet runs a slow, silent step with a live timer. NO_PROGRESS=1 turns timers off.
STEWARD_T0="${STEWARD_T0:-$(date +%s)}"; export STEWARD_T0   # scripts a command starts share its start time
_elapsed() { local s=$(( $(date +%s) - STEWARD_T0 )); printf '%d:%02d' $((s / 60)) $((s % 60)); }
log()  { printf '\033[1;34m==>\033[0m %s \033[2m[%s]\033[0m\n' "$*" "$(_elapsed)"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

# quiet LABEL CMD... — run a slow step that prints nothing useful while it works: its output goes to QUIET_OUT (and a
# log), a terminal shows a live timer, then a ✓ with its time, or ✗ and the log's last lines. Returns CMD's status.
# shellcheck disable=SC2034 # QUIET_OUT is read by the scripts that call quiet
QUIET_OUT=""
quiet() {
  local label="$1"; shift
  local logf start=${SECONDS} ticker="" rc=0
  logf="$(mktemp -t steward-quiet)"
  if [[ -t 2 && "${NO_PROGRESS:-0}" != 1 ]]; then
    ( while :; do printf '\r\033[2K   … %s %ss' "${label}" "$((SECONDS - start))" >&2; sleep 1; done ) & ticker=$!
  else printf '   … %s\n' "${label}" >&2; fi
  "$@" >"${logf}" 2>&1 || rc=$?
  if [[ -n "${ticker}" ]]; then kill "${ticker}" 2>/dev/null; wait "${ticker}" 2>/dev/null || true; printf '\r\033[2K' >&2; fi
  # shellcheck disable=SC2034
  QUIET_OUT="$(cat "${logf}")"
  if (( rc == 0 )); then printf '   \033[1;32m✓\033[0m %s (%ss)\n' "${label}" "$((SECONDS - start))" >&2; rm -f "${logf}"
  else printf '   \033[1;31m✗\033[0m %s: exit %s after %ss; last lines of %s:\n' "${label}" "${rc}" "$((SECONDS - start))" "${logf}" >&2; tail -15 "${logf}" | sed 's/^/     /' >&2; fi
  return "${rc}"
}

# run CMD... — prints the command; skips it when DRY_RUN=1
run() {
  printf '   $ %s\n' "$*"
  [[ "${DRY_RUN}" == "1" ]] || "$@"
}

# run_shown CMD... — run for a slow command whose output matters (npm install -g): prints the command and skips it when
# DRY_RUN=1, as run does. On a terminal it shows a live timer while the command works, then prints all of its output
# (warnings included) and a ✓ or ✗ with its time; elsewhere, or with NO_PROGRESS=1, the output streams as run's does.
# Returns CMD's status.
run_shown() {
  printf '   $ %s\n' "$*"
  [[ "${DRY_RUN}" == "1" ]] && return 0
  if [[ ! -t 2 || "${NO_PROGRESS:-0}" == 1 ]]; then "$@"; return; fi
  local label="$*" logf start=${SECONDS} ticker rc=0
  (( $# > 3 )) && label="$1 $2 … ${*: -1}"   # one short line, so the timer redraws in place
  logf="$(mktemp -t steward-run)"
  ( while :; do printf '\r\033[2K   … %s %ss' "${label}" "$((SECONDS - start))" >&2; sleep 1; done ) & ticker=$!
  "$@" >"${logf}" 2>&1 </dev/null || rc=$?
  kill "${ticker}" 2>/dev/null; wait "${ticker}" 2>/dev/null || true; printf '\r\033[2K' >&2
  cat "${logf}"; rm -f "${logf}"
  if (( rc == 0 )); then printf '   \033[1;32m✓\033[0m %s (%ss)\n' "${label}" "$((SECONDS - start))" >&2
  else printf '   \033[1;31m✗\033[0m %s: exit %s after %ss\n' "${label}" "${rc}" "$((SECONDS - start))" >&2; fi
  return "${rc}"
}

confirm() {
  [[ "${DRY_RUN}" == "1" ]] && return 0
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "${reply}" =~ ^[Yy]$ ]]
}

# Timestamped copy of the global config and lockfile before any mutation; prints the backup stem. A second backup in
# the same second gets -2, -3 …: `steward sc upgrade` runs tools back to back, and one name each keeps the backup
# from before every tool (sharing a name, a later tool's copy overwrote it).
backup_config() {
  local base stamp n=1
  base="$(date +%Y%m%d-%H%M%S)"; stamp="${base}"
  while [[ -e "${BACKUP_DIR}/config.toml.${stamp}" ]]; do n=$((n + 1)); stamp="${base}-${n}"; done
  mkdir -p "${BACKUP_DIR}"
  if [[ "${DRY_RUN}" != "1" ]]; then
    cp -pL "${MISE_CONFIG}" "${BACKUP_DIR}/config.toml.${stamp}"
    [[ -e "${MISE_CONFIG%/*}/mise.lock" ]] && cp -pL "${MISE_CONFIG%/*}/mise.lock" "${BACKUP_DIR}/mise.lock.${stamp}"
  fi
  echo "${BACKUP_DIR}/config.toml.${stamp}"
}

# A running script keeps its PATH after `mise use -g`; re-derive it so node/npm point at the new versions.
refresh_env() {
  [[ "${DRY_RUN}" == "1" ]] && return 0
  eval "$(mise env -s bash)"
  hash -r
}

# user_path PATH — a path the user typed, as an absolute path: ~ expanded, a relative one taken from the folder they
# ran steward in (STEWARD_CWD; scripts run from the engine's area folders)
user_path() {
  # shellcheck disable=SC2088 # the patterns match a literal ~ the user typed; it is expanded below
  case "$1" in
    /*) printf '%s' "$1" ;;
    "~") printf '%s' "${HOME}" ;;
    "~/"*) printf '%s' "${HOME}/${1#\~/}" ;;
    *) printf '%s' "${STEWARD_CWD:-${PWD}}/$1" ;;
  esac
}

# hybrids_json — hybrids.toml as JSON (yq is installed via mise)
hybrids_json() { yq -p toml -o json '.hybrid' "${SC_INSTANCE}/hybrids.toml"; }

active_node_prefix() { "$(mise which node)" -p 'require("path").resolve(process.execPath, "../..")'; }

# Private machine state: install receipts and backups. Never in the repo (backups hold config contents).
STATE_DIR="${STEWARD_PATHS_STATE}"

# hybrid_receipt NAME — JSON recorded by the last install_hybrids of NAME, or nothing
hybrid_receipt() { cat "${STATE_DIR}/hybrids/$1.json" 2>/dev/null || true; }

write_hybrid_receipt() { # name version scripts
  mkdir -p "${STATE_DIR}/hybrids"
  printf '{"name":"%s","version":"%s","allow_scripts":"%s","node":"%s","installed_at":"%s","engine":"%s"}\n' \
    "$1" "$2" "$3" "$(node -p 'process.versions.node')" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${STEWARD_ENGINE_VERSION}" \
    >"${STATE_DIR}/hybrids/$1.json"
}

# write_change_receipt KIND WHAT — record a mise change (upgrade-tool, node-patch); it starts a soak (lib/soak.js)
write_change_receipt() {
  [[ "${DRY_RUN}" == "1" ]] && return 0
  mkdir -p "${STATE_DIR}/changes" && chmod 700 "${STATE_DIR}"
  printf '{"kind":"%s","what":"%s","at":"%s","engine":"%s"}\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${STEWARD_ENGINE_VERSION}" \
    >"${STATE_DIR}/changes/$(date -u +%Y%m%dT%H%M%SZ)-$1.json"
}

# ruflo_policy_dirs — every Ruflo policy folder under $HOME (Ruflo writes one wherever it ran: projects,
# ~/Documents/Codex, ~/.codex/.chatgpt-projects, ~/.swarm …) down to [projects] max_depth, plus [paths]
# ruflo_config_dir, which holds the trust anchors.
ruflo_policy_dirs() {
  local prune=(-path "${HOME}/Library" -o -path "${HOME}/.Trash" -o -name node_modules -o -name .git -o -path "${STATE_DIR}")
  local x
  for x in ${STEWARD_PROJECTS_EXCLUDE[@]+"${STEWARD_PROJECTS_EXCLUDE[@]}"}; do prune+=(-o -path "${x}"); done
  find "${HOME}" -maxdepth "${STEWARD_PROJECTS_MAX_DEPTH}" \( "${prune[@]}" \) -prune -o -type d -path '*/.claude-flow/policy' -print 2>/dev/null | sort
  if [[ -d "${STEWARD_PATHS_RUFLO_CONFIG_DIR}" ]]; then echo "${STEWARD_PATHS_RUFLO_CONFIG_DIR}"; fi
}

# Clone (APFS) every Ruflo policy folder into a timestamped private backup. Restore one by copying
# home/<path> back over <path> with Ruflo stopped; restore the project's folder and ~/.config/ruflo together.
backup_ruflo_policy() {
  local dest dirs d n=0
  dest="${STATE_DIR}/backups/ruflo-policy-$(date +%Y%m%d-%H%M%S)"
  # the search walks $HOME (about 50 s on a full one): a live timer, so it doesn't look hung
  quiet "finding Ruflo policy folders" ruflo_policy_dirs; dirs="${QUIET_OUT}"
  log "Ruflo policy backup: $(grep -c . <<<"${dirs}") folder(s) → ${dest/#${HOME}/~}"
  [[ "${DRY_RUN}" == "1" ]] && return 0
  mkdir -p "${dest}/home" && chmod 700 "${STATE_DIR}" "${dest}"
  while IFS= read -r d; do
    [[ -n "${d}" ]] || continue
    mkdir -p "${dest}/home/$(dirname "${d#"${HOME}"/}")"
    cp -cpR "${d}" "${dest}/home/${d#"${HOME}"/}" || die "Ruflo policy backup failed at ${d}"
    n=$((n + 1))
  done <<<"${dirs}"
  printf '%s\n' "${dirs}" >"${dest}/paths.txt"
  log "backed up ${n} folder(s)"
}

# Install every hybrid with npm -g into the currently active Node, using its reviewed script allow-list,
# and record a receipt. A hybrid with state_backup = "ruflo-policy" gets the policy backup first whenever
# the version differs from its last receipt (or no receipt exists).
install_hybrids() {
  local n i name version source scripts spec backup prev
  n="$(hybrids_json | yq '. | length')"
  for ((i = 0; i < n; i++)); do
    name="$(hybrids_json | yq -r ".[$i].name")"
    version="$(hybrids_json | yq -r ".[$i].version")"
    source="$(hybrids_json | yq -r ".[$i].source")"
    scripts="$(hybrids_json | yq -r ".[$i].allow_scripts | join(\",\")")"
    backup="$(hybrids_json | yq -r ".[$i].state_backup // \"\"")"
    if [[ "${source}" == "registry" ]]; then spec="${name}@${version}"; else spec="${SC_INSTANCE}/${source}"; fi
    if [[ "${backup}" == "ruflo-policy" ]]; then
      prev="$(hybrid_receipt "${name}" | yq -p json -r '.version // ""')"
      [[ "${prev}" == "${version}" ]] || { log "${name}: last receipt ${prev:-none} → ${version}"; backup_ruflo_policy; }
    fi
    # Install each hybrid on its own: a shared npm transaction dedupes optional deps across them
    # (seen 2026-10-21 with ruflo + agentdb) and changes which copies resolve.
    if [[ -n "${scripts}" ]]; then
      run_shown npm install -g --allow-scripts="${scripts}" "${spec}"
    else
      run_shown npm install -g "${spec}"
    fi
    [[ "${DRY_RUN}" == "1" ]] || write_hybrid_receipt "${name}" "${version}" "${scripts}"
  done
}

# hybrid_receipt_ok NAME — true when NAME's receipt matches hybrids.toml (version, allow-scripts) and the
# active Node, i.e. the install on disk is the reviewed one.
hybrid_receipt_ok() {
  local r want_v want_s
  r="$(hybrid_receipt "$1")"
  [[ -n "${r}" ]] || return 1
  want_v="$(hybrids_json | yq -r ".[] | select(.name == \"$1\") | .version")"
  want_s="$(hybrids_json | yq -r ".[] | select(.name == \"$1\") | .allow_scripts | join(\",\")")"
  [[ "$(yq -p json -r '.version' <<<"${r}")" == "${want_v}" &&
    "$(yq -p json -r '.allow_scripts' <<<"${r}")" == "${want_s}" &&
    "$(yq -p json -r '.node' <<<"${r}")" == "$(node -p 'process.versions.node')" ]]
}

# ---- host helpers (bin/status) ------------------------------------------------------------------------------
# Homebrew, the release-age gate and security exceptions are Node since R5c (lib/providers/, supply-chain/checks/, D43).

# host_json — the host policy as JSON: the engine's defaults under the instance's host.toml (lib/host.js, D40). A script
# that reads it in a loop sets STEWARD_HOST_JSON="$(host_json)" once, and later calls reuse it.
host_json() { if [[ -n "${STEWARD_HOST_JSON:-}" ]]; then printf '%s\n' "${STEWARD_HOST_JSON}"; else node "${REPO_ROOT}/lib/host.js" --json; fi; }
