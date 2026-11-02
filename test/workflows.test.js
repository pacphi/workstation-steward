// The CI that proves the engine on Linux (parity 0.8): a Linux Tests job on every PR, with Milestone 0's exit criterion
// (the audit and the plan on Ubuntu with Linuxbrew), and a release tested on Linux as well as macOS before it publishes.
// Reads the workflow files with yq (the example toolchain's). No network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const wf = name => JSON.parse(execFileSync('yq', ['-o', 'json', '.', path.join(REPO, '.github', 'workflows', name)], { encoding: 'utf8' }));

test('test.yml: a Linux job on every PR (no private-copy guard), with the same steps as macOS', () => {
  const t = wf('test.yml');
  const j = t.jobs['test-linux'];
  assert.ok(j, 'a test-linux job');
  assert.equal(j['runs-on'], 'ubuntu-latest');
  assert.equal(j.if, undefined, 'it runs on the private copy too: Linux minutes are cheap');
  const runs = j.steps.map(s => s.run || '').join('\n');
  for (const c of ['mise install', 'npm ci --ignore-scripts --prefix tools/types', 'node bin/steward.js config', 'just test']) assert.ok(runs.includes(c), c);
  assert.equal(t.jobs.test['runs-on'], 'macos-latest', 'the macOS job stays');
  assert.ok(String(t.jobs.test.if).includes('private'), 'and keeps its guard');
});

test('test.yml: Milestone 0\'s exit criterion: the audit and the plan on Ubuntu with Linuxbrew, checked, in the summary', () => {
  const s = wf('test.yml').jobs['test-linux'].steps.find(x => /exit criterion/i.test(x.name || ''));
  assert.ok(s, 'the smoke step');
  assert.match(s.run, /brew shellenv/);
  assert.match(s.run, /linux \(ubuntu/);
  assert.match(s.run, /sc audit --plain/);
  assert.match(s.run, /DRY_RUN=1 node bin\/steward\.js sc plan --plain/);
  assert.match(s.run, /GITHUB_STEP_SUMMARY/);
  for (const absent of ['macOS (softwareupdate', 'App Store', 'Homebrew casks']) assert.ok(s.run.includes(absent), `it checks that "${absent}" is absent`);
  assert.equal(s.env && s.env.GH_TOKEN, '${{ github.token }}');
});

test('release.yml: the release is tested on Linux as well, and publish waits for both', () => {
  const r = wf('release.yml');
  const j = r.jobs['test-linux'];
  assert.ok(j, 'a test-linux job');
  assert.equal(j['runs-on'], 'ubuntu-latest');
  assert.deepEqual(j.needs, r.jobs.test.needs, 'started the same way as the macOS test job');
  assert.equal(j.if, r.jobs.test.if);
  const runs = j.steps.map(s => s.run || '').join('\n');
  for (const c of ['mise install', 'just test', 'just lint']) assert.ok(runs.includes(c), c);
  assert.ok([].concat(r.jobs.publish.needs).includes('test-linux'), 'publish needs test-linux');
  assert.match(r.jobs.publish.if, /needs\.test-linux\.result == 'success'/);
  assert.equal(r.jobs.publish['runs-on'], 'macos-latest', 'publish moves to Linux only at the release step (owner, 2026-11-02)');
});
