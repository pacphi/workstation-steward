// lib/config.js: steward.toml is parsed once while it stays the same, and read again after a rewrite. yq is a
// process per parse, and one command loads the config from every module it requires (steward brief: seven or more).
// A stub yq on PATH counts its calls, then runs the real one. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-memo-')));

test('config: two loads parse steward.toml once; a rewrite in the same process is read again', () => {
  const yq = spawnSync('sh', ['-c', 'command -v yq'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(yq, 'yq is on PATH');
  const bin = path.join(ROOT, 'bin'), count = path.join(ROOT, 'yq-calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'yq'), `#!/bin/sh\necho "$@" >> '${count}'\nexec '${yq}' "$@"\n`, { mode: 0o755 });
  const inst = path.join(ROOT, 'instance');
  fs.mkdirSync(inst);
  fs.writeFileSync(path.join(inst, 'steward.toml'), '[policy]\nsoak_days = 3\n');
  const script = `
    const fs = require('fs'), path = require('path');
    const C = require(${JSON.stringify(path.join(REPO, 'lib', 'config.js'))});
    const calls = () => fs.readFileSync(${JSON.stringify(count)}, 'utf8').split('\\n').filter(Boolean).length;
    const a = C.load().values.policy.soak_days;
    a.toString(); C.load().values.policy.soak_days = 99; // a caller changing its copy changes no one else's
    const b = C.load().values.policy.soak_days;
    const once = calls();
    fs.writeFileSync(path.join(${JSON.stringify(inst)}, 'steward.toml'), '[policy]\\nsoak_days = 11\\nreview_days = 2\\n');
    const c = C.load().values.policy;
    console.log(JSON.stringify({ a, b, once, after: calls(), c: [c.soak_days, c.review_days] }));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STEWARD_INSTANCE: inst } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.a, 3);
  assert.equal(out.b, 3);
  assert.equal(out.once, 1, 'three loads, one yq');
  assert.equal(out.after, 2, 'the rewrite was parsed again');
  assert.deepEqual(out.c, [11, 2]);
});
