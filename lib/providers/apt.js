// apt as a package source (parity 1a, D-a per package): Debian, Ubuntu and Linux Mint, the Debian family. The upgrade
// (parity 1b) goes through lib/roothandoff.js: pinned versions, sudo at your terminal or handed over (D-b revised).
//   - a version from a security pocket (debian-security, Ubuntu's -security) is taken at once, and says so (owner,
//     2026-11-03); everything else waits out the release-age gate
//   - its own copy of the package lists: `apt-get update` into <state>/apt as the user, no sudo, the repositories'
//     signatures still checked against the system's keyring; the system's apt state is never touched (owner, 2026-11-03)
//   - each new version dated by the earliest day it was publicly available: snapshot.debian.org on Debian and LMDE (its first
//     sighting in debian or debian-security), Launchpad on Ubuntu and on Mint's Ubuntu base (Release, Updates or
//     Security; never Proposed or a deleted copy); a version neither knows (Mint's own repo, a PPA) by the first-seen
//     clock, the first time this machine saw it (owner, 2026-11-03). Answers are cached for the day.
// Every command goes through ctx.run, so tests hand it canned output.
const fs = require('fs');
const os = require('os');
const path = require('path');

const id = 'apt';
const SNAPSHOT = 'https://snapshot.debian.org/mr/binary/';
const LAUNCHPAD = 'https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedBinaries';
const DEBIAN_ARCHIVES = ['debian', 'debian-security'];
const UBUNTU_POCKETS = ['Release', 'Updates', 'Security'];
const enc = encodeURIComponent;

// dir(ctx) — where the steward keeps its own apt lists and its first-seen clock
const dir = ctx => path.join(ctx.cfg.paths.state, 'apt');
// opts(ctx) — apt's options for the steward's own lists and cache, as this user, without the system's lock
const opts = ctx => ['-o', `Dir::State::Lists=${dir(ctx)}/lists`, '-o', `Dir::Cache=${dir(ctx)}/cache`, '-o', `Dir::Cache::archives=${dir(ctx)}/cache/archives`,
  '-o', 'Debug::NoLocking=true', '-o', `APT::Sandbox::User=${os.userInfo().username}`];

// parseUpgradable(text) — [{name, suite, want, have}] from `apt list --upgradable`
const parseUpgradable = text => String(text).split('\n').map(l => l.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/)).filter(Boolean)
  .map(m => ({ name: m[1], suite: m[2], want: m[3], have: m[4] }));

// debianDate(json) — the earliest first_seen in Debian's own archives, as an ISO time, from snapshot.debian.org's fileinfo
function debianDate(j) {
  const seen = Object.values((j && j.fileinfo) || {}).flat().filter(f => DEBIAN_ARCHIVES.includes(f.archive_name)).map(f => f.first_seen).filter(Boolean).sort();
  const m = seen.length && seen[0].match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : '';
}

// ubuntuDate(json) — the earliest publication in Release, Updates or Security (not deleted), from Launchpad's answer
function ubuntuDate(j) {
  const t = ((j && j.entries) || []).filter(e => UBUNTU_POCKETS.includes(e.pocket) && e.status !== 'Deleted' && e.date_published)
    .map(e => Date.parse(e.date_published)).filter(Number.isFinite).sort((a, b) => a - b);
  return t.length ? new Date(t[0]).toISOString() : '';
}

// firstSeen(file, key, now) — when this machine first saw that version (ISO), recorded the first time and never moved
function firstSeen(file, key, now) {
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (!seen[key]) {
    seen[key] = now.toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(seen, null, 1)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  }
  return seen[key];
}

// release(ctx) — {id, ubuntu, debian} from this machine's os-release: ubuntu is the Ubuntu codename Launchpad knows (Mint's
// base too); debian is true on Debian and on a distribution built on it with no Ubuntu base (LMDE: DEBIAN_CODENAME, parity 1c)
function release(ctx) {
  for (const f of ['etc/os-release', 'usr/lib/os-release']) {
    let t; try { t = fs.readFileSync(path.join(ctx.sysroot || '/', f), 'utf8'); } catch { continue; }
    const v = k => ((t.match(new RegExp(`^${k}=["']?([^"'\\n]*)`, 'm')) || [])[1] || '');
    const ubuntu = v('UBUNTU_CODENAME') || (v('ID') === 'ubuntu' ? v('VERSION_CODENAME') : '');
    return { id: v('ID'), ubuntu, debian: v('ID') === 'debian' || (!ubuntu && !!v('DEBIAN_CODENAME')) };
  }
  return { id: '', ubuntu: '', debian: false };
}

// cached(ctx, key, get, prefix) — the day's answer for key, else get() kept for the rest of the day (dnf shares it)
async function cached(ctx, key, get, prefix = 'apt') {
  const f = path.join(ctx.cache, `${prefix}-${ctx.today.replace(/-/g, '')}`, `${key.replace(/[^A-Za-z0-9._+-]/g, '_')}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).date; } catch { /* not yet today */ }
  const date = await get();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ date }));
  return date;
}

const json = async (ctx, url) => {
  const r = await ctx.run('curl', ['-fsS', '--max-time', '20', url]);
  try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
};

// releaseDate(ctx, name, want) — {date, from}: when that version became public, and how that is known
async function releaseDate(ctx, name, want) {
  const r = release(ctx);
  if (r.debian) {
    const date = await cached(ctx, `debian-${name}-${want}`, async () => debianDate(await json(ctx, `${SNAPSHOT}${enc(name)}/${enc(want)}/binfiles?fileinfo=1`)));
    if (date) return { date, from: 'snapshot' };
  } else if (r.ubuntu) {
    const arch = (await ctx.run('dpkg', ['--print-architecture'])).stdout.trim();
    const series = enc(`https://api.launchpad.net/1.0/ubuntu/${r.ubuntu}/${arch}`);
    const date = await cached(ctx, `ubuntu-${r.ubuntu}-${arch}-${name}-${want}`, async () => ubuntuDate(await json(ctx,
      `${LAUNCHPAD}&binary_name=${enc(name)}&exact_match=true&version=${enc(want)}&distro_arch_series=${series}&ws.size=50`)));
    if (date) return { date, from: 'Launchpad' };
  }
  return { date: firstSeen(path.join(dir(ctx), 'first-seen.json'), `${name} ${want}`, ctx.now), from: 'first seen here' };
}

// outdated(ctx) — what apt would upgrade, from the steward's own lists, refreshed first (as the user: no sudo)
async function outdated(ctx) {
  for (const d of ['lists/partial', 'cache/archives/partial']) fs.mkdirSync(path.join(dir(ctx), d), { recursive: true });
  await ctx.run('apt-get', [...opts(ctx), '-qq', 'update']);
  return parseUpgradable((await ctx.run('apt', [...opts(ctx), 'list', '--upgradable'])).stdout);
}

const source = {
  id, check: 'apt', provider: id, name: 'apt packages', title: 'apt packages', noun: 'apt package(s)', tag: 'apt',
  platforms: ['linux'], families: ['debian'], gateMode: 'per-package', exceptionKind: 'apt', exceptionVersion: want => want,
  needsRoot: true, heldEta: true, back: 'sudo apt-get install <package>=<previous version>, where the archive still has it (parity 1b)',
  available: async ctx => (await ctx.run('apt-get', ['--version'])).status === 0 && (await ctx.run('dpkg-query', ['--version'])).status === 0,
  refresh: () => null, outdated, releaseDate, manual: async () => [], manualText: (_w, l) => l,
  upgradeCmd: names => ({ cmd: 'apt-get', args: ['install', '--only-upgrade', ...names] }),
};

// installed(ctx, names) — {name: version} of those installed, read as you (dpkg-query)
async function installed(ctx, names) {
  const r = await ctx.run('dpkg-query', ['-W', '-f=${Package}\t${Version}\n', ...names]);
  return Object.fromEntries(String(r.stdout || '').split('\n').map(l => l.split('\t')).filter(([n, v]) => n && v && names.includes(n)));
}
// offered(ctx, name) — the versions of name the repos offer, from the steward's own lists (apt-cache madison: the
// repos only, never dpkg's own record of what is installed)
async function offered(ctx, name) {
  const r = await ctx.run('apt-cache', [...opts(ctx), 'madison', name]);
  return String(r.stdout || '').split('\n').map(l => l.split('|').map(x => x.trim())).filter(c => c[0] === name && c[1]).map(c => c[1]);
}
// download(ctx, name, version, dest) — that build's .deb into dest, as you, from the steward's own lists (apt-get
// download checks the repository's signatures and the file's hash); the file, or null (kept packages, D88)
async function download(ctx, name, version, dest) {
  await ctx.run('apt-get', [...opts(ctx), '-qq', 'download', `${name}=${version}`], { cwd: dest });
  const file = `${name}_${version.replace(/:/g, '%3a')}_`;
  return require('../kept.js').downloaded(dest, b => b.startsWith(file) && b.endsWith('.deb'));
}
// securityPocket(item) — the security pocket a version comes from (a suite ending in -security; apt list joins several
// with commas), or ''
const securityPocket = item => String((item && item.suite) || '').split(',').find(s => s.endsWith('-security')) || '';
// pin(i) — name=version for a planned item; a bare name stays as it is
const pin = i => (typeof i === 'string' ? i : `${i.name}=${i.want}`);

Object.assign(source, {
  installed, offered, securityPocket, download,
  // root refreshes the system's own lists before an upgrade or a rollback: they can be older than the steward's copy,
  // and root apt reads only those (owner, 2026-11-03; the Debian container's run found it)
  rootRefresh: { cmd: 'apt-get', args: ['update'] },
  upgradeCmd: items => ({ cmd: 'apt-get', args: ['install', '--only-upgrade', ...items.map(pin)] }),
  // the way back: the steward's kept copy of the build from before (a path: apt-get installs a local .deb), else that
  // version while the repos still offer it (D88)
  rollbackCmd: items => ({ cmd: 'apt-get', args: ['install', '--allow-downgrades', ...items.map(i => i.file || `${i.name}=${i.to}`)] }),
  back: 'steward sc rollback <receipt> (it printed its receipt above): the kept copy of each version from before, else the one the repos still offer',
});

module.exports = { source, parseUpgradable, debianDate, ubuntuDate, firstSeen, cached };
