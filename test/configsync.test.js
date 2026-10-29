// lib/configsync.js, `steward config sync` (D50), both ways, on throwaway repos. origin looks like GitHub
// (https://github.com/o/<name>.git, rewritten to a local bare repo), a stand-in gh keeps its PRs in a JSON file, and a
// stand-in mise (first on PATH) records its calls, so nothing installs and nothing leaves the machine. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-configsync-')));
const BIN = path.join(ROOT, 'bin');
const PRS = path.join(ROOT, 'prs.json');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'mise'), `#!/bin/sh\necho "mise $*" >> "${path.join(ROOT, 'mise-calls')}"\n`, { mode: 0o755 });
// gh: auth status (GH_AUTH=0 fails it), pr create / list / close, against PRS; heads are read from the bare remote
fs.writeFileSync(path.join(BIN, 'gh'), `#!/usr/bin/env node
const fs = require('fs'); const { execFileSync } = require('child_process');
const a = process.argv.slice(2), opt = n => a[a.indexOf(n) + 1];
const prs = fs.existsSync(${JSON.stringify(PRS)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(PRS)}, 'utf8')) : [];
const save = () => fs.writeFileSync(${JSON.stringify(PRS)}, JSON.stringify(prs));
const bare = slug => ${JSON.stringify(ROOT)} + '/' + slug.split('/')[1] + '.git';
if (a[0] === 'auth') process.exit(process.env.GH_AUTH === '0' ? 1 : 0);
if (a[1] === 'create') {
  const n = prs.length + 1, head = opt('--head');
  const oid = execFileSync('git', ['-C', bare(opt('-R')), 'rev-parse', head], { encoding: 'utf8' }).trim();
  prs.push({ number: n, state: 'OPEN', url: 'https://github.com/' + opt('-R') + '/pull/' + n, headRefOid: oid, head, base: opt('--base'), title: opt('--title'), body: opt('--body') });
  save(); console.log(prs[n - 1].url);
} else if (a[1] === 'list') {
  console.log(JSON.stringify(prs.filter(p => p.head === opt('--head'))));
} else if (a[1] === 'close') {
  const p = prs.find(x => x.number === Number(a[2])); p.state = 'CLOSED'; save();
  if (a.includes('--delete-branch')) execFileSync('git', ['-C', bare(opt('-R')), 'branch', '-D', p.head]);
} else process.exit(2);
`, { mode: 0o755 });
/** @type {NodeJS.ProcessEnv} */
const ENV = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', XDG_STATE_HOME: path.join(ROOT, 'state'), GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'), PATH: `${BIN}:${process.env.PATH}`, STEWARD_GH: path.join(BIN, 'gh') };
delete ENV.STEWARD_CONFIG;
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, `[user]\n\tname = t\n\temail = t@e.com\n[init]\n\tdefaultBranch = main\n[url "${ROOT}/"]\n\tinsteadOf = https://github.com/o/\n`);
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const sync = (inst, args = [], input = '', env = {}) => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'lib', 'configsync.js'), ...args], { encoding: 'utf8', input, env: { ...ENV, STEWARD_INSTANCE: inst, ...env } });
  return { ...r, stdout: plain(r.stdout), stderr: plain(r.stderr) };
};
const miseCalls = () => { try { return fs.readFileSync(path.join(ROOT, 'mise-calls'), 'utf8'); } catch { return ''; } };
const prs = () => (fs.existsSync(PRS) ? JSON.parse(fs.readFileSync(PRS, 'utf8')) : []);
const setPr = (n, fields) => fs.writeFileSync(PRS, JSON.stringify(prs().map(p => (p.number === n ? { ...p, ...fields } : p))));
const receiptOf = out => (out.match(/--rollback (\S+)/) || [])[1];
let k = 0;

// An instance in a repo of its own whose origin "is on GitHub"; upstream() is a merge there, made from a second clone
function fixture() {
  const id = ++k, name = `cfg${id}`, url = `https://github.com/o/${name}.git`, inst = path.join(ROOT, `inst${id}`), other = path.join(ROOT, `other${id}`);
  execFileSync('git', ['init', '-q', '--bare', path.join(ROOT, `${name}.git`)], { env: ENV });
  fs.mkdirSync(path.join(inst, 'mise'), { recursive: true });
  fs.mkdirSync(path.join(inst, 'supply-chain'));
  fs.writeFileSync(path.join(inst, 'steward.toml'), 'schema = 1\n[profiles]\nai_tooling = false\nprojects = false\n');
  fs.writeFileSync(path.join(inst, 'mise', 'mise.lock'), 'lock 1\n');
  fs.writeFileSync(path.join(inst, 'supply-chain', 'host.toml'), 'always_current = []\n');
  fs.writeFileSync(path.join(inst, 'notes.md'), 'notes\n');
  git(inst, 'init', '-q'); git(inst, 'add', '.'); git(inst, 'commit', '-qm', 'init');
  git(inst, 'remote', 'add', 'origin', url); git(inst, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', url, other], { env: ENV });
  const upstream = (file, text, msg) => { git(other, 'pull', '-q', '--ff-only'); fs.writeFileSync(path.join(other, file), text); git(other, 'commit', '-qam', msg); git(other, 'push', '-q'); };
  // squash-merge a PR branch on "GitHub", deleting the branch, as `gh pr merge --squash --delete-branch` would
  const merge = branch => { git(other, 'fetch', '-q'); git(other, 'pull', '-q', '--ff-only'); git(other, 'merge', '-q', '--squash', `origin/${branch}`); git(other, 'commit', '-qm', 'squash'); git(other, 'push', '-q'); git(other, 'push', '-q', 'origin', '--delete', branch); };
  return { inst, upstream, merge, head: () => git(inst, 'rev-parse', 'HEAD'), branch: () => git(inst, 'symbolic-ref', '--short', 'HEAD'), origin: () => git(inst, 'rev-parse', 'origin/main') };
}

test('pull: the plan lists the commits, their files and what follows; nothing changes', () => {
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

test('pull --apply: fast-forwards after a yes, writes a receipt, runs mise install when asked, then steward check', () => {
  const f = fixture();
  f.upstream('mise/mise.lock', 'lock 2\n', 'chore(deps): update a tool (#2)');
  const r = sync(f.inst, ['--apply'], 'y\ny\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.head(), f.origin());
  assert.match(miseCalls(), /^mise install$/m);
  assert.match(r.stdout, /==> steward check\n/);
  const rc = JSON.parse(fs.readFileSync(receiptOf(r.stdout), 'utf8'));
  assert.equal(rc.kind, 'config-sync'); assert.equal(rc.complete, true); assert.equal(rc.after, f.head());
  const changes = fs.readdirSync(path.join(ROOT, 'state', 'workstation-steward', 'changes'));
  assert.ok(changes.some(c => c.endsWith('-config-sync.json')), 'mise install starts the soak through a change receipt');
});

test('pull --apply: a no keeps everything; declining mise install skips it', () => {
  const f = fixture();
  f.upstream('mise/mise.lock', 'lock 2\n', 'up');
  const before = f.head(), calls = miseCalls();
  assert.match(sync(f.inst, ['--apply'], 'n\n').stdout, /nothing changed/);
  assert.equal(f.head(), before);
  const r = sync(f.inst, ['--apply'], 'y\nn\n');
  assert.equal(f.head(), f.origin());
  assert.match(r.stdout, /later: mise install/);
  assert.equal(miseCalls(), calls, 'mise was not run');
});

test('refuses an edit in the way, a diverged branch, no upstream, and a folder that is not a repo', () => {
  const f = fixture();
  f.upstream('mise/mise.lock', 'lock 2\n', 'up');
  fs.writeFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'mine\n');
  const before = f.head();
  const inWay = sync(f.inst, ['--apply'], 'y\n');
  assert.equal(inWay.status, 2);
  assert.match(inWay.stdout, /not syncing: your edits to mise\/mise\.lock are in the way of the pull/);
  assert.equal(f.head(), before);
  git(f.inst, 'commit', '-qam', 'mine');
  const div = sync(f.inst, ['--apply'], 'y\n');
  assert.equal(div.status, 1);
  assert.match(div.stderr, /have diverged \(1 commit\(s\) here, 1 there\)\. The steward never merges or rebases/);
  git(f.inst, 'branch', '--unset-upstream');
  assert.match(sync(f.inst).stderr, /main has no upstream to follow: git -C .* push -u origin main/);
});

test('a leftover REBASE_HEAD does not block a pull; a rebase that is running does', () => {
  const f = fixture();
  f.upstream('notes.md', 'notes 2\n', 'up');
  fs.writeFileSync(path.join(f.inst, '.git', 'REBASE_HEAD'), `${f.head()}\n`);
  const stale = sync(f.inst);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /pull +1 commit\(s\)/);
  fs.mkdirSync(path.join(f.inst, '.git', 'rebase-apply'));
  const real = sync(f.inst);
  assert.equal(real.status, 1);
  assert.match(real.stderr, /a rebase is in progress: finish or abort it first/);
});

test('config sync is off, with the steps, when the config is not a repo, has no remote, or sits inside another repo', () => {
  const loose = path.join(ROOT, 'loose');
  fs.mkdirSync(loose); fs.writeFileSync(path.join(loose, 'steward.toml'), '');
  const notRepo = sync(loose, ['--apply'], 'y\n');
  assert.equal(notRepo.status, 3);
  assert.match(notRepo.stderr, /^config sync is off: your config \(.*loose\) isn't a Git repository yet\.\nTo turn it on \(docs\/config-repo\.md\):\n {2}cd .*\n {2}git init -b main && git add -A && git commit -m 'My steward config'\n {2}gh repo create <you>\/steward-config --private --source \. --remote origin --push\n$/);
  git(loose, 'init', '-q'); git(loose, 'add', '.'); git(loose, 'commit', '-qm', 'init');
  const noRemote = sync(loose);
  assert.equal(noRemote.status, 3);
  assert.match(noRemote.stderr, /config sync is off: your config is a Git repository with no GitHub remote\.\n.*\n {2}gh repo create <you>\/steward-config --private --source .*loose --remote origin --push/);
  const inner = path.join(loose, 'inner');
  fs.mkdirSync(inner); fs.writeFileSync(path.join(inner, 'steward.toml'), '');
  assert.match(sync(inner).stderr, /config sync is off: your config \(.*inner\) is inside another Git repository/);
  assert.equal(git(loose, 'status', '--porcelain'), '?? inner/', 'nothing changed');
});

test('pull --rollback: moves the branch back after a yes, once; refuses when it moved since', () => {
  const f = fixture();
  f.upstream('notes.md', 'upstream notes\n', 'docs: notes (#3)');
  const before = f.head();
  const rp = receiptOf(sync(f.inst, ['--apply'], 'y\n').stdout);
  const back = sync(f.inst, ['--rollback', rp], 'y\n');
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, /stepping back over:\n +\w{7} docs: notes \(#3\)/);
  assert.equal(f.head(), before);
  assert.match(sync(f.inst, ['--rollback', rp], 'y\n').stderr, /already rolled back/);
  const rp2 = receiptOf(sync(f.inst, ['--apply'], 'y\n').stdout);
  fs.appendFileSync(path.join(f.inst, 'notes.md'), 'x\n'); git(f.inst, 'commit', '-qam', 'later');
  assert.match(sync(f.inst, ['--rollback', rp2], 'y\n').stderr, /main moved since the sync/);
});

test('send: the plan lists every local file with the steward command behind it; nothing changes', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'lock 2\n');
  fs.writeFileSync(path.join(f.inst, 'supply-chain', 'host.toml'), 'always_current = ["x"]\n');
  const d = path.join(ROOT, 'state', 'workstation-steward', 'changes');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '29990101T000000Z-upgrade.json'), JSON.stringify({ kind: 'upgrade', what: 'gh@2.103.2', at: '2999-01-01T00:00:00Z' }));
  const r = sync(f.inst);
  fs.rmSync(path.join(d, '29990101T000000Z-upgrade.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /send +2 file\(s\) as a PR to o\/cfg\d+, on a new steward\/sync-<time> branch:/);
  assert.match(r.stdout, /mise\/mise\.lock +steward sc upgrade gh@2\.103\.2/);
  assert.match(r.stdout, /supply-chain\/host\.toml +an edit on this Mac/);
  assert.match(r.stdout, /this Mac stays on that branch until you merge the PR/);
  assert.equal(f.branch(), 'main');
  assert.equal(prs().length, 0);
});

test('send --apply: everything local goes on a new branch with a PR; main matches GitHub; this Mac stays on the branch', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'committed here\n'); git(f.inst, 'commit', '-qam', 'docs: a local commit');
  fs.writeFileSync(path.join(f.inst, 'supply-chain', 'host.toml'), 'always_current = ["x"]\n');
  fs.writeFileSync(path.join(f.inst, 'new.toml'), 'x = 1\n');
  const r = sync(f.inst, ['--apply'], 'y\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /==> sent as PR #\d+: https:\/\/github\.com\/o\/cfg\d+\/pull\/\d+/);
  assert.match(f.branch(), /^steward\/sync-\d{8}-\d{4}$/);
  assert.equal(git(f.inst, 'status', '--porcelain'), '', 'everything is committed on the branch');
  assert.equal(git(f.inst, 'rev-parse', 'main'), f.origin(), 'main matches GitHub again');
  const [pr] = prs().slice(-1);
  assert.equal(pr.base, 'main'); assert.equal(pr.state, 'OPEN');
  assert.match(pr.title, /^chore\(config\): changes from /);
  assert.match(pr.body, /`supply-chain\/host\.toml` \| an edit on this Mac/);
  assert.match(pr.body, /`new\.toml`/);
  assert.match(pr.body, /- \w{7} docs: a local commit/);
  assert.equal(git(f.inst, 'show', `${pr.head}:new.toml`), 'x = 1');
  const rc = JSON.parse(fs.readFileSync(receiptOf(r.stdout), 'utf8'));
  assert.equal(rc.kind, 'config-sync-send'); assert.equal(rc.complete, true); assert.equal(rc.pr.number, pr.number);
});

test('send: while the PR is open it waits, and new edits go onto the same PR', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'one\n');
  sync(f.inst, ['--apply'], 'y\n');
  const n = prs().length;
  assert.match(sync(f.inst).stdout, /waiting for you to merge PR #\d+: https:/);
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'two\n');
  assert.match(sync(f.inst).stdout, /add +1 file\(s\) to PR #\d+: notes\.md/);
  const r = sync(f.inst, ['--apply'], 'y\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /==> added to PR #\d+/);
  assert.equal(prs().length, n, 'no second PR');
  assert.equal(git(f.inst, 'rev-parse', 'HEAD'), git(f.inst, 'rev-parse', `origin/${f.branch()}`), 'pushed');
});

test('send: after the merge, sync switches back to main, fast-forwards and deletes the branch; not if commits came after', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'lock from here\n');
  sync(f.inst, ['--apply'], 'y\n');
  const branch = f.branch(), [pr] = prs().slice(-1);
  f.merge(branch); setPr(pr.number, { state: 'MERGED' });
  // a commit made after the PR's head would be lost: refuse
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'late\n'); git(f.inst, 'commit', '-qam', 'late');
  assert.match(sync(f.inst, ['--apply'], 'y\n').stderr, /merged, but steward\/sync-\S+ has commits made after it/);
  git(f.inst, 'reset', '-q', '--hard', 'HEAD~1');
  const plan = sync(f.inst);
  assert.match(plan.stdout, /finish +PR #\d+ is merged: switch to main, fast-forward 1 commit\(s\), delete steward\/sync-\S+/);
  const calls = miseCalls();
  const r = sync(f.inst, ['--apply'], 'y\ny\ny\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(miseCalls(), calls, 'its own change was already in use here: no mise install');
  assert.equal(f.branch(), 'main');
  assert.equal(f.head(), f.origin());
  assert.equal(git(f.inst, 'branch', '--list', branch), '', 'the local branch is gone');
  assert.equal(fs.readFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'utf8'), 'lock from here\n');
  assert.match(r.stdout, /==> steward check/);
});

test('send --rollback: closes the open PR and puts this Mac back exactly as before; a closed PR says how', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'committed\n'); git(f.inst, 'commit', '-qam', 'local commit');
  const origHead = f.head();
  fs.writeFileSync(path.join(f.inst, 'supply-chain', 'host.toml'), 'edited\n');
  fs.writeFileSync(path.join(f.inst, 'untracked.toml'), 'u\n');
  const rp = receiptOf(sync(f.inst, ['--apply'], 'y\n').stdout);
  const branch = f.branch(), [pr] = prs().slice(-1);
  const back = sync(f.inst, ['--rollback', rp], 'y\n');
  assert.equal(back.status, 0, back.stderr);
  assert.equal(prs().find(p => p.number === pr.number).state, 'CLOSED');
  assert.equal(f.branch(), 'main');
  assert.equal(f.head(), origHead, 'the local commit is back on main');
  const st = git(f.inst, 'status', '--porcelain', '--untracked-files=all');
  assert.match(st, /^ ?M supply-chain\/host\.toml$/m, 'the edit is uncommitted again');
  assert.match(st, /^\?\? untracked\.toml$/m, 'the new file is untracked again');
  assert.equal(git(f.inst, 'branch', '--list', branch), '');
  // a PR closed on GitHub, not by us: sync says what to do
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'again\n');
  sync(f.inst, ['--apply'], 'y\n');
  setPr(prs().slice(-1)[0].number, { state: 'CLOSED' });
  assert.match(sync(f.inst).stderr, /was closed without merging\. To put this Mac back as before the send: steward config sync --rollback/);
});

test('send needs a GitHub remote and a gh login; pulling needs neither', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'x\n');
  assert.match(sync(f.inst, ['--apply'], 'y\n', { GH_AUTH: '0' }).stderr, /sending needs the GitHub CLI, logged in: gh auth login/);
  assert.equal(f.branch(), 'main');
  git(f.inst, 'remote', 'set-url', 'origin', path.join(ROOT, 'cfg-elsewhere.git'));
  assert.match(sync(f.inst, ['--apply', '--no-fetch'], 'y\n').stderr, /sending goes as a GitHub pull request, and origin is .*: only pulling works here/);
});

test('up to date with nothing local says so; steward config sync and steward config both route (D50)', () => {
  const f = fixture();
  assert.match(sync(f.inst).stdout, /up to date with origin\/main; nothing to send/);
  f.upstream('notes.md', 'n2\n', 'up');
  const env = { ...ENV, STEWARD_INSTANCE: f.inst };
  const s = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'config', 'sync'], { encoding: 'utf8', env });
  assert.equal(s.status, 0, s.stderr);
  assert.match(plain(s.stdout), /pull +1 commit\(s\)/);
  const c = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'config'], { encoding: 'utf8', env });
  assert.match(plain(c.stdout), /^instance: /m);
});
