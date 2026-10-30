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

test('send: the plan says which local files are new and which are deleted, so a stray file stands out', () => {
  const f = fixture();
  fs.rmSync(path.join(f.inst, 'notes.md'));
  fs.writeFileSync(path.join(f.inst, 'mise', 'config.toml.bak-1'), 'a backup\n');
  const r = sync(f.inst);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /notes\.md +deleted on this Mac/);
  assert.match(r.stdout, /mise\/config\.toml\.bak-1 +new on this Mac/);
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

// Edits git can combine (2026-10-29): an upgrade's pin edit on one line of mise/config.toml, a Renovate merge on
// another, used to stop the pull and the send; finishing a merged send stopped on an edit made after it.
const LINES = Array.from({ length: 12 }, (_, i) => `tool${i + 1} = "1.0.0"`);
const text = (changes = {}) => `${LINES.map((l, i) => changes[i + 1] || l).join('\n')}\n`;
// seed(f) — a 12-line mise/config.toml, committed and pushed, so edits can sit on lines apart
const seed = f => { fs.writeFileSync(path.join(f.inst, 'mise', 'config.toml'), text()); git(f.inst, 'add', '.'); git(f.inst, 'commit', '-qm', 'seed'); git(f.inst, 'push', '-q'); };
const CFG = f => path.join(f.inst, 'mise', 'config.toml');
// snapshot(f) — everything a refusal must leave as it was (after the fetch a sync makes): HEAD, branches, status,
// the edited files' bytes, the stash
const snapshot = f => (git(f.inst, 'fetch', '-q', '--prune'), { head: f.head(), branches: git(f.inst, 'branch', '-a', '-v', '--no-abbrev'), status: git(f.inst, 'status', '--porcelain', '--untracked-files=all'), cfg: fs.readFileSync(CFG(f), 'utf8'), lock: fs.readFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'utf8'), stash: git(f.inst, 'stash', 'list') });

test('pull: an edit on other lines of a file the pull changes is set aside and put back; the send then takes it', () => {
  const f = fixture();
  seed(f);
  f.upstream('mise/config.toml', text({ 3: 'tool3 = "1.1.0"' }), 'chore(deps): update tool3 (#4)');
  fs.writeFileSync(CFG(f), text({ 9: 'tool9 = "2.0.0"' }));
  const before = f.head();
  const plan = sync(f.inst);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, /keeps +your edits to mise\/config\.toml are set aside and put back \(git combines them with the pull\)/);
  assert.match(plan.stdout, /send +1 file\(s\)/);
  assert.equal(f.head(), before, 'the plan changes nothing');
  const r = sync(f.inst, ['--apply'], 'y\nn\nn\n'); // pull yes, mise install no, send no
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.head(), f.origin());
  assert.equal(fs.readFileSync(CFG(f), 'utf8'), text({ 3: 'tool3 = "1.1.0"', 9: 'tool9 = "2.0.0"' }), 'both changes, the edit still uncommitted');
  assert.equal(git(f.inst, 'status', '--porcelain'), 'M mise/config.toml');
  assert.equal(git(f.inst, 'stash', 'list'), '', 'nothing left in the stash');
  assert.match(r.stdout, /your edits to mise\/config\.toml: set aside and put back \(a copy: /);
  const rc = JSON.parse(fs.readFileSync(receiptOf(r.stdout), 'utf8'));
  assert.equal(rc.complete, true);
  assert.deepEqual(rc.carried.files, ['mise/config.toml']);
  assert.equal(fs.readFileSync(path.join(rc.carried.copies, 'mise', 'config.toml'), 'utf8'), text({ 9: 'tool9 = "2.0.0"' }), 'a copy of the edit as it was');
  assert.ok(!rc.carried.copies.startsWith(f.inst), 'the copy is outside the checkout');
  const send = sync(f.inst, ['--apply'], 'y\n');
  assert.equal(send.status, 0, send.stderr);
  assert.match(send.stdout, /==> sent as PR/);
});

test('pull: edits on the same lines as the pull, or staged, are refused and nothing changes', () => {
  const f = fixture();
  seed(f);
  f.upstream('mise/config.toml', text({ 3: 'tool3 = "1.1.0"' }), 'up');
  fs.writeFileSync(CFG(f), text({ 3: 'tool3 = "9.9.9"' }));
  const was = snapshot(f);
  const r = sync(f.inst, ['--apply'], 'y\ny\ny\n');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /not syncing: your edits to mise\/config\.toml are in the way of the pull \(both change the same lines of mise\/config\.toml\)/);
  assert.deepEqual(snapshot(f), was);
  fs.writeFileSync(CFG(f), text({ 9: 'tool9 = "2.0.0"' })); git(f.inst, 'add', 'mise/config.toml');
  const staged = sync(f.inst);
  assert.equal(staged.status, 2);
  assert.match(staged.stdout, /in the way of the pull \(mise\/config\.toml is staged \(git add\), which the steward doesn't set aside: git -C .* restore --staged mise\/config\.toml\)/);
});

test('pull: when the edits do not go back cleanly after all, the pull is undone and the checkout is byte for byte as before', () => {
  const f = fixture();
  seed(f);
  f.upstream('mise/config.toml', text({ 3: 'tool3 = "1.1.0"' }), 'up');
  fs.writeFileSync(CFG(f), text({ 9: 'tool9 = "2.0.0"' }));
  fs.writeFileSync(path.join(f.inst, 'notes.md'), 'an edit the pull does not touch\n');
  fs.writeFileSync(path.join(f.inst, 'supply-chain', 'host.toml'), 'mine to stash\n'); git(f.inst, 'stash', 'push', '-q', '-m', 'a stash of yours', '--', 'supply-chain'); // stays yours
  // the plan's check (git merge-file) says the edit combines; a -merge attribute makes git stash pop conflict anyway,
  // the one way to reach the put-back-and-refuse path
  fs.writeFileSync(path.join(f.inst, '.git', 'info', 'attributes'), 'mise/config.toml -merge\n');
  const was = snapshot(f);
  assert.match(sync(f.inst).stdout, /keeps +your edits to mise\/config\.toml are set aside and put back/);
  const r = sync(f.inst, ['--apply'], 'y\ny\ny\n');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /not syncing: your edits to mise\/config\.toml are in the way of the pull \(they did not go back cleanly\)/);
  assert.deepEqual(snapshot(f), was, 'HEAD, status, files and your own stash as they were');
  assert.equal(fs.readFileSync(path.join(f.inst, 'notes.md'), 'utf8'), 'an edit the pull does not touch\n');
  const rp = fs.readdirSync(path.join(ROOT, 'state', 'workstation-steward', 'backups')).filter(d => d.startsWith('config-sync-2')).sort().pop();
  const rc = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'workstation-steward', 'backups', rp, 'receipt.json'), 'utf8'));
  assert.equal(rc.complete, false);
  assert.match(rc.restored, /nothing changed/);
  assert.match(sync(f.inst, ['--rollback', path.join(ROOT, 'state', 'workstation-steward', 'backups', rp, 'receipt.json')]).stderr, /not a config sync receipt/);
});

test('pull --rollback: a pull that carried an edit moves back with the edit as it was before the pull', () => {
  const f = fixture();
  seed(f);
  f.upstream('mise/config.toml', text({ 3: 'tool3 = "1.1.0"' }), 'chore(deps): update tool3 (#5)');
  fs.writeFileSync(CFG(f), text({ 9: 'tool9 = "2.0.0"' }));
  const before = f.head();
  const rp = receiptOf(sync(f.inst, ['--apply'], 'y\nn\nn\n').stdout);
  assert.equal(f.head(), f.origin());
  const plan = sync(f.inst, ['--rollback', rp], 'n\n');
  assert.match(plan.stdout, /your edits to mise\/config\.toml are set aside and put back/);
  assert.equal(f.head(), f.origin(), 'a no changes nothing');
  const back = sync(f.inst, ['--rollback', rp], 'y\nn\n');
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(f.head(), before);
  assert.equal(fs.readFileSync(CFG(f), 'utf8'), text({ 9: 'tool9 = "2.0.0"' }));
  assert.equal(git(f.inst, 'status', '--porcelain'), 'M mise/config.toml');
  assert.equal(git(f.inst, 'stash', 'list'), '');
  assert.ok(JSON.parse(fs.readFileSync(rp, 'utf8')).rolled_back);
});

// sendAndMerge(f) — send the line-2 edit, squash-merge its PR on "GitHub"; returns the send branch
function sendAndMerge(f) {
  seed(f);
  fs.writeFileSync(CFG(f), text({ 2: 'tool2 = "1.2.0"' }));
  fs.writeFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'lock from the send\n');
  assert.equal(sync(f.inst, ['--apply'], 'y\n').status, 0);
  const branch = f.branch(), [pr] = prs().slice(-1);
  f.merge(branch); setPr(pr.number, { state: 'MERGED' });
  return branch;
}

test('send: finishing a merged send carries an edit made since to a file the send changed (main was one commit behind)', () => {
  const f = fixture();
  const branch = sendAndMerge(f);
  fs.writeFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'lock after an upgrade-tool\n');
  const plan = sync(f.inst);
  assert.match(plan.stdout, /stays +1 local edit\(s\), carried over to main/);
  assert.doesNotMatch(plan.stdout, /keeps/, 'the send branch has GitHub\'s files: no setting aside needed');
  const r = sync(f.inst, ['--apply'], 'y\n');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.branch(), 'main');
  assert.equal(f.head(), f.origin());
  assert.equal(fs.readFileSync(path.join(f.inst, 'mise', 'mise.lock'), 'utf8'), 'lock after an upgrade-tool\n');
  assert.equal(git(f.inst, 'status', '--porcelain'), 'M mise/mise.lock');
  assert.equal(git(f.inst, 'branch', '--list', branch), '', 'the send branch is gone here');
  assert.equal(git(f.inst, 'ls-remote', '--heads', 'origin', branch), '', 'and on GitHub');
  assert.match(r.stdout, /==> fast-forwarded \w{7} → \w{7}/);
});

test('send: finishing carries an edit across a later merge on other lines, and refuses one on the same lines', () => {
  const f = fixture();
  const branch = sendAndMerge(f);
  f.upstream('mise/config.toml', text({ 2: 'tool2 = "1.2.0"', 11: 'tool11 = "1.3.0"' }), 'chore(deps): update tool11 (#6)');
  fs.writeFileSync(CFG(f), text({ 2: 'tool2 = "1.2.0"', 11: 'tool11 = "7.0.0"' }));
  const was = snapshot(f);
  const clash = sync(f.inst, ['--apply'], 'y\ny\n');
  assert.equal(clash.status, 2);
  assert.match(clash.stdout, /not finishing: your edits to mise\/config\.toml are in the way of the switch \(both change the same lines/);
  assert.deepEqual(snapshot(f), was);
  assert.equal(f.branch(), branch);
  fs.writeFileSync(CFG(f), text({ 2: 'tool2 = "1.2.0"', 6: 'tool6 = "6.0.0"' }));
  assert.match(sync(f.inst).stdout, /keeps +your edits to mise\/config\.toml are set aside and put back \(git combines them with what GitHub merged\)/);
  const r = sync(f.inst, ['--apply'], 'y\nn\n'); // finish yes, mise install no
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.branch(), 'main');
  assert.equal(f.head(), f.origin());
  assert.equal(fs.readFileSync(CFG(f), 'utf8'), text({ 2: 'tool2 = "1.2.0"', 6: 'tool6 = "6.0.0"', 11: 'tool11 = "1.3.0"' }));
  assert.equal(git(f.inst, 'stash', 'list'), '');
  assert.equal(git(f.inst, 'branch', '--list', branch), '');
});

test('send: finishing puts everything back when a carried edit does not go back cleanly', () => {
  const f = fixture();
  const branch = sendAndMerge(f);
  f.upstream('mise/config.toml', text({ 2: 'tool2 = "1.2.0"', 11: 'tool11 = "1.3.0"' }), 'up');
  fs.writeFileSync(CFG(f), text({ 2: 'tool2 = "1.2.0"', 6: 'tool6 = "6.0.0"' }));
  fs.writeFileSync(path.join(f.inst, '.git', 'info', 'attributes'), 'mise/config.toml -merge\n'); // see the pull's test
  const was = snapshot(f);
  const r = sync(f.inst, ['--apply'], 'y\ny\n');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /not finishing: .* \(they did not go back cleanly\)\. .*Nothing changed\./);
  assert.deepEqual(snapshot(f), was, 'still on the send branch, main where it was, the edit byte for byte');
  assert.equal(f.branch(), branch);
});
