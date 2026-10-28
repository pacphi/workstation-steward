#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# lock-fix.sh: one advisory, one package, one PR. A lockfile-level security bump in a fresh clone,
# checked against the release-age rule and the repo's own CI audit command.
# For advisories that land after a consolidation PR (ampel#90, emailibrium#312, a Rust app's ctutils).
#
# Usage:
#   lock-fix.sh [options] OWNER/REPO BASE DIR PACKAGE VERSION ADVISORY
#     DIR        directory (relative to the repo root) holding Cargo.lock or go.mod; '.' for root
#     PACKAGE    crate name (Rust) or module path (Go)
#     ADVISORY   RUSTSEC-..., GHSA-..., GO-... or another OSV id
#   Required:
#     --why TEXT        one line on what the advisory is, for the commit and PR body
#     --audit CMD       the repo's CI audit command, run from the clone root, e.g.
#                       'bash .github/scripts/cargo-audit.sh --no-fetch' or 'cargo audit && cargo deny check'
#   Options:
#     --scratch DIR     where to clone (default: $PR_CONSOLIDATION_SCRATCH; never under ~/Development)
#     --from OLD        the version to move from, when the lockfile has several (Rust)
#     --first-patched   allow VERSION although it is younger than the release-age window. Use only
#                       when VERSION is the FIRST patched release in GHSA, RustSec or OSV.
#     --days N          release-age window in days (default: steward.toml min_release_age_days, else 3)
#     --type TYPE       conventional-commit type (default fix; use chore for release-please repos
#                       when the change is dev-only)
#     --signoff         git commit -s (repos with a DCO check)
#     --trailer LINE    append LINE to the commit message. Default: none. Attribution follows the
#                       repo's .claude/settings.json; see AGENTS.md.
#     --execute         commit, push and open the PR. Without it the script stops after the audit
#                       and shows the diff.
#
# Supported: Rust (cargo update -p PKG@OLD --precise VERSION; only the Cargo.lock may change) and
# Go (go get PKG@VERSION && go mod tidy; only go.mod and go.sum may change). For npm/pnpm
# transitive fixes use the override technique in ecosystems/node.md instead.
# A one-package PR can't go green while the base has OTHER open advisories (emailibrium main had
# 15 when the ctutils fix was tried there); the audit step shows that before anything is pushed.
#
# Exit: 0 done or nothing to do, 1 a check failed, 2 usage error.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/_lib.sh"
need gh git jq curl

why="" audit="" scratch=${PR_CONSOLIDATION_SCRATCH:-} from="" first=0 days=$(default_days) ctype=fix
signoff=0 trailer="" execute=0
pos=""
while [ $# -gt 0 ]; do
  case "$1" in
    --why) why=${2:?}; shift 2 ;;
    --audit) audit=${2:?}; shift 2 ;;
    --scratch) scratch=${2:?}; shift 2 ;;
    --from) from=${2:?}; shift 2 ;;
    --first-patched) first=1; shift ;;
    --days) days=${2:?}; shift 2 ;;
    --type) ctype=${2:?}; shift 2 ;;
    --signoff) signoff=1; shift ;;
    --trailer) trailer=${2:?}; shift 2 ;;
    --execute) execute=1; shift ;;
    -h|--help) awk 'NR > 2 && /^#/ {sub(/^# ?/, ""); print; next} NR > 2 {exit}' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) pos="$pos$1
"; shift ;;
  esac
done
set --
while IFS= read -r p; do [ -z "$p" ] || set -- "$@" "$p"; done <<EOF
$pos
EOF
[ $# -eq 6 ] || die "usage: lock-fix.sh [options] OWNER/REPO BASE DIR PACKAGE VERSION ADVISORY (see --help)"
repo=$1 base=$2 dir=$3 pkg=$4 ver=$5 adv=$6
[ -n "$why" ] || die "--why is required"
[ -n "$audit" ] || die "--audit is required (mirror the CI audit step exactly)"
[ -n "$scratch" ] || die "--scratch or PR_CONSOLIDATION_SCRATCH is required"
case "$scratch" in "$HOME"/Development|"$HOME"/Development/*) die "refusing to clone under ~/Development" ;; esac

adv_url() {
  case "$1" in
    RUSTSEC-*) echo "https://rustsec.org/advisories/$1.html" ;;
    GHSA-*) echo "https://github.com/advisories/$1" ;;
    GO-*) echo "https://pkg.go.dev/vuln/$1" ;;
    *) echo "https://osv.dev/vulnerability/$1" ;;
  esac
}

# --- clone and detect the ecosystem -----------------------------------------------------------
name=${repo##*/}-$base-$(printf '%s' "${pkg##*/}" | tr -c 'A-Za-z0-9._-' '-')
mkdir -p "$scratch"
clone="$scratch/lockfix-$name"
rm -rf "$clone"
gh repo clone "$repo" "$clone" -- -q -b "$base" --recurse-submodules >&2
cd "$clone"
[ -d "$dir" ] || die "no directory $dir in $repo@$base"

if [ -f "$dir/Cargo.lock" ]; then
  eco=rust
  need cargo
  lock=$dir/Cargo.lock; [ "$dir" = . ] && lock=Cargo.lock
  allowed=$lock
  published=$(curl -fsS -A 'pr-consolidation-lock-fix' "https://crates.io/api/v1/crates/$pkg/$ver" | jq -r '.version.created_at // empty')
elif [ -f "$dir/go.mod" ]; then
  eco=go
  need go
  gm=$dir/go.mod; gs=$dir/go.sum; [ "$dir" = . ] && { gm=go.mod; gs=go.sum; }
  allowed="$gm $gs"
  esc() { printf '%s' "$1" | sed 's/[A-Z]/!&/g' | tr '[:upper:]' '[:lower:]'; }
  published=$(curl -fsS "https://proxy.golang.org/$(esc "$pkg")/@v/$(esc "$ver").info" | jq -r '.Time // empty')
else
  die "$dir has neither Cargo.lock nor go.mod"
fi
# --- release age ------------------------------------------------------------------------------
[ -n "$published" ] || die "can't find $pkg $ver in the registry"
age=$(iso_age_days "$published")
cutoff=$(cutoff_iso "$days")
young=0
[ "$(printf '%.19s' "$published")" \> "$(printf '%.19s' "$cutoff")" ] && young=1
if [ "$young" -eq 1 ] && [ "$first" -eq 0 ]; then
  die "$pkg $ver was published $published ($age days ago), inside the ${days}-day window. Pass --first-patched only if it is the first patched release for $adv."
fi

# --- update ---------------------------------------------------------------------------------
if [ "$eco" = rust ]; then
  before=$(awk -v c="name = \"$pkg\"" '$0 == c {getline; print $3}' "$lock" | tr -d '"' | sort -u | paste -sd' ' -)
  [ -n "$before" ] || die "$pkg is not in $lock"
  case "$before" in
    *" "*) [ -n "$from" ] || die "$lock has several $pkg versions ($before); pass --from" ;;
    *) from=${from:-$before} ;;
  esac
  [ "$from" != "$ver" ] || { printf '%s is already at %s in %s; nothing to do\n' "$pkg" "$ver" "$lock" >&2; exit 0; }
  (cd "$dir" && cargo update -q -p "$pkg@$from" --precise "$ver")
  how="cargo update -p $pkg@$from --precise $ver"
  after=$(awk -v c="name = \"$pkg\"" '$0 == c {getline; print $3}' "$lock" | tr -d '"' | sort -u | paste -sd' ' -)
else
  from=$(cd "$dir" && go list -m -f '{{.Version}}' "$pkg" 2>/dev/null || true)
  [ "$from" != "$ver" ] || { printf '%s is already at %s; nothing to do\n' "$pkg" "$ver" >&2; exit 0; }
  (cd "$dir" && go get "$pkg@$ver" && go mod tidy)
  how="go get $pkg@$ver && go mod tidy"
  after=$(cd "$dir" && go list -m -f '{{.Version}}' "$pkg")
fi
printf '%s: %s -> %s\n' "$pkg" "${from:-none}" "$after" >&2

changed=$(git diff --name-only)
extra=$(printf '%s\n' "$changed" | awk -v ok="$allowed" 'BEGIN {n = split(ok, a, " "); for (i = 1; i <= n; i++) okset[a[i]] = 1} NF && !($0 in okset)')
[ -z "$extra" ] || { printf 'unexpected files changed:\n%s\n' "$extra" >&2; exit 1; }
git diff --stat >&2

# Every other version the update pulled in must pass the release-age rule too.
ages=$("$here/lock-age.sh" -d "$days" --local HEAD . || true)
printf '%s\n' "$ages" | awk 'NF' >&2
under=$(printf '%s\n' "$ages" | awk -F'\t' -v me="$pkg@$ver" '$5 == "UNDER" && $2 != me')
[ -z "$under" ] || { printf 'other new versions are inside the %s-day window:\n%s\n' "$days" "$under" >&2; exit 1; }

# --- audit ----------------------------------------------------------------------------------
log="$scratch/lockfix-$name-audit.log"
if ! bash -c "$audit" >"$log" 2>&1; then
  printf 'audit failed: %s (log: %s)\n' "$audit" "$log" >&2
  tail -25 "$log" >&2
  exit 1
fi
printf 'audit passed: %s\n' "$audit" >&2

if [ "$young" -eq 1 ]; then
  age_md="## 3-day release-age exception

$pkg $ver was published on $published and is the first patched release for $adv, so it is taken under the first-patched-release exception. A newer release that isn't first-patched is not taken."
else
  age_md="## 3-day release age

$pkg $ver was published on $published, so it passes the ${days}-day rule without an exception."
fi
title="$ctype(deps): bump ${pkg##*/} to $ver for $adv"
msg="$title

$why"
[ -z "$trailer" ] || msg="$msg

$trailer"
body="## Summary

[$adv]($(adv_url "$adv")): $why

This is a lockfile-level change: \`$how\` in \`$dir\`.

$age_md

## Verification

\`$audit\` exits 0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"

if [ "$execute" -eq 0 ]; then
  printf '\n(dry run: clone left at %s; pass --execute to commit, push and open the PR)\n' "$clone" >&2
  printf '\n--- PR title ---\n%s\n--- PR body ---\n%s\n' "$title" "$body"
  exit 0
fi

default=$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name)
branch="fix/${pkg##*/}-$(printf '%s' "$adv" | tr '[:upper:]' '[:lower:]')"
[ "$base" = "$default" ] || branch="$branch-$base"
git switch -qc "$branch"
if [ "$signoff" -eq 1 ]; then git commit -q -s -am "$msg"; else git commit -q -am "$msg"; fi
git push -q -u origin HEAD
gh pr create -R "$repo" --base "$base" --head "$branch" --title "$title" --body "$body"
