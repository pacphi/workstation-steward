#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# lock-age.sh: list every lockfile entry that is NEW between a base and a head, with its registry
# publish time, and flag anything younger than the release-age cutoff. Read-only.
#
# Usage:
#   lock-age.sh [-d DAYS | -c CUTOFF] OWNER/REPO#N            # a PR (open or merged)
#   lock-age.sh [-d DAYS | -c CUTOFF] -R OWNER/REPO BASE HEAD  # two refs on GitHub
#   lock-age.sh [-d DAYS | -c CUTOFF] --local BASE [HEAD]      # a local clone (run inside it);
#                                                              # HEAD '.' means the working tree
#   lock-age.sh [-d DAYS | -c CUTOFF] --files OLD NEW          # two lockfile copies outside Git (OLD may be /dev/null or
#                                                              # missing: every entry is then new); the kind comes from
#                                                              # NEW's file name (e.g. aube-lock.yaml from a mise npm: install)
#   -d DAYS     cutoff is now minus DAYS (default: steward.toml min_release_age_days, else 3; see _lib.sh)
#   -c CUTOFF   explicit UTC cutoff, e.g. 2026-10-20T15:00:00Z (to re-check a past PR as of then)
#
# "New" means a name@version present at HEAD but not at the merge base of BASE and HEAD, per
# lockfile path. For a PR the merge base is taken from the PR's recorded base commit, so a
# squash-merged PR still shows what it introduced.
#
# Lockfiles and registries:
#   pnpm-lock.yaml (v6+), aube-lock.yaml (same format), package-lock.json, npm-shrinkwrap.json   registry.npmjs.org  .time[v]
#   Cargo.lock (crates.io sources only)                           crates.io API       created_at
#   go.sum                                                        proxy.golang.org    .info Time
#   uv.lock, poetry.lock, requirements*.txt (== pins only)        pypi.org JSON       upload time
# yarn.lock, Gemfile.lock, composer.lock, packages.lock.json and Maven/Gradle are not parsed;
# see the ecosystem files for their registry commands.
#
# Output TSV: lockfile, name@version, published (UTC), age in days, flag (OK | UNDER | UNKNOWN).
# A summary goes to stderr. UNKNOWN usually means a private registry, a git/path source the
# parser let through, or a registry error; check those by hand.
# Exit: 0 nothing under the cutoff, 1 at least one UNDER, 2 usage or lookup setup error.
#
# Environment: LOCK_AGE_UA sets the User-Agent for crates.io (its policy asks for one).
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/_lib.sh"
need jq curl git

days=$(default_days) cutoff="" mode="" repo="" base="" head="" oldf="" newf=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) days=${2:?-d needs a number}; shift 2 ;;
    -c) cutoff=${2:?-c needs a timestamp}; shift 2 ;;
    -R) mode=remote; repo=${2:?-R needs OWNER/REPO}; base=${3:?missing BASE}; head=${4:?missing HEAD}; shift 4 ;;
    --files) mode=files; oldf=${2:?--files needs OLD NEW}; newf=${3:?--files needs OLD NEW}; shift 3 ;;
    --local) mode=local; base=${2:?--local needs BASE}; shift 2
             case "${1:-}" in ''|-*) head=HEAD ;; *) head=$1; shift ;; esac ;;
    -h|--help) awk 'NR > 2 && /^#/ {sub(/^# ?/, ""); print; next} NR > 2 {exit}' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$mode" ] || die "unexpected argument $1"
       mode="pr"; parsed=$(parse_pr "$1") || exit 2
       repo=${parsed% *}; pr=${parsed#* }; shift ;;
  esac
done
[ -n "$mode" ] || die "usage: lock-age.sh [-d DAYS|-c CUTOFF] (OWNER/REPO#N | -R OWNER/REPO BASE HEAD | --local BASE [HEAD] | --files OLD NEW)"
[ -n "$cutoff" ] || cutoff=$(cutoff_iso "$days")
ua=${LOCK_AGE_UA:-workstation-steward-lock-age (https://github.com/pacphi/workstation-steward)}

work=$(mktemp -d "${TMPDIR:-/tmp}/lock-age.XXXXXX")
trap 'rm -rf "$work"' EXIT

# --- resolve the two commits to compare -------------------------------------------------------
case "$mode" in
  pr)
    need gh
    refs=$(gh pr view "$pr" -R "$repo" --json baseRefOid,headRefOid --jq '"\(.baseRefOid) \(.headRefOid)"')
    base=${refs% *}; head=${refs#* } ;;
esac
case "$mode" in
  pr|remote)
    need gh
    gh api "repos/$repo/compare/$base...$head" >"$work/compare.json"
    mb=$(jq -r .merge_base_commit.sha "$work/compare.json")
    [ -n "$mb" ] && [ "$mb" != null ] || die "could not compare $base...$head in $repo"
    jq -r '.files[]? | select(.status != "removed") | .filename' "$work/compare.json" >"$work/files"
    [ "$(wc -l <"$work/files" | tr -d ' ')" -lt 300 ] || warn "the compare API lists at most 300 files; some lockfiles may be missed"
    ;;
  files)
    [ -r "$newf" ] || die "cannot read $newf"
    mb=old head=new
    printf "%s\n" "${newf##*/}" >"$work/files" ;;
  local)
    mb=$(git merge-base "$base" "$( [ "$head" = . ] && echo HEAD || echo "$head")")
    if [ "$head" = . ]; then git diff --name-only "$mb" >"$work/files"
    else git diff --name-only "$mb" "$head" >"$work/files"; fi ;;
esac

get_file() { # get_file REF PATH -> content on stdout, nothing if missing
  case "$mode" in
    files) if [ "$1" = old ]; then cat -- "$oldf" 2>/dev/null || true; else cat -- "$newf"; fi ;;
    local) if [ "$1" = . ]; then cat -- "$2" 2>/dev/null || true
           else git show "$1:$2" 2>/dev/null || true; fi ;;
    *) gh api "repos/$repo/contents/$2?ref=$1" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true ;;
  esac
}

# --- parsers: lockfile content on stdin -> "name@version" lines -------------------------------
parse_pnpm() {
  awk '/^(packages|snapshots):/ {s=1; next} /^[^ ]/ {s=0} s && /^  [^ ]/' \
    | sed -E "s/^  //; s/^'//; s/'?:( .*)?$//; s|^/||; s/\(.*//" \
    | awk '/^(@[^\/@]+\/)?[^@]+@[0-9]/'
}
parse_npm() {
  jq -r '(.packages // {}) | to_entries[]
    | select(.key != "" and (.value.link | not) and .value.version != null
             and ((.value.resolved // "") | test("^https?://")))
    | "\(.key | sub(".*node_modules/"; ""))@\(.value.version)"' 2>/dev/null || true
}
parse_cargo() {
  awk 'function flush() { if (n != "" && s ~ /^"registry\+/) print n "@" v; n = v = s = "" }
       /^\[\[package\]\]/ {flush()} /^name = / {n=$3} /^version = / {v=$3} /^source = / {s=$3}
       END {flush()}' | tr -d '"'
}
parse_gosum() {
  awk 'NF >= 3 {v=$2; sub(/\/go\.mod$/, "", v); print $1 "@" v}'
}
parse_pytoml() { # uv.lock and poetry.lock: [[package]] blocks; skip editable/virtual/path/git sources
  awk 'function flush() { if (n != "" && s !~ /(editable|virtual|path|git|directory) *=/) print n "@" v; n = v = s = "" }
       /^\[\[package\]\]/ {flush()} /^name = / {n=$3} /^version = / {v=$3} /^source = / {s=$0}
       END {flush()}' | tr -d '"'
}
parse_requirements() {
  sed -E 's/[[:space:]]*#.*$//' \
    | awk 'match($0, /^[A-Za-z0-9._-]+(\[[^]]*\])?[[:space:]]*==[[:space:]]*[^ ;\\]+/) {
             s = substr($0, 1, RLENGTH); sub(/\[[^]]*\]/, "", s); gsub(/[[:space:]]/, "", s)
             sub(/==/, "@", s); print s }'
}

kind_of() {
  case "${1##*/}" in
    pnpm-lock.yaml|aube-lock.yaml) echo pnpm ;;
    package-lock.json|npm-shrinkwrap.json) echo npm ;;
    Cargo.lock) echo cargo ;;
    go.sum) echo gosum ;;
    uv.lock|poetry.lock) echo pytoml ;;
    requirements*.txt|*-requirements.txt|*_requirements.txt) echo requirements ;;
    *) echo "" ;;
  esac
}

# --- registry lookups: name version -> ISO timestamp, or "" -----------------------------------
date_npm() {
  local f
  f="$work/npm-$(printf '%s' "$1" | tr '/@' '__')"
  [ -s "$f" ] || curl -fsS "https://registry.npmjs.org/$(printf '%s' "$1" | sed 's|/|%2F|')" >"$f" 2>/dev/null || true
  jq -r --arg v "$2" '.time[$v] // empty' "$f" 2>/dev/null || true
}
date_crates() {
  sleep 1 # crates.io asks API clients for at most one request per second
  curl -fsS -A "$ua" "https://crates.io/api/v1/crates/$1/$2" 2>/dev/null | jq -r '.version.created_at // empty' 2>/dev/null || true
}
go_escape() { printf '%s' "$1" | sed 's/[A-Z]/!&/g' | tr '[:upper:]' '[:lower:]'; }
date_go() {
  curl -fsS "https://proxy.golang.org/$(go_escape "$1")/@v/$(go_escape "$2").info" 2>/dev/null \
    | jq -r '.Time // empty' 2>/dev/null || true
}
date_pypi() {
  curl -fsSL "https://pypi.org/pypi/$1/$2/json" 2>/dev/null \
    | jq -r '[.urls[].upload_time_iso_8601] | min // empty' 2>/dev/null || true
}

# --- main ------------------------------------------------------------------------------------
total=0 under=0 unknown=0 seen=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  kind=$(kind_of "$path")
  [ -n "$kind" ] || continue
  seen=$((seen + 1))
  get_file "$mb" "$path" | "parse_$kind" | sort -u >"$work/old"
  get_file "$head" "$path" | "parse_$kind" | sort -u >"$work/new"
  comm -13 "$work/old" "$work/new" >"$work/added"
  while IFS= read -r nv; do
    [ -n "$nv" ] || continue
    name=${nv%@*} ver=${nv##*@}
    case "$kind" in
      pnpm|npm) d=$(date_npm "$name" "$ver") ;;
      cargo) d=$(date_crates "$name" "$ver") ;;
      gosum) d=$(date_go "$name" "$ver") ;;
      pytoml|requirements) d=$(date_pypi "$name" "$ver") ;;
    esac
    total=$((total + 1))
    if [ -z "$d" ]; then
      flag=UNKNOWN age="?"; unknown=$((unknown + 1))
    else
      age=$(iso_age_days "$d")
      # Compare on the seconds-precision prefix; registries differ in fractional digits.
      if [ "$(printf '%.19s' "$d")" \> "$(printf '%.19s' "$cutoff")" ]; then
        flag=UNDER; under=$((under + 1))
      else
        flag=OK
      fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$path" "$nv" "${d:--}" "$age" "$flag"
  done <"$work/added"
done <"$work/files"

printf 'lock-age: %s changed lockfile(s), %s new entries, %s UNDER (published after %s), %s UNKNOWN\n' \
  "$seen" "$total" "$under" "$cutoff" "$unknown" >&2
[ "$under" -eq 0 ]
