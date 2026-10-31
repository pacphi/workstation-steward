// bare `steward` (bin/steward.js): the briefing's lines, then the help, from one process (lib/brief.js --banner), with
// no network and no walk of the project roots. It replaced five banners. A throwaway instance; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-banner-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('bare steward: the briefing (one next step), a blank line, then the help; no network, about a second', () => {
  const inst = path.join(ROOT, 'inst'), stubs = path.join(ROOT, 'stubs'), marker = path.join(ROOT, 'marker');
  fs.mkdirSync(inst, { recursive: true }); fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(inst, 'steward.toml'),
    `[paths]\nstate = "${path.join(ROOT, 'state')}"\ncache = "${path.join(ROOT, 'cache')}"\n[profiles]\nai_tooling = false\nprojects = false\n`);
  for (const t of ['gh', 'npm', 'curl', 'mise']) { fs.writeFileSync(path.join(stubs, t), `#!/bin/sh\necho ${t} "$@" >> '${marker}'\nexit 1\n`); fs.chmodSync(path.join(stubs, t), 0o755); }
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, STEWARD_INSTANCE: inst, STEWARD_NO_REFRESH: '1', NO_COLOR: '1', NO_PROGRESS: '1' } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# bare steward took ${ms.toFixed(0)} ms`);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  // a review was never run here: the briefing names it as the one next step, in its own words
  assert.match(out, /^steward a review is due \(never run\)\nnext: steward review\n/);
  assert.match(out, /\n\nsteward \S+: keeps this machine's software supply chain current/, 'a blank line, then the help');
  assert.doesNotMatch(out, /review due \(never run\): steward review/, 'not the old review banner');
  assert.ok(!fs.existsSync(marker), `no network tool ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
  assert.ok(ms < 3000, `${ms} ms`);
});

test('bare steward: a briefing that can\'t be read still shows the help', () => {
  const inst = path.join(ROOT, 'broken');
  fs.mkdirSync(inst, { recursive: true });
  fs.writeFileSync(path.join(inst, 'steward.toml'), '[brief]\nstale_hours = "soon"\n'); // an invalid value
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js')], {
    encoding: 'utf8', env: { ...process.env, STEWARD_INSTANCE: inst, STEWARD_NO_REFRESH: '1', NO_COLOR: '1' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: steward <command>/);
});
