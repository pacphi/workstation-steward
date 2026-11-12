#!/usr/bin/env bash
# The end-to-end run's root phase for dnf (parity dnf 1c, `just linux-test <id> --e2e`), in a throwaway Fedora container
# with the network on: what a user's machine has before the steward runs. As root: sudo, allowed `dnf5` and nothing else
# (D-b: the steward runs sudo as a child at the terminal, or hands the line over); a few packages taken back to the
# release's own build, which Fedora's repos keep (the updates repo keeps only its newest), so there is something to
# upgrade and a way back to take. Then the user phase, as the steward user: drive.js.
# It never runs on a real machine: tools/linux-test.js starts it only in a labelled container removed after the run.
set -euo pipefail
say() { printf '\ne2e root: %s\n' "$*"; }

[[ -f /.dockerenv || -n "${container:-}" ]] || { echo "ERROR dnf.sh runs only in linux-test's container" >&2; exit 2; }

osr() { sed -n "s/^$1=//p" /etc/os-release | tr -d '"' | head -1; }
[[ "$(osr ID)" == fedora ]] || { echo "ERROR dnf.sh: not Fedora ($(osr ID))" >&2; exit 2; }
say "fedora ($(osr PRETTY_NAME))"

mkdir -p /work/src /work/home
cp -a /src/. /work/src/
chown -R steward /work

say 'sudo, allowed dnf5 only'
dnf5 -y -q --disable-repo='*-testing' install sudo >/dev/null
printf 'steward ALL=(root) NOPASSWD: /usr/bin/dnf5\n' > /etc/sudoers.d/steward-e2e
chmod 0440 /etc/sudoers.d/steward-e2e
visudo -cf /etc/sudoers.d/steward-e2e

# seed NAME — take NAME back to the oldest build the repos offer (testing left out: the release's own), when there are
# two or more; one already at it counts as it is. dnf5 downgrade, as the steward's rollback does
: > /work/seeded.txt
evr() { rpm -q --qf '%{EPOCHNUM}:%{VERSION}-%{RELEASE}\n' "$1" | head -1 | sed 's/^0://'; }
seed() {
  local name="$1" vers old
  vers="$(dnf5 -q --disable-repo='*-testing' repoquery --qf '%{evr}\n' "${name}" 2>/dev/null | awk 'NF && !seen[$0]++' | sort -V)"
  [[ "$(printf '%s\n' "${vers}" | grep -c .)" -ge 2 ]] || return 1
  old="$(printf '%s\n' "${vers}" | head -1)"
  say "seed ${name} ${old} (offered: $(printf '%s ' ${vers}))"
  if [[ "$(evr "${name}")" != "${old}" ]]; then dnf5 -y -q --disable-repo='*-testing' downgrade "${name}-${old}" >/dev/null || return 1; fi
  [[ "$(evr "${name}")" == "${old}" ]] || return 1
  printf '%s\t%s\tfedora\n' "${name}" "${old}" >> /work/seeded.txt
}

# packages safe to take back a build in a throwaway container: never dnf, rpm, glibc, sudo or TLS
n=0
for p in tzdata less diffutils findutils which tar gzip file sed; do
  rpm -q "${p}" >/dev/null 2>&1 || continue
  if seed "${p}"; then n=$((n + 1)); fi
  [[ ${n} -ge 3 ]] && break
done
[[ ${n} -ge 1 ]] || { echo 'ERROR dnf.sh: no package with an older build in the repos to seed' >&2; exit 1; }
say "seeded: $(cut -f1,2 /work/seeded.txt | tr '\t\n' ' ,')"

say 'the user phase, as steward'
exec su steward -s /bin/bash -c "export HOME=/work/home PATH=/opt/mise/shims:/usr/local/bin:/usr/bin:/bin STEWARD_INSTANCE=/work/src/examples \
  MISE_DATA_DIR=/opt/mise MISE_GLOBAL_CONFIG_FILE=/opt/mise/config.toml MISE_CACHE_DIR=/tmp/mise-cache MISE_STATE_DIR=/tmp/mise-state MISE_OFFLINE=1 \
  NO_PROGRESS=1 NO_COLOR=1; cd /work/src && node test/containers/e2e/drive.js dnf fedora"
