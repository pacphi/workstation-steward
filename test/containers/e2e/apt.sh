#!/usr/bin/env bash
# The end-to-end run's root phase for apt (parity 1c, `just linux-test <id> --e2e`), in a throwaway container with the
# network on: what a user's machine has before the steward runs. As root: sudo, allowed `apt-get` and nothing else
# (D-b: the steward runs sudo as a child at the terminal, or hands the line over); older versions of a few packages the
# archive still offers (apt-cache madison), so there is something to upgrade and a way back to take; on Mint and LMDE,
# one from Mint's own repo too, for the first-seen clock. Then the user phase, as the steward user: drive.js.
# It never runs on a real machine: tools/linux-test.js starts it only in a labelled container removed after the run.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
say() { printf '\ne2e root: %s\n' "$*"; }

[[ -f /.dockerenv || -n "${container:-}" ]] || { echo "ERROR apt.sh runs only in linux-test's container" >&2; exit 2; }

# which date path this machine takes (lib/providers/apt.js release())
osr() { sed -n "s/^$1=//p" /etc/os-release | tr -d '"' | head -1; }
id="$(osr ID)"
case "${id}" in
  debian) distro=debian ;;
  ubuntu) distro=ubuntu ;;
  linuxmint) if [[ -n "$(osr UBUNTU_CODENAME)" ]]; then distro=mint; else distro=lmde; fi ;;
  *) echo "ERROR apt.sh: not an apt distribution (${id})" >&2; exit 2 ;;
esac
say "${distro} ($(osr PRETTY_NAME))"

mkdir -p /work/src /work/home
cp -a /src/. /work/src/
chown -R steward /work

say 'sudo, allowed apt-get only'
apt-get update -qq
apt-get install -y -qq --no-install-recommends sudo >/dev/null
printf 'steward ALL=(root) NOPASSWD: /usr/bin/apt-get\n' > /etc/sudoers.d/steward-e2e
chmod 0440 /etc/sudoers.d/steward-e2e
visudo -cf /etc/sudoers.d/steward-e2e

# seed NAME FROM — install the oldest version madison lists for NAME (from FROM's repo: mint, or any), if it has two or more
: > /work/seeded.txt
seed() {
  local name="$1" from="$2" lines vers old
  lines="$(apt-cache madison "${name}" 2>/dev/null || true)"
  [[ "${from}" == mint ]] && lines="$(printf '%s\n' "${lines}" | grep 'packages.linuxmint.com' || true)"
  vers="$(printf '%s\n' "${lines}" | awk -F'|' 'NF>=3 {gsub(/ /, "", $2); print $2}' | awk '!seen[$0]++')"
  [[ "$(printf '%s\n' "${vers}" | grep -c .)" -ge 2 ]] || return 1
  old="$(printf '%s\n' "${vers}" | tail -1)"
  say "seed ${name} ${old} (madison: $(printf '%s ' ${vers}))"
  apt-get install -y -qq --no-install-recommends --allow-downgrades "${name}=${old}" >/dev/null
  printf '%s\t%s\t%s\n' "${name}" "${old}" "${from}" >> /work/seeded.txt
}

# packages that are safe to take back a version or two in a throwaway container: never apt, dpkg, libc, sudo or TLS
n=0
for p in tzdata distro-info-data less xz-utils libatomic1 procps; do
  dpkg-query -W "${p}" >/dev/null 2>&1 || continue
  if seed "${p}" any; then n=$((n + 1)); fi
  [[ ${n} -ge 2 ]] && break
done
[[ ${n} -ge 1 ]] || { echo 'ERROR apt.sh: no package with an older version in the archive to seed' >&2; exit 1; }

if [[ "${distro}" == mint || "${distro}" == lmde ]]; then
  for p in $(dpkg-query -W -f '${Package}\n'); do
    case "${p}" in apt|dpkg|libc*|sudo|base-files|*ssl*|ca-certificates|mint-mirrors) continue ;; esac
    if seed "${p}" mint; then break; fi
  done || true
fi

say "seeded: $(cut -f1,2 /work/seeded.txt | tr '\t\n' ' ,')"

# a pending restart, as update-notifier-common writes it on Ubuntu and Mint (parity 1e): the user's audit must name it
say 'a pending restart: /run/reboot-required'
printf '*** System restart required ***\n' > /run/reboot-required
printf 'steward-e2e-restart\n' > /run/reboot-required.pkgs
say 'the user phase, as steward'
exec su steward -s /bin/bash -c "export HOME=/work/home PATH=/opt/mise/shims:/usr/local/bin:/usr/bin:/bin STEWARD_INSTANCE=/work/src/examples \
  MISE_DATA_DIR=/opt/mise MISE_GLOBAL_CONFIG_FILE=/opt/mise/config.toml MISE_CACHE_DIR=/tmp/mise-cache MISE_STATE_DIR=/tmp/mise-state MISE_OFFLINE=1 \
  NO_PROGRESS=1 NO_COLOR=1; cd /work/src && node test/containers/e2e/drive.js apt ${distro}"
