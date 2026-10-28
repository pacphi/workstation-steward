// supply-chain/bin/addon-check.js (part of `steward sc verify`): with the AI tooling add-on off there is nothing to
// check; with it on, a tool this machine doesn't have is reported, not a crash; one that is installed and won't load
// fails. The install check found verify crashing on a fresh Mac without the AI tools. Throwaway folders; no network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-addon-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// an instance whose mise data folder and npm -g prefix are empty throwaway folders
function setup(name, aiTooling) {
  const dir = path.join(ROOT, name);
  const data = path.join(dir, 'mise');
  fs.mkdirSync(path.join(data, 'installs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'steward.toml'), `schema = 1\n[paths]\nmise_data_dir = "${data}"\n[profiles]\nai_tooling = ${aiTooling}\n`);
  const run = () => spawnSync(process.execPath, [path.join(REPO, 'supply-chain', 'bin', 'addon-check.js')], {
    encoding: 'utf8', env: { ...process.env, STEWARD_INSTANCE: dir, npm_config_prefix: path.join(dir, 'npm-global'), NO_COLOR: '1' } });
  return { data, run };
}

test('addon-check: the AI tooling add-on off means nothing to check', () => {
  const r = setup('off', false).run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped: the AI tooling add-on is off/);
});

test('addon-check: tools that are not installed are reported, not a crash; an installed one that fails to load fails', () => {
  const s = setup('on', true);
  const none = s.run();
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /-- {3}npm-agentic-qe → better-sqlite3: not installed/);
  assert.match(none.stdout, /-- {3}npm -g ruflo → sharp: not installed/);
  // an agentic-qe install whose better-sqlite3 throws on load
  const mod = path.join(s.data, 'installs', 'npm-agentic-qe', '1.0.0', 'node_modules', '.mise', 'agentic-qe@1.0.0', 'node_modules', 'better-sqlite3');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'package.json'), '{"name":"better-sqlite3","main":"index.js"}');
  fs.writeFileSync(path.join(mod, 'index.js'), 'throw new Error("broken native addon");');
  const broken = s.run();
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /FAIL npm-agentic-qe → better-sqlite3 :: broken native addon/);
});
