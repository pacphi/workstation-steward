// lib/hooktimeouts.js and ai-tooling/bin/timeouts.js on throwaway repos: millisecond hook timeouts become seconds, nothing
// else changes, tracked and oddly formatted files are skipped, and a receipt rolls it back. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const H = require('../lib/hooktimeouts.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-timeouts-')));
const PROJECTS = path.join(ROOT, 'projects');
const CLAUDE = path.join(ROOT, 'claude');
fs.mkdirSync(PROJECTS); fs.mkdirSync(CLAUDE);
fs.writeFileSync(path.join(ROOT, 'steward.toml'), `[projects]\nroots = ["${PROJECTS}"]\nexclude = []\n[paths]\nstate = "${path.join(ROOT, 'state')}"\nclaude_dir = "${CLAUDE}"\n`);
const ENV = { ...process.env, STEWARD_CONFIG: path.join(ROOT, 'steward.toml'), XDG_STATE_HOME: path.join(ROOT, 'xstate'), GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'), NO_PROGRESS: '1' };
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const run = (args, input = '') => spawnSync(process.execPath, [path.join(__dirname, '..', 'ai-tooling', 'bin', 'timeouts.js'), ...args], { encoding: 'utf8', env: ENV, input });

const settings = () => ({
  mcp: { timeout: 5000 }, // not a hook: must stay
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a', timeout: 5000 }, { type: 'command', command: 'b', timeout: 30 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'c', timeout: 60000 }, { type: 'command', command: 'd', timeout: 6000 }] }],
  },
});
function project(name, { track = false, text = null } = {}) {
  const dir = path.join(PROJECTS, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't');
  const f = path.join(dir, '.claude', 'settings.json');
  fs.writeFileSync(f, text === null ? JSON.stringify(settings(), null, 2) + '\n' : text);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
  if (track) { git(dir, 'add', '.claude/settings.json'); git(dir, 'commit', '-qm', 'x'); }
  return f;
}
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('find and fixed: only millisecond hook timeouts, rounded up; the rest is untouched', () => {
  const s = settings();
  assert.deepEqual(H.find(s).map(h => h.value).sort((a, b) => a - b), [5000, 6000, 60000]);
  const n = H.fixed(s);
  assert.equal(n.hooks.PreToolUse[0].hooks[0].timeout, 5);
  assert.equal(n.hooks.PreToolUse[0].hooks[1].timeout, 30);
  assert.equal(n.hooks.Stop[0].hooks[0].timeout, 60);
  assert.equal(n.hooks.Stop[0].hooks[1].timeout, 6);
  assert.equal(n.mcp.timeout, 5000);
  assert.deepEqual(H.find({ hooks: { X: [{ hooks: [{ timeout: 999 }, { timeout: 1500 }] }] } }).map(h => h.value), [1500]);
  assert.equal(H.fixed({ hooks: { X: [{ hooks: [{ timeout: 1500 }] }] } }).hooks.X[0].hooks[0].timeout, 2);
});

test('serialize: null when a rewrite would reformat more than the timeouts', () => {
  const compact = JSON.stringify(settings());
  assert.equal(H.serialize(compact + '\n', H.fixed(settings()), settings()), null); // compact JSON has no indent: a rewrite would reformat it
  assert.equal(H.serialize('{"a":1,\n  "b":2}\n', { a: 1, b: 2 }, { a: 1, b: 2 }), null);
});

test('timeouts: plan lists an untracked file, skips tracked and oddly formatted ones, and changes nothing', () => {
  const ok = project('plain');
  const tracked = project('tracked', { track: true });
  const odd = project('odd', { text: '{ "hooks": {"Stop": [{"hooks": [{"timeout": 5000}]}]} }\n' });
  const before = fs.readFileSync(ok, 'utf8');
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /apply .*plain\/\.claude\/settings\.json +3 timeout/);
  assert.match(out, /SKIP .*tracked\/\.claude\/settings\.json.*tracked by Git/);
  assert.match(out, /SKIP .*odd\/\.claude\/settings\.json.*reformatted/);
  assert.equal(fs.readFileSync(ok, 'utf8'), before);
  assert.deepEqual(read(tracked), settings());
  assert.ok(odd);
});

test('timeouts --apply: "n" changes nothing; "y" fixes only the timeouts, backs up, writes a receipt, and rolls back', () => {
  for (const d of fs.readdirSync(PROJECTS)) fs.rmSync(path.join(PROJECTS, d), { recursive: true, force: true });
  const f = project('plain');
  const user = path.join(CLAUDE, 'settings.json');
  fs.writeFileSync(user, JSON.stringify(settings(), null, 2) + '\n');
  const orig = fs.readFileSync(f, 'utf8');
  assert.equal(run(['--apply'], 'n\n').status, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), orig);

  const done = run(['--apply'], 'y\n');
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const after = read(f);
  assert.deepEqual(after, H.fixed(settings()));
  assert.equal(after.mcp.timeout, 5000);
  assert.deepEqual(read(user), H.fixed(settings()));
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').length, orig.split('\n').length, 'same number of lines');
  assert.equal(run([]).stdout.includes('no hook timeouts in milliseconds'), true);

  const bk = path.join(ENV.XDG_STATE_HOME, '..', 'state', 'backups');
  const dir = fs.readdirSync(bk).find(d => d.startsWith('timeouts-'));
  assert.ok(dir, 'receipt folder');
  const receipt = path.join(bk, dir, 'receipt.json');
  const rc = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(rc.kind, 'timeouts');
  assert.equal(rc.files.length, 2);

  const back = spawnSync(process.execPath, [path.join(__dirname, '..', 'ai-tooling', 'bin', 'timeouts.js'), '--rollback', receipt], { encoding: 'utf8', env: ENV, input: 'y\n' });
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), orig);
});

test('timeouts --rollback refuses when a file changed since', () => {
  for (const d of fs.readdirSync(PROJECTS)) fs.rmSync(path.join(PROJECTS, d), { recursive: true, force: true });
  fs.rmSync(path.join(CLAUDE, 'settings.json'), { force: true });
  const f = project('plain');
  const ap = run(['--apply'], 'y\n');
  assert.equal(ap.status, 0, ap.stdout + ap.stderr);
  const edited = fs.readFileSync(f, 'utf8').replace(/"timeout": 5\b/, '"timeout": 7');
  assert.notEqual(edited, fs.readFileSync(f, 'utf8'), 'the test edit must change the file');
  fs.writeFileSync(f, edited);
  const bk = path.join(ENV.XDG_STATE_HOME, '..', 'state', 'backups');
  const dirs = fs.readdirSync(bk).filter(d => d.startsWith('timeouts-')).sort();
  const r = run(['--rollback', path.join(bk, dirs[dirs.length - 1], 'receipt.json')], 'y\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing/);
});
