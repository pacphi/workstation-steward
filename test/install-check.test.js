// The install check as a matrix, from a ref (parity 1d, T.4 and T.7): tools/install-check.sh installs the steward the
// way a maintainer's machine runs it, on the macOS runner and inside each Linux row's container (`just linux-test <id>
// --install-check`, tools/linux-test.js). Worktree mode from any commit; npm mode only for a released version whose
// package.json `os` names this platform. The script never runs on a real machine: it writes ~/.local/bin/steward.
// Throwaway Git repos; no Docker, no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../tools/linux-test.js');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'tools', 'install-check.sh');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'steward-ic-'));
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

// repo(version, os) — a throwaway Git repo whose package.json has that version (and os), one commit
function repo(version, osList) {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version, ...(osList ? { os: osList } : {}) }));
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'one');
  return d;
}

// fn(name, ...args) — one function of the script, sourced (its main doesn't run when sourced), in a clean environment
const fn = (name, ...args) => spawnSync('bash', ['-c', `source "${SCRIPT}"; ${name} "$@"`, 'ic', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...fn.env } });
fn.env = {};

test('install-check.sh refuses to run on a plain machine: it writes ~/.local/bin/steward and the release worktree', () => {
  assert.ok(fs.existsSync(SCRIPT), 'tools/install-check.sh');
  const r = spawnSync('bash', [SCRIPT, REPO], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp() } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /runs only on a CI runner or in a linux-test container/);
  // a container alone isn't enough: linux-test says so with STEWARD_INSTALL_CHECK=1 (the test rows run in containers too)
  const c = spawnSync('bash', [SCRIPT, REPO], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp(), container: 'docker' } });
  assert.equal(c.status, 2);
});

test('install-check.sh: the version line it expects, worked out as steward version works it out (a tag, else HEAD@<short>)', () => {
  const d = repo('1.2.3');
  const short = git(d, 'rev-parse', '--short', 'HEAD').stdout.trim();
  assert.equal(fn('ic_expected', d).stdout.trim(), `release 1.2.3 (HEAD@${short})`, 'a commit with no tag (T.7: any commit of main)');
  git(d, 'tag', 'v1.2.3');
  assert.equal(fn('ic_expected', d).stdout.trim(), 'release 1.2.3 (v1.2.3)', 'a release tag');
});

test('install-check.sh: npm mode only for a released version, and only where its package.json os names this platform', () => {
  fn.env = { IC_VERSION: '0.10.1' };
  assert.equal(fn('ic_npm_mode', repo('0.10.1', ['darwin']), 'darwin').status, 0, 'a Mac release, on the Mac');
  const skip = fn('ic_npm_mode', repo('0.10.1', ['darwin']), 'linux');
  assert.notEqual(skip.status, 0, 'a Mac-only release on Linux: npm would refuse the platform (the bar\'s last box, R-2)');
  assert.match(skip.stdout, /npm mode: skipped \(0\.10\.1's package\.json os is darwin only\)/);
  assert.equal(fn('ic_npm_mode', repo('0.11.0', ['darwin', 'linux']), 'linux').status, 0, 'once os names linux');
  assert.equal(fn('ic_npm_mode', repo('0.11.0'), 'linux').status, 0, 'no os field: every platform');
  fn.env = {};
  assert.notEqual(fn('ic_npm_mode', repo('0.11.0', ['darwin', 'linux']), 'linux').status, 0, 'a ref, not a version: worktree mode only');
});

test('install-check.sh: says whether the commit is on main; one that isn\'t still runs, marked (owner, 2026-11-03)', () => {
  const d = repo('1.0.0');
  git(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(fn('ic_on_main', d).stdout.trim(), 'on main: yes');
  git(d, 'switch', '-q', '-c', 'pr');
  fs.writeFileSync(path.join(d, 'f'), 'x');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'two');
  assert.equal(fn('ic_on_main', d).stdout.trim(), "NOT on main: doesn't count for the release bar");
});

test('linux-test --install-check: its arguments (a ref, rows), and it never runs together with --e2e', () => {
  assert.deepEqual(L.parseArgs(['debian-13', '--install-check', '--ref', 'abc1234']), { want: ['debian-13'], x64: false, keep: false, e2e: false, installCheck: true, ref: 'abc1234' });
  assert.deepEqual(L.parseArgs(['all', '--x64']), { want: ['all'], x64: true, keep: false, e2e: false, installCheck: false, ref: '' });
  assert.throws(() => L.parseArgs(['debian-13', '--ref']), /--ref needs a commit/);
  assert.throws(() => L.parseArgs(['debian-13', '--e2e', '--install-check']), /one of --e2e and --install-check/);
});

test('installCheckArgs: the row\'s image with a fresh home and an empty mise, the network on, read-only, non-root, the subject copied in', () => {
  const a = L.installCheckArgs({ tag: 'steward-test/debian-13:abc', name: 'steward-ic-debian-13-1', tooling: '/w/tooling', subject: '/w/subject', x64: true,
    env: { IC_VERSION: '0.11.0', CLAUDE_CODE: '2.1.312', RELEASE_AGE_DAYS: '', IC_REF: 'abc1234', GH_TOKEN: 'secret', HOME: '/Users/me' } });
  const has = (...xs) => { const i = a.indexOf(xs[0]); return i >= 0 && xs.every((x, k) => a[i + k] === x); };
  assert.equal(a[0], 'run');
  assert.ok(has('--rm') && has('--label', `${L.LABEL}=1`) && has('--name', 'steward-ic-debian-13-1') && has('--platform', 'linux/amd64'));
  assert.ok(!a.includes('none'), 'the network is on: mise, npm and GitHub are what a fresh machine reaches');
  assert.ok(has('--read-only') && has('--user', 'steward'), 'nothing written outside the home and /tmp, and not as root');
  assert.ok(has('--tmpfs', '/work:exec,mode=1777') && has('--tmpfs', '/tmp:exec,mode=1777'));
  assert.ok(has('-v', '/w/tooling:/tooling:ro') && has('-v', '/w/subject:/subject:ro'));
  const env = a.flatMap((x, i) => (x === '-e' ? [a[i + 1]] : []));
  for (const e of ['STEWARD_INSTALL_CHECK=1', 'HOME=/work/home', 'MISE_DATA_DIR=/work/home/.local/share/mise', 'MISE_OFFLINE=0', 'PATH=/usr/local/bin:/usr/bin:/bin', 'IC_VERSION=0.11.0', 'CLAUDE_CODE=2.1.312', 'IC_REF=abc1234']) assert.ok(env.includes(e), e);
  assert.ok(!env.some(e => e.startsWith('GH_TOKEN=') || e === 'HOME=/Users/me'), 'only the install check\'s own inputs go in');
  assert.ok(!env.some(e => e.includes('/opt/mise')), 'the image\'s preinstalled toolchain is off the PATH and out of mise');
  assert.match(a[a.length - 1], /cp -a \/subject\/\. \/work\/subject\/.*bash \/tooling\/tools\/install-check\.sh \/work\/subject/, 'git worktree add writes into .git, so the subject is copied');
});

test('install check: a row passes on exit 0 and the script\'s last line; its SUMMARY lines go to the job summary', () => {
  const out = 'noise\nSUMMARY on main: yes\nSUMMARY 1. worktree mode: `release 0.10.1 (HEAD@9f80e41)`\nmore\ninstall check: passed\n';
  assert.equal(L.icPassed(out, 0), true);
  assert.equal(L.icPassed(out, 1), false, 'a failing exit code fails the row');
  assert.equal(L.icPassed('SUMMARY on main: yes\n', 0), false, 'it stopped before the end');
  assert.deepEqual(L.icSummary(out), ['on main: yes', '1. worktree mode: `release 0.10.1 (HEAD@9f80e41)`']);
});
