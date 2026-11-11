// The dnf source (parity dnf 1a, lib/providers/dnf.js): Fedora packages, read-only. Its own metadata cache, read as the
// user; testing repos never read; each new version dated by Bodhi's date_stable for its advisory (never the advisory's
// own issued time), else for its build, else the release's day for a version only in the release's own repo, else the
// first-seen clock; a security advisory taken at once. No network: dnf5, rpm and curl are canned, from real output trimmed (Fedora 43, 44 and 45
// containers, 2026-11-11).
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../lib/providers/dnf.js');
const P = require('../lib/providers/index.js');
const { plan, apply } = require('../supply-chain/bin/upgrade.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-dnf-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date('2026-11-11T21:00:00Z');
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

// `dnf5 repoquery --upgrades --latest-limit=1 --qf '%{name} %{evr} %{arch} %{repoid} %{sourcerpm}\n'` (Fedora 44, trimmed;
// the last line is the fedora:45 prerelease image's, from a testing repo, to show it is dropped)
const UPGRADES = `tzdata 2026f-1.fc44 noarch updates tzdata-2026f-1.fc44.src.rpm
openssl-libs 1:3.5.9-1.fc44 aarch64 updates openssl-3.5.9-1.fc44.src.rpm
glibc 2.43-9.fc44 aarch64 updates glibc-2.43-9.fc44.src.rpm
vim-minimal 2:9.2.1302-2.fc44 aarch64 updates vim-9.2.1302-2.fc44.src.rpm
fedora-gpg-keys 44-2 noarch fedora fedora-repos-44-2.src.rpm
mystery 1.0-1.fc44 aarch64 updates mystery-1.0-1.fc44.src.rpm
libblkid 2.42.4-1.fc45 aarch64 updates-testing util-linux-2.42.4-1.fc45.src.rpm
`;
// `rpm -q --qf '%{NAME} %{EPOCHNUM}:%{VERSION}-%{RELEASE}\n' …`
const INSTALLED = `tzdata 0:2026c-1.fc44
openssl-libs 1:3.5.4-2.fc44
glibc 0:2.43-8.fc44
vim-minimal 2:9.2.1200-1.fc44
fedora-gpg-keys 0:44-1
mystery 0:0.9-1.fc44
`;
// `dnf5 advisory list --json` on dnf5 5.4 (Fedora 44): "buildtime" holds the issued time, in epoch seconds. vim's is the
// day it went to testing (2026-11-10 02:52:25), not the day it went stable (2026-11-11 01:02:59): the repo's updateinfo
// still had it so in the compose that made it stable (seen live, 2026-11-11)
const ADV54 = JSON.stringify([
  { name: 'FEDORA-2026-eb1954eea8', type: 'unspecified', severity: 'None', nevra: 'tzdata-2026f-1.fc44.noarch', buildtime: 1793928302 },
  { name: 'FEDORA-2026-12f3f3d569', type: 'security', severity: 'Important', nevra: 'openssl-libs-1:3.5.9-1.fc44.aarch64', buildtime: 1790989781 },
  { name: 'FEDORA-2026-97b00a408b', type: 'bugfix', severity: 'None', nevra: 'vim-minimal-2:9.2.1302-2.fc44.aarch64', buildtime: 1794279145 },
]);
// Bodhi /updates/?alias=…&alias=… (trimmed): the stable date of each
const BODHI_ALIASES = { updates: [
  { alias: 'FEDORA-2026-eb1954eea8', status: 'stable', date_testing: '2026-11-05 03:03:56', date_stable: '2026-11-06 01:25:02' },
  { alias: 'FEDORA-2026-12f3f3d569', status: 'stable', date_testing: '2026-10-01 02:00:29', date_stable: '2026-10-03 01:09:41' },
  { alias: 'FEDORA-2026-97b00a408b', status: 'stable', date_testing: '2026-11-10 02:52:25', date_stable: '2026-11-11 01:02:59' },
] };
// the same on dnf5 5.2.18 (Fedora 43): the issued time as a UTC string
const ADV52 = JSON.stringify([
  { name: 'FEDORA-2026-5879bc27e1', type: 'security', severity: 'Moderate', nevra: 'dnf5-5.2.18.0-6.fc43.aarch64', buildtime: '2026-11-10 01:52:44' },
]);
// Bodhi /updates/?builds=glibc-2.43-9.fc44 (trimmed)
const BODHI_GLIBC = { updates: [{ alias: 'FEDORA-2026-8dd7cc3306', status: 'stable', type: 'unspecified', date_submitted: '2026-09-29 11:08:14',
  date_testing: '2026-09-30 02:25:49', date_stable: '2026-10-01 01:11:24', date_pushed: '2026-10-01 01:11:24' }] };
// Bodhi /releases/F44 (trimmed)
const BODHI_F44 = { name: 'F44', state: 'current', released_on: '2026-04-28', eol: '2027-06-02' };

test('parseUpgrades: name, version (epoch kept), arch, repo and source build; a testing repo is dropped', () => {
  const u = D.parseUpgrades(UPGRADES);
  assert.deepEqual(u[1], { name: 'openssl-libs', want: '1:3.5.9-1.fc44', arch: 'aarch64', repo: 'updates', srpm: 'openssl-3.5.9-1.fc44' });
  assert.equal(u.length, 6);
  assert.ok(!u.some(i => i.repo === 'updates-testing'), 'never from testing');
  assert.deepEqual(D.parseUpgrades(''), []);
});

test('parseInstalled: epoch 0 dropped as dnf5 drops it; others kept; a package not installed is left out', () => {
  assert.deepEqual(D.parseInstalled(`${INSTALLED}nope package nope is not installed\n`).tzdata, '2026c-1.fc44');
  assert.equal(D.parseInstalled(INSTALLED)['openssl-libs'], '1:3.5.4-2.fc44');
  assert.equal(D.parseInstalled('package nope is not installed\n').nope, undefined);
});

test('issuedISO: dnf5 5.4\'s epoch seconds and 5.2\'s UTC string give the same instant as Bodhi\'s date_stable', () => {
  assert.equal(D.issuedISO(1792718499), '2026-10-23T01:21:39.000Z', 'ca-certificates on Fedora 44: Bodhi said 2026-10-23 01:21:39');
  assert.equal(D.issuedISO('2026-11-10 01:52:44'), '2026-11-10T01:52:44Z');
  assert.equal(D.issuedISO('soon'), '');
  assert.equal(D.issuedISO(undefined), '');
});

test('parseAdvisories: keyed by name-evr (arch dropped); the type says security; both dnf5 forms read', () => {
  const a = D.parseAdvisories(ADV54);
  assert.deepEqual(a['openssl-libs-1:3.5.9-1.fc44'], { id: 'FEDORA-2026-12f3f3d569', type: 'security', issued: '2026-10-03T01:09:41.000Z', security: true });
  assert.equal(a['tzdata-2026f-1.fc44'].security, false);
  assert.equal(D.parseAdvisories(ADV52)['dnf5-5.2.18.0-6.fc43'].issued, '2026-11-10T01:52:44Z');
  assert.deepEqual(D.parseAdvisories('not json'), {});
});

test('parseAdvisories: a version in two advisories keeps the earliest date, and is security if either is', () => {
  const a = D.parseAdvisories(JSON.stringify([
    { name: 'B', type: 'bugfix', nevra: 'x-1-1.fc44.noarch', buildtime: 1790000000 },
    { name: 'S', type: 'security', nevra: 'x-1-1.fc44.noarch', buildtime: 1790100000 },
  ]));
  assert.equal(a['x-1-1.fc44'].id, 'B');
  assert.equal(a['x-1-1.fc44'].security, true);
});

test('bodhiStable: each stable update\'s date_stable by alias; a testing one is left out', () => {
  assert.deepEqual(D.bodhiStable(BODHI_ALIASES)['FEDORA-2026-97b00a408b'], '2026-11-11T01:02:59Z');
  assert.deepEqual(D.bodhiStable({ updates: [{ alias: 'X', status: 'testing', date_stable: null }] }), {});
  assert.deepEqual(D.bodhiStable(null), {});
});

test('bodhiDate: date_stable of a stable update only; a testing one has none', () => {
  assert.equal(D.bodhiDate(BODHI_GLIBC), '2026-10-01T01:11:24Z');
  assert.equal(D.bodhiDate({ updates: [{ status: 'testing', date_stable: null }] }), '');
  assert.equal(D.bodhiDate(null), '');
});

// ctx(answers) — a Fedora 44 machine; curl answers by URL prefix, the rest canned; calls counted
function ctx(answers = {}, extra = {}) {
  const sys = path.join(ROOT, `sys-${Math.random().toString(36).slice(2)}`);
  put(path.join(sys, 'etc', 'os-release'), 'NAME="Fedora Linux"\nVERSION_ID=44\nID=fedora\nPRETTY_NAME="Fedora Linux 44 (Container Image)"\n');
  const calls = [];
  const run = async (cmd, args = []) => {
    const k = [cmd, ...args].join(' ');
    calls.push(k);
    if (cmd === 'dnf5' && args.includes('repoquery')) return { status: 0, stdout: UPGRADES };
    if (cmd === 'dnf5' && args.includes('advisory')) return { status: 0, stdout: ADV54 };
    if (cmd === 'dnf5' || (cmd === 'rpm' && args[0] === '--version')) return { status: 0, stdout: 'dnf5 version 5.4.3.0\n' };
    if (cmd === 'rpm') return { status: 0, stdout: INSTALLED };
    if (cmd === 'curl') {
      const url = args[args.length - 1];
      const hit = Object.entries(answers).find(([p]) => url.startsWith(p));
      return hit ? { status: 0, stdout: JSON.stringify(hit[1]) } : { status: 22, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  const state = path.join(ROOT, `state-${Math.random().toString(36).slice(2)}`);
  return { run, calls, now: NOW, today: '2026-11-11', platform: 'linux', family: 'rhel', sysroot: sys, cache: path.join(state, 'cache'),
    cfg: { policy: { min_release_age_days: 3 }, profiles: { ai_tooling: false }, paths: { state } }, policy: { security_exception: [] }, home: ROOT, ...extra };
}
const BODHI = 'https://bodhi.fedoraproject.org';

test('outdated: as the user, its own cache, never a testing repo; what is installed now beside each', async () => {
  const c = ctx();
  const items = await D.source.outdated(c);
  assert.equal(items.length, 6);
  assert.deepEqual(items.find(i => i.name === 'openssl-libs'), { name: 'openssl-libs', have: '1:3.5.4-2.fc44', want: '1:3.5.9-1.fc44', arch: 'aarch64', repo: 'updates',
    srpm: 'openssl-3.5.9-1.fc44', advisory: 'FEDORA-2026-12f3f3d569' });
  assert.equal(items.find(i => i.name === 'tzdata').advisory, undefined, 'not a security advisory');
  const q = c.calls.find(k => k.includes('repoquery'));
  assert.ok(q.startsWith('dnf5 ') && q.includes(`--setopt=cachedir=${path.join(c.cfg.paths.state, 'dnf', 'cache')}`) && q.includes('--disable-repo=*-testing'), q);
  assert.ok(!c.calls.some(k => k.startsWith('sudo')), 'no sudo');
});

test('releaseDate: Bodhi\'s stable date for the advisory (one request for all), else for the build, then the release\'s day, then first seen here', async () => {
  const c = ctx({ [`${BODHI}/updates/?alias=`]: BODHI_ALIASES, [`${BODHI}/updates/?builds=glibc-2.43-9.fc44`]: BODHI_GLIBC, [`${BODHI}/releases/F44`]: BODHI_F44 });
  await D.source.outdated(c);
  assert.deepEqual(await D.source.releaseDate(c, 'tzdata', '2026f-1.fc44'), { date: '2026-11-06T01:25:02Z', from: 'Bodhi' });
  assert.deepEqual(await D.source.releaseDate(c, 'vim-minimal', '2:9.2.1302-2.fc44'), { date: '2026-11-11T01:02:59Z', from: 'Bodhi' },
    'the stable day, never the advisory\'s issued time (its testing day)');
  const batch = c.calls.filter(k => k.includes('/updates/?alias='));
  assert.equal(batch.length, 1, 'one request for every advisory');
  for (const a of ['FEDORA-2026-eb1954eea8', 'FEDORA-2026-12f3f3d569', 'FEDORA-2026-97b00a408b']) assert.ok(batch[0].includes(`alias=${a}`), batch[0]);
  assert.deepEqual(await D.source.releaseDate(c, 'glibc', '2.43-9.fc44'), { date: '2026-10-01T01:11:24Z', from: 'Bodhi' });
  assert.deepEqual(await D.source.releaseDate(c, 'fedora-gpg-keys', '44-2'), { date: '2026-04-28T00:00:00Z', from: 'release day' });
  assert.deepEqual(await D.source.releaseDate(c, 'mystery', '1.0-1.fc44'), { date: NOW.toISOString(), from: 'first seen here' });
  const n = c.calls.filter(k => k.startsWith('curl')).length;
  await D.source.releaseDate(c, 'glibc', '2.43-9.fc44');
  assert.equal(c.calls.filter(k => k.startsWith('curl')).length, n, 'Bodhi\'s answer was cached for the day');
  assert.equal(c.calls.filter(k => k.includes('advisory list')).length, 1, 'advisories read once per run');
  const again = ctx({}, { cache: c.cache, cfg: c.cfg });
  await D.source.outdated(again);
  assert.deepEqual(await D.source.releaseDate(again, 'tzdata', '2026f-1.fc44'), { date: '2026-11-06T01:25:02Z', from: 'Bodhi' }, 'a later run the same day: from the cache');
  assert.ok(!again.calls.some(k => k.includes('alias=')), 'no request');
});

test('releaseDate when Bodhi can\'t be reached: the first-seen clock, never the advisory\'s issued time', async () => {
  const c = ctx();
  await D.source.outdated(c);
  assert.deepEqual(await D.source.releaseDate(c, 'tzdata', '2026f-1.fc44'), { date: NOW.toISOString(), from: 'first seen here' });
  const j = await P.judge(c, D.source, { name: 'vim-minimal', have: '2:9.2.1200-1.fc44', want: '2:9.2.1302-2.fc44' });
  assert.equal(j.verdict, 'hold');
});

test('judge: a security advisory is taken at once and named; any other waits out the gate', async () => {
  const c = ctx({ [`${BODHI}/updates/?alias=`]: BODHI_ALIASES });
  const items = await D.source.outdated(c);
  const j = await P.judge(c, D.source, items.find(i => i.name === 'openssl-libs'));
  assert.equal(j.verdict, 'take');
  assert.equal(j.pocket, 'FEDORA-2026-12f3f3d569');
  const k = await P.judge(c, D.source, items.find(i => i.name === 'vim-minimal'));
  assert.equal(k.verdict, 'hold', 'vim\'s bugfix went stable 2026-11-11: 0 days old');
});

test('sources: dnf on the rhel family only', () => {
  const base = { now: NOW, cfg: { policy: { min_release_age_days: 3 } } };
  assert.ok(P.sources({ ...base, platform: 'linux', family: 'rhel' }).some(s => s.id === 'dnf'));
  assert.ok(!P.sources({ ...base, platform: 'linux', family: 'debian' }).some(s => s.id === 'dnf'));
  assert.ok(!P.sources({ ...base, platform: 'macos', family: null }).some(s => s.id === 'dnf'));
});

test('plan on Fedora: read-only until dnf 1b; each update past the gate is its exact sudo line, nothing planned for apply', async () => {
  const c = ctx({ [`${BODHI}/updates/?alias=`]: BODHI_ALIASES, [`${BODHI}/updates/?builds=glibc-2.43-9.fc44`]: BODHI_GLIBC, [`${BODHI}/releases/F44`]: BODHI_F44 }, { sources: [D.source] });
  c.run = (orig => async (cmd, args = []) => (cmd === 'mise' ? { status: 0, stdout: '{}' } : cmd === 'node' ? { status: 0, stdout: 'ok\t2026.10.21\t2026.10.21\tcurrent\tfalse\n' } : orig(cmd, args)))(c.run);
  const lines = [], sections = [];
  const p = await plan(c, { section: (_n, t) => sections.push(t), line: l => lines.push(l), warn: () => {} });
  assert.equal(sections[0], 'dnf packages');
  const say = l => assert.ok(lines.includes(l), `${l}\n---\n${lines.join('\n')}`);
  say('manual dnf: needs root, which the steward takes on in dnf 1b (5d old, Bodhi): sudo dnf5 upgrade -y tzdata-2026f-1.fc44.noarch');
  say('manual dnf: needs root, which the steward takes on in dnf 1b (security advisory: FEDORA-2026-12f3f3d569): sudo dnf5 upgrade -y openssl-libs-1:3.5.9-1.fc44.aarch64');
  say('manual dnf: needs root, which the steward takes on in dnf 1b (41d old, Bodhi): sudo dnf5 upgrade -y glibc-2.43-9.fc44.aarch64');
  say('manual dnf: needs root, which the steward takes on in dnf 1b (197d old, release day): sudo dnf5 upgrade -y fedora-gpg-keys-44-2.noarch');
  say('hold   vim-minimal 2:9.2.1200-1.fc44 -> 2:9.2.1302-2.fc44 (0d old, Bodhi)');
  say('hold   mystery 0.9-1.fc44 -> 1.0-1.fc44 (0d old, first seen here)');
  assert.deepEqual(p.packages, [], 'apply gets nothing from dnf');
});

test('apply refuses a read-only source: it fails that step and runs nothing for it', async () => {
  const ran = [], keep = { log: console.log, error: console.error }, errs = [];
  Object.assign(console, { log: () => {}, error: (...a) => errs.push(a.join(' ')) });
  let code;
  try {
    code = await apply({ packages: [{ source: 'dnf', names: ['tzdata'], items: [{ name: 'tzdata', want: '2026f-1.fc44' }] }], tools: [], updaters: [], miseSelf: '' },
      { sources: [D.source], dry: false, step: async (cmd, args) => { ran.push([cmd, ...args].join(' ')); return 0; }, script: async (cmd) => { ran.push(cmd); return 0; },
        sudo: async () => { ran.push('sudo'); return 0; }, ctx: ctx() });
  } finally { Object.assign(console, keep); }
  assert.equal(code, 1);
  assert.ok(errs.some(e => e.includes('dnf: read-only until dnf 1b')), errs.join('\n'));
  assert.ok(!ran.some(k => k.startsWith('sudo') || k.startsWith('dnf5')), ran.join('\n'));
});
