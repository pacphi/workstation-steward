// The apt source (parity 1a, lib/providers/apt.js): Debian, Ubuntu and Linux Mint packages, read-only. Its own copy of
// the package lists, refreshed without sudo; each new version dated by the earliest day it was publicly available
// (snapshot.debian.org for Debian; Launchpad for Ubuntu and Mint's Ubuntu base: Release, Updates or Security, never
// Proposed or a deleted copy), else by the first-seen clock; judged by the release-age gate like any source. No network:
// curl, apt, apt-get and dpkg are canned.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../lib/providers/apt.js');
const P = require('../lib/providers/index.js');
const { plan } = require('../supply-chain/bin/upgrade.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-apt-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date('2026-11-03T12:00:00Z');
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

const UPGRADABLE = `Listing...
tzdata/stable-updates 2026f-0+deb13u1 all [upgradable from: 2026e-0+deb13u1]
libc6/trixie-security 2.41-12+deb13u2 arm64 [upgradable from: 2.41-12+deb13u1]
mintupdate/zara 6.0.5 all [upgradable from: 6.0.4]
`;

test('parseUpgradable: name, the suite it comes from, the new version and the one installed', () => {
  assert.deepEqual(A.parseUpgradable(UPGRADABLE), [
    { name: 'tzdata', suite: 'stable-updates', want: '2026f-0+deb13u1', have: '2026e-0+deb13u1' },
    { name: 'libc6', suite: 'trixie-security', want: '2.41-12+deb13u2', have: '2.41-12+deb13u1' },
    { name: 'mintupdate', suite: 'zara', want: '6.0.5', have: '6.0.4' },
  ]);
  assert.deepEqual(A.parseUpgradable('Listing...\n'), []);
});

test('debianDate: the earliest first_seen in Debian\'s own archives (debian, debian-security); others ignored', () => {
  const j = { fileinfo: {
    a: [{ archive_name: 'debian-security', first_seen: '20260925T120339Z' }, { archive_name: 'debian', first_seen: '20261002T203108Z' }],
    b: [{ archive_name: 'debian-ports', first_seen: '20250101T000000Z' }],
  } };
  assert.equal(A.debianDate(j), '2026-09-25T12:03:39Z');
  assert.equal(A.debianDate({ fileinfo: {} }), '');
});

test('ubuntuDate: the earliest publication in Release, Updates or Security; Proposed and deleted copies never count', () => {
  const entries = [
    { pocket: 'Security', status: 'Published', date_published: '2026-10-19T17:40:33.530460+00:00' },
    { pocket: 'Updates', status: 'Published', date_published: '2026-10-14T14:30:55.772752+00:00' },
    { pocket: 'Proposed', status: 'Deleted', date_published: '2026-10-05T17:12:39.970469+00:00' },
    { pocket: 'Updates', status: 'Deleted', date_published: '2026-10-01T00:00:00+00:00' },
  ];
  assert.equal(A.ubuntuDate({ entries }), '2026-10-14T14:30:55.772Z');
  assert.equal(A.ubuntuDate({ entries: [] }), '');
});

test('firstSeen: the first time a version is seen, kept from then on', () => {
  const f = path.join(ROOT, 'state', 'apt', 'first-seen.json');
  assert.equal(A.firstSeen(f, 'mintupdate 6.0.5', NOW), NOW.toISOString());
  assert.equal(A.firstSeen(f, 'mintupdate 6.0.5', new Date('2026-11-09T00:00:00Z')), NOW.toISOString(), 'never moved');
  assert.equal(A.firstSeen(f, 'mintupdate 6.0.6', new Date('2026-11-09T00:00:00Z')), '2026-11-09T00:00:00.000Z');
});

// ctx(distro, answers) — a Linux machine of that distribution; curl answers by URL prefix, the rest canned; calls counted
function ctx(distro, answers = {}, extra = {}) {
  const sys = path.join(ROOT, `sys-${distro}-${Math.random().toString(36).slice(2)}`);
  const rel = { debian: 'ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n', ubuntu: 'ID=ubuntu\nID_LIKE=debian\nVERSION_ID="26.04"\nVERSION_CODENAME=resolute\nUBUNTU_CODENAME=resolute\n',
    linuxmint: 'ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID="22.2"\nVERSION_CODENAME=zara\nUBUNTU_CODENAME=noble\n',
    // LMDE 7's own os-release (linuxmintd/lmde7-amd64, 2026-11-03): Mint on Debian, with no Ubuntu codename
    lmde: 'NAME="LMDE"\nVERSION_ID="7"\nVERSION_CODENAME=gigi\nID=linuxmint\nID_LIKE=debian\nDEBIAN_CODENAME=trixie\n' }[distro];
  put(path.join(sys, 'etc', 'os-release'), rel);
  const calls = [];
  const run = async (cmd, args = []) => {
    const k = [cmd, ...args].join(' ');
    calls.push(k);
    if (cmd === 'dpkg') return { status: 0, stdout: 'arm64\n' };
    if (cmd === 'apt-get' || cmd === 'dpkg-query') return { status: 0, stdout: '' };
    if (cmd === 'apt') return { status: 0, stdout: UPGRADABLE };
    if (cmd === 'curl') {
      const url = args[args.length - 1];
      const hit = Object.entries(answers).find(([p]) => url.startsWith(p));
      return hit ? { status: 0, stdout: JSON.stringify(hit[1]) } : { status: 22, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  const state = path.join(ROOT, `state-${Math.random().toString(36).slice(2)}`);
  return { run, calls, now: NOW, today: '2026-11-03', platform: 'linux', family: 'debian', sysroot: sys, cache: path.join(state, 'cache'),
    cfg: { policy: { min_release_age_days: 3 }, profiles: { ai_tooling: false }, paths: { state } }, policy: { security_exception: [] }, home: ROOT, ...extra };
}
const SNAP = 'https://snapshot.debian.org/mr/binary/';
const LP = 'https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedBinaries';

test('releaseDate on Debian: snapshot.debian.org, the version URL-encoded; cached for the day', async () => {
  const c = ctx('debian', { [`${SNAP}tzdata/2026f-0%2Bdeb13u1/binfiles`]: { fileinfo: { a: [{ archive_name: 'debian', first_seen: '20261028T080000Z' }] } } });
  assert.deepEqual(await A.source.releaseDate(c, 'tzdata', '2026f-0+deb13u1'), { date: '2026-10-28T08:00:00Z', from: 'snapshot' });
  await A.source.releaseDate(c, 'tzdata', '2026f-0+deb13u1');
  assert.equal(c.calls.filter(k => k.startsWith('curl')).length, 1, 'the second answer came from the cache');
});

test('releaseDate on Ubuntu and on Mint (its Ubuntu base): Launchpad, for this release and CPU', async () => {
  const lp = { entries: [{ pocket: 'Updates', status: 'Published', date_published: '2026-10-14T14:30:55+00:00' }] };
  const u = ctx('ubuntu', { [LP]: lp });
  assert.deepEqual(await A.source.releaseDate(u, 'tzdata', '2026e-0ubuntu0.26.04.1'), { date: '2026-10-14T14:30:55.000Z', from: 'Launchpad' });
  const url = u.calls.find(k => k.startsWith('curl')).split(' ').pop();
  assert.ok(url.includes('binary_name=tzdata') && url.includes('version=2026e-0ubuntu0.26.04.1') && url.includes('ubuntu%2Fresolute%2Farm64'), url);
  const m = ctx('linuxmint', { [LP]: lp });
  await A.source.releaseDate(m, 'tzdata', '2026e-0ubuntu0.24.04.1');
  assert.ok(m.calls.find(k => k.startsWith('curl')).includes('ubuntu%2Fnoble%2Farm64'), 'Mint is dated on its Ubuntu base');
});

test('releaseDate with no public date (Mint\'s own repo, a PPA): the first-seen clock', async () => {
  const m = ctx('linuxmint', { [LP]: { entries: [] } });
  assert.deepEqual(await A.source.releaseDate(m, 'mintupdate', '6.0.5'), { date: NOW.toISOString(), from: 'first seen here' });
});

test('releaseDate on LMDE (Mint on Debian): snapshot.debian.org, as on Debian; a version Debian never had is first seen (parity 1c)', async () => {
  const c = ctx('lmde', { [`${SNAP}tzdata/2026f-0%2Bdeb13u1/binfiles`]: { fileinfo: { a: [{ archive_name: 'debian', first_seen: '20261028T080000Z' }] } } });
  assert.deepEqual(await A.source.releaseDate(c, 'tzdata', '2026f-0+deb13u1'), { date: '2026-10-28T08:00:00Z', from: 'snapshot' });
  assert.ok(!c.calls.some(k => k.includes('launchpad')), 'never Launchpad: LMDE has no Ubuntu base');
  const m = ctx('lmde');
  assert.deepEqual(await A.source.releaseDate(m, 'mintupdate', '7.1.2'), { date: NOW.toISOString(), from: 'first seen here' });
  assert.ok(m.calls.some(k => k.startsWith('curl') && k.includes('snapshot.debian.org')), 'snapshot was asked first');
});

test('sources: apt on the Debian family only', () => {
  const base = { now: NOW, cfg: { policy: { min_release_age_days: 3 } } };
  assert.ok(P.sources({ ...base, platform: 'linux', family: 'debian' }).some(s => s.id === 'apt'));
  assert.ok(!P.sources({ ...base, platform: 'linux', family: 'rhel' }).some(s => s.id === 'apt'));
  assert.ok(!P.sources({ ...base, platform: 'macos', family: null }).some(s => s.id === 'apt'));
});

test('plan on Debian: apt\'s section; old enough is taken, pinned, with why; a security pocket is taken at once; young is held (parity 1b)', async () => {
  const c = ctx('debian', {
    [`${SNAP}tzdata/`]: { fileinfo: { a: [{ archive_name: 'debian', first_seen: '20261028T080000Z' }] } },
    [`${SNAP}libc6/`]: { fileinfo: { a: [{ archive_name: 'debian-security', first_seen: '20261102T080000Z' }] } },
  }, { sources: [A.source] });
  c.run = (orig => async (cmd, args = []) => (cmd === 'mise' ? { status: 0, stdout: '{}' } : cmd === 'node' ? { status: 0, stdout: 'ok\t2026.10.21\t2026.10.21\tcurrent\tfalse\n' } : orig(cmd, args)))(c.run);
  const lines = [], sections = [];
  const p = await plan(c, { section: (_n, t) => sections.push(t), line: l => lines.push(l), warn: () => {} });
  assert.equal(sections[0], 'apt packages');
  assert.ok(lines.includes('take   tzdata 2026e-0+deb13u1 -> 2026f-0+deb13u1 (6d old, snapshot)'), lines.join('\n'));
  assert.ok(lines.includes('take   libc6 2.41-12+deb13u1 -> 2.41-12+deb13u2 (security pocket: trixie-security)'), lines.join('\n'));
  assert.ok(lines.includes('hold   mintupdate 6.0.4 -> 6.0.5 (0d old, first seen here)'), lines.join('\n'));
  assert.ok(!lines.some(l => l.startsWith('manual apt')), 'no longer a manual line (D-b revised)');
  assert.deepEqual(p.packages, [{ source: 'apt', names: ['tzdata', 'libc6'], items: [
    { name: 'tzdata', have: '2026e-0+deb13u1', want: '2026f-0+deb13u1', why: 'gate: 6d old, snapshot' },
    { name: 'libc6', have: '2.41-12+deb13u1', want: '2.41-12+deb13u2', why: 'security pocket: trixie-security' },
  ] }]);
  const lists = c.calls.find(k => k.startsWith('apt-get') && k.includes(' update'));
  assert.ok(lists && lists.includes('Dir::State::Lists=') && !lists.startsWith('sudo'), `its own lists, no sudo: ${lists}`);
});

test('judge: a security-pocket version is taken whatever its age, and says which pocket; others still wait out the gate', async () => {
  const c = ctx('debian', { [`${SNAP}libc6/`]: { fileinfo: { a: [{ archive_name: 'debian-security', first_seen: '20261103T080000Z' }] } } });
  const j = await P.judge(c, A.source, { name: 'libc6', suite: 'trixie-security', have: '2.41-12+deb13u1', want: '2.41-12+deb13u2' });
  assert.equal(j.verdict, 'take');
  assert.equal(j.age, 0);
  assert.equal(j.pocket, 'trixie-security');
  const k = await P.judge(c, A.source, { name: 'libc6', suite: 'trixie-updates', have: '2.41-12+deb13u1', want: '2.41-12+deb13u2' });
  assert.equal(k.verdict, 'hold');
  assert.equal(k.pocket, undefined);
});
