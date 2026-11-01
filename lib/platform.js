// The platform the steward runs on, by the names host.toml and the audit's checks use (R5c): macos, linux, windows.
// A host.toml entry that holds for one platform only says so with `platforms = ["macos"]`; an entry without the key
// holds on every platform, which is what every entry meant before the key existed.
// On Linux it also reads os-release (parity 0.1, D63): the distribution, its version and its family, which the
// providers, the trust store and host.toml's `families` key go by. An entry with `families` narrows only its Linux
// part, and an entry with `families` but no `platforms` holds on Linux only (lib/host.js warns about it: an older
// steward ignores `families`). macOS and Windows have no distribution or family.
const fs = require('fs');

const NAMES = { darwin: 'macos', linux: 'linux', win32: 'windows' };
const PLATFORMS = ['macos', 'linux', 'windows'];
const FAMILIES = ['debian', 'rhel', 'suse', 'arch', 'alpine', 'void', 'gentoo', 'slackware', 'nixos'];
// FAMILY_OF — an os-release ID, or an ID_LIKE word, to its family. ID is checked first, then each ID_LIKE word in order
const FAMILY_OF = {
  debian: 'debian', ubuntu: 'debian', linuxmint: 'debian',
  fedora: 'rhel', rhel: 'rhel', centos: 'rhel', rocky: 'rhel', almalinux: 'rhel',
  'opensuse-leap': 'suse', 'opensuse-tumbleweed': 'suse', sles: 'suse', suse: 'suse', opensuse: 'suse',
  arch: 'arch', alpine: 'alpine', void: 'void', gentoo: 'gentoo', slackware: 'slackware', nixos: 'nixos',
};
// where os-release lives: /etc first, then /usr/lib (the os-release spec's fallback)
const OS_RELEASE = ['/etc/os-release', '/usr/lib/os-release'];

// current(nodePlatform) — this machine's platform name
const current = (p = process.platform) => NAMES[p] || p;

// parseOsRelease(text) — {id, like, version, pretty} from os-release's KEY=value lines: a value may be quoted with " or
// ', and inside double quotes a backslash escapes the next character; comments, blank lines and junk are skipped
function parseOsRelease(text) {
  const v = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let s = m[2].trim();
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1).replace(/\\(.)/g, '$1');
    else if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) s = s.slice(1, -1);
    v[m[1]] = s;
  }
  return { id: v.ID || null, like: (v.ID_LIKE || '').split(/\s+/).filter(Boolean), version: v.VERSION_ID || null, pretty: v.PRETTY_NAME || null };
}

// familyOf(id, like) — the family of a distribution, or null when neither its ID nor an ID_LIKE word is known
function familyOf(id, like = []) {
  for (const k of [id, ...like]) if (k && Object.hasOwn(FAMILY_OF, k)) return FAMILY_OF[k];
  return null;
}

// describe({nodePlatform, read}) — {platform, distro, version, family, pretty}; os-release is read on Linux only, and
// a missing one gives an unknown distribution (all null). With no arguments the answer is worked out once and kept.
let cached = null;
function describe(o = {}) {
  const fresh = 'nodePlatform' in o || 'read' in o;
  if (!fresh && cached) return cached;
  const platform = current(o.nodePlatform || process.platform);
  const d = { platform, distro: null, version: null, family: null, pretty: null };
  if (platform === 'linux') {
    const read = o.read || (f => fs.readFileSync(f, 'utf8'));
    for (const f of OS_RELEASE) {
      let text;
      try { text = read(f); } catch { continue; }
      const r = parseOsRelease(text);
      Object.assign(d, { distro: r.id, version: r.version, family: familyOf(r.id, r.like), pretty: r.pretty });
      break;
    }
  }
  if (!fresh) cached = d;
  return d;
}

// label(d) — how a header names the platform: 'macos' as before; on Linux the distribution and its version
function label(d = describe()) {
  if (d.platform !== 'linux') return d.platform;
  if (!d.distro) return 'linux (unknown distribution)';
  return `linux (${d.distro}${d.version ? ` ${d.version}` : ''})`;
}

// applies(entry, platform, family) — whether a host.toml entry holds here: a plain value, or a table without
// `platforms` or `families`, always; `platforms` limits it to those platforms; `families` limits its Linux part to
// those families (and, without `platforms`, the entry to Linux)
function applies(e, platform = current(), family = platform === current() ? describe().family : null) {
  if (!e || typeof e !== 'object') return true;
  const fam = Array.isArray(e.families) ? e.families : null;
  const plats = Array.isArray(e.platforms) ? e.platforms : (fam ? ['linux'] : null);
  if (plats && !plats.includes(platform)) return false;
  if (fam && platform === 'linux') return fam.includes(family);
  return true;
}

module.exports = { PLATFORMS, FAMILIES, current, parseOsRelease, familyOf, describe, label, applies };
