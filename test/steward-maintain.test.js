// .claude/skills/steward-maintain/bin/ (/steward-maintain): the maintainer's flows refuse what's outside their scope. Stand-ins for steward,
// gh and curl on PATH (they record what they were asked); no network, and nothing is applied anywhere. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const BIN = path.join(REPO, '.claude', 'skills', 'steward-maintain', 'bin');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-maintainer-')));
const SLUG = spawnSync('git', ['-C', REPO, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim()
  .replace(/^(https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '');

// stand-ins: each answers from files in its own folder and appends its arguments (and any stdin) to calls.log
function standins(answers) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'bin-'));
  for (const [name, text] of Object.entries(answers)) fs.writeFileSync(path.join(dir, `${name}.out`), text);
  const tool = name => `#!/bin/bash
in=""; [ -t 0 ] || in="$(cat 2>/dev/null | tr '\\n' ' ')"
echo "${name} $* <${'$'}{in}>" >> "${dir}/calls.log"
key="${name}"
case "${name} $*" in
  "steward fleet sync"*--apply*) key=steward-sync-apply ;; "steward fleet sync"*) key=steward-sync ;;
  "steward fleet prune-merged"*--apply*) key=steward-prune-apply ;; "steward fleet prune-merged"*) key=steward-prune ;;
  "steward config sync --apply"*) key=steward-config-apply ;; "steward config sync"*) key=steward-config ;;
  "gh pr view"*) key=gh-pr ;; "gh api"*commits*) key=gh-commit ;; "gh release view"*) key=gh-release ;;
  "curl"*attestations*) key=curl-attest ;; "curl"*) key=curl-registry ;;
esac
[ -f "${dir}/${'$'}{key}.out" ] && cat "${dir}/${'$'}{key}.out"
exit 0
`;
  for (const name of ['steward', 'gh', 'curl']) fs.writeFileSync(path.join(dir, name), tool(name), { mode: 0o755 });
  return { dir, calls: () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '') };
}
/** @type {NodeJS.ProcessEnv} */
const ENV = { ...process.env, STEWARD_INSTANCE: path.join(REPO, 'examples'), NO_PROGRESS: '1', RELEASE_WAIT_SECONDS: '0', RELEASE_WAIT_TRIES: '1' };
delete ENV.STEWARD_BIN;
const run = (s, script, args = []) => spawnSync(path.join(BIN, script), args, { encoding: 'utf8', env: { ...ENV, PATH: `${s.dir}:${process.env.PATH}` } });

// what npm and GitHub say about a release, as the stand-ins answer: provenanceCommit is the commit npm's attestation names
function published({ latest = '9.9.9', tagCommit = 'a'.repeat(40), provenanceCommit = tagCommit, draft = 'false false' } = {}) {
  const payload = Buffer.from(JSON.stringify({ predicate: { buildDefinition: {
    externalParameters: { workflow: { repository: `https://github.com/${SLUG}`, path: '.github/workflows/release.yml' } },
    resolvedDependencies: [{ digest: { gitCommit: provenanceCommit } }] } } })).toString('base64');
  return {
    'curl-registry': JSON.stringify({ 'dist-tags': { latest }, time: { [latest]: '2026-10-29T00:00:00Z' } }),
    'curl-attest': JSON.stringify({ attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload } } }] }),
    'gh-commit': `${tagCommit}\n`, 'gh-release': `${draft}\n`,
  };
}

test('after-merge: refuses a PR that is not merged, before running anything', () => {
  const s = standins({ 'gh-pr': 'OPEN - fix: something\n' });
  const r = run(s, 'after-merge.sh', ['12']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PR #12 is OPEN, not merged: nothing done/);
  assert.doesNotMatch(s.calls(), /^steward/m);
});

test('after-merge: a plan with nothing to do is never applied; one with work is applied once, answered after the plan', () => {
  const idle = standins({ 'gh-pr': `MERGED ${'b'.repeat(40)} fix: something\n`, 'steward-sync': 'main is already up to date with origin/main.\n', 'steward-prune': 'nothing to delete.\n' });
  const r = run(idle, 'after-merge.sh', ['12']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(idle.calls(), /--apply/);
  const behind = standins({ 'steward-sync': 'fast-forward main 2 commit(s)\n', 'steward-prune': 'delete  old-branch (merged)\n' });
  const r2 = run(behind, 'after-merge.sh');
  assert.equal(r2.status, 0, r2.stderr);
  const calls = behind.calls().split('\n').filter(l => l.startsWith('steward'));
  assert.deepEqual(calls.map(l => l.replace(REPO, '<engine>')), [
    'steward fleet sync <engine> <>', 'steward fleet sync <engine> --apply <y y y >',
    'steward fleet prune-merged <engine> <>', 'steward fleet prune-merged <engine> --apply <y y y >',
  ]);
});

test('after-merge: several PRs must all be merged; a merged release-please PR names its version for the release flow', () => {
  const rel = standins({ 'gh-pr': `MERGED ${'b'.repeat(40)} chore(main): release 9.9.9\n`, 'steward-sync': 'already up to date\n', 'steward-prune': 'nothing to delete.\n' });
  const r = run(rel, 'after-merge.sh', ['39']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^release: 9\.9\.9$/m);
  const plain = standins({ 'gh-pr': `MERGED ${'b'.repeat(40)} fix: something\n`, 'steward-sync': 'already up to date\n', 'steward-prune': 'nothing to delete.\n' });
  assert.doesNotMatch(run(plain, 'after-merge.sh', ['41']).stdout, /^release:/m);
  const mixed = standins({ 'gh-pr': 'CLOSED - fix: abandoned\n' });
  const r2 = run(mixed, 'after-merge.sh', ['41', '42']);
  assert.equal(r2.status, 1);
  assert.doesNotMatch(mixed.calls(), /^steward/m);
});

test('status: shows the plans and the open PRs, and applies nothing', () => {
  const s = standins({ 'steward-sync': 'fast-forward main 1 commit(s)\n', 'steward-prune': 'nothing to delete.\n', 'steward-config': '  up to date with origin/main; nothing to send\n', 'curl-registry': '{"dist-tags":{"latest":"9.9.9"}}' });
  const r = run(s, 'status.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fast-forward main 1 commit/);
  assert.doesNotMatch(s.calls(), /--apply/);
});

test('release --verify-only: passes only when npm, the provenance commit and the GitHub release all agree with the tag', () => {
  assert.equal(run(standins(published()), 'release.sh', ['9.9.9', '--verify-only']).status, 0);
  const wrongCommit = run(standins(published({ provenanceCommit: 'c'.repeat(40) })), 'release.sh', ['9.9.9', '--verify-only']);
  assert.equal(wrongCommit.status, 1);
  assert.match(wrongCommit.stderr, /provenance commit ccccccc is not v9\.9\.9's commit aaaaaaa/);
  const notLatest = run(standins(published({ latest: '9.9.8' })), 'release.sh', ['9.9.9', '--verify-only']);
  assert.equal(notLatest.status, 1);
  assert.match(notLatest.stderr, /npm's latest is 9\.9\.8, not 9\.9\.9/);
  const draft = run(standins(published({ draft: 'true false' })), 'release.sh', ['9.9.9', '--verify-only']);
  assert.equal(draft.status, 1);
  assert.match(draft.stderr, /draft or a prerelease/);
});

test('repin: needs the owner\'s words, and a release that verifies, before it backs up or moves anything', () => {
  const s = standins(published({ latest: '9.9.8' }));
  const noWhy = run(s, 'repin.sh', ['9.9.9']);
  assert.equal(noWhy.status, 1);
  assert.match(noWhy.stderr, /a repin is the owner's call/);
  const blankWhy = run(s, 'repin.sh', ['9.9.9', '--why', '  ']);
  assert.equal(blankWhy.status, 1);
  const unverified = run(s, 'repin.sh', ['9.9.9', '--why', 'repin when it is out']);
  assert.equal(unverified.status, 1);
  assert.match(unverified.stderr, /v9\.9\.9 isn't verified: no repin/);
  assert.doesNotMatch(unverified.stdout, /backup and receipt/);
});

test('config-sync: after finishing a send that carried an edit, the edit stays local and the flow passes; an edit it did not plan stops it', () => {
  const cfg = fs.mkdtempSync(path.join(ROOT, 'cfg-'));
  const git = (...a) => spawnSync('git', ['-C', cfg, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.copyFileSync(path.join(REPO, 'examples', 'steward.toml'), path.join(cfg, 'steward.toml'));
  fs.writeFileSync(path.join(cfg, 'tools.txt'), 'a 1\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(cfg, 'tools.txt'), 'a 2\n');
  const env = { STEWARD_INSTANCE: cfg };
  const carried = standins({ 'steward-config': '~/cfg  (o/cfg, steward/sync-1, PR #1 merged)\n  finish  PR #1 is merged: switch to main, fast-forward 1 commit(s), delete steward/sync-1\n  stays   1 local edit(s), carried over to main\n' });
  const r = spawnSync(path.join(BIN, 'config-sync.sh'), [], { encoding: 'utf8', env: { ...ENV, ...env, PATH: `${carried.dir}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /carried over and stay local/);
  assert.match(carried.calls(), /config sync --apply/);
  const unplanned = standins({ 'steward-config': '~/cfg  (o/cfg, main → origin/main)\n  pull    1 commit(s):\n' });
  const r2 = spawnSync(path.join(BIN, 'config-sync.sh'), [], { encoding: 'utf8', env: { ...ENV, ...env, PATH: `${unplanned.dir}:${process.env.PATH}` } });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /uncommitted changes/);
});

test('config-sync: takes nothing when in step, and stops for the owner when the plan would send local edits', () => {
  const idle = standins({ 'steward-config': '~/cfg  (o/cfg, main → origin/main)\n  up to date with origin/main; nothing to send\n' });
  const r = run(idle, 'config-sync.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(idle.calls(), /--apply/);
  const send = standins({ 'steward-config': '~/cfg  (o/cfg, main → origin/main)\n  send    1 file(s) as a PR to o/cfg, on a new steward/sync-<time> branch:\n' });
  const r2 = run(send, 'config-sync.sh');
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /sends local edits as a PR, which this flow doesn't do/);
  assert.doesNotMatch(send.calls(), /--apply/);
});
