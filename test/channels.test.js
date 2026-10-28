// The release and dev channels (D41): the launcher's $STEWARD_CHANNEL wins; a dev build uses the examples and its own
// state unless given --real or a $STEWARD_INSTANCE (init is exempt); with a real config, a command that can change
// things first names the dev build; `check` holds the config to a format the pinned release reads. No network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const EXAMPLES = path.join(REPO, 'examples');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-channels-')));
const BASE = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', XDG_STATE_HOME: path.join(ROOT, 'state'), XDG_CONFIG_HOME: path.join(ROOT, 'xdg'), STEWARD_RELEASE: path.join(ROOT, 'no-release') };
for (const k of ['STEWARD_INSTANCE', 'STEWARD_CONFIG', 'STEWARD_CHANNEL']) delete BASE[k];
const steward = (args, env = {}) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), ...args], { encoding: 'utf8', env: { ...BASE, ...env } });

test('channel: the launcher decides; the version line names the build', () => {
  assert.match(steward(['version'], { STEWARD_CHANNEL: 'release' }).stdout, /^workstation-steward release \d+\.\d+\.\d+ \(/);
  assert.match(steward(['version'], { STEWARD_CHANNEL: 'dev' }).stdout, /^workstation-steward dev \d+\.\d+\.\d+ \(/);
});

test('dev: examples and its own state by default; --real or an explicit instance uses that; init is exempt', () => {
  const sandbox = steward(['version'], { STEWARD_CHANNEL: 'dev' }).stdout;
  assert.match(sandbox, /using examples\/ and its own state/);
  assert.match(sandbox, /instance: .*\/examples +\[env STEWARD_INSTANCE\]/);   // paths print with ~ for home
  const real = steward(['version', '--real'], { STEWARD_CHANNEL: 'dev' }).stdout;
  assert.doesNotMatch(real, /using examples/);
  assert.doesNotMatch(real, /instance: .*examples/);
  const given = steward(['version'], { STEWARD_CHANNEL: 'dev', STEWARD_INSTANCE: EXAMPLES }).stdout;
  assert.doesNotMatch(given, /using examples\/ and its own state/);
  // the sandbox keeps a separate state folder
  const st = steward(['config', '--json'], { STEWARD_CHANNEL: 'dev' });
  assert.equal(JSON.parse(st.stdout).paths.state, path.join(ROOT, 'state', 'workstation-steward-dev', 'workstation-steward'));
  // init makes a config where it's told, never into the examples
  const target = path.join(ROOT, 'fresh');
  const init = steward(['init', target, '--yes'], { STEWARD_CHANNEL: 'dev' });
  assert.equal(init.status, 0, init.stderr);
  assert.ok(fs.existsSync(path.join(target, 'steward.toml')));
  assert.match(init.stderr, /DEV BUILD .* "init"/);
});

test('dev with a real config: a command that can change things names the build first; read-only ones do not', () => {
  const w = steward(['sc', 'release-age'], { STEWARD_CHANNEL: 'dev', STEWARD_INSTANCE: EXAMPLES });
  assert.match(w.stderr, /DEV BUILD dev .* is about to run "sc release-age" against .*examples/);
  const r = steward(['sc', 'soak'], { STEWARD_CHANNEL: 'dev', STEWARD_INSTANCE: EXAMPLES });
  assert.doesNotMatch(r.stderr, /DEV BUILD/);
  const sandboxed = steward(['sc', 'release-age'], { STEWARD_CHANNEL: 'dev' });
  assert.doesNotMatch(sandboxed.stderr, /DEV BUILD/, 'the examples sandbox is not a real config');
  const rel = steward(['sc', 'release-age'], { STEWARD_CHANNEL: 'release', STEWARD_INSTANCE: EXAMPLES });
  assert.doesNotMatch(rel.stderr, /DEV BUILD/);
});

test('check: a dev build holds the config to the formats the pinned release reads', () => {
  const fake = reads => {
    const d = fs.mkdtempSync(path.join(ROOT, 'release-'));
    fs.mkdirSync(path.join(d, 'lib'));
    fs.writeFileSync(path.join(d, 'lib', 'config.js'), `module.exports = { ENGINE_VERSION: '9.9.9', SCHEMA: { CURRENT: ${Math.max(...reads)}, READS: ${JSON.stringify(reads)} } };\n`);
    return d;
  };
  const ok = steward(['check'], { STEWARD_CHANNEL: 'dev', STEWARD_INSTANCE: EXAMPLES, STEWARD_RELEASE: fake([1]) });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /the pinned release \(9\.9\.9\) reads format 1/);
  const no = steward(['check'], { STEWARD_CHANNEL: 'dev', STEWARD_INSTANCE: EXAMPLES, STEWARD_RELEASE: fake([2]) });
  assert.equal(no.status, 1);
  assert.match(no.stdout, /WANTS .*pinned release \(9\.9\.9.*reads formats 2, and your config is 1/);
  const none = steward(['check'], { STEWARD_CHANNEL: 'dev', STEWARD_INSTANCE: EXAMPLES });
  assert.doesNotMatch(none.stdout, /pinned release/, 'no release checkout: nothing to answer to');
});
