// The Tumbleweed snapshot source (parity D-a snapshot mode, lib/providers/tumbleweed.js): one whole-system move to the
// newest archived snapshot whose folder was published at least the gate's days ago; the way back is the snapshot from
// before. No network: curl, uname and zypper are canned. The archive lists follow what the Mac saw on 2026-11-20
// (history/list: eight-digit names, newest first; history/?jsontable: each folder's name and an epoch mtime).
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/providers/tumbleweed.js');
const P = require('../lib/providers/index.js');
const H = require('../lib/roothandoff.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-tw-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date('2026-11-20T12:00:00Z');
const day = (d, h = 0) => Math.floor(Date.parse(`${d}T${String(h).padStart(2, '0')}:00:00Z`) / 1000);

const LIST = '20261118\n20261115\n20261112\n20261110\n';
// folder times: each 1 to 2.5 days after its name
const TABLE = JSON.stringify({ data: [
  { name: '20261118', size: '-', mtime: day('2026-11-19', 20) },
  { name: '20261115', size: '-', mtime: day('2026-11-17', 6) },
  { name: '20261112', size: '-', mtime: day('2026-11-14', 2) },
  { name: '20261110', size: '-', mtime: day('2026-11-11', 12) },
  { name: 'README', size: 10, mtime: 1 },
] });

function machine(o = {}) {
  const sys = path.join(ROOT, `sys-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(sys, 'etc'), { recursive: true });
  const state = path.join(ROOT, `state-${Math.random().toString(36).slice(2)}`);
  let version = o.version || '20261112';
  fs.writeFileSync(path.join(sys, 'etc', 'os-release'), `ID="${o.id || 'opensuse-tumbleweed'}"\nVERSION_ID="${version}"\n`);
  const calls = [], sudo = [], printed = [];
  const run = async (cmd, args = []) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'curl') {
      if (o.offline) return { status: 7, stdout: '' };
      return { status: 0, stdout: args.some(a => a.endsWith('/list')) ? (o.list || LIST) : (o.table || TABLE) };
    }
    if (cmd === 'uname') return { status: 0, stdout: `${o.arch || 'x86_64'}\n` };
    if (cmd === 'zypper') return { status: 0, stdout: 'zypper 1.14' };
    return { status: 1, stdout: '' };
  };
  const c = { run, now: NOW, sysroot: sys, platform: 'linux', family: 'suse', cfg: { policy: { min_release_age_days: 3, kept_versions: 2 }, paths: { state } }, policy: {}, today: '2026-11-20', calls };
  // the root steps stand in: a dup to snap-<date> sets the version
  const spawn = async (_c, args) => {
    sudo.push(`sudo ${args.join(' ')}`);
    const m = args.join(' ').match(/dup --from snap-(\d{8})/);
    if (m) { version = m[1]; fs.writeFileSync(path.join(sys, 'etc', 'os-release'), `ID="opensuse-tumbleweed"\nVERSION_ID="${version}"\n`); }
    return 0;
  };
  return { c, sudo, printed, o: extra => ({ spawn, print: s => printed.push(String(s)), ...extra }) };
}

test('parseList: eight-digit names, newest first, anything else dropped', () => {
  assert.deepEqual(T.parseList('20261118\n20261115 \nlatest\n2026\n20261118\n'), ['20261118', '20261115']);
  assert.deepEqual(T.parseList(''), []);
});

test('parseTable: folder name to publish time from any array of rows; epoch seconds, milliseconds or text', () => {
  const t = T.parseTable(TABLE);
  assert.equal(t['20261118'], '2026-11-19T20:00:00.000Z');
  assert.equal(t.README, undefined);
  assert.equal(T.parseTable(JSON.stringify([{ name: '20261110/', mtime: '1794355200000' }]))['20261110'], '2026-11-11T00:00:00.000Z');
  assert.equal(T.parseTable(JSON.stringify([{ name: '20261110', mtime: '2026-11-11 00:00:00 UTC' }]))['20261110'], '2026-11-11T00:00:00.000Z');
  assert.deepEqual(T.parseTable('<html>'), {});
});

test('outdated: the newest snapshot whose folder is at least 3 days old; the name is never the date', async () => {
  const m = machine();
  // 20261118's folder is 16h old: held back; 20261115's folder is 3.25 days old: ripe
  assert.deepEqual(await T.source.outdated(m.c), [{ name: 'tumbleweed', have: '20261112', want: '20261115' }]);
  const j = await P.judge(m.c, T.source, { name: 'tumbleweed', have: '20261112', want: '20261115' });
  assert.equal(j.verdict, 'take');
  assert.equal(j.age, 3);
});

test('outdated: when only young snapshots are newer, the newest is returned so the plan holds it and says when', async () => {
  const m = machine({ version: '20261115' });
  const items = await T.source.outdated(m.c);
  assert.deepEqual(items, [{ name: 'tumbleweed', have: '20261115', want: '20261118' }]);
  const j = await P.judge(m.c, T.source, items[0]);
  assert.equal(j.verdict, 'hold');
  assert.equal(j.age, 0);
});

test('outdated: current, newer than the archive, or an older snapshot is never a move; the steward never goes backwards', async () => {
  assert.deepEqual(await T.source.outdated(machine({ version: '20261118' }).c), []);
  assert.deepEqual(await T.source.outdated(machine({ version: '20261120' }).c), []);
});

test('not Tumbleweed, not x86_64, or an unreadable archive: nothing taken, and each is said, never up to date', async () => {
  assert.deepEqual(await T.source.outdated(machine({ id: 'opensuse-leap' }).c), []);
  assert.deepEqual(await T.source.manual(machine({ id: 'opensuse-leap' }).c), []);
  const arm = machine({ arch: 'aarch64' });
  assert.deepEqual(await T.source.outdated(arm.c), []);
  assert.deepEqual(await T.source.manual(arm.c), [], 'ARM has its own source (tumbleweed-arm.js)');
  const off = machine({ offline: true });
  assert.deepEqual(await T.source.outdated(off.c), []);
  assert.match((await T.source.manual(off.c))[0], /couldn't read the snapshot archive/);
  assert.match((await T.source.manual(machine({ version: '20260101' }).c))[0], /no longer in the archive/);
  assert.deepEqual(await T.source.manual(machine().c), [], 'a readable archive with the installed snapshot in it has nothing to say');
});

test('the archive is read once per run', async () => {
  const m = machine();
  await T.source.outdated(m.c); await T.source.manual(m.c); await T.source.releaseDate(m.c, 'tumbleweed', '20261115');
  assert.equal(m.c.calls.filter(k => k.startsWith('curl')).length, 2, 'the list and the table, once');
});

test('sources: the Tumbleweed source is on the suse family only', () => {
  const base = { now: NOW, cfg: { policy: { min_release_age_days: 3 } } };
  assert.ok(P.sources({ ...base, platform: 'linux', family: 'suse' }).some(s => s.id === 'tumbleweed'));
  assert.ok(!P.sources({ ...base, platform: 'linux', family: 'debian' }).some(s => s.id === 'tumbleweed'));
  assert.equal(T.source.gateMode, 'snapshot');
});

test('upgrade at a terminal: the repos are set aside, the snapshot added, refreshed and dup\'d from; the receipt checks the date', async () => {
  const m = machine();
  const items = [{ name: 'tumbleweed', have: '20261112', want: '20261115', why: 'gate: 3d old' }];
  assert.equal(await H.upgrade(m.c, T.source, items, m.o({ tty: true })), 0, m.printed.join('\n'));
  assert.deepEqual(m.sudo, [
    'sudo zypper --non-interactive modifyrepo --disable --all',
    'sudo zypper --non-interactive addrepo --refresh --check https://download.opensuse.org/history/20261115/tumbleweed/repo/oss/ snap-20261115',
    'sudo zypper --non-interactive --gpg-auto-import-keys refresh snap-20261115',
    'sudo zypper --non-interactive dup --from snap-20261115 --allow-downgrade --no-recommends --auto-agree-with-licenses',
  ]);
  const dir = path.join(m.c.cfg.paths.state, 'backups');
  const rp = path.join(dir, fs.readdirSync(dir)[0], 'receipt.json');
  const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
  assert.equal(r.outcome, 'done');
  assert.deepEqual(r.after, { tumbleweed: '20261115' });
  assert.deepEqual(r.back.items, [{ name: 'tumbleweed', to: '20261112' }], 'the archive still lists the snapshot from before');
  m.sudo.length = 0;
  assert.equal(await H.rollback(m.c, T.source, rp, m.o({ tty: true, ask: async () => true })), 0, m.printed.join('\n'));
  assert.ok(m.sudo.some(l => l.includes('dup --from snap-20261112')), 'the way back is the same chain with the old date');
  assert.equal((await T.source.installed(m.c, ['tumbleweed'])).tumbleweed, '20261112');
});

test('upgrade that stops partway is named as failed, and a snapshot that did not take is not "done"', async () => {
  const m = machine();
  const items = [{ name: 'tumbleweed', have: '20261112', want: '20261115', why: 'gate' }];
  const failing = m.o({ tty: true, spawn: async () => 0 }); // sudo "succeeds" but the version never moves
  assert.equal(await H.upgrade(m.c, T.source, items, failing), 1);
  assert.ok(m.printed.some(l => /not at the wanted version: tumbleweed \(20261112, wanted 20261115\)/.test(l)), m.printed.join('\n'));
});

test('upgrade with no terminal: the whole chain is handed over as one line', async () => {
  const m = machine();
  const items = [{ name: 'tumbleweed', have: '20261112', want: '20261115', why: 'gate' }];
  assert.equal(await H.upgrade(m.c, T.source, items, m.o({ tty: false })), 4);
  assert.deepEqual(m.sudo, []);
  assert.ok(m.printed.some(l => l.includes('sudo zypper --non-interactive modifyrepo --disable --all && sudo zypper --non-interactive addrepo')), m.printed.join('\n'));
});

test('no way back once the archive has dropped the snapshot from before: said, never a guess', async () => {
  const m = machine({ list: '20261118\n20261115\n' });
  const items = [{ name: 'tumbleweed', have: '20261112', want: '20261115', why: 'gate' }];
  assert.equal(await H.upgrade(m.c, T.source, items, m.o({ tty: true })), 0);
  assert.ok(m.printed.some(l => l.includes('no way back for tumbleweed: no kept copy, and the repos no longer offer 20261112')), m.printed.join('\n'));
});
