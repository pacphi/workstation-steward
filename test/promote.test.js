// ai-tooling/qualify/aqe/promote.sh refuses what a run that stopped part-way left behind, with the step that finishes
// the job, before it backs up anything: a leftover releases/<r>.partial (a rerun would copy the stage into it), and a
// release that exists while current points elsewhere. DRY_RUN=1 and a throwaway instance; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PROMOTE = path.join(REPO, 'ai-tooling', 'qualify', 'aqe', 'promote.sh');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-promote-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// box(name) — an instance whose AQE runtime has releases/1.0.0-local.1 as current, and a passing qualification
// receipt for 2.0.0-local.1 in its cache
function box(name) {
  const dir = path.join(ROOT, name), ai = path.join(dir, 'ai'), cache = path.join(dir, 'cache'), state = path.join(dir, 'state');
  fs.mkdirSync(path.join(dir, 'ai-tooling'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'steward.toml'),
    `schema = 1\n[paths]\nai_tooling_root = "${ai}"\ncache = "${cache}"\nstate = "${state}"\n[profiles]\nai_tooling = true\n`);
  fs.copyFileSync(path.join(REPO, 'examples', 'ai-tooling', 'ai-tooling.toml'), path.join(dir, 'ai-tooling', 'ai-tooling.toml'));
  fs.writeFileSync(path.join(dir, 'projects', 'registry.toml'), '');
  const runtime = path.join(ai, 'aqe');
  fs.mkdirSync(path.join(runtime, 'releases', '1.0.0-local.1'), { recursive: true });
  fs.symlinkSync('releases/1.0.0-local.1', path.join(runtime, 'current'));
  const ws = path.join(cache, 'qualify', 'aqe-2.0.0-local.1');
  fs.mkdirSync(path.join(ws, 'stage', '2.0.0-local.1'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'receipt.json'), JSON.stringify({ allPass: true }));
  return { dir, runtime };
}
const promote = dir => spawnSync('bash', [PROMOTE, '2.0.0'], {
  encoding: 'utf8', env: { ...process.env, STEWARD_INSTANCE: dir, DRY_RUN: '1', NO_COLOR: '1', NO_PROGRESS: '1' } });

test('promote: a clean runtime gets as far as the dry run', () => {
  const r = promote(box('clean').dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /current 1\.0\.0-local\.1 -> 2\.0\.0-local\.1/);
});

test('promote: a leftover releases/<r>.partial is refused, naming current and the cleanup', () => {
  const b = box('partial');
  fs.mkdirSync(path.join(b.runtime, 'releases', '2.0.0-local.1.partial', 'bin'), { recursive: true });
  const r = promote(b.dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /a previous promote of 2\.0\.0-local\.1 stopped while installing it; current still -> 1\.0\.0-local\.1/);
  assert.match(r.stderr, /rm -rf .*releases\/2\.0\.0-local\.1\.partial/);
});

test('promote: a release kept by a rollback is not overwritten, and isn\'t called a crash', () => {
  const b = box('kept');
  fs.mkdirSync(path.join(b.runtime, 'releases', '2.0.0-local.1'), { recursive: true });
  const r = promote(b.dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /releases\/2\.0\.0-local\.1 exists but current -> 1\.0\.0-local\.1 \(a rollback keeps it/);
});

test('promote: an already promoted release says so', () => {
  const b = box('done');
  fs.mkdirSync(path.join(b.runtime, 'releases', '2.0.0-local.1'), { recursive: true });
  fs.rmSync(path.join(b.runtime, 'current'));
  fs.symlinkSync('releases/2.0.0-local.1', path.join(b.runtime, 'current'));
  const r = promote(b.dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /2\.0\.0-local\.1 is already promoted/);
});
