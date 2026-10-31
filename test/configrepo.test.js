// lib/configrepo.js (D50): the config folder as a Git repository, read-only, on throwaway repos with a local bare
// remote. The banner never touches the network; --fetch does. No GitHub, no real config. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-configrepo-')));
/** @type {NodeJS.ProcessEnv} */
const ENV = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', XDG_STATE_HOME: path.join(ROOT, 'state'), GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig') };
delete ENV.STEWARD_CONFIG;
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, `[user]\n\tname = t\n\temail = t@e.com\n[init]\n\tdefaultBranch = main\n[url "${ROOT}/"]\n\tinsteadOf = https://github.com/o/\n`);
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, ''); // banners are coloured, as the others are
const cr = (inst, ...args) => { const r = spawnSync(process.execPath, [path.join(REPO, 'lib', 'configrepo.js'), ...args], { encoding: 'utf8', env: { ...ENV, STEWARD_INSTANCE: inst } }); return { ...r, stdout: plain(r.stdout) }; };
let k = 0;

// An instance in a repo of its own, pushed to a bare remote, and a second clone that stands in for GitHub merges
function fixture() {
  const id = ++k, remote = path.join(ROOT, `r${id}.git`), inst = path.join(ROOT, `inst${id}`), other = path.join(ROOT, `other${id}`);
  execFileSync('git', ['init', '-q', '--bare', remote], { env: ENV });
  fs.mkdirSync(path.join(inst, 'mise'), { recursive: true });
  fs.writeFileSync(path.join(inst, 'steward.toml'), '[profiles]\nai_tooling = false\nprojects = false\n');
  fs.writeFileSync(path.join(inst, 'mise', 'mise.lock'), 'lock 1\n');
  git(inst, 'init', '-q'); git(inst, 'add', '.'); git(inst, 'commit', '-qm', 'init');
  git(inst, 'remote', 'add', 'origin', remote); git(inst, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, other], { env: ENV });
  const upstream = msg => { fs.writeFileSync(path.join(other, 'steward.toml'), `# ${msg}\n[profiles]\nai_tooling = false\nprojects = false\n`); git(other, 'commit', '-qam', msg); git(other, 'push', '-q'); };
  return { remote, inst, upstream };
}

test('configrepo: in step says so and the banner stays quiet; not a repo, or inside another repo, is not a config repo', () => {
  const f = fixture();
  assert.equal(cr(f.inst, '--banner').stdout, '');
  assert.match(cr(f.inst).stdout, /^repo: .*\(main → origin\/main\)\n +in step/m);
  const loose = path.join(ROOT, 'loose');
  fs.mkdirSync(loose); fs.writeFileSync(path.join(loose, 'steward.toml'), '');
  assert.equal(cr(loose, '--banner').stdout, '');
  assert.match(cr(loose).stdout, /not a Git repository of its own, so config sync is off; docs\/config-repo\.md/);
  const inner = path.join(f.inst, 'nested');
  fs.mkdirSync(inner); fs.writeFileSync(path.join(inner, 'steward.toml'), '');
  assert.match(cr(inner).stdout, /not a Git repository of its own \(it's inside /, 'an instance inside another repo (examples/ in the engine)');
});

test('configrepo: changed files and unpushed commits show in the banner and the status, each with its git command', () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'lock 2\n');
  fs.writeFileSync(path.join(f.inst, 'new.toml'), 'x = 1\n');
  const b = cr(f.inst, '--banner').stdout;
  assert.match(b, /^config 2 file\(s\) changed here: steward config\n$/);
  const j = JSON.parse(cr(f.inst, '--json').stdout);
  assert.deepEqual(j.changed.sort(), ['mise/mise.lock', 'new.toml']);
  git(f.inst, 'add', '.'); git(f.inst, 'commit', '-qm', 'local');
  assert.match(cr(f.inst, '--banner').stdout, /^config 1 commit\(s\) not pushed: steward config\n$/);
  assert.match(cr(f.inst).stdout, /1 commit\(s\) not pushed to origin\/main\n +→ git -C .* push\n/);
});

test('configrepo: newer commits upstream show only after a fetch; the banner never fetches', () => {
  const f = fixture();
  f.upstream('Renovate: update a tool (#2)');
  assert.equal(cr(f.inst, '--banner').stdout, '', 'no fetch yet: the banner does not know');
  const fetched = cr(f.inst, '--fetch');
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.match(fetched.stdout, /1 newer commit\(s\) on origin\/main \(as of \d{4}-\d\d-\d\d \d\d:\d\d\)\n +→ steward config sync/, 'pulling works from any remote');
  assert.match(cr(f.inst, '--banner').stdout, /^config 1 newer on GitHub \(as of \d{4}-\d\d-\d\d \d\d:\d\d\): steward config sync\n$/);
  // with the remote gone the banner still answers at once from what it knew, and a fetch reports its failure
  fs.renameSync(f.remote, `${f.remote}-gone`);
  assert.match(cr(f.inst, '--banner').stdout, /1 newer on GitHub/);
  assert.match(cr(f.inst, '--fetch').stdout, /fetch failed: /);
});

test('bare steward (the briefing) and steward config show the config repo (D50)', () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'lock 2\n');
  const env = { ...ENV, STEWARD_INSTANCE: f.inst };
  const bare = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js')], { encoding: 'utf8', env });
  // bare steward is the briefing: the change, then the one next step (no GitHub remote here, so config sync is off)
  assert.match(plain(bare.stdout), /^steward config: 1 file\(s\) changed here: mise\/mise\.lock\nnext: git -C .* status$/m);
  const conf = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'config'], { encoding: 'utf8', env });
  assert.equal(conf.status, 0, conf.stderr);
  assert.match(conf.stdout, /\nrepo: +no GitHub remote \(main → origin\/main\)\n +1 file\(s\) changed here: mise\/mise\.lock\n +→ git -C /);
});

test('with a GitHub remote everything points to steward config sync; a sent PR\'s branch says it waits for a merge', () => {
  const f = fixture();
  git(f.inst, 'remote', 'set-url', 'origin', `https://github.com/o/${path.basename(f.remote)}`);
  fs.appendFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'lock 2\n');
  assert.match(cr(f.inst, '--banner').stdout, /^config 1 file\(s\) changed here: steward config sync\n$/);
  assert.match(cr(f.inst).stdout, /^repo: +o\/r\d+ \(main → origin\/main\)\n +1 file\(s\) changed here: mise\/mise\.lock\n +→ steward config sync$/m);
  git(f.inst, 'switch', '-q', '-c', 'steward/sync-20261028-2200'); git(f.inst, 'commit', '-qam', 'sent');
  assert.match(cr(f.inst, '--banner').stdout, /^config your pull request is waiting for a merge: steward config sync\n$/);
  assert.match(cr(f.inst).stdout, /sent as a pull request from steward\/sync-20261028-2200: merge it on GitHub\n +→ steward config sync/);
});

test('without a GitHub remote, steward config says config sync is off and how to turn it on', () => {
  const loose = path.join(ROOT, 'loose-remote');
  fs.mkdirSync(loose); fs.writeFileSync(path.join(loose, 'steward.toml'), '');
  git(loose, 'init', '-q'); git(loose, 'add', '.'); git(loose, 'commit', '-qm', 'init');
  assert.match(cr(loose).stdout, /repo: +no GitHub remote \(main, no upstream\)\n +config sync is off until it has one\n +→ gh repo create <you>\/steward-config --private --source .* --remote origin --push/);
});

test('configrepo: reading the state never rewrites the repo\'s index (no optional locks), so looking changes nothing', () => {
  const f = fixture();
  const index = path.join(f.inst, '.git', 'index');
  const future = new Date(Date.now() + 60e3);
  fs.utimesSync(path.join(f.inst, 'steward.toml'), future, future); // stat changed, content not: git status would refresh the index
  const before = fs.statSync(index, { bigint: true }).mtimeNs;
  assert.equal(cr(f.inst, '--banner').status, 0);
  assert.match(cr(f.inst).stdout, /in step/);
  assert.equal(fs.statSync(index, { bigint: true }).mtimeNs, before, '.git/index was rewritten');
});
