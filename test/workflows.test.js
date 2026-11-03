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
  // each test job names its OS, so a check's name says where it ran (the owner, 2026-11-02)
  assert.equal(t.jobs['test-macos']['runs-on'], 'macos-latest', 'the macOS job stays, as test-macos');
  assert.ok(String(t.jobs['test-macos'].if).includes('private'), 'and keeps its guard');
});

test('test.yml: Milestone 0\'s exit criterion: the audit and the plan on Ubuntu with Linuxbrew, checked, in the summary', () => {
  const s = wf('test.yml').jobs['test-linux'].steps.find(x => /exit criterion/i.test(x.name || ''));
  assert.ok(s, 'the smoke step');
  assert.match(s.run, /brew shellenv/);
  // first without Homebrew, as most Linux machines are (a run with Linuxbrew alone hid a crash), then with it
  const at = re => s.run.search(re);
  assert.ok(at(/sc audit --plain/) >= 0 && at(/sc audit --plain/) < at(/brew shellenv/), 'an audit before Linuxbrew is on PATH');
  assert.ok(s.run.lastIndexOf('sc audit --plain') > at(/brew shellenv/), 'and one after');
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
  assert.equal(r.jobs.test, undefined, 'no job named plain test');
  assert.equal(r.jobs['test-macos']['runs-on'], 'macos-latest');
  assert.deepEqual(j.needs, r.jobs['test-macos'].needs, 'started the same way as the macOS test job');
  assert.equal(j.if, r.jobs['test-macos'].if);
  const runs = j.steps.map(s => s.run || '').join('\n');
  for (const c of ['mise install', 'just test', 'just lint']) assert.ok(runs.includes(c), c);
  assert.deepEqual([].concat(r.jobs.publish.needs).sort(), ['release-please', 'test-linux', 'test-macos']);
  assert.match(r.jobs.publish.if, /needs\.test-macos\.result == 'success' && needs\.test-linux\.result == 'success'/);
  const uses = JSON.stringify(r.jobs.publish);
  assert.ok(!/needs\.test\./.test(uses), 'publish reads the tag and commit from test-macos');
  assert.equal(r.jobs.publish['runs-on'], 'macos-latest', 'publish moves to Linux only at the release step (owner, 2026-11-02)');
});

test('test.yml: one job named test passes only when every OS job did, so main\'s required check stays test (the owner\'s idea, 2026-11-02)', () => {
  const g = wf('test.yml').jobs.test;
  assert.ok(g, 'a gate job named test');
  assert.deepEqual([].concat(g.needs).sort(), ['rows', 'test-containers', 'test-linux', 'test-macos'], 'the container rows are part of the required check, and so is reading them: a broken matrix.json would skip them, and skipped counts (parity 1c)');
  assert.equal(g.if, '${{ always() }}', 'it runs even when a job it needs failed, and then fails itself');
  assert.equal(g['runs-on'], 'ubuntu-latest');
  const run = g.steps.map(s => s.run || '').join('\n');
  assert.match(JSON.stringify(g.steps), /join\(needs\.\*\.result/, 'every job it needs, whatever is added later');
  // its own script, run with each mix of results the jobs it needs can end in
  const gate = results => require('child_process').spawnSync('bash', ['-c', run], { encoding: 'utf8', env: { ...process.env, RESULTS: results } }).status;
  assert.equal(gate('success success'), 0);
  assert.equal(gate('skipped success'), 0, 'a skipped job (macOS on a private copy) counts');
  assert.notEqual(gate('success failure'), 0);
  assert.notEqual(gate('cancelled success'), 0);
  assert.notEqual(gate('skipped skipped'), 0, 'at least one must have passed');
});

test('test.yml: every row of test/containers/matrix.json runs in CI, from that one list, as just linux-test runs it (parity 1c, T.1)', () => {
  const t = wf('test.yml');
  const rows = t.jobs.rows;
  assert.ok(rows, 'a rows job');
  assert.equal(rows['runs-on'], 'ubuntu-latest');
  const step = rows.steps.find(s => /linux-test\.js ci/.test(s.run || ''));
  assert.ok(step && step.id, 'it reads the rows with node tools/linux-test.js ci, in a step with an id');
  assert.match(String(rows.outputs && rows.outputs.rows), new RegExp(`steps\\.${step.id}\\.outputs\\.rows`));
  const c = t.jobs['test-containers'];
  assert.ok(c, 'a test-containers job');
  assert.equal(c['runs-on'], 'ubuntu-latest');
  assert.equal(c.needs, 'rows');
  assert.equal(c.strategy['fail-fast'], false, 'one row failing never cancels the others');
  assert.equal(c.strategy.matrix.row, '${{ fromJSON(needs.rows.outputs.rows) }}');
  const run = c.steps.map(s => s.run || '').join('\n');
  assert.match(run, /node tools\/linux-test\.js run "?\$\{\{ matrix\.row \}\}"?/, 'the same tool and path as on a Mac');
  assert.equal(c.if, undefined, 'the private copy too: Linux minutes are cheap');
});

test('test.yml: the container jobs run linux-test.js on the example toolchain\'s Node (26), not the runner\'s own', () => {
  const t = wf('test.yml');
  const mise = t.jobs['test-linux'].steps.find(s => /jdx\/mise-action/.test(s.uses || ''));
  for (const id of ['rows', 'test-containers']) {
    const j = t.jobs[id];
    const steps = j.steps;
    const m = steps.findIndex(s => s.uses === mise.uses);
    assert.ok(m >= 0, `${id}: the same pinned mise-action as test-linux`);
    assert.equal(steps[m].with.version, mise.with.version, `${id}: the same mise`);
    assert.equal(steps[m].with.install, false, `${id}: the action installs nothing itself`);
    const n = steps.findIndex(s => /^mise install node$/.test((s.run || '').trim()));
    const l = steps.findIndex(s => /linux-test\.js/.test(s.run || ''));
    assert.ok(n > m && l > n, `${id}: Node from the example toolchain, before linux-test.js runs`);
    assert.equal(j.env && j.env.MISE_GLOBAL_CONFIG_FILE, '${{ github.workspace }}/examples/mise/config.toml', `${id}: the example toolchain`);
  }
});

// The install check as a matrix, from a ref (parity 1d, T.4 and T.7; owner, 2026-11-03): the macOS runner and one container
// per row of test/containers/matrix.json, each running tools/install-check.sh; worktree mode from any commit before the
// release (R-2), npm mode for a released version. The tooling comes from the workflow's own commit, the thing installed
// from the ref or the tag, since an older tag has neither the script nor the list.
test('install-check.yml: a ref or a version, exactly one', () => {
  const w = wf('install-check.yml');
  const i = w.on.workflow_dispatch.inputs;
  for (const k of ['ref', 'version']) assert.equal(i[k].required, false, `${k} is optional: one of the two`);
  assert.ok(i.claude_code && i.release_age_days, 'the other inputs stay');
  const steps = w.jobs.rows.steps.map(s => s.run || '').join('\n');
  assert.match(steps, /exactly one of ref and version/, 'the rows job refuses neither or both');
});

test('install-check.yml: every job checks out the tooling (this commit) and the subject (the ref, or the tag), with history', () => {
  const w = wf('install-check.yml');
  for (const id of ['rows', 'macos', 'linux']) {
    const co = w.jobs[id].steps.filter(s => /^actions\/checkout@/.test(s.uses || ''));
    const tooling = co.find(s => s.with && s.with.path === 'tooling');
    const subject = co.find(s => s.with && s.with.path === 'subject');
    assert.ok(tooling && !tooling.with.ref, `${id}: tooling/ at the workflow's own commit`);
    assert.ok(subject, `${id}: subject/`);
    assert.equal(subject.with.ref, "${{ inputs.ref || format('refs/tags/v{0}', inputs.version) }}", `${id}: the ref, else the tag`);
    assert.equal(subject.with['fetch-depth'], 0, `${id}: tags and origin/main, for the version line and "on main"`);
  }
});

test('install-check.yml: the Mac runs the script; each matrix.json row runs it in its container, from the same list as the tests', () => {
  const w = wf('install-check.yml');
  assert.equal(w.jobs.install, undefined, 'the one macOS job became the matrix');
  const rows = w.jobs.rows;
  assert.equal(rows['runs-on'], 'ubuntu-latest');
  assert.match(rows.steps.map(s => s.run || '').join('\n'), /node tooling\/tools\/linux-test\.js ci/, 'rows from matrix.json (T.1)');
  const mac = w.jobs.macos;
  assert.equal(mac['runs-on'], 'macos-latest');
  assert.match(mac.steps.map(s => s.run || '').join('\n'), /bash tooling\/tools\/install-check\.sh "?\$\{\{ github\.workspace \}\}\/subject"?/);
  const lin = w.jobs.linux;
  assert.equal(lin['runs-on'], 'ubuntu-latest');
  assert.equal(lin.needs, 'rows');
  assert.equal(lin.strategy['fail-fast'], false, 'one row failing never cancels the others');
  assert.equal(lin.strategy.matrix.row, '${{ fromJSON(needs.rows.outputs.rows) }}');
  assert.match(lin.steps.map(s => s.run || '').join('\n'), /node tooling\/tools\/linux-test\.js run "\$\{\{ matrix\.row \}\}" --install-check/);
  for (const id of ['rows', 'linux']) {
    const steps = w.jobs[id].steps;
    const m = steps.findIndex(s => /jdx\/mise-action/.test(s.uses || ''));
    const n = steps.findIndex(s => /^mise install node$/.test((s.run || '').trim()));
    const l = steps.findIndex(s => /linux-test\.js/.test(s.run || ''));
    assert.ok(m >= 0 && n > m && l > n, `${id}: linux-test.js on the example toolchain's Node, as in test.yml`);
    assert.equal(w.jobs[id].env && w.jobs[id].env.MISE_GLOBAL_CONFIG_FILE, '${{ github.workspace }}/tooling/examples/mise/config.toml', `${id}: the tooling's example toolchain`);
  }
});
