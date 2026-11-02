// lib/updaters.js (D52): declared update sources. The schema, the class in force, the key pin, and apply, rollback and
// the copies prune removes, end to end against a stand-in updater (a shell script with its own key and data folder) in
// a throwaway folder. No network, no real Brain.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const U = require('../lib/updaters.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-updaters-')));
const KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAreviewed\n-----END PUBLIC KEY-----';
const MATCH = '-----BEGIN PUBLIC KEY-----[\\s\\S]*?-----END PUBLIC KEY-----';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let n = 0;

// tool(mode) — a stand-in updater in its own folder: `update.sh --check` exits 10 while db/v differs from remote, and
// `--apply` copies remote into db/v and prints its source. mode: live (says the live release asset), fallback (says a
// pinned fallback), rotate (also replaces its own key), fail (exits 3 before touching anything)
function tool(mode = 'live') {
  const dir = path.join(ROOT, `tool-${++n}`);
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'db', 'v'), 'old\n');
  fs.writeFileSync(path.join(dir, 'remote'), 'new\n');
  fs.writeFileSync(path.join(dir, 'update.sh'), `#!/bin/bash
# ${KEY.split('\n').join('\n# ')}
cd "$(dirname "$0")"
if [[ "$1" == --check ]]; then cmp -s db/v remote && { echo "UP TO DATE $(cat db/v)"; exit 0; }; echo "BEHIND $(cat db/v)"; exit 10; fi
[[ "${mode}" == fail ]] && { echo "signature could not be fetched"; exit 3; }
cp remote db/v
[[ "${mode}" == rotate ]] && sed -i.bak 's/reviewed/rotated/' update.sh
[[ "${mode}" == fallback ]] && echo "(source: PINNED FALLBACK)" || echo "(source: live release asset \\"kb.zip\\")"
`);
  fs.chmodSync(path.join(dir, 'update.sh'), 0o755);
  const keyText = fs.readFileSync(path.join(dir, 'update.sh'), 'utf8').match(new RegExp(MATCH))[0];
  return {
    dir,
    u: {
      name: `tool-${n}`, class: 'signed_data', why: 'test', when: path.join(dir, 'update.sh'),
      check: `${dir}/update.sh --check`, apply: `${dir}/update.sh --apply`, require_output: 'source: live release asset',
      backup: [path.join(dir, 'db')], pin: { file: path.join(dir, 'update.sh'), match: MATCH, sha256: sha(keyText) },
    },
  };
}
const newDir = name => { const d = path.join(ROOT, 'state', 'backups', `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const receiptIn = d => JSON.parse(fs.readFileSync(path.join(d, 'receipt.json'), 'utf8'));
const lastDir = () => { const b = path.join(ROOT, 'state', 'backups'); return path.join(b, fs.readdirSync(b).sort((x, y) => Number(x.split('-').pop()) - Number(y.split('-').pop())).pop()); };

test('problems: a complete entry has none; each missing piece is named, and signed_data needs a pin and require_output', () => {
  assert.deepEqual(U.problems(tool().u), []);
  assert.deepEqual(U.problems({ name: 'x', class: 'nightly', why: 'w', check: 'c', apply: 'a', backup: ['b'] }), ['class "nightly" is not one of gated, always_current, signed_data, exception']);
  assert.deepEqual(U.problems({ class: 'gated' }), ['no name', 'no why', 'no check', 'no apply', 'no backup']);
  assert.deepEqual(U.problems({ name: 'x', class: 'signed_data', why: 'w', check: 'c', apply: 'a', backup: ['b'] }), ['signed_data needs a pin (file, match, sha256)', 'signed_data needs require_output']);
  assert.deepEqual(U.problems({ name: 'x', class: 'exception', why: 'w', check: 'c', apply: 'a', backup: ['b'] }), ['an exception needs expires = "YYYY-MM-DD"']);
  assert.deepEqual(U.problems({ name: 'x', why: 'w', check: 'c', apply: 'a', backup: 'b' }), ['backup must be a list of paths']);
});

test('classOf: no class is gated; an exception is gated again once it expires', () => {
  assert.equal(U.classOf({}, '2026-10-29'), 'gated');
  assert.equal(U.classOf({ class: 'exception', expires: '2026-10-29' }, '2026-10-29'), 'exception');
  assert.equal(U.classOf({ class: 'exception', expires: '2026-10-28' }, '2026-10-29'), 'gated');
  assert.equal(U.classOf({ class: 'signed_data' }, '2026-10-29'), 'signed_data');
});

test('active: one whose `when` path is missing is left out, silently; one without `when` always holds', () => {
  const { u } = tool();
  const names = U.active({ updater: [u, { ...u, name: 'gone', when: path.join(ROOT, 'nowhere') }, { ...u, name: 'always', when: undefined }] }).map(x => x.name);
  assert.deepEqual(names, [u.name, 'always']);
});

test('pinState: the reviewed key holds; a changed key, a missing match or a missing file does not', () => {
  const { u } = tool();
  assert.equal(U.pinState(u).ok, true);
  assert.match(U.pinState({ ...u, pin: { ...u.pin, sha256: 'ab'.repeat(32) } }).why, /hashes to .*not the pinned abababababab/);
  assert.match(U.pinState({ ...u, pin: { ...u.pin, match: 'NOT THERE' } }).why, /the pinned text isn't in/);
  assert.match(U.pinState({ ...u, pin: { ...u.pin, file: path.join(ROOT, 'none') } }).why, /is missing/);
});

test('selfUpdate: the file must hold the value; a missing file is unset', () => {
  const f = path.join(ROOT, 'pref');
  fs.writeFileSync(f, 'no\n');
  assert.deepEqual(U.selfUpdate({ self_update_off: { file: f, value: 'no' } }), { ok: true, have: 'no' });
  fs.writeFileSync(f, 'yes\n');
  assert.equal(U.selfUpdate({ self_update_off: { file: f, value: 'no' } }).ok, false);
  assert.deepEqual(U.selfUpdate({ self_update_off: { file: path.join(ROOT, 'none'), value: 'no' } }), { ok: false, have: 'unset', where: path.join(ROOT, 'none'), want: 'no' });
});

test('check: exit 0 is current, 10 behind, anything else unknown', async () => {
  const run = status => async () => ({ status, stdout: 'out\n' });
  assert.deepEqual(await U.check({ check: 'x' }, run(0)), { state: 'current', status: 0, out: 'out' });
  assert.equal((await U.check({ check: 'x' }, run(10))).state, 'behind');
  assert.equal((await U.check({ check: 'x' }, run(2))).state, 'unknown');
});

test('apply: backs up, applies, requires the output, writes a receipt; rollback puts the copy back', async () => {
  const { dir, u } = tool();
  assert.equal(await U.apply(u, { newDir, today: '2026-10-29' }), 0);
  assert.equal(fs.readFileSync(path.join(dir, 'db', 'v'), 'utf8'), 'new\n');
  const d = lastDir();
  const rc = receiptIn(d);
  assert.equal(rc.kind, 'updater-signed_data');
  assert.equal(rc.outcome, 'applied');
  assert.match(rc.before, /BEHIND old/);
  assert.match(rc.after, /UP TO DATE new/);
  assert.equal(fs.readFileSync(path.join(d, rc.backups[0].copy, 'v'), 'utf8'), 'old\n', 'the copy holds what was there');
  assert.match(rc.rollback, /^steward sc rollback .*receipt\.json$/);

  assert.equal(await U.apply(u, { newDir, today: '2026-10-29' }), 0, 'current: nothing to do');
  assert.equal(lastDir(), d, 'no new backup when current');

  assert.equal(await U.rollback(path.join(d, 'receipt.json'), { ask: async () => true }), 0);
  assert.equal(fs.readFileSync(path.join(dir, 'db', 'v'), 'utf8'), 'old\n');
  const kept = fs.readdirSync(d).find(f => f.startsWith('rolled-back-'));
  assert.equal(fs.readFileSync(path.join(d, kept, '0', 'db', 'v'), 'utf8'), 'new\n', 'what was there moves beside the copy');
  assert.ok(fs.readdirSync(d).some(f => /^rollback-.*\.json$/.test(f)));
});

test('apply: refuses a fallback source, a failed run, a gated class, a changed key and a missing backup; puts a rotated key back', async () => {
  const fb = tool('fallback');
  assert.equal(await U.apply(fb.u, { newDir, today: '2026-10-29' }), 1);
  assert.match(receiptIn(lastDir()).outcome, /failed: its output doesn't say "source: live release asset"/);

  const bad = tool('fail');
  assert.equal(await U.apply(bad.u, { newDir, today: '2026-10-29' }), 1);
  assert.equal(receiptIn(lastDir()).outcome, 'failed: apply exited 3');

  const g = tool();
  const before = lastDir();
  assert.equal(await U.apply({ ...g.u, class: 'gated' }, { newDir, today: '2026-10-29' }), 1);
  assert.equal(await U.apply({ ...g.u, class: 'exception', expires: '2026-10-28' }, { newDir, today: '2026-10-29' }), 1, 'an expired exception is gated');
  assert.equal(await U.apply({ ...g.u, pin: { ...g.u.pin, sha256: 'ab'.repeat(32) } }, { newDir, today: '2026-10-29' }), 1);
  assert.equal(await U.apply({ ...g.u, backup: [...g.u.backup, path.join(g.dir, 'not-there')] }, { newDir, today: '2026-10-29' }), 1, 'signed_data: every backup path must exist');
  assert.equal(lastDir(), before, 'refused before any backup');
  assert.equal(fs.readFileSync(path.join(g.dir, 'db', 'v'), 'utf8'), 'old\n');

  const rot = tool('rotate');
  const reviewed = fs.readFileSync(rot.u.pin.file, 'utf8');
  assert.equal(await U.apply(rot.u, { newDir, today: '2026-10-29' }), 1);
  assert.match(receiptIn(lastDir()).outcome, /changed the signing key/);
  assert.equal(fs.readFileSync(rot.u.pin.file, 'utf8'), reviewed, 'the reviewed updater is back');
});

test('rollback: refuses a receipt that is not an updater\'s, and one whose copies were pruned', async () => {
  const d = newDir('repin');
  fs.writeFileSync(path.join(d, 'receipt.json'), JSON.stringify({ kind: 'repin', at: '2026-10-29T00:00:00Z' }));
  assert.equal(await U.rollback(d, { ask: async () => true }), 1);
  const e = newDir('updater-x');
  fs.writeFileSync(path.join(e, 'receipt.json'), JSON.stringify({ kind: 'updater-signed_data', name: 'x', at: '2026-10-29T00:00:00Z', backups: [{ path: '/x', copy: 'copies/0/x' }] }));
  assert.equal(await U.rollback(e, { ask: async () => true }), 1);
});

test('prunable: the copies of updater receipts older than soak_days, and nothing else', () => {
  const state = path.join(ROOT, 'prune-state');
  const add = (name, at, dirs) => {
    const d = path.join(state, 'backups', name);
    for (const x of dirs) fs.mkdirSync(path.join(d, x), { recursive: true });
    fs.writeFileSync(path.join(d, 'receipt.json'), JSON.stringify({ kind: 'updater-signed_data', at }));
  };
  add('updater-a-20261020T000000Z', '2026-10-20T00:00:00Z', ['copies', 'pin', 'rolled-back-20261021T000000Z']);
  add('updater-a-20261028T000000Z', '2026-10-28T00:00:00Z', ['copies']);
  add('repin-20261001T000000Z', '2026-10-01T00:00:00Z', ['copies']);
  const got = U.prunable(state, 3, new Date('2026-10-29T00:00:00Z')).map(p => path.relative(state, p));
  assert.deepEqual(got, ['backups/updater-a-20261020T000000Z/copies', 'backups/updater-a-20261020T000000Z/pin', 'backups/updater-a-20261020T000000Z/rolled-back-20261021T000000Z']);
});

// Dated entries (D72): the release dates come from npm or GitHub, the steward picks the version, and verify compares
// the installed file with the vendor's sha256. A stand-in run answers the reads; a stand-in installer (a shell script
// that writes versions/<v> and points a link at it, as Claude Code's does) is the apply.
const H = 3600e3;
const NOW = new Date('2026-11-02T22:00:00Z');
const ago = h => new Date(NOW.getTime() - h * H).toISOString();
const stub = answers => (cmd, args = []) => {
  const k = [cmd, ...args].join(' ');
  const v = Object.entries(answers).find(([p]) => k === p || (p.endsWith('*') && k.startsWith(p.slice(0, -1))))?.[1];
  return Promise.resolve(v === undefined ? { status: 1, stdout: '' } : typeof v === 'string' ? { status: 0, stdout: v } : v);
};
const TIMES = { created: ago(900), modified: ago(1), '1.9.0': ago(400), '2.0.0': ago(300), '2.0.1': ago(200), '2.0.2-beta.1': ago(100), '2.0.2': ago(100), '2.0.3': ago(20), '3.0.0': ago(90) };

function nativeTool(installed = '2.0.0') {
  const dir = path.join(ROOT, `native-${++n}`);
  fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'versions', installed), `build ${installed}\n`);
  fs.symlinkSync(path.join(dir, 'versions', installed), path.join(dir, 'bin', 'tool'));
  fs.writeFileSync(path.join(dir, 'install.sh'), `#!/bin/bash
cd "$(dirname "$0")"
[[ -n "$FAIL" ]] && exit 3
printf 'build %s\\n' "$1" > "versions/$1"
ln -sfn "$PWD/versions/$1" bin/tool
echo "installed $1"
`);
  fs.chmodSync(path.join(dir, 'install.sh'), 0o755);
  return {
    dir,
    u: {
      name: `native-${n}`, class: 'gated', why: 'test', installed: `basename "$(readlink ${dir}/bin/tool)"`, released: { npm: 'tool' },
      apply: `${dir}/install.sh {version}`, backup: [path.join(dir, 'bin', 'tool'), path.join(dir, 'versions', '{installed}')],
      verify: { url: 'https://example.test/{version}/manifest.json', json: 'platforms.{platform}.checksum', file: path.join(dir, 'versions', '{version}') },
    },
  };
}
const manifest = (v, body = `build ${v}\n`) => JSON.stringify({ version: v, platforms: { [U.platform()]: { checksum: sha(body) } } });

test('problems: a dated entry needs installed, released and {version} in apply, but no check; verify is complete or absent', () => {
  assert.deepEqual(U.problems(nativeTool().u), []);
  assert.deepEqual(U.problems({ name: 'x', why: 'w', released: { npm: 'p' }, apply: 'a', backup: ['b'] }), ['no installed', 'a dated apply must say {version}']);
  assert.deepEqual(U.problems({ name: 'x', why: 'w', installed: 'i', released: {}, apply: 'a {version}', backup: ['b'] }), ['released must name a source: { npm = "<package>" } or { github = "<owner>/<repo>" }']);
  assert.deepEqual(U.problems({ name: 'x', why: 'w', installed: 'i', released: { github: 'nope' }, apply: 'a {version}', backup: ['b'], verify: { url: 'u' } }), ['released.github "nope" is not <owner>/<repo>', 'verify needs url, json and file']);
  assert.deepEqual(U.problems({ name: 'x', why: 'w', check: 'c', apply: 'a', backup: ['b'], self_update_off: [{ file: 'f' }] }), ['self_update_off needs file and value']);
});

test('selfUpdate: a JSON key (a dotted path) can be the switch, and with several any one holding is enough', () => {
  const a = path.join(ROOT, 'claude.json'), b = path.join(ROOT, 'settings.json');
  fs.writeFileSync(a, JSON.stringify({ autoUpdates: false }));
  fs.writeFileSync(b, JSON.stringify({ env: { OTHER: '1' } }));
  const both = { self_update_off: [{ file: a, key: 'autoUpdates', value: false }, { file: b, key: 'env.DISABLE_AUTOUPDATER', value: '1' }] };
  assert.deepEqual(U.selfUpdate(both), { ok: true, have: 'false', where: `${a} autoUpdates` });
  fs.writeFileSync(a, JSON.stringify({}));   // the installer moved the switch
  fs.writeFileSync(b, JSON.stringify({ env: { DISABLE_AUTOUPDATER: '1' } }));
  assert.equal(U.selfUpdate(both).ok, true);
  fs.writeFileSync(b, JSON.stringify({ env: {} }));
  assert.deepEqual(U.selfUpdate(both), { ok: false, have: `${a} autoUpdates = unset, ${b} env.DISABLE_AUTOUPDATER = unset`, where: `${a} autoUpdates or ${b} env.DISABLE_AUTOUPDATER`, want: `${a} autoUpdates = false or ${b} env.DISABLE_AUTOUPDATER = 1` });
  assert.deepEqual(U.selfUpdate({ self_update_off: { file: a, key: 'autoUpdates', value: false } }), { ok: false, have: 'unset', where: `${a} autoUpdates`, want: 'false' });
});

test('dated check: the newest version on the installed line past the gate; prereleases, majors and the too-young are not taken', async () => {
  const { u } = nativeTool('2.0.0');
  // npm 12 prints the time map inside an array
  const run = stub({ [`bash -c ${u.installed}`]: `${ROOT}/versions/2.0.0\n`, 'npm view tool time --json': JSON.stringify([TIMES]) });
  const c = await U.check(u, run, { minDays: 3, now: NOW });
  assert.equal(c.state, 'behind');
  assert.equal(c.target, '2.0.2');
  assert.equal(c.waiting, '2.0.3');
  assert.equal(c.major, '3.0.0');
  assert.match(c.out, /^2\.0\.0 -> 2\.0\.2 \(published 2026-10-29 /);
  // installed early: 2.0.3 is 20 hours old, so it is held until it clears, and nothing is taken
  const young = await U.check(u, stub({ [`bash -c ${u.installed}`]: 'versions/2.0.3', 'npm view tool time --json': JSON.stringify(TIMES) }), { minDays: 3, now: NOW });
  assert.deepEqual([young.state, young.clearsAt], ['young', '2026-11-05 02:00 UTC']);
  // current on its line, with a newer one waiting
  const cur = await U.check(u, stub({ [`bash -c ${u.installed}`]: 'versions/2.0.2', 'npm view tool time --json': JSON.stringify(TIMES) }), { minDays: 3, now: NOW });
  assert.deepEqual([cur.state, cur.waiting, cur.major], ['current', '2.0.3', '3.0.0']);
  // a 0.x minor is a major
  const zero = await U.check(u, stub({ [`bash -c ${u.installed}`]: '0.4.1', 'npm view tool time --json': JSON.stringify({ '0.4.1': ago(500), '0.4.2': ago(300), '0.5.0': ago(300) }) }), { minDays: 3, now: NOW });
  assert.deepEqual([zero.target, zero.major], ['0.4.2', '0.5.0']);
  // unreadable: no version, or no dates
  assert.equal((await U.check(u, stub({}), { minDays: 3, now: NOW })).state, 'unknown');
  assert.match((await U.check(u, stub({ [`bash -c ${u.installed}`]: '2.0.0' }), { minDays: 3, now: NOW })).out, /npm tool couldn't be read/);
});

test('dated check: GitHub releases, drafts and prereleases left out, a leading v dropped', async () => {
  const u = { ...nativeTool().u, released: { github: 'o/r' } };
  const rel = [{ tag_name: 'v1.3.0', published_at: ago(10), prerelease: false }, { tag_name: 'v1.2.0', published_at: ago(100) }, { tag_name: 'v1.2.9-rc.1', published_at: ago(90), prerelease: true }, { tag_name: 'v1.2.8', published_at: ago(80), draft: true }];
  const c = await U.check(u, stub({ [`bash -c ${u.installed}`]: '1.1.0', 'gh api repos/o/r/releases?per_page=100': JSON.stringify(rel) }), { minDays: 3, now: NOW });
  assert.deepEqual([c.state, c.target, c.waiting], ['behind', '1.2.0', '1.3.0']);
});

test('apply (dated): backs up the link and its build, installs the picked version, checks its sha256; rollback puts both back', async () => {
  const { dir, u } = nativeTool('2.0.0');
  const answers = stub({ 'npm view tool time --json': JSON.stringify(TIMES), 'curl -fsSL --max-time 30 https://example.test/2.0.2/manifest.json': manifest('2.0.2') });
  // `installed` is answered from the real link, so the check after the apply sees the new version
  const reads = (cmd, args) => (cmd === 'bash' && args[1] === u.installed ? Promise.resolve({ status: 0, stdout: fs.readlinkSync(path.join(dir, 'bin', 'tool')) }) : answers(cmd, args));
  assert.equal(await U.apply(u, { newDir, run: reads, minDays: 3, now: NOW }), 0);
  const d = lastDir();
  const rc = receiptIn(d);
  assert.deepEqual([rc.kind, rc.from, rc.to, rc.outcome, rc.after], ['updater-gated', '2.0.0', '2.0.2', 'applied', '2.0.2']);
  assert.equal(rc.verify.have, sha('build 2.0.2\n'));
  assert.equal(fs.readlinkSync(path.join(dir, 'bin', 'tool')), path.join(dir, 'versions', '2.0.2'));
  assert.equal(fs.readlinkSync(path.join(d, 'copies', '0', 'tool')), path.join(dir, 'versions', '2.0.0'), 'the link is copied as a link');
  assert.equal(await U.rollback(d, { ask: async () => true }), 0);
  assert.equal(fs.readlinkSync(path.join(dir, 'bin', 'tool')), path.join(dir, 'versions', '2.0.0'));
  assert.equal(fs.readFileSync(path.join(dir, 'versions', '2.0.0'), 'utf8'), 'build 2.0.0\n');
});

test('apply (dated): a sha256 that is not the vendor\'s puts the link back; no manifest, or a young install, changes nothing', async () => {
  const { dir, u } = nativeTool('2.0.0');
  const reads = extra => stub({ [`bash -c ${u.installed}`]: 'versions/2.0.0', 'npm view tool time --json': JSON.stringify(TIMES), ...extra });
  assert.equal(await U.apply(u, { newDir, run: reads({ 'curl -fsSL --max-time 30 https://example.test/2.0.2/manifest.json': manifest('2.0.2', 'something else') }), minDays: 3, now: NOW }), 1);
  assert.match(receiptIn(lastDir()).outcome, /^failed: .*2\.0\.2 hashes to .*not the vendor's .*what it replaced is back$/);
  assert.equal(receiptIn(lastDir()).restored, true, 'put back already: the brief does not ask for a rollback');
  assert.equal(fs.readlinkSync(path.join(dir, 'bin', 'tool')), path.join(dir, 'versions', '2.0.0'));
  const before = fs.readdirSync(path.join(ROOT, 'state', 'backups')).length;
  assert.equal(await U.apply(u, { newDir, run: reads({}), minDays: 3, now: NOW }), 1, 'no manifest: refused before any copy');
  assert.equal(await U.apply(u, { newDir, run: stub({ [`bash -c ${u.installed}`]: 'versions/2.0.3', 'npm view tool time --json': JSON.stringify(TIMES) }), minDays: 3, now: NOW }), 0, 'young: held');
  assert.equal(fs.readdirSync(path.join(ROOT, 'state', 'backups')).length, before);
  assert.equal(await U.apply({ ...u, released: undefined, check: 'true' }, { newDir }), 1, 'gated without dates: still refused');
});
