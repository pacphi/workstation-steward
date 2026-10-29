// The engine's shipped host defaults (supply-chain/host-defaults.toml, D40 and D52): every shipped [[updater]] is
// complete, names what it was reviewed against, and is active only where its tool is installed. A shipped key pin is
// reviewed in the engine PR that adds or changes it; this test makes sure the pin is there to review. No network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const U = require('../lib/updaters.js');
const { DEFAULTS_FILE } = require('../lib/host.js');

const defaults = JSON.parse(execFileSync('yq', ['-p', 'toml', '-o', 'json', '.', DEFAULTS_FILE], { encoding: 'utf8' }));

test('host defaults: every shipped [[updater]] is complete, has why, when, require_output and backup, and a known class', () => {
  assert.ok((defaults.updater || []).length >= 1, 'brain-kb ships');
  for (const u of defaults.updater) {
    assert.deepEqual(U.problems(u), [], u.name);
    for (const k of ['why', 'when', 'require_output']) assert.ok(typeof u[k] === 'string' && u[k].length, `${u.name}: ${k}`);
    assert.ok(Array.isArray(u.backup) && u.backup.length, `${u.name}: backup`);
    assert.ok(U.CLASSES.includes(u.class), `${u.name}: class ${u.class}`);
    assert.ok(u.when.startsWith('~/') || u.when.startsWith('/'), `${u.name}: when is a path`);
  }
});

test('host defaults: a shipped signed_data updater pins its key with a sha256 and a URL the weekly watch reads', () => {
  for (const u of defaults.updater.filter(x => x.class === 'signed_data')) {
    assert.match(u.pin.sha256, /^[0-9a-f]{64}$/, u.name);
    assert.match(u.pin.watch, /^https:\/\//, `${u.name}: watch`);
    assert.doesNotThrow(() => new RegExp(u.pin.match), u.name);
  }
});

test('host defaults: shipped names are unique, so [off] and yours replace exactly one', () => {
  const names = defaults.updater.map(u => u.name);
  assert.equal(new Set(names).size, names.length);
});
