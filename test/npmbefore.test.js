// lib/npmbefore.js (D89): npm's --before for a hybrid install, so its dependencies wait out the release-age gate too,
// and npm view's time answer read as an object or as npm 12's one-element array (the AQE lock-age check uses it).
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('../lib/npmbefore.js');

const NOW = new Date('2026-11-16T12:00:00Z');

test('before: now minus the gate\'s days', () => {
  assert.equal(B.before(3, '', NOW), '2026-11-13T12:00:00.000Z');
  assert.equal(B.before(3, '2026-11-01T00:00:00Z', NOW), '2026-11-13T12:00:00.000Z', 'an older pin changes nothing');
});

test('before: a pin newer than the gate (a security exception) moves the cutoff just past its own publish time', () => {
  assert.equal(B.before(3, '2026-11-15T08:00:00.000Z', NOW), '2026-11-15T08:00:01.000Z');
  assert.equal(B.before(3, 'not a date', NOW), '2026-11-13T12:00:00.000Z');
});

test('times: npm view\'s object, npm 12\'s one-element array, and anything else as {}', () => {
  const t = { '1.0.0': '2026-01-01T00:00:00.000Z', created: '2025-12-01T00:00:00.000Z' };
  assert.deepEqual(B.times(JSON.stringify(t)), t);
  assert.deepEqual(B.times(JSON.stringify([t])), t);
  assert.deepEqual(B.times('npm warn something'), {});
  assert.deepEqual(B.times('null'), {});
});

test('the command: prints an ISO cutoff; DRY_RUN=1 never asks npm; a bad day count is refused', () => {
  const S = path.join(__dirname, '..', 'lib', 'npmbefore.js');
  const r = spawnSync(process.execPath, [S, '3', 'some-pkg', '1.0.0'], { encoding: 'utf8', env: { ...process.env, DRY_RUN: '1', PATH: '/nonexistent' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(spawnSync(process.execPath, [S, 'x'], { encoding: 'utf8' }).status, 2);
});
