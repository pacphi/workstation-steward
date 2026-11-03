// supply-chain/bin/mise-self.js: which release mise itself moves to (D38). Pure functions; no network, no mise.
// Fixture: jdx/mise releases as published on 2026-10-27 (gh api repos/jdx/mise/releases). Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, cmp, inRange, choose } = require('../supply-chain/bin/mise-self.js');

const NOW = new Date('2026-10-27T15:25:00Z');
const releases = [
  ['2026.10.21', '2026-10-27T10:23:17Z'], ['2026.10.20', '2026-10-26T21:21:55Z'], ['2026.10.19', '2026-10-24T20:02:03Z'],
  ['2026.10.18', '2026-10-23T11:54:36Z'], ['2026.10.17', '2026-10-21T01:29:26Z'], ['2026.10.9', '2026-10-13T14:53:38Z'],
  ['2026.8.2', '2026-08-05T00:00:00Z'], ['2026.7.13', '2026-07-20T00:00:00Z'],
].map(([version, at]) => ({ version, at: new Date(at) }));

test('parse and cmp: calendar versions compare by number, not as text', () => {
  assert.deepEqual(parse('v2026.10.18'), [2026, 10, 18]);
  assert.equal(parse('2026.10'), null);
  assert.equal(parse('latest'), null);
  assert.ok(cmp('2026.10.9', '2026.8.2') > 0);   // as text, "10" sorts before "8"
  assert.ok(cmp('2026.10.18', '2026.10.9') > 0);
  assert.equal(cmp('v2026.8.2', '2026.8.2'), 0);
});

test('inRange: the GitHub Advisory DB range forms', () => {
  assert.ok(inRange('2026.7.13', '<= 2026.7.13'));
  assert.ok(!inRange('2026.8.2', '<= 2026.7.13'));
  assert.ok(inRange('2026.5.1', '>= 2026.3.15, < 2026.6.4'));
  assert.ok(!inRange('2026.6.4', '>= 2026.3.15, < 2026.6.4'));
  assert.ok(!inRange('2026.8.2', ''));
  assert.ok(!inRange('2026.8.2', 'garbage'));
});

test('choose: the newest release past the gate, not the newest release', () => {
  const p = choose({ current: '2026.8.2', releases, now: NOW, days: 3 });
  assert.equal(p.action, 'take');
  assert.equal(p.target, '2026.10.18');            // 10.19 is 2.8 days old
  assert.equal(p.newest, '2026.10.21');
  assert.equal(p.behind, 6);
});

test('choose: hold while every newer release is under the gate; ok when current', () => {
  const p = choose({ current: '2026.10.18', releases, now: NOW, days: 3 });
  assert.equal(p.action, 'hold');
  assert.equal(p.target, '2026.10.18');
  assert.match(p.reason, /3 newer release\(s\), all under the 3d gate/);
  assert.equal(choose({ current: '2026.10.21', releases, now: NOW, days: 3 }).action, 'ok');
});

test('choose: a young first patched release needs an unexpired host.toml exception, and takes that exact release', () => {
  const advisories = [{ id: 'GHSA-test', fixed: '2026.10.20' }];
  const held = choose({ current: '2026.8.2', releases, now: NOW, days: 3, advisories });
  assert.equal(held.action, 'take');               // still takes the gated 10.18 …
  assert.equal(held.target, '2026.10.18');
  assert.match(held.reason, /GHSA-test is fixed in 2026\.10\.20 .*security_exception/);  // … and says what 10.20 needs
  const exceptions = [{ kind: 'mise', name: 'mise', version: '2026.10.20', advisory: 'https://example.test/a', expires: '2026-11-03' }];
  const taken = choose({ current: '2026.8.2', releases, now: NOW, days: 3, advisories, exceptions });
  assert.equal(taken.target, '2026.10.20');        // the first patched release, not 10.21
  assert.match(taken.reason, /security exception/);
  const expired = [{ ...exceptions[0], expires: '2026-10-26' }];
  assert.equal(choose({ current: '2026.8.2', releases, now: NOW, days: 3, advisories, exceptions: expired }).target, '2026.10.18');
});

test('choose: an advisory fixed at or below the gated release adds nothing', () => {
  const p = choose({ current: '2026.8.2', releases, now: NOW, days: 3, advisories: [{ id: 'GHSA-old', fixed: '2026.10.9' }] });
  assert.equal(p.target, '2026.10.18');
  assert.doesNotMatch(p.reason, /GHSA-old/);
});

// --plan on a machine without Homebrew (most Linux machines): "not a Homebrew mise", never a crash. Found by running the
// audit in a Linux container (parity 0.8): spawnSync of a missing brew gives stdout null, and .trim() threw.
test('--plan without Homebrew on the machine: a plan line, not a crash', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-mise-self-')));
  fs.writeFileSync(path.join(bin, 'mise'), '#!/bin/sh\necho "2026.10.21 linux-arm64 (2026-10-27)"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const yq = spawnSync('/bin/sh', ['-c', 'command -v yq'], { encoding: 'utf8' }).stdout.trim();
  const PATH = [bin, path.dirname(process.execPath), path.dirname(fs.realpathSync(yq)), '/usr/bin', '/bin'].join(':');
  // not found: 1 from bash or zsh, 127 from dash (Debian's and Ubuntu's /bin/sh)
  assert.notEqual(spawnSync('/bin/sh', ['-c', 'command -v brew'], { encoding: 'utf8', env: { PATH } }).status, 0, 'no brew on this PATH');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'supply-chain', 'bin', 'mise-self.js'), '--plan'], { encoding: 'utf8', env: { PATH, HOME: os.homedir(), STEWARD_INSTANCE: path.join(__dirname, '..', 'examples') } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /TypeError/);
  assert.match(r.stdout, /^\w+\t2026\.10\.21\t/, r.stdout);
});
