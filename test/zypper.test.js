// The zypper source (parity zypper 1a and 1b, lib/providers/zypper.js): openSUSE Leap packages. Its own metadata
// cache, read as the user; each new version dated by the issued time of the patch that brings it (the update repo's own
// updateinfo, in that cache), else the first-seen clock; a security patch taken at once. Tumbleweed is said to be not
// checked. The upgrade goes through the root hand-off, refreshed and pinned; the way back is an --oldpackage install of
// the edition from before, while the repos offer it. No network: zypper and rpm are canned. The XML follows zypper's --xmlout and the rpm-md updateinfo format,
// with names and versions from zypper's step 0 on Leap 16.0 (2026-11-12).
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Z = require('../lib/providers/zypper.js');
const P = require('../lib/providers/index.js');
const { plan, apply } = require('../supply-chain/bin/upgrade.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-zypper-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date('2026-11-12T21:00:00Z');
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

// `zypper --non-interactive --cache-dir=… --xmlout list-updates`
const LU = `<?xml version='1.0'?>
<stream>
<message type="info">Loading repository data...</message>
<update-status version="0.6">
<update-list>
<update name="libpcre2-8-0" edition="10.45-160000.5.1" arch="aarch64" kind="package" edition-old="10.45-160000.4.1" >
<summary>A library for Perl-compatible regular expressions</summary>
<description></description>
<license></license>
<source url="http://download.opensuse.org/update/leap/16.0/oss" alias="repo-oss-update"/>
</update>
<update name="timezone" edition="2026f-160000.2.1" arch="aarch64" kind="package" edition-old="2026a-160000.1.1" >
<summary>Timezone Descriptions</summary>
<source url="http://download.opensuse.org/update/leap/16.0/oss" alias="repo-oss-update"/>
</update>
<update name="less" edition="679-160000.3.1" arch="aarch64" kind="package" edition-old="679-160000.2.1" >
<summary>Text File Browser and Pager Similar to more</summary>
<source url="http://download.opensuse.org/update/leap/16.0/oss" alias="repo-oss-update"/>
</update>
<update name="mystery" edition="1.1-160000.1.1" arch="noarch" kind="package" edition-old="1.0-160000.1.1" >
<source url="http://download.opensuse.org/distribution/leap/16.0/repo/oss" alias="repo-oss"/>
</update>
<update name="openSUSE-Leap-16.0-2026-12" edition="1" arch="noarch" kind="patch" status="needed" category="security" />
</update-list>
</update-status>
</stream>
`;
// the update repo's updateinfo.xml (rpm-md; issued in epoch seconds): pcre2's patch is a security one
const UPDATEINFO = `<?xml version="1.0" encoding="UTF-8"?>
<updates>
  <update from="maint-coord@suse.de" status="stable" type="security" version="1">
    <id>openSUSE-Leap-16.0-2026-12</id>
    <title>Security update for pcre2</title>
    <severity>important</severity>
    <release>openSUSE Leap 16.0</release>
    <issued date="1794355200"/>
    <pkglist>
      <collection>
        <package name="libpcre2-8-0" epoch="0" version="10.45" release="160000.5.1" arch="aarch64" src="src/pcre2-10.45-160000.5.1.src.rpm"><filename>libpcre2-8-0-10.45-160000.5.1.aarch64.rpm</filename></package>
      </collection>
    </pkglist>
  </update>
  <update from="maint-coord@suse.de" status="stable" type="recommended" version="1">
    <id>openSUSE-Leap-16.0-2026-7</id>
    <title>Recommended update for timezone</title>
    <severity>moderate</severity>
    <issued date="1793750400"/>
    <pkglist><collection>
      <package name="timezone" epoch="0" version="2026f" release="160000.2.1" arch="aarch64"><filename>timezone-2026f-160000.2.1.aarch64.rpm</filename></package>
    </collection></pkglist>
  </update>
  <update from="maint-coord@suse.de" status="stable" type="recommended" version="1">
    <id>openSUSE-Leap-16.0-2026-15</id>
    <title>Recommended update for less</title>
    <severity>low</severity>
    <issued date="1794398400"/>
    <pkglist><collection>
      <package name="less" epoch="0" version="679" release="160000.3.1" arch="aarch64"/>
    </collection></pkglist>
  </update>
</updates>
`;

test('parseUpdates: packages only (a patch row is not one), edition, the installed one, arch and repo alias', () => {
  const u = Z.parseUpdates(LU);
  assert.equal(u.length, 4);
  assert.deepEqual(u[0], { name: 'libpcre2-8-0', want: '10.45-160000.5.1', have: '10.45-160000.4.1', arch: 'aarch64', repo: 'repo-oss-update' });
  assert.equal(u[3].repo, 'repo-oss');
  assert.deepEqual(Z.parseUpdates(''), []);
});

test('parseUpdateinfo: every package each patch lists, by name and edition (epoch 0 left out); security from the type', () => {
  const p = Z.parseUpdateinfo(UPDATEINFO);
  assert.deepEqual(p['libpcre2-8-0 10.45-160000.5.1'], { id: 'openSUSE-Leap-16.0-2026-12', issued: '2026-11-11T00:00:00.000Z', security: true });
  assert.equal(p['timezone 2026f-160000.2.1'].security, false);
  assert.equal(Z.evr({ epoch: '2', version: '1.0', release: '3.1' }), '2:1.0-3.1');
  const two = Z.parseUpdateinfo(`<updates><update type="recommended"><id>B</id><issued date="1790000000"/><package name="x" epoch="0" version="1" release="1"/></update>
<update type="security"><id>S</id><issued date="1790100000"/><package name="x" epoch="0" version="1" release="1"/></update></updates>`);
  assert.deepEqual(two['x 1-1'], { id: 'B', issued: new Date(1790000000e3).toISOString(), security: true }, 'the earliest, and security if either is');
  assert.deepEqual(Z.parseUpdateinfo('not xml'), {});
});

test('issuedISO: epoch seconds, or a UTC date and time; anything else is no date', () => {
  assert.equal(Z.issuedISO('1794355200'), '2026-11-11T00:00:00.000Z');
  assert.equal(Z.issuedISO('2026-11-10 01:52:44'), '2026-11-10T01:52:44Z');
  assert.equal(Z.issuedISO('soon'), '');
  assert.equal(Z.issuedISO(undefined), '');
});

// ctx(o) — a Leap 16.0 (or o.id) machine with the update repo's updateinfo in the steward's own cache (o.ext: how it is
// compressed); zypper and rpm canned; calls counted
function ctx(o = {}) {
  const sys = path.join(ROOT, `sys-${Math.random().toString(36).slice(2)}`);
  const id = o.id || 'opensuse-leap';
  put(path.join(sys, 'etc', 'os-release'), `NAME="openSUSE ${id === 'opensuse-leap' ? 'Leap' : 'Tumbleweed'}"\nVERSION_ID="${id === 'opensuse-leap' ? '16.0' : '20261110'}"\nID="${id}"\n`);
  const state = path.join(ROOT, `state-${Math.random().toString(36).slice(2)}`);
  if (o.updateinfo !== false) {
    const rd = path.join(state, 'zypper', 'cache', 'raw', 'repo-oss-update', 'repodata');
    const ext = o.ext === undefined ? '.gz' : o.ext;
    const body = ext === '.gz' ? zlib.gzipSync(UPDATEINFO) : Buffer.from(UPDATEINFO);
    put(path.join(rd, `0123abcd-updateinfo.xml${ext}`), body);
    put(path.join(rd, 'repomd.xml'), '<repomd/>');
  }
  const calls = [];
  const run = async (cmd, args = []) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'zypper' && args.includes('list-updates')) return { status: 0, stdout: LU };
    if (cmd === 'zypper' && args.includes('search')) {
      const n = args[args.length - 1], eds = ((o.offered || {})[n] || []);
      return { status: 0, stdout: `<?xml version='1.0'?><stream><search-result version="0.0"><solvable-list>${
        (o.installed && o.installed[n] ? `<solvable status="installed" name="${n}" kind="package" edition="${o.installed[n]}" arch="aarch64" repository="(System Packages)"/>` : '')}${
        eds.map(e => `<solvable status="${o.installed && o.installed[n] === e ? 'installed' : 'not-installed'}" name="${n}" kind="package" edition="${e}" arch="aarch64" repository="Update repository (OSS)"/>`).join('')
      }<solvable status="not-installed" name="${n}-devel" kind="package" edition="9-9" arch="aarch64" repository="Main repository"/></solvable-list></search-result></stream>` };
    }
    if (cmd === 'rpm' && args[0] === '-q' && o.installed) return { status: 0, stdout: args.slice(3).map(n => (o.installed[n] ? `${n} ${/:/.test(o.installed[n]) ? '' : '0:'}${o.installed[n]}\n` : `package ${n} is not installed\n`)).join('') };
    if (cmd === 'zypper' || (cmd === 'rpm' && args[0] === '--version')) return { status: 0, stdout: 'zypper 1.14.94\n' };
    return { status: 1, stdout: '' };
  };
  return { run, calls, now: NOW, today: '2026-11-12', platform: 'linux', family: 'suse', sysroot: sys, cache: path.join(state, 'cache'),
    cfg: { policy: { min_release_age_days: 3 }, profiles: { ai_tooling: false }, paths: { state } }, policy: { security_exception: [] }, home: ROOT, ...(o.extra || {}) };
}

test('outdated: as the user, its own cache, no sudo; a security patch names itself', async () => {
  const c = ctx();
  const items = await Z.source.outdated(c);
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], { name: 'libpcre2-8-0', have: '10.45-160000.4.1', want: '10.45-160000.5.1', arch: 'aarch64', repo: 'repo-oss-update', advisory: 'openSUSE-Leap-16.0-2026-12' });
  assert.equal(items[1].advisory, undefined);
  const q = c.calls.find(k => k.includes('list-updates'));
  assert.ok(q.startsWith('zypper --non-interactive ') && q.includes(`--cache-dir=${path.join(c.cfg.paths.state, 'zypper', 'cache')}`), q);
  assert.ok(!c.calls.some(k => k.startsWith('sudo')), 'no sudo');
});

test('releaseDate: the issued time of the patch that brings it, else first seen here; a plain updateinfo.xml reads too', async () => {
  for (const ext of ['.gz', '']) {
    const c = ctx({ ext });
    await Z.source.outdated(c);
    assert.deepEqual(await Z.source.releaseDate(c, 'timezone', '2026f-160000.2.1'), { date: '2026-11-04T00:00:00.000Z', from: 'patch openSUSE-Leap-16.0-2026-7' });
    assert.deepEqual(await Z.source.releaseDate(c, 'mystery', '1.1-160000.1.1'), { date: NOW.toISOString(), from: 'first seen here' });
  }
  const none = ctx({ updateinfo: false });
  await Z.source.outdated(none);
  assert.deepEqual(await Z.source.releaseDate(none, 'timezone', '2026f-160000.2.1'), { date: NOW.toISOString(), from: 'first seen here' }, 'no updateinfo cached: the clock, never a guess');
});

test('judge: a security patch is taken at once and named; any other waits out the gate', async () => {
  const c = ctx();
  const items = await Z.source.outdated(c);
  const j = await P.judge(c, Z.source, items[0]);
  assert.equal(j.verdict, 'take');
  assert.equal(j.pocket, 'openSUSE-Leap-16.0-2026-12');
  assert.equal((await P.judge(c, Z.source, items[1])).verdict, 'take', 'timezone: 8 days old');
  assert.equal((await P.judge(c, Z.source, items[2])).verdict, 'hold', 'less: 1 day old');
});

test('Tumbleweed: nothing read, and the section says it is not checked, never up to date', async () => {
  const c = ctx({ id: 'opensuse-tumbleweed' });
  assert.deepEqual(await Z.source.outdated(c), []);
  assert.ok(!c.calls.some(k => k.includes('list-updates')));
  const m = await Z.source.manual(c);
  assert.equal(m.length, 1);
  assert.match(m[0], /^Tumbleweed: not checked/);
  assert.deepEqual(await Z.source.manual(ctx()), [], 'Leap has no such line');
});

test('sources: zypper on the suse family only', () => {
  const base = { now: NOW, cfg: { policy: { min_release_age_days: 3 } } };
  assert.ok(P.sources({ ...base, platform: 'linux', family: 'suse' }).some(s => s.id === 'zypper'));
  assert.ok(!P.sources({ ...base, platform: 'linux', family: 'rhel' }).some(s => s.id === 'zypper'));
  assert.ok(!P.sources({ ...base, platform: 'macos', family: null }).some(s => s.id === 'zypper'));
});

test('plan on Leap: each update past the gate is taken with its why; the rest held (zypper 1b)', async () => {
  const c = ctx({ extra: { sources: [Z.source] } });
  c.run = (orig => async (cmd, args = []) => (cmd === 'mise' ? { status: 0, stdout: '{}' } : cmd === 'node' ? { status: 0, stdout: 'ok\t2026.10.21\t2026.10.21\tcurrent\tfalse\n' } : orig(cmd, args)))(c.run);
  const lines = [], sections = [];
  const p = await plan(c, { section: (_n, t) => sections.push(t), line: l => lines.push(l), warn: () => {} });
  assert.equal(sections[0], 'zypper packages');
  const say = l => assert.ok(lines.includes(l), `${l}\n---\n${lines.join('\n')}`);
  say('take   libpcre2-8-0 10.45-160000.4.1 -> 10.45-160000.5.1 (security patch: openSUSE-Leap-16.0-2026-12)');
  say('take   timezone 2026a-160000.1.1 -> 2026f-160000.2.1 (8d old, patch openSUSE-Leap-16.0-2026-7)');
  say('hold   less 679-160000.2.1 -> 679-160000.3.1 (1d old, patch openSUSE-Leap-16.0-2026-15)');
  say('hold   mystery 1.0-160000.1.1 -> 1.1-160000.1.1 (0d old, first seen here)');
  assert.ok(!lines.some(l => l.startsWith('manual zypper')), 'no longer read-only');
  assert.equal(p.packages.length, 1);
  assert.deepEqual(p.packages[0].names, ['libpcre2-8-0', 'timezone']);
  assert.deepEqual(Z.source.upgradeCmd(p.packages[0].items).args,
    ['--non-interactive', 'install', '--no-recommends', 'libpcre2-8-0=10.45-160000.5.1', 'timezone=2026f-160000.2.1'], 'each pinned to the exact edition');
  assert.deepEqual(Z.source.rootRefresh, { cmd: 'zypper', args: ['--non-interactive', 'refresh'] });
  assert.equal(Z.source.readOnly, undefined);
});

test('zypper: installed from rpm, as you; offered from the steward\'s own cache, the rpm database\'s row left out', async () => {
  const c = ctx({ installed: { timezone: '2026f-160000.2.1', vim: '1:9.1-1.1' }, offered: { timezone: ['2026a-160000.1.1', '2026f-160000.2.1'] } });
  assert.deepEqual(await Z.source.installed(c, ['timezone', 'vim', 'gone']), { timezone: '2026f-160000.2.1', vim: '1:9.1-1.1' });
  assert.deepEqual(await Z.source.installed(c, []), {});
  assert.deepEqual(await Z.source.offered(c, 'timezone'), ['2026a-160000.1.1', '2026f-160000.2.1'], 'not timezone-devel, not the installed row');
  const q = c.calls.find(k => k.includes(' search '));
  assert.ok(q.includes(`--cache-dir=${path.join(c.cfg.paths.state, 'zypper', 'cache')}`) && q.includes('--match-exact'), q);
  assert.deepEqual(Z.source.rollbackCmd([{ name: 'timezone', to: '2026a-160000.1.1' }]),
    { cmd: 'zypper', args: ['--non-interactive', 'install', '--oldpackage', '--no-recommends', 'timezone=2026a-160000.1.1'] });
  assert.ok(!c.calls.some(k => k.startsWith('sudo')), 'all as you');
});

// leap(o) — a Leap machine whose rpm database the stand-in sudo changes: zypper install sets each name=edition it gets
function leap(o = {}) {
  const inst = { timezone: '2026a-160000.1.1', 'libpcre2-8-0': '10.45-160000.4.1', ...(o.installed || {}) };
  const c = ctx({ installed: inst, offered: o.offered || { timezone: ['2026a-160000.1.1', '2026f-160000.2.1'], 'libpcre2-8-0': ['10.45-160000.4.1', '10.45-160000.5.1'] } });
  const sudo = [], printed = [];
  const spawn = async (cmd, args) => {
    sudo.push([cmd, ...args].join(' '));
    if (args.includes('install')) for (const a of args) { const m = a.match(/^([^=]+)=(.+)$/); if (m) inst[m[1]] = m[2]; }
    return 0;
  };
  return { c, inst, sudo, printed, o: extra => ({ spawn, print: s => printed.push(String(s).replace(/\x1b\[[0-9;]*m/g, '')), ...extra }) };
}

test('zypper upgrade at a terminal: refreshed, then one pinned install; the receipt checks every edition and keeps the way back', async () => {
  const H = require('../lib/roothandoff.js');
  const m = leap();
  const items = [{ name: 'timezone', have: '2026a-160000.1.1', want: '2026f-160000.2.1', why: 'gate: 8d old, patch openSUSE-Leap-16.0-2026-7' },
    { name: 'libpcre2-8-0', have: '10.45-160000.4.1', want: '10.45-160000.5.1', why: 'security patch: openSUSE-Leap-16.0-2026-12' }];
  assert.equal(await H.upgrade(m.c, Z.source, items, m.o({ tty: true })), 0, m.printed.join('\n'));
  assert.deepEqual(m.sudo, ['sudo zypper --non-interactive refresh',
    'sudo zypper --non-interactive install --no-recommends timezone=2026f-160000.2.1 libpcre2-8-0=10.45-160000.5.1']);
  assert.deepEqual(m.inst, { timezone: '2026f-160000.2.1', 'libpcre2-8-0': '10.45-160000.5.1' });
  const rp = path.join(m.c.cfg.paths.state, 'backups', fs.readdirSync(path.join(m.c.cfg.paths.state, 'backups'))[0], 'receipt.json');
  const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
  assert.equal(r.outcome, 'done');
  assert.deepEqual(r.back.items, [{ name: 'timezone', to: '2026a-160000.1.1' }, { name: 'libpcre2-8-0', to: '10.45-160000.4.1' }], 'Leap keeps the builds from before');
  assert.equal(await H.rollback(m.c, Z.source, rp, m.o({ tty: true, ask: async () => true })), 0, m.printed.join('\n'));
  assert.equal(m.sudo[3], 'sudo zypper --non-interactive install --oldpackage --no-recommends timezone=2026a-160000.1.1 libpcre2-8-0=10.45-160000.4.1');
  assert.deepEqual(m.inst, { timezone: '2026a-160000.1.1', 'libpcre2-8-0': '10.45-160000.4.1' });
});

test('zypper rollback with nothing left to go back to: said, never a guess', async () => {
  const H = require('../lib/roothandoff.js');
  const m = leap({ offered: { timezone: ['2026f-160000.2.1'] } });
  const items = [{ name: 'timezone', have: '2026a-160000.1.1', want: '2026f-160000.2.1', why: 'gate: 8d old' }];
  assert.equal(await H.upgrade(m.c, Z.source, items, m.o({ tty: true })), 0);
  const rp = path.join(m.c.cfg.paths.state, 'backups', fs.readdirSync(path.join(m.c.cfg.paths.state, 'backups'))[0], 'receipt.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(rp, 'utf8')).back.items, []);
  assert.ok(m.printed.some(l => l === '   no way back for timezone: the archive no longer offers 2026a-160000.1.1'), m.printed.join('\n'));
});

test('zypper without a terminal: the exact lines are handed over and the receipt waits; nothing runs through sudo', async () => {
  const H = require('../lib/roothandoff.js');
  const m = leap();
  const items = [{ name: 'timezone', have: '2026a-160000.1.1', want: '2026f-160000.2.1', why: 'gate: 8d old' }];
  assert.equal(await H.upgrade(m.c, Z.source, items, m.o({ tty: false })), 4);
  assert.deepEqual(m.sudo, []);
  assert.ok(m.printed.some(l => l.includes('sudo zypper --non-interactive refresh && sudo zypper --non-interactive install --no-recommends timezone=2026f-160000.2.1')), m.printed.join('\n'));
});
