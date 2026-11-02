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

test('host defaults: every shipped [[updater]] is complete, has why, when, require_output (or a dated one\'s verify) and backup, and a known class', () => {
  assert.ok((defaults.updater || []).length >= 2, 'brain-kb and claude-code ship');
  for (const u of defaults.updater) {
    assert.deepEqual(U.problems(u), [], u.name);
    for (const k of ['why', 'when']) assert.ok(typeof u[k] === 'string' && u[k].length, `${u.name}: ${k}`);
    // a dated one proves what it installed by the vendor's sha256 instead of a line of its output (D72)
    if (U.dated(u)) assert.ok(u.verify && /^https:\/\//.test(u.verify.url), `${u.name}: verify, from an https URL`);
    else assert.ok(typeof u.require_output === 'string' && u.require_output.length, `${u.name}: require_output`);
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

test('host defaults: claude-code is dated from npm, gated, verified against Anthropic\'s manifest, and its updater kept off either way', () => {
  const u = defaults.updater.find(x => x.name === 'claude-code');
  assert.deepEqual([u.class, u.released.npm], ['gated', '@anthropic-ai/claude-code']);
  assert.match(u.verify.url, /^https:\/\/downloads\.claude\.ai\/claude-code-releases\/\{version\}\/manifest\.json$/);
  assert.deepEqual(u.backup, ['~/.local/bin/claude', '~/.local/share/claude/versions/{installed}']);
  assert.deepEqual(u.self_update_off.map(o => o.key), ['autoUpdates', 'env.DISABLE_AUTOUPDATER']);
});

test('host defaults: shipped names are unique, so [off] and yours replace exactly one', () => {
  const names = defaults.updater.map(u => u.name);
  assert.equal(new Set(names).size, names.length);
});
