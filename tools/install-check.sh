#!/usr/bin/env bash
# The install check (parity 1d, T.4 and T.7): the steward installed on a fresh machine the way a maintainer's machine
# runs it (D41, D48), checked at each step. It runs on the Install check workflow's macOS runner and, through
# `just linux-test <id> --install-check` (tools/linux-test.js), inside a container for each row of
# test/containers/matrix.json. Usage: tools/install-check.sh <subject>, where <subject> is a checkout of the commit to
# install (any commit: worktree mode, R-2) or of a release tag (IC_VERSION=X.Y.Z: worktree mode, then npm mode).
#   1. worktree mode, from just release-worktree; steward version before and after steward init
#   2. the fresh config checks out, and mise is linked to it
#   3. npm mode, from steward sc upgrade-tool (a released version whose package.json os names this platform)
#   4. steward check, and the plugin folder as Claude Code builds it (sh, from home)
#   5. the skills plugin, from steward skills install
#   6. back to worktree mode, from steward sc rollback (after 3)
# Inputs (environment): IC_VERSION (a release), IC_REF (a commit to move the subject to first; linux-test --ref),
# CLAUDE_CODE (the Claude Code version for 5), RELEASE_AGE_DAYS (for this run only, the gate in 3). Each result is a
# `SUMMARY <text>` line, also appended to $GITHUB_STEP_SUMMARY when set; the last line is `install check: passed`.
# It writes ~/.local/bin/steward, the release worktree and ~/.config, so it refuses to run anywhere but a CI runner or
# a linux-test container that says STEWARD_INSTALL_CHECK=1. Engine tooling: not part of the npm package.

# say TEXT — one result: a SUMMARY line, and the job summary when there is one
say() {
  echo "SUMMARY $*"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$*" >> "${GITHUB_STEP_SUMMARY}"; fi
}

# ic_expected DIR — the line `steward version` prints for the release worktree DIR, worked out as bin/steward.js
# build() works it out: release <package.json version> (<the tag at HEAD, else branch@short; HEAD@short when detached>)
ic_expected() {
  local dir="$1" ver at
  ver="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "${dir}/package.json")"
  at="$(git -C "${dir}" describe --tags --exact-match 2>/dev/null)" \
    || at="$(git -C "${dir}" rev-parse --abbrev-ref HEAD)@$(git -C "${dir}" rev-parse --short HEAD)"
  echo "release ${ver} (${at})"
}

# ic_npm_mode DIR PLATFORM — whether npm mode runs: only for a released version (IC_VERSION), and only when its
# package.json os names PLATFORM (darwin, linux), since npm refuses any other; says why when it doesn't
ic_npm_mode() {
  local dir="$1" platform="$2" oses
  [[ -n "${IC_VERSION:-}" ]] || return 1
  oses="$(node -e 'const o=require(process.argv[1]).os; process.stdout.write(Array.isArray(o) ? o.join(", ") : "")' "${dir}/package.json")"
  [[ -z "${oses}" || ", ${oses}, " == *", ${platform}, "* ]] && return 0
  echo "npm mode: skipped (${IC_VERSION}'s package.json os is ${oses} only)"
  return 1
}

# ic_on_main DIR — whether DIR's commit is on origin/main; one that isn't still runs, and says it doesn't count for the
# release bar (owner, 2026-11-03)
ic_on_main() {
  local dir="$1"
  if ! git -C "${dir}" rev-parse --verify -q refs/remotes/origin/main >/dev/null; then echo 'on main: unknown (no origin/main here)'
  elif git -C "${dir}" merge-base --is-ancestor HEAD refs/remotes/origin/main; then echo 'on main: yes'
  else echo "NOT on main: doesn't count for the release bar"; fi
}

# activate — mise on PATH the way a maintainer's shell has it (mise activate, no shims), then the launchers
activate() {
  eval "$(mise activate bash)"
  eval "$(mise hook-env -s bash)"
  export PATH="${HOME}/.local/bin:${PATH}"
  hash -r
}

main() {
  set -euo pipefail
  if ! [[ "${GITHUB_ACTIONS:-}" == true || ((-f /.dockerenv || -n "${container:-}") && "${STEWARD_INSTALL_CHECK:-}" == 1) ]]; then
    echo "ERROR install-check.sh runs only on a CI runner or in a linux-test container: it writes ~/.local/bin/steward, the release worktree and ~/.config" >&2
    exit 2
  fi
  local subject="${1:?usage: install-check.sh <subject checkout>}" platform target out before dir expected
  subject="$(cd "${subject}" && pwd)"
  cd "${subject}"
  [[ -z "${IC_VERSION:-}" || "${IC_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "IC_VERSION is not X.Y.Z: ${IC_VERSION}"; exit 1; }
  [[ "${CLAUDE_CODE:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "CLAUDE_CODE is not X.Y.Z: ${CLAUDE_CODE:-}"; exit 1; }
  [[ -z "${RELEASE_AGE_DAYS:-}" || "${RELEASE_AGE_DAYS}" =~ ^[0-9]+$ ]] || { echo "RELEASE_AGE_DAYS is not a number"; exit 1; }
  if [[ -n "${IC_REF:-}" ]]; then git -c advice.detachedHead=false checkout -q --detach "${IC_REF}"; fi
  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo "ERROR not macOS or Linux"; exit 1 ;; esac
  if [[ -n "${IC_VERSION:-}" ]]; then target="v${IC_VERSION}"; else target="$(git rev-parse HEAD)"; fi
  local where="${platform}"
  if [[ -f /etc/os-release ]]; then where="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '"')"; fi
  say "## Install check: workstation-steward ${IC_VERSION:-at $(git rev-parse --short HEAD)} on ${where}"
  say "$(ic_on_main "${subject}") ($(git rev-parse HEAD))"

  echo "== 1. Worktree mode, from just release-worktree; steward version before and after steward init"
  export MISE_GLOBAL_CONFIG_FILE="${subject}/examples/mise/config.toml"
  mise install
  activate
  echo y | just release-worktree "${target}"
  dir="${STEWARD_RELEASE:-${HOME}/.local/share/workstation-steward/release}"
  # before any config: version answers and points at init (the first install check found it failing; fixed in 0.2.1)
  before="$(steward version)"; echo "${before}"
  grep -qF "no steward.toml yet: steward init" <<<"${before}" || { echo "expected version to point at steward init"; exit 1; }
  steward init --yes
  out="$(steward version)"; echo "${out}"
  expected="$(ic_expected "${dir}")"
  grep -qF "${expected}" <<<"${out}" || { echo "expected: ${expected}"; exit 1; }
  say "1. worktree mode: \`$(head -1 <<<"${out}")\`"

  echo "== 2. The fresh config checks out, and mise is linked to it"
  steward config --check
  steward sc link
  ls -l "${HOME}/.config/mise/"
  say "2. config checks out; mise linked: \`$(readlink "${HOME}/.config/mise/config.toml")\`"
  # from here on, mise reads what steward sc link made, as on a maintainer's machine
  unset MISE_GLOBAL_CONFIG_FILE
  mise install
  activate

  local npm=0
  if ic_npm_mode "${subject}" "${platform}"; then npm=1; else
    if [[ -n "${IC_VERSION:-}" ]]; then say "$(ic_npm_mode "${subject}" "${platform}" || true)"; else say "3. npm mode: not run (a ref is worktree mode only; npm mode is for a released version, R-2)"; fi
  fi
  if [[ ${npm} == 1 ]]; then
    echo "== 3. npm mode, from steward sc upgrade-tool"
    if [[ -n "${RELEASE_AGE_DAYS:-}" ]]; then
      echo y | steward sc release-age "${RELEASE_AGE_DAYS}"
      say "3. the release-age gate lowered to ${RELEASE_AGE_DAYS} day(s) for this run (input)"
    fi
    # the provenance record must name THIS repository and its release workflow, not merely exist
    local repo="${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}"
    [[ "${repo}" != / ]] || repo="$(git remote get-url origin | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##')"
    curl -fsS "https://registry.npmjs.org/-/npm/v1/attestations/workstation-steward@${IC_VERSION}" | REPO="${repo}" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).attestations.find(x=>/slsa/.test(x.predicateType));const w=a&&JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload,"base64").toString()).predicate.buildDefinition.externalParameters.workflow;if(!w||w.repository!==process.env.REPO||w.path!==".github/workflows/release.yml"){console.error("provenance does not name",process.env.REPO,"release.yml:",JSON.stringify(w));process.exit(1)}console.log("provenance:",w.repository,w.path,w.ref)})'
    # then the pin; allow_low_downloads approves a package name younger than 30 days,
    # which mise's npm installer otherwise refuses (this one's until 2026-11-27; the third install check found it)
    steward sc upgrade-tool "npm:workstation-steward[allow_low_downloads=true]" "${IC_VERSION}"
    activate
    echo "steward is $(command -v steward)"
    out="$(steward version)"; echo "${out}"
    grep -qF "release ${IC_VERSION} (npm)" <<<"${out}" || { echo "expected: release ${IC_VERSION} (npm)"; exit 1; }
    say "3. npm mode: \`$(head -1 <<<"${out}")\` from \`$(command -v steward)\`"
  fi

  echo "== 4. steward check, and the plugin folder as Claude Code builds it (sh, from home)"
  steward check
  local plug
  plug="$(cd ~ && sh -c 'steward skills path')"
  ls "${plug}/skills"
  [[ -f "${plug}/.claude-plugin/plugin.json" && -f "${plug}/skills/supply-chain/SKILL.md" ]] || { echo "no plugin in ${plug}"; exit 1; }
  say "4. check passed; plugin folder holds: $(cd "${plug}/skills" && printf '%s ' *)"

  echo "== 5. The skills plugin, from steward skills install"
  npm install -g --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE}"
  hash -r; claude --version
  steward skills install --yes
  claude plugin list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(x=>x.id==="steward@workstation-steward");if(!p||!p.enabled){console.error("steward@workstation-steward is not installed and enabled");process.exit(1)}console.log(JSON.stringify(p))})'
  say "5. plugin: \`steward@workstation-steward\` installed and enabled (Claude Code ${CLAUDE_CODE})"

  if [[ ${npm} == 1 ]]; then
    echo "== 6. Back to worktree mode, from steward sc rollback"
    printf 'y\ny\n' | steward sc rollback
    activate
    echo "steward is $(command -v steward)"
    out="$(steward version)"; echo "${out}"
    grep -qF "${expected}" <<<"${out}" || { echo "expected: ${expected}"; exit 1; }
    plug="$(cd ~ && sh -c 'steward skills path')"; ls "${plug}/skills"
    say "6. back to worktree mode: \`$(head -1 <<<"${out}")\`; the plugin's command still answers"
  fi
  echo "install check: passed"
}

# sourced (the tests call its functions one by one), main doesn't run
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
