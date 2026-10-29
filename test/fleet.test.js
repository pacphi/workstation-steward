// fleet/bin/sync.js and fleet/bin/prune-merged.js on throwaway repos with a local bare remote. Backups and receipts go
// to a temporary XDG_STATE_HOME; gh is a fake. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-fleet-')));
const ENV = { ...process.env, XDG_STATE_HOME: path.join(ROOT, 'state'), XDG_CONFIG_HOME: path.join(ROOT, 'xdg'), GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'), NO_PROGRESS: '1' };
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
const BIN = path.join(__dirname, '..', 'fleet', 'bin');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const run = (script, args, input = '') => spawnSync('node', [path.join(BIN, script), ...args], { encoding: 'utf8', env: ENV, input });
let k = 0;

// A bare remote, a seed clone that moves it, and a work clone. `base` files exist in the first commit.
function fixture(base) {
  const id = ++k, remote = path.join(ROOT, `r${id}.git`), seed = path.join(ROOT, `seed${id}`), work = path.join(ROOT, `work${id}`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: ENV });
  for (const d of [seed, work]) fs.mkdirSync(d);
  execFileSync('git', ['clone', '-q', remote, seed], { env: ENV, stdio: 'ignore' });
  for (const d of [seed]) { git(d, 'config', 'user.email', 't@e.com'); git(d, 'config', 'user.name', 't'); }
  for (const [p, t] of Object.entries(base)) put(seed, p, t);
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'init'); git(seed, 'push', '-q', 'origin', 'main');
  fs.rmSync(work, { recursive: true });
  execFileSync('git', ['clone', '-q', remote, work], { env: ENV, stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@e.com'); git(work, 'config', 'user.name', 't');
  const move = (files, del = []) => { for (const [p, t] of Object.entries(files)) put(seed, p, t); for (const p of del) git(seed, 'rm', '-q', p); git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'up'); git(seed, 'push', '-q', 'origin', 'main'); };
  return { remote, seed, work, move };
}

test('sync: drops edits upstream already has, keeps unrelated ones, fast-forwards, writes a receipt', () => {
  const f = fixture({ 'same.txt': 'a\n', 'json.json': '{"a":1,"b":2}\n', 'merge.txt': '1\n2\n3\n4\n5\n6\n7\n8\n', 'gone.txt': 'x\n', 'mine.txt': 'mine\n' });
  f.move({ 'same.txt': 'a2\n', 'json.json': '{"a":1,"b":3}\n', 'merge.txt': '1\n2\nthree\n4\n5\n6\n7\n8\n', 'new.txt': 'n\n' }, ['gone.txt']);
  put(f.work, 'same.txt', 'a2\n');                       // byte-equal
  put(f.work, 'json.json', '{\n "b": 3,\n "a": 1\n}\n'); // JSON-equal, different text
  put(f.work, 'merge.txt', '1\n2\nthree\n4\n5\n6\n7\n8\n'); // already inside upstream
  fs.rmSync(path.join(f.work, 'gone.txt'));              // deleted here and upstream
  put(f.work, 'new.txt', 'n\n');                         // untracked at a path upstream adds
  put(f.work, 'mine.txt', 'mine, edited\n');             // upstream doesn't touch it
  const plan = run('sync.js', [f.work]);
  assert.equal(plan.status, 0, plan.stderr + plan.stdout);
  assert.match(plan.stdout, /drop +same\.txt/);
  assert.doesNotMatch(plan.stdout, /mine\.txt/);
  assert.equal(fs.readFileSync(path.join(f.work, 'same.txt'), 'utf8'), 'a2\n');
  assert.notEqual(git(f.work, 'rev-parse', 'HEAD'), git(f.work, 'rev-parse', 'origin/main'));
  const no = run('sync.js', [f.work, '--apply', '--no-fetch'], 'n\n');
  assert.equal(no.status, 1);
  assert.notEqual(git(f.work, 'rev-parse', 'HEAD'), git(f.work, 'rev-parse', 'origin/main'));
  const yes = run('sync.js', [f.work, '--apply'], 'y\n');
  assert.equal(yes.status, 0, yes.stderr + yes.stdout);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), git(f.work, 'rev-parse', 'origin/main'));
  assert.equal(fs.readFileSync(path.join(f.work, 'mine.txt'), 'utf8'), 'mine, edited\n');
  assert.equal(fs.existsSync(path.join(f.work, 'gone.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.work, 'new.txt'), 'utf8'), 'n\n');
  const bk = path.join(ENV.XDG_STATE_HOME, 'workstation-steward', 'backups');
  const dirs = fs.readdirSync(bk).filter(d => d.startsWith('sync-work'));
  assert.equal(dirs.length, 1);
  const r = JSON.parse(fs.readFileSync(path.join(bk, dirs[0], 'receipt.json'), 'utf8'));
  assert.equal(r.kind, 'sync'); assert.equal(r.complete, true);
  assert.ok(fs.existsSync(path.join(bk, dirs[0], 'files', 'json.json')));
});

test('sync: a differing edit blocks until named with --replace', () => {
  const f = fixture({ 'a.txt': '1\n2\n3\n' });
  f.move({ 'a.txt': '1\nup\n3\n' });
  put(f.work, 'a.txt', '1\nmine\n3\n');
  const blocked = run('sync.js', [f.work, '--apply'], 'y\n');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /BLOCKED a\.txt/);
  assert.equal(fs.readFileSync(path.join(f.work, 'a.txt'), 'utf8'), '1\nmine\n3\n');
  const ok = run('sync.js', [f.work, '--apply', '--replace', 'a.txt'], 'y\n');
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(fs.readFileSync(path.join(f.work, 'a.txt'), 'utf8'), '1\nup\n3\n');
  const bk = path.join(ENV.XDG_STATE_HOME, 'workstation-steward', 'backups');
  const d = fs.readdirSync(bk).filter(x => x.startsWith('sync-work') && fs.existsSync(path.join(bk, x, 'files', 'a.txt')));
  assert.equal(fs.readFileSync(path.join(bk, d[0], 'files', 'a.txt'), 'utf8'), '1\nmine\n3\n');
});

test('sync: refuses local commits, a detached HEAD and a merge in progress; no-op when current', () => {
  const f = fixture({ 'a.txt': 'a\n' });
  assert.match(run('sync.js', [f.work]).stdout, /already up to date/);
  f.move({ 'b.txt': 'b\n' });
  put(f.work, 'c.txt', 'c\n'); git(f.work, 'add', '.'); git(f.work, 'commit', '-qm', 'local');
  const ahead = run('sync.js', [f.work]);
  assert.equal(ahead.status, 1); assert.match(ahead.stderr, /1 local commit/);
  git(f.work, 'reset', '-q', '--hard', 'origin/main'); // the fetch above moved it; drop my local commit for the next cases
  git(f.work, 'checkout', '-q', '--detach');
  assert.match(run('sync.js', [f.work]).stderr, /detached HEAD/);
  git(f.work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(f.work, '.git', 'MERGE_HEAD'), git(f.work, 'rev-parse', 'HEAD'));
  assert.match(run('sync.js', [f.work]).stderr, /merge is in progress/);
});

// Git can leave REBASE_HEAD behind once a rebase is over; it judges a rebase by rebase-merge/ or rebase-apply/.
// A two-month-old leftover blocked a real checkout's sync until it was removed by hand.
test('sync: a leftover REBASE_HEAD does not block; a rebase that is running does', () => {
  const f = fixture({ 'a.txt': 'a\n' });
  f.move({ 'b.txt': 'b\n' });
  fs.writeFileSync(path.join(f.work, '.git', 'REBASE_HEAD'), git(f.work, 'rev-parse', 'HEAD'));
  const stale = run('sync.js', [f.work]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /main: 1 commit\(s\) to fast-forward/);
  fs.mkdirSync(path.join(f.work, '.git', 'rebase-merge'));
  const real = run('sync.js', [f.work]);
  assert.equal(real.status, 1);
  assert.match(real.stderr, /a rebase is in progress: finish or abort it first/);
});

// prune-merged: a fake gh answers `pr list --head <branch>` from a table in GH_FAKE
function fakeGh() {
  const p = path.join(ROOT, `gh${++k}`);
  fs.writeFileSync(p, '#!/bin/sh\nb=""; while [ $# -gt 0 ]; do [ "$1" = "--head" ] && b="$2"; shift; done\nnode -e \'const t=JSON.parse(process.env.GH_FAKE||"{}");console.log(JSON.stringify(t[process.argv[1]]||[]))\' "$b"\n', { mode: 0o755 });
  return p;
}
test('prune-merged: deletes only branches whose PR merged, remote is gone and nothing is newer', () => {
  const f = fixture({ 'a.txt': 'a\n' });
  git(f.work, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
  git(f.work, 'config', `url.${f.remote}.insteadOf`, 'https://github.com/o/r.git');
  const mk = (name, text) => { git(f.work, 'checkout', '-q', '-b', name, 'main'); put(f.work, `${name}.txt`, text); git(f.work, 'add', '.'); git(f.work, 'commit', '-qm', name); return git(f.work, 'rev-parse', 'HEAD').trim(); };
  const merged = mk('merged', 'm');
  mk('later', 'l'); put(f.work, 'later2.txt', 'x'); git(f.work, 'add', '.'); git(f.work, 'commit', '-qm', 'after'); // commit after the PR head
  mk('open', 'o'); git(f.work, 'push', '-q', 'origin', 'open'); // remote still there
  mk('nopr', 'n');
  git(f.work, 'checkout', '-q', 'main');
  const laterHead = git(f.work, 'rev-parse', 'later~1').trim();
  const gh = fakeGh();
  const env = { ...ENV, STEWARD_GH: gh, GH_FAKE: JSON.stringify({ merged: [{ number: 5, headRefOid: merged }], later: [{ number: 6, headRefOid: laterHead }], open: [{ number: 7, headRefOid: merged }] }) };
  const go = (a, input = '') => spawnSync('node', [path.join(BIN, 'prune-merged.js'), f.work, ...a], { encoding: 'utf8', env, input });
  const plan = go([]);
  assert.equal(plan.status, 0, plan.stderr + plan.stdout);
  assert.match(plan.stdout, /delete merged /);
  assert.match(plan.stdout, /keep +later .*1 commit/);
  assert.match(plan.stdout, /keep +open .*remote branch still exists/);
  assert.match(plan.stdout, /keep +nopr .*no merged PR/);
  assert.match(plan.stdout, /keep +main .*current branch/);
  assert.ok(git(f.work, 'branch', '--list', 'merged').trim());
  const done = go(['--apply'], 'y\n');
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(git(f.work, 'branch', '--list', 'merged').trim(), '');
  for (const b of ['later', 'open', 'nopr']) assert.ok(git(f.work, 'branch', '--list', b).trim(), b);
  const bk = path.join(ENV.XDG_STATE_HOME, 'workstation-steward', 'backups');
  const d = fs.readdirSync(bk).find(x => x.startsWith('prune-merged-'));
  const r = JSON.parse(fs.readFileSync(path.join(bk, d, 'receipt.json'), 'utf8'));
  assert.deepEqual(r.branches.map(b => [b.name, b.tip]), [['merged', merged]]);
});

test('sync and prune-merged: a relative <repo> is read from the folder steward runs in, not ~/Development/active', () => {
  const f = fixture({ 'a.txt': 'a\n' });
  f.move({ 'a.txt': 'b\n' });
  const env = { ...ENV, STEWARD_CWD: path.dirname(f.work) };
  const sync = spawnSync('node', [path.join(BIN, 'sync.js'), path.basename(f.work)], { encoding: 'utf8', env });
  assert.equal(sync.status, 0, sync.stderr + sync.stdout);
  assert.ok(sync.stdout.includes(f.work), sync.stdout);
  assert.match(sync.stdout, /1 commit\(s\) to fast-forward/);
  // its origin is a local folder, so prune-merged stops at the GitHub check: past finding the checkout
  const prune = spawnSync('node', [path.join(BIN, 'prune-merged.js'), path.basename(f.work), '--no-fetch'], { encoding: 'utf8', env });
  assert.match(prune.stderr, /origin is not a GitHub remote/);
  // and through the client, `.` is the checkout it runs in
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'steward.js'), 'fleet', 'sync', '.', '--no-fetch'],
    { cwd: f.work, encoding: 'utf8', env: { ...ENV, STEWARD_INSTANCE: path.join(__dirname, '..', 'examples') } });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.ok(cli.stdout.includes(f.work), cli.stdout);
});
