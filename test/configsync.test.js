// lib/configsync.js, `steward config sync` (D50): the pull side, on throwaway repos with a local bare remote. A stand-in
// mise (first on PATH) records its calls, so nothing installs; state goes to a temporary folder. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-configsync-')));
const BIN = path.join(ROOT, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'mise'), `#!/bin/sh\necho "mise $*" >> "${path.join(ROOT, 'mise-calls')}"\n`, { mode: 0o755 });
/** @type {NodeJS.ProcessEnv} */
const ENV = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', XDG_STATE_HOME: path.join(ROOT, 'state'), GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'), PATH: `${BIN}:${process.env.PATH}` };
delete ENV.STEWARD_CONFIG;
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@e.com\n[init]\n\tdefaultBranch = main\n');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const sync = (inst, args = [], input = '', env = {}) => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'lib', 'configsync.js'), ...args], { encoding: 'utf8', input, env: { ...ENV, STEWARD_INSTANCE: inst, ...env } });
  return { ...r, stdout: plain(r.stdout), stderr: plain(r.stderr) };
};
const miseCalls = () => { try { return fs.readFileSync(path.join(ROOT, 'mise-calls'), 'utf8'); } catch { return ''; } };
let k = 0;

// An instance in a repo of its own, pushed to a bare remote; upstream(file, text, msg) is a merge on "GitHub"
function fixture() {
  const id = ++k, remote = path.join(ROOT, `r${id}.git`), inst = path.join(ROOT, `inst${id}`), other = path.join(ROOT, `other${id}`);
  execFileSync('git', ['init', '-q', '--bare', remote], { env: ENV });
  fs.mkdirSync(path.join(inst, 'mise'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'steward.toml'), 'schema = 1\n[profiles]\nai_tooling = false\nprojects = false\n');
  fs.writeFileSync(path.join(inst, 'mise', 'mise.lock'), 'lock 1\n');
  fs.writeFileSync(path.join(inst, 'notes.md'), 'notes\n');
  git(inst, 'init', '-q'); git(inst, 'add', '.'); git(inst, 'commit', '-qm', 'init');
  git(inst, 'remote', 'add', 'origin', remote); git(inst, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, other], { env: ENV });
  const upstream = (file, text, msg) => { fs.writeFileSync(path.join(other, file), text); git(other, 'commit', '-qam', msg); git(other, 'push', '-q'); };
  return { inst, upstream, head: () => git(inst, 'rev-parse', 'HEAD'), remoteHead: () => git(other, 'rev-parse', 'HEAD') };
}

test('config sync: the plan lists the commits, their files and what follows; nothing changes', () => {
  const f = fixture();
  f.upstream('mise/mise.lock', 'lock 2\n', 'chore(deps): update a tool (#2)');
  const before = f.head();
  const r = sync(f.inst);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pull +1 commit\(s\):\n +\w{7} chore\(deps\): update a tool \(#2\)\n +files +mise\/mise\.lock\n +then +mise install \(mise\/ changed; asks\), steward check\n\nplan only/);
  assert.equal(f.head(), before);
  assert.match(sync(f.inst, ['--apply'], '', { DRY_RUN: '1' }).stdout, /plan only/, 'DRY_RUN=1 stops at the plan');
  assert.equal(f.head(), before);
});

test('config sync --apply: fast-forwards after a yes, writes a receipt, runs mise install when asked, then steward check', () => {
  const f = fixture();
  f.upstream('mise/mise.lock', 'lock 2\n', 'chore(deps): update a tool (#2)');
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'my notes\n'); // a local edit GitHub doesn't touch stays
  const r = sync(f.inst, ['--apply'], 'y\ny\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.head(), f.remoteHead());
  assert.equal(fs.readFileSync(path.join(f.inst, 'notes.md'), 'utf8'), 'my notes\n');
  assert.match(r.stdout, /stays +1 local edit\(s\) GitHub doesn't touch/);
  assert.match(miseCalls(), /^mise install$/m);
  assert.match(r.stdout, /==> steward check\n/);
  const rp = (r.stdout.match(/rollback: steward config sync --rollback (\S+)/) || [])[1];
  const rc = JSON.parse(fs.readFileSync(rp.replace(/^~/, os.homedir()), 'utf8'));
  assert.equal(rc.kind, 'config-sync'); assert.equal(rc.complete, true); assert.equal(rc.after, f.head());
  const changes = fs.readdirSync(path.join(ROOT, 'state', 'workstation-steward', 'changes'));
  assert.ok(changes.some(c => c.endsWith('-config-sync.json')), 'mise install starts the soak through a change receipt');
});

test('config sync --apply: a no keeps everything; declining mise install skips it', () => {
  const f = fixture();
  f.upstream('mise/mise.lock', 'lock 2\n', 'up');
  const before = f.head(), calls = miseCalls();
  assert.match(sync(f.inst, ['--apply'], 'n\n').stdout, /nothing changed/);
  assert.equal(f.head(), before);
  const r = sync(f.inst, ['--apply'], 'y\nn\n');
  assert.equal(f.head(), f.remoteHead());
  assert.match(r.stdout, /later: mise install/);
  assert.equal(miseCalls(), calls, 'mise was not run');
});

test('config sync: refuses an edit in the way, a diverged branch, no upstream, and a folder that is not a repo', () => {
  const f = fixture();
  f.upstream('mise/mise.lock', 'lock 2\n', 'up');
  fs.writeFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'mine\n');
  const before = f.head();
  const inWay = sync(f.inst, ['--apply'], 'y\n');
  assert.equal(inWay.status, 2);
  assert.match(inWay.stdout, /not syncing: your edits to mise\/mise\.lock are in the way/);
  assert.equal(f.head(), before);
  git(f.inst, 'commit', '-qam', 'mine');
  const div = sync(f.inst, ['--apply'], 'y\n');
  assert.equal(div.status, 1);
  assert.match(div.stderr, /have diverged \(1 commit\(s\) here, 1 there\)\. The steward never merges or rebases/);
  git(f.inst, 'branch', '--unset-upstream');
  assert.match(sync(f.inst).stderr, /main has no upstream to follow: git -C .* push -u origin main/);
  const loose = path.join(ROOT, 'loose');
  fs.mkdirSync(loose); fs.writeFileSync(path.join(loose, 'steward.toml'), '');
  assert.match(sync(loose).stderr, /is not a Git repository of its own: docs\/config-repo\.md/);
});

test('config sync: up to date says so, with what is unpushed or changed here', () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.inst, 'notes.md'), 'more\n');
  git(f.inst, 'commit', '-qam', 'local');
  const r = sync(f.inst);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /up to date with origin\/main\n +1 commit\(s\) here not pushed: git -C .* push/);
});

test('config sync --rollback: moves the branch back after a yes, once; refuses when it moved since', () => {
  const f = fixture();
  f.upstream('notes.md', 'upstream notes\n', 'docs: notes (#3)');
  const before = f.head();
  const rp = (sync(f.inst, ['--apply'], 'y\n').stdout.match(/--rollback (\S+)/) || [])[1].replace(/^~/, os.homedir());
  const back = sync(f.inst, ['--rollback', rp], 'y\n');
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, /stepping back over:\n +\w{7} docs: notes \(#3\)/);
  assert.equal(f.head(), before);
  assert.match(sync(f.inst, ['--rollback', rp], 'y\n').stderr, /already rolled back/);
  // sync again, then a local commit: rolling back would lose it, so it refuses
  const rp2 = (sync(f.inst, ['--apply'], 'y\n').stdout.match(/--rollback (\S+)/) || [])[1].replace(/^~/, os.homedir());
  fs.appendFileSync(path.join(f.inst, 'notes.md'), 'x\n'); git(f.inst, 'commit', '-qam', 'later');
  assert.match(sync(f.inst, ['--rollback', rp2], 'y\n').stderr, /main moved since the sync/);
});

test('steward config sync runs the sync, and steward config still shows the config (D50)', () => {
  const f = fixture();
  f.upstream('notes.md', 'n2\n', 'up');
  const env = { ...ENV, STEWARD_INSTANCE: f.inst };
  const s = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'config', 'sync'], { encoding: 'utf8', env });
  assert.equal(s.status, 0, s.stderr);
  assert.match(plain(s.stdout), /pull +1 commit\(s\)/);
  const c = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'config'], { encoding: 'utf8', env });
  assert.match(plain(c.stdout), /^instance: /m);
});
