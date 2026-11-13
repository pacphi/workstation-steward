#!/usr/bin/env bash
# The end-to-end run's root phase for zypper (parity zypper 1c, `just linux-test <id> --e2e`), in a throwaway openSUSE Leap
# container with the network on: what a user's machine has before the steward runs. As root: sudo, allowed `zypper` and
# nothing else (D-b: the steward runs sudo as a child at the terminal, or hands the line over); a few packages taken back
# to an older edition the update repo still keeps (zypper's step 0), so there is something to upgrade and a way back.
# Then the user phase, as the steward user: drive.js. Tumbleweed waits for its snapshot mode (the owner, 2026-11-13).
# It never runs on a real machine: tools/linux-test.js starts it only in a labelled container removed after the run.
set -euo pipefail
say() { printf '\ne2e root: %s\n' "$*"; }

[[ -f /.dockerenv || -n "${container:-}" ]] || { echo "ERROR zypper.sh runs only in linux-test's container" >&2; exit 2; }

osr() { sed -n "s/^$1=//p" /etc/os-release | tr -d '"' | head -1; }
case "$(osr ID)" in
  opensuse-leap) ;;
  opensuse-tumbleweed) echo "ERROR zypper.sh: Tumbleweed's end-to-end run comes with its snapshot mode (docs/platforms/parity.md)" >&2; exit 2 ;;
  *) echo "ERROR zypper.sh: not openSUSE Leap ($(osr ID))" >&2; exit 2 ;;
esac
say "leap ($(osr PRETTY_NAME))"

mkdir -p /work/src /work/home
cp -a /src/. /work/src/
chown -R steward /work

say 'sudo, allowed zypper only'
zypper -n -q install --no-recommends sudo >/dev/null
printf 'steward ALL=(root) NOPASSWD: /usr/bin/zypper\n' > /etc/sudoers.d/steward-e2e
chmod 0440 /etc/sudoers.d/steward-e2e
visudo -cf /etc/sudoers.d/steward-e2e

# what the run learned of zypper's own output, for the tests' fixtures (zypper 1c): kept in the log
say 'zypper --xmlout list-updates (as root, for the record)'
zypper -n --xmlout list-updates | head -60 || true
say 'zypper --xmlout list-patches (as root, for the record)'
zypper -n --xmlout list-patches | head -40 || true
say 'updateinfo files in the system cache'
ls -la /var/cache/zypp/raw/*/repodata/ 2>/dev/null | grep -i updateinfo || echo 'none found'

# seed NAME — take NAME back to the oldest edition the update repo offers, when it offers two or more
: > /work/seeded.txt
ed() { rpm -q --qf '%{EPOCHNUM}:%{VERSION}-%{RELEASE}\n' "$1" | head -1 | sed 's/^0://'; }
seed() {
  local name="$1" vers old
  vers="$(zypper -n --xmlout search --details --match-exact --type package "${name}" 2>/dev/null \
    | grep -o '<solvable [^>]*>' | grep -v 'System Packages' | grep -o 'edition="[^"]*"' | cut -d'"' -f2 | awk 'NF && !seen[$0]++' | sort -V)"
  [[ "$(printf '%s\n' "${vers}" | grep -c .)" -ge 2 ]] || return 1
  old="$(printf '%s\n' "${vers}" | head -1)"
  say "seed ${name} ${old} (offered: $(printf '%s ' ${vers}))"
  if [[ "$(ed "${name}")" != "${old}" ]]; then zypper -n -q install --oldpackage --no-recommends "${name}=${old}" >/dev/null || return 1; fi
  [[ "$(ed "${name}")" == "${old}" ]] || return 1
  printf '%s\t%s\tleap\n' "${name}" "${old}" >> /work/seeded.txt
}

# packages safe to take back an edition in a throwaway container: never zypper, libzypp, rpm, glibc, sudo or TLS
n=0
for p in timezone less diffutils findutils which tar gzip file sed libpcre2-8-0 libzck1; do
  rpm -q "${p}" >/dev/null 2>&1 || continue
  if seed "${p}"; then n=$((n + 1)); fi
  [[ ${n} -ge 3 ]] && break
done
[[ ${n} -ge 1 ]] || { echo 'ERROR zypper.sh: no package with an older edition in the repos to seed' >&2; exit 1; }
say "seeded: $(cut -f1,2 /work/seeded.txt | tr '\t\n' ' ,')"

say 'the user phase, as steward'
exec su steward -s /bin/bash -c "export HOME=/work/home PATH=/opt/mise/shims:/usr/local/bin:/usr/bin:/bin STEWARD_INSTANCE=/work/src/examples \
  MISE_DATA_DIR=/opt/mise MISE_GLOBAL_CONFIG_FILE=/opt/mise/config.toml MISE_CACHE_DIR=/tmp/mise-cache MISE_STATE_DIR=/tmp/mise-state MISE_OFFLINE=1 \
  NO_PROGRESS=1 NO_COLOR=1; cd /work/src && node test/containers/e2e/drive.js zypper leap"
