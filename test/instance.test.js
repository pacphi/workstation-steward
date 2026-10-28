// lib/config.js: where the instance is (D39), the [profiles] add-on gates, and that the engine reads every policy file
// from the instance. A throwaway instance in a temp folder; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveInstance } = require('../lib/config.js');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-instance-')));
const INST = path.join(ROOT, 'inst');
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(INST, rel)), { recursive: true }); fs.writeFileSync(path.join(INST, rel), text); };
put('steward.toml', '[profiles]\nai_tooling = false\nprojects = false\n');
put('supply-chain/host.toml', 'always_current = ["marker-browser"]\n');
put('supply-chain/hybrids.toml', '[[hybrid]]\nname = "marker-hybrid"\nversion = "1.0.0"\nsource = "registry"\nallow_scripts = []\n');
put('projects/registry.toml', '');
/** @type {NodeJS.ProcessEnv} */
const ENV = { ...process.env, STEWARD_INSTANCE: INST, NO_PROGRESS: '1' };
delete ENV.STEWARD_CONFIG;
const node = (args, env = ENV) => spawnSync('node', args, { cwd: REPO, encoding: 'utf8', env });

test('resolveInstance: $STEWARD_INSTANCE, then the engine folder, then ~/.config', () => {
  const has = set => f => set.includes(f);
  assert.deepEqual(resolveInstance({ env: { STEWARD_INSTANCE: '/i' }, engineRoot: '/e', home: '/h', exists: has(['/i/steward.toml', '/e/steward.toml']) }),
    { root: '/i', source: 'env STEWARD_INSTANCE', error: undefined });
  assert.match(resolveInstance({ env: { STEWARD_INSTANCE: '~/i' }, engineRoot: '/e', home: '/h', exists: has([]) }).error, /no steward\.toml there/);
  assert.equal(resolveInstance({ env: { STEWARD_INSTANCE: '~/i' }, engineRoot: '/e', home: '/h', exists: has(['/h/i/steward.toml']) }).root, '/h/i');
  assert.deepEqual(resolveInstance({ env: {}, engineRoot: '/e', home: '/h', exists: has(['/e/steward.toml']) }), { root: '/e', source: 'engine folder' });
  assert.equal(resolveInstance({ env: {}, engineRoot: '/e', home: '/h', exists: has([]) }).root, '/h/.config/workstation-steward');
  assert.equal(resolveInstance({ env: { XDG_CONFIG_HOME: '/x' }, engineRoot: '/e', home: '/h', exists: has([]) }).root, '/x/workstation-steward');
});

test('config: reports the instance and its source; --shell exports it; a bad $STEWARD_INSTANCE is an error', () => {
  assert.match(node(['lib/config.js']).stdout, new RegExp(`instance: +${INST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +\\[env STEWARD_INSTANCE\\]`));
  assert.ok(node(['lib/config.js', '--shell']).stdout.includes(`STEWARD_INSTANCE_ROOT='${INST}'`));
  const bad = node(['lib/config.js'], { ...ENV, STEWARD_INSTANCE: path.join(ROOT, 'nowhere') });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no steward\.toml there/);
  const badSh = spawnSync('bash', ['-c', 'source lib/lib.sh && echo reached'], { cwd: REPO, encoding: 'utf8', env: { ...ENV, STEWARD_INSTANCE: path.join(ROOT, 'nowhere') } });
  assert.equal(badSh.status, 1);                  // bash stops at the config, as Node does
  assert.doesNotMatch(badSh.stdout, /reached/);
  assert.match(badSh.stderr, /steward config failed/);
});

test('profiles: both add-ons are off by default and gate with exit 3; unknown names exit 2', () => {
  for (const p of ['ai_tooling', 'projects']) {
    const r = node(['lib/config.js', '--profile', p]);
    assert.equal(r.status, 3, p);
    assert.match(r.stderr, new RegExp(`add-on is off .*\\[profiles\\] ${p} = false`));
  }
  assert.equal(node(['lib/config.js', '--profile', 'nope']).status, 2);
  const none = path.join(ROOT, 'empty'); fs.mkdirSync(none); fs.writeFileSync(path.join(none, 'steward.toml'), '');
  assert.equal(node(['lib/config.js', '--profile', 'projects'], { ...ENV, STEWARD_INSTANCE: none }).status, 3);   // built-in default
});

test('policy files come from the instance: Node (C.policy) and bash (lib.sh)', () => {
  const js = node(['-e', 'console.log(require("./lib/config.js").policy("supply-chain/host.toml").always_current[0])']);
  assert.equal(js.stdout.trim(), 'marker-browser', js.stderr);
  // host_json merges the engine's defaults first, then the instance's additions (lib/host.js, D40)
  const sh = spawnSync('bash', ['-c', 'source lib/lib.sh && echo "$SC_INSTANCE" && hybrids_json | yq -r ".[0].name" && host_json | yq -p json -r ".always_current[-1]"'],
    { cwd: REPO, encoding: 'utf8', env: ENV });
  assert.deepEqual(sh.stdout.trim().split('\n'), [path.join(INST, 'supply-chain'), 'marker-hybrid', 'marker-browser'], sh.stderr);
});

test('add-ons off: their steward commands refuse with a reason, and the projects banner stays quiet', () => {
  for (const [mod, recipe] of [['ai', 'drift'], ['projects', 'scan']]) {
    const r = node(['bin/steward.js', mod, recipe]);
    assert.equal(r.status, 3, `steward ${mod} ${recipe}`);
    assert.match(r.stderr, /add-on is off/);
  }
  const banner = node(['projects/bin/projects.js', 'banner']);
  assert.equal(banner.status, 0, banner.stderr);
  assert.equal(banner.stdout, '');
});
