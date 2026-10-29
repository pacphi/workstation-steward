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
  assert.deepEqual(U.selfUpdate({ self_update_off: { file: path.join(ROOT, 'none'), value: 'no' } }), { ok: false, have: 'unset' });
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

test('apply: refuses a fallback source, a failed run, a gated class and a changed key; puts a rotated key back', async () => {
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
