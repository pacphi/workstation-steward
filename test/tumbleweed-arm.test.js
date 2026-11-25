// Tumbleweed on ARM (parity D91, lib/providers/tumbleweed-arm.js): ARM has no snapshot archive, so the one item is the
// live snapshot of openSUSE's ports repo, dated by the repo's own publish time (repomd <revision>), taken once that is
// the gate's days old. The plan shows one line; the receipt and the kept copies are per package (the source's `members`),
// and the way back is the kept copy of each package's build from before. No network: curl, uname, zypper and rpm are
// canned. The dup dry-run XML is a stand-in until the Mac's fixture (dup-dry-run-arm64.xml) replaces it.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/providers/tumbleweed-arm.js');
const X86 = require('../lib/providers/tumbleweed.js');
const P = require('../lib/providers/index.js');
const H = require('../lib/roothandoff.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-twarm-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date('2026-11-23T12:00:00Z');
const REVISION = Math.floor(Date.parse('2026-11-19T04:25:49Z') / 1000); // the Mac saw 1795062349 for snapshot 20261118
const PRODUCTS = '/ openSUSE 20261118-1\n';
const REPOMD = `<?xml version="1.0"?><repomd xmlns="http://linux.duke.edu/metadata/repo"><revision>${REVISION}</revision></repomd>`;
const DUP = `<?xml version='1.0'?><stream><install-summary packages-to-change="2">
<to-upgrade><solvable type="package" name="curl" edition="8.23.0-3.1" arch="aarch64" edition-old="8.23.0-1.1" repository="snap"/>
<solvable type="package" name="libcurl-mini4" edition="8.23.0-3.1" arch="aarch64" edition-old="8.23.0-1.1" repository="snap"/></to-upgrade>
</install-summary></stream>`;
const RPM = { curl: '8.23.0-1.1', 'libcurl-mini4': '8.23.0-1.1' };

function machine(o = {}) {
  const sys = path.join(ROOT, `sys-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(sys, 'etc'), { recursive: true });
  const state = path.join(ROOT, `state-${Math.random().toString(36).slice(2)}`);
  let version = o.version || '20261112';
  const rpm = { ...RPM };
  fs.writeFileSync(path.join(sys, 'etc', 'os-release'), `ID="${o.id || 'opensuse-tumbleweed'}"\nVERSION_ID="${version}"\n`);
  const calls = [], sudo = [], printed = [];
  let live = o.products || PRODUCTS;
  const offers = new Set(['8.23.0-3.1']); // ARM's repo offers only its newest build
  const run = async (cmd, args = []) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'curl') {
      if (o.offline) return { status: 7, stdout: '' };
      return { status: 0, stdout: args.some(a => a.endsWith('media.1/products')) ? live : (o.repomd || REPOMD) };
    }
    if (cmd === 'uname') return { status: 0, stdout: `${o.arch || 'aarch64'}\n` };
    if (cmd === 'rpm') return { status: 0, stdout: args.filter(a => rpm[a]).map(a => `${a} 0:${rpm[a]}`).join('\n') };
    if (cmd === 'zypper' && args.includes('dup') && args.includes('--dry-run')) return { status: 0, stdout: o.dup || DUP };
    if (cmd === 'zypper' && args.includes('download')) {
      const dest = args.find(a => a.startsWith('--pkg-cache-dir=')).slice('--pkg-cache-dir='.length);
      const spec = args[args.length - 1].replace(/\.aarch64/, '');
      const [n, v] = spec.split('=');
      if (!offers.has(v)) return { status: 104, stdout: '' };
      fs.mkdirSync(path.join(dest, 'repo-oss', 'aarch64'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'repo-oss', 'aarch64', `${n}-${v}.aarch64.rpm`), `${n} ${v}`);
      return { status: 0, stdout: '' };
    }
    if (cmd === 'zypper') return { status: 0, stdout: 'zypper 1.14' };
    return { status: 1, stdout: '' };
  };
  const c = { run, now: NOW, sysroot: sys, platform: 'linux', family: 'suse', cfg: { policy: { min_release_age_days: 3, kept_versions: 2 }, paths: { state } }, policy: {}, today: '2026-11-23', calls };
  // the root steps stand in: the dup moves os-release and every package to the wanted build
  const spawn = async (_c, args) => {
    sudo.push(`sudo ${args.join(' ')}`);
    if (args.includes('dup')) {
      version = '20261118';
      fs.writeFileSync(path.join(sys, 'etc', 'os-release'), `ID="opensuse-tumbleweed"\nVERSION_ID="${version}"\n`);
      rpm.curl = '8.23.0-3.1'; rpm['libcurl-mini4'] = '8.23.0-3.1';
    }
    if (args.includes('--oldpackage')) { rpm.curl = '8.23.0-1.1'; rpm['libcurl-mini4'] = '8.23.0-1.1'; version = '20261112'; fs.writeFileSync(path.join(sys, 'etc', 'os-release'), `ID="opensuse-tumbleweed"\nVERSION_ID="${version}"\n`); return o.rollbackCode || 0; }
    return 0;
  };
  return { c, sudo, printed, offers, live: v => { live = v; }, o: extra => ({ spawn, print: s => printed.push(String(s)), ...extra }) };
}

test('parseProducts: the live snapshot name from media.1/products; anything else is empty', () => {
  assert.equal(T.parseProducts('/ openSUSE 20261118-1\n'), '20261118');
  assert.equal(T.parseProducts('/ openSUSE 20261118-1'), '20261118');
  assert.equal(T.parseProducts('<html>403</html>'), '');
  assert.equal(T.parseProducts(''), '');
});

test('parseRevision: the repo\'s publish time from repomd; empty when unreadable', () => {
  assert.equal(T.parseRevision(REPOMD), '2026-11-19T04:25:49.000Z');
  assert.equal(T.parseRevision('<repomd></repomd>'), '');
  assert.equal(T.parseRevision('nope'), '');
});

test('parseDup: each package a dup would change, from the dry-run XML', () => {
  assert.deepEqual(T.parseDup(DUP), [
    { name: 'curl', have: '8.23.0-1.1', want: '8.23.0-3.1', arch: 'aarch64' },
    { name: 'libcurl-mini4', have: '8.23.0-1.1', want: '8.23.0-3.1', arch: 'aarch64' },
  ]);
  assert.deepEqual(T.parseDup('<stream/>'), []);
});

test('outdated: one item, the live snapshot; the date is the repo\'s publish time, never the name', async () => {
  const m = machine();
  const items = await T.source.outdated(m.c);
  assert.deepEqual(items, [{ name: 'tumbleweed', have: '20261112', want: '20261118', packages: 2 }]);
  const d = /** @type {any} */ (await T.source.releaseDate(m.c, 'tumbleweed', '20261118'));
  assert.equal(d.date, '2026-11-19T04:25:49.000Z');
  const j = await P.judge(m.c, T.source, items[0]);
  assert.equal(j.verdict, 'take', 'published 3 days and 8 hours before now');
});

test('outdated: a live snapshot younger than the gate is held, and says when it is eligible', async () => {
  const m = machine();
  m.c.now = new Date('2026-11-20T12:00:00Z');
  const items = await T.source.outdated(m.c);
  assert.equal((await P.judge(m.c, T.source, items[0])).verdict, 'hold');
});

test('outdated: current, not Tumbleweed, not aarch64, or an unreadable repo: nothing taken, each said, never up to date', async () => {
  assert.deepEqual(await T.source.outdated(machine({ version: '20261118' }).c), []);
  assert.deepEqual(await T.source.outdated(machine({ version: '20261120' }).c), [], 'never backwards');
  assert.deepEqual(await T.source.outdated(machine({ id: 'opensuse-leap' }).c), []);
  assert.deepEqual(await T.source.manual(machine({ id: 'opensuse-leap' }).c), []);
  assert.deepEqual(await T.source.outdated(machine({ arch: 'x86_64' }).c), []);
  assert.deepEqual(await T.source.manual(machine({ arch: 'x86_64' }).c), [], 'x86_64 is the other source\'s');
  const off = machine({ offline: true });
  assert.deepEqual(await T.source.outdated(off.c), []);
  assert.match((await T.source.manual(off.c))[0], /couldn't read the live ARM snapshot/);
  const odd = machine({ version: 'rolling' });
  assert.match((await T.source.manual(odd.c))[0], /couldn't read the installed snapshot/);
});

test('the x86_64 source no longer says ARM is "not checked yet"', async () => {
  const m = machine();
  assert.deepEqual(await X86.source.manual(m.c), []);
  assert.deepEqual(await X86.source.outdated(m.c), []);
});

test('sources: the ARM source is on the suse family only, in snapshot mode', () => {
  const base = { now: NOW, cfg: { policy: { min_release_age_days: 3 } } };
  assert.ok(P.sources({ ...base, platform: 'linux', family: 'suse' }).some(s => s.id === 'tumbleweed-arm'));
  assert.ok(!P.sources({ ...base, platform: 'linux', family: 'debian' }).some(s => s.id === 'tumbleweed-arm'));
  assert.equal(T.source.gateMode, 'snapshot');
});

test('the plan uses the steward\'s own repo file for the live ports repo, never the system\'s repos', async () => {
  const m = machine();
  await T.source.outdated(m.c);
  const dry = m.c.calls.find(k => k.startsWith('zypper') && k.includes(' dup ') && k.includes('--dry-run'));
  assert.ok(dry, m.c.calls.join('\n'));
  assert.match(dry, /--reposd-dir=/);
  assert.match(dry, /--xmlout/);
  const repos = fs.readdirSync(path.join(m.c.cfg.paths.state, 'zypper', 'arm-repos'));
  assert.ok(repos.length, 'a .repo file was written');
  assert.match(fs.readFileSync(path.join(m.c.cfg.paths.state, 'zypper', 'arm-repos', repos[0]), 'utf8'), /ports\/aarch64\/tumbleweed\/repo\/oss\//);
});

test('members: the receipt\'s per-package items come from the dry-run, behind the one plan line', async () => {
  const m = machine();
  const items = await T.source.outdated(m.c);
  assert.deepEqual((await T.source.members(m.c, items)).map(i => i.name), ['curl', 'libcurl-mini4']);
});

test('preflight: refuses when the live snapshot is no longer the planned one, and says so', async () => {
  const m = machine();
  const items = await T.source.outdated(m.c);
  assert.equal(await T.source.preflight(m.c, items), null);
  const stale = machine({ products: '/ openSUSE 20261120-1\n' });
  const why = await T.source.preflight(stale.c, [{ name: 'tumbleweed', have: '20261112', want: '20261118' }]);
  assert.match(why, /20261120.*20261118|20261118.*20261120/);
});

test('upgrade at a terminal: repos set aside, the live ports repo added, refreshed, dup from it; every package kept and checked', async () => {
  const m = machine();
  const items = await T.source.outdated(m.c);
  assert.equal(await H.upgrade(m.c, T.source, items, m.o({ tty: true })), 0, m.printed.join('\n'));
  assert.deepEqual(m.sudo, [
    'sudo zypper --non-interactive modifyrepo --disable --all',
    'sudo zypper --non-interactive addrepo --refresh --check https://download.opensuse.org/ports/aarch64/tumbleweed/repo/oss/ snap-arm-20261118',
    'sudo zypper --non-interactive --gpg-auto-import-keys refresh snap-arm-20261118',
    'sudo zypper --non-interactive dup --from snap-arm-20261118 --allow-downgrade --no-recommends --auto-agree-with-licenses',
  ]);
  const dir = path.join(m.c.cfg.paths.state, 'backups');
  const r = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0], 'receipt.json'), 'utf8'));
  assert.equal(r.outcome, 'done');
  assert.deepEqual(r.items.map(i => i.name), ['curl', 'libcurl-mini4'], 'the receipt is per package');
  assert.deepEqual(r.kept.curl, { have: false, want: true }, 'the build from before is gone from ARM\'s repo; the new one is kept');
  assert.deepEqual(r.back.items, [], 'the first move has no way back');
  assert.equal(r.back.none.length, 2);
});

test('the second move has a way back: the kept copies, installed with --oldpackage, rc 106 counted as success', async () => {
  const m = machine();
  // the first move kept the 8.23.0-1.1 builds (as if a move before had)
  const K = require('../lib/kept.js');
  m.offers.add('8.23.0-1.1');
  for (const n of ['curl', 'libcurl-mini4']) await K.keep(m.c, T.source, n, '8.23.0-1.1');
  m.offers.delete('8.23.0-1.1');
  const items = await T.source.outdated(m.c);
  assert.equal(await H.upgrade(m.c, T.source, items, m.o({ tty: true })), 0, m.printed.join('\n'));
  const dir = path.join(m.c.cfg.paths.state, 'backups');
  const rp = path.join(dir, fs.readdirSync(dir)[0], 'receipt.json');
  const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
  assert.equal(r.back.items.length, 2);
  assert.ok(r.back.items.every(b => b.file && b.sha256));
  m.sudo.length = 0;
  assert.equal(await H.rollback(m.c, T.source, rp, m.o({ tty: true, ask: async () => true, spawn: async (_c, a) => { m.sudo.push(`sudo ${a.join(' ')}`); return 106; } })), 1, 'the stand-in sudo moved nothing, so the check after fails');
});

test('a step may name exit codes that count as success (zypper offline exits 106)', async () => {
  const m = machine();
  const items = await T.source.outdated(m.c);
  const calls = [];
  const spawn = async (_c, a) => { calls.push(a); if (a.includes('dup')) { return 106; } return 0; };
  await H.upgrade(m.c, T.source, items, m.o({ tty: true, spawn }));
  assert.equal(calls.length, 4, 'the dup step\'s 106 did not stop the run');
});

test('upgrade with no terminal: the chain is handed over as one line, and says which snapshot it expects', async () => {
  const m = machine();
  const items = await T.source.outdated(m.c);
  assert.equal(await H.upgrade(m.c, T.source, items, m.o({ tty: false })), 4);
  assert.deepEqual(m.sudo, []);
  assert.ok(m.printed.some(l => l.includes('snap-arm-20261118')), m.printed.join('\n'));
});

test('upgrade is refused before sudo when the live snapshot moved since the plan', async () => {
  const m = machine();
  const items = await T.source.outdated(m.c);
  m.live('/ openSUSE 20261120-1\n');
  assert.notEqual(await H.upgrade(m.c, T.source, items, m.o({ tty: true })), 0);
  assert.deepEqual(m.sudo, []);
  assert.ok(m.printed.some(l => /20261120/.test(l)), m.printed.join('\n'));
});

test('installed: tumbleweed is the os-release snapshot; other names come from rpm', async () => {
  const m = machine();
  assert.deepEqual(await T.source.installed(m.c, ['tumbleweed', 'curl']), { tumbleweed: '20261112', curl: '8.23.0-1.1' });
});
