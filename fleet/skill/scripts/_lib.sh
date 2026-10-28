#!/usr/bin/env bash
# _lib.sh: helpers shared by the pr-consolidation scripts. Source it; don't run it.
#
#   . "$(dirname "$0")/_lib.sh"
#
# Requires gh (authenticated) and jq. Written for macOS bash 3.2: no ${v,,}, no mapfile,
# no associative arrays.

die() { printf '%s: %s\n' "${0##*/}" "$*" >&2; exit 2; }
warn() { printf '%s: %s\n' "${0##*/}" "$*" >&2; }

need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "needs '$c' on PATH"
  done
}

# default_days: the release-age window in days. $STEWARD_POLICY_MIN_RELEASE_AGE_DAYS when it's set; else, when these
# scripts run from a workstation-steward checkout (fleet/skill/scripts, or through a symlink to it), that checkout's
# steward.toml [policy] min_release_age_days; else 3.
default_days() {
  local cfg
  if [ -n "${STEWARD_POLICY_MIN_RELEASE_AGE_DAYS:-}" ]; then echo "$STEWARD_POLICY_MIN_RELEASE_AGE_DAYS"; return; fi
  cfg="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd)/lib/config.js"
  if [ -f "$cfg" ] && command -v node >/dev/null 2>&1; then
    node "$cfg" --json 2>/dev/null | jq -er '.policy.min_release_age_days' 2>/dev/null && return
  fi
  echo 3
}

# parse_pr <ref>: accepts https://github.com/OWNER/REPO/pull/N or OWNER/REPO#N.
# Prints "OWNER/REPO N".
parse_pr() {
  local ref=$1 repo num
  case "$ref" in
    https://github.com/*/pull/*)
      repo=$(printf '%s' "$ref" | cut -d/ -f4,5)
      num=${ref##*/pull/}; num=${num%%[/?#]*} ;;
    */*#*)
      repo=${ref%%#*}; num=${ref##*#} ;;
    *) die "not a PR reference: $ref (use OWNER/REPO#N or a PR URL)" ;;
  esac
  case "$num" in ''|*[!0-9]*) die "bad PR number in: $ref" ;; esac
  printf '%s %s\n' "$repo" "$num"
}

# read_refs <args...>: prints one PR reference per line, from the arguments, or from a file
# when the arguments are "-f FILE" ('-' for stdin). Blank lines, lines starting with #, and
# ' # ...' trailing comments are skipped (OWNER/REPO#N itself has no space before the #).
read_refs() {
  if [ "${1:-}" = "-f" ]; then
    [ -n "${2:-}" ] || die "-f needs a file"
    if [ "$2" = "-" ]; then cat; else cat -- "$2"; fi | sed -e 's/^[[:space:]]*#.*$//' -e 's/[[:space:]][[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' \
      | awk '{print $1}'
  else
    local r
    for r in "$@"; do printf '%s\n' "$r"; done
  fi
}

# iso_age_days <iso8601>: whole and fractional days since the timestamp (jq does the date math,
# so this works the same on macOS and Linux). Prints "?" if the timestamp can't be parsed.
iso_age_days() {
  jq -rn --arg d "$1" '
    try (($d | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601) as $t
         | ((now - $t) / 86400 * 10 | floor) / 10 | tostring)
    catch "?"'
}

# cutoff_iso <days>: the UTC timestamp <days> ago, e.g. 2026-10-20T15:00:00Z.
cutoff_iso() {
  jq -rn --argjson d "$1" '(now - $d * 86400) | floor | todate'
}
