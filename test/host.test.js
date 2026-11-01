// lib/host.js (D40): the engine's shared host defaults under the instance's own host.toml. A plain value: yours wins;
// a list: yours adds; a named entry: yours adds, or replaces the default with that name; [off] turns defaults off by
// name or value, and an [off] that matches nothing is reported; security_exception is yours alone. No network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { merge } = require('../lib/host.js');

const REPO = path.join(__dirname, '..');
const D = {
  electron_supported_majors: 3,
  always_current: ['google-chrome', 'firefox'],
  vendored_node: ['/Applications/A.app/node'],
  distrusted_root: [{ name: 'Root A', sha256: 'AA' }],
  ioc: [{ name: 'IOC 1', files: ['/tmp/a'] }, { name: 'IOC 2', files: ['/tmp/b'] }],
};

test('merge: defaults alone', () => {
  const { policy, warnings } = merge(D, {});
  assert.equal(policy.electron_supported_majors, 3);
  assert.deepEqual(policy.always_current, ['google-chrome', 'firefox']);
  assert.deepEqual(policy.ioc.map(e => [e.name, e._source]), [['IOC 1', 'default'], ['IOC 2', 'default']]);
  assert.deepEqual(policy.security_exception, []);
  assert.deepEqual(warnings, []);
});

test('merge: yours adds, replaces by name, wins on plain values, and keeps security exceptions', () => {
  const mine = {
    electron_supported_majors: 2,
    always_current: ['arc'],
    vendored_node: ['/Applications/A.app/node', '/Applications/B.app/node'],
    ioc: [{ name: 'IOC 2', files: ['/tmp/b2'] }, { name: 'Mine', files: ['/tmp/m'] }],
    security_exception: [{ kind: 'formula', name: 'x', version: '1', advisory: 'u', expires: '2026-11-01' }],
  };
  const { policy, sources } = merge(D, mine);
  assert.equal(policy.electron_supported_majors, 2);
  assert.deepEqual(policy.always_current, ['google-chrome', 'firefox', 'arc']);
  assert.deepEqual(policy.vendored_node, ['/Applications/A.app/node', '/Applications/B.app/node'], 'no duplicates');
  assert.deepEqual(policy.ioc.map(e => [e.name, e.files[0], e._source]), [['IOC 1', '/tmp/a', 'default'], ['IOC 2', '/tmp/b2', 'yours'], ['Mine', '/tmp/m', 'yours']]);
  assert.equal(policy.security_exception.length, 1);
  assert.ok(sources.some(s => s.key === 'electron_supported_majors' && s.source === 'yours'));
});

test('merge: [off] turns defaults off by value or name; one that matches nothing is reported', () => {
  const { policy, sources, warnings } = merge(D, { off: { always_current: ['firefox', 'safari'], ioc: ['IOC 1'], colours: ['x'] } });
  assert.deepEqual(policy.always_current, ['google-chrome']);
  assert.deepEqual(policy.ioc.map(e => e.name), ['IOC 2']);
  assert.ok(sources.some(s => s.item === 'firefox' && s.source === 'off'));
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /always_current: "safari" is not a default/);
  assert.match(warnings.join('\n'), /\[off\] colours: not a key that has defaults/);
});

test('merge: an entry with platforms holds only there; one without holds everywhere (R5c)', () => {
  const defaults = {
    always_current: ['firefox', { name: 'google-chrome', platforms: ['macos'] }],
    vendored_node: [{ path: '/Applications/X.app/node', platforms: ['macos'] }, { path: '/opt/x/node', platforms: ['linux'] }],
    ioc: [{ name: 'everywhere' }, { name: 'mac only', platforms: ['macos'] }],
  };
  const mine = { security_exception: [{ kind: 'formula', name: 'a' }, { kind: 'formula', name: 'b', platforms: ['linux'] }], off: { always_current: ['google-chrome'] } };
  const mac = merge(defaults, mine, 'macos');
  assert.deepEqual(mac.policy.always_current, ['firefox'], 'a table item is turned off by its name like a string');
  assert.deepEqual(mac.policy.vendored_node, ['/Applications/X.app/node']);
  assert.deepEqual(mac.policy.ioc.map(i => i.name), ['everywhere', 'mac only']);
  assert.deepEqual(mac.policy.security_exception.map(e => e.name), ['a']);
  assert.deepEqual(mac.warnings, []);
  const linux = merge(defaults, {}, 'linux');
  assert.deepEqual(linux.policy.always_current, ['firefox']);
  assert.deepEqual(linux.policy.vendored_node, ['/opt/x/node']);
  assert.deepEqual(linux.policy.ioc.map(i => i.name), ['everywhere']);
  assert.ok(linux.sources.some(x => x.source === 'elsewhere' && x.item === 'mac only'));
  assert.match(merge({ ioc: [{ name: 'x', platforms: ['mac'] }] }, {}, 'macos').warnings[0], /platforms must list macos, linux, windows \(not mac\)/);
});

test('merge: families narrows a Linux entry to those families; it needs platforms = ["linux"] beside it (parity 0.1, D63)', () => {
  const defaults = {
    vendored_node: [{ path: '/run/current-system/sw/bin/node', platforms: ['linux'], families: ['nixos'] }, { path: '/opt/x/node', platforms: ['linux'] }],
    ioc: [{ name: 'debian only', platforms: ['linux'], families: ['debian'] }, { name: 'bare', families: ['rhel'] }, { name: 'typo', platforms: ['linux'], families: ['debain'] }],
  };
  const nix = merge(defaults, {}, 'linux', 'nixos');
  assert.deepEqual(nix.policy.vendored_node, ['/run/current-system/sw/bin/node', '/opt/x/node']);
  assert.deepEqual(nix.policy.ioc.map(i => i.name), []);
  const deb = merge(defaults, {}, 'linux', 'debian');
  assert.deepEqual(deb.policy.vendored_node, ['/opt/x/node']);
  assert.deepEqual(deb.policy.ioc.map(i => i.name), ['debian only']);
  const away = deb.sources.find(x => x.source === 'elsewhere' && x.item === '/run/current-system/sw/bin/node');
  assert.equal(away.why, 'default; platforms = ["linux"], families = ["nixos"]');
  assert.deepEqual(merge(defaults, {}, 'linux', 'rhel').policy.ioc.map(i => i.name), ['bare'], 'families without platforms still holds on Linux');
  assert.deepEqual(merge(defaults, {}, 'macos', null).policy.ioc.map(i => i.name), [], 'and only on Linux');
  assert.deepEqual(deb.warnings, [
    'ioc bare: families needs platforms = ["linux"] too (an older steward ignores families and would apply the entry everywhere)',
    'ioc typo: families must list debian, rhel, suse, arch, alpine, void, gentoo, slackware, nixos (not debain)',
  ]);
});

test('merge: without families, a Mac merges exactly as before (parity 0.1)', () => {
  const defaults = { always_current: ['firefox', { name: 'google-chrome', platforms: ['macos'] }], ioc: [{ name: 'linux', platforms: ['linux'] }] };
  const three = merge(defaults, {}, 'macos');
  const four = merge(defaults, {}, 'macos', null);
  assert.deepEqual(four, three);
  assert.equal(three.sources.find(x => x.source === 'elsewhere').why, 'default; platforms = ["linux"]');
});

test('host.js: the report names the platform as before on macOS (parity 0.1)', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-host-')));
  fs.writeFileSync(path.join(ROOT, 'steward.toml'), 'schema = 1\n');
  const report = spawnSync(process.execPath, [path.join(REPO, 'lib', 'host.js')], { encoding: 'utf8', env: { ...process.env, STEWARD_INSTANCE: ROOT } }).stdout;
  assert.match(report.split('\n')[0], /^host policy \(macos\): \d+ default\(s\) from the engine/);
});

test('merge: [[updater]] merges by name and turns off with [off]; an incomplete one is left out and reported (D52)', () => {
  const full = { why: 'w', check: 'c', apply: 'a', backup: ['b'] };
  const defaults = { updater: [{ name: 'kb', class: 'signed_data', require_output: 'ok', pin: { file: 'f', match: 'm', sha256: 'aa' }, ...full }, { name: 'sigs', class: 'always_current', ...full }] };
  const mine = { updater: [{ name: 'kb', class: 'signed_data', ...full }, { name: 'own', ...full }], off: { updater: ['sigs'] } };
  const { policy, sources, warnings } = merge(defaults, mine);
  assert.deepEqual(policy.updater.map(u => [u.name, u._source]), [['own', 'yours']], 'yours replaced kb, and without a pin it is left out');
  assert.ok(sources.some(s => s.key === 'updater' && s.item === 'sigs' && s.source === 'off'));
  assert.deepEqual(warnings, ['updater kb (yours): signed_data needs a pin (file, match, sha256); left out', 'updater kb (yours): signed_data needs require_output; left out']);
  assert.deepEqual(merge(defaults, {}).policy.updater.map(u => u.name), ['kb', 'sigs']);
});

test('host.js: the engine defaults parse, and an instance\'s [off] shows in the report and the JSON', () => {
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-host-')));
  fs.writeFileSync(path.join(ROOT, 'steward.toml'), 'schema = 1\n');
  fs.mkdirSync(path.join(ROOT, 'supply-chain'));
  fs.writeFileSync(path.join(ROOT, 'supply-chain', 'host.toml'), '[off]\nalways_current = ["firefox"]\n');
  const env = { ...process.env, STEWARD_INSTANCE: ROOT };
  const json = JSON.parse(spawnSync(process.execPath, [path.join(REPO, 'lib', 'host.js'), '--json'], { encoding: 'utf8', env }).stdout);
  assert.ok(!json.always_current.includes('firefox'));
  assert.ok(json.ioc.length >= 1 && json.distrusted_root.length >= 1, 'the shipped IOCs and roots arrive');
  const report = spawnSync(process.execPath, [path.join(REPO, 'lib', 'host.js')], { encoding: 'utf8', env }).stdout;
  assert.match(report, /1 turned off/);
  assert.match(report, /off +always_current +firefox/);
});
