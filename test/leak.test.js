// tools/export.js and tools/leak-check.js (D39): the export holds only allowed, tracked files, never the instance,
// archive/ or owner/, with a public CLAUDE.md; leak-check finds instance files, a registry with projects, home paths
// and private terms, and passes a clean tree. Throwaway folders; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-leak-')));
const run = (script, args) => spawnSync(process.execPath, [path.join(REPO, 'tools', script), ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
const tree = (name, files) => {
  const d = path.join(ROOT, name);
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
  return d;
};
const terms = path.join(ROOT, 'terms.txt');
fs.writeFileSync(terms, '# private\nsecret-project\n');

test('leak-check: a clean tree passes; each kind of leak is found with file and line', () => {
  const clean = tree('clean', { 'README.md': '# ok\nSee /Users/x/.cache and /Users/runner/work.\nThe secret-projector skill.\n', 'examples/projects/registry.toml': '# empty\n' });
  const ok = run('leak-check.js', [clean, '--terms', terms]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /clean/);
  const dirty = tree('dirty', {
    'steward.toml': 'schema = 1\n', 'archive/old.md': 'x\n', 'owner/AGENTS.md': 'x\n',
    'projects/registry.toml': '[[project]]\npath = "~/x"\n',
    'docs/a.md': `line\nsee ${'/Users/'}alice/code\nthe Secret-Project repo\nclone org/secret-project-2\n`,   // built in two parts: this file is exported too
  });
  const bad = run('leak-check.js', [dirty, '--terms', terms]);
  assert.equal(bad.status, 1);
  for (const want of [/steward\.toml: a private or instance file/, /archive\/old\.md: a private or instance file/, /owner\/AGENTS\.md/,
    /projects\/registry\.toml: a registry with projects/, /docs\/a\.md:2: a home path \(\/Users\/alice\)/, /docs\/a\.md:3: a private term \(Secret-Project\)/, /docs\/a\.md:4: a private term \(secret-project\)/]) {
    assert.match(bad.stdout, want);
  }
});

test('export: only allowed tracked files; never the instance, archive/ or owner/; public CLAUDE.md and .gitignore', () => {
  const out = path.join(ROOT, 'export');
  const r = run('export.js', [out, '--no-check']);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['bin/steward.js', 'lib/config.js', 'examples/steward.toml', 'AGENTS.md', 'LICENSE', 'tools/public.txt']) assert.ok(fs.existsSync(path.join(out, f)), f);
  for (const f of ['steward.toml', 'mise', 'renovate.json', 'supply-chain/host.toml', 'projects/registry.toml', 'archive', 'owner', 'leak-terms.txt', '.github/workflows/lock-check.yml']) {
    assert.ok(!fs.existsSync(path.join(out, f)), `${f} must not be exported`);
  }
  assert.equal(fs.readFileSync(path.join(out, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.match(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), /^\/projects\/registry\.toml$/m);
  const link = path.join(out, '.claude', 'skills', 'supply-chain-steward');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'skill links stay symlinks');
  assert.equal(run('export.js', [out]).status, 2, 'refuses a folder that is not empty');
  const empty = path.join(ROOT, 'no-terms.txt'); fs.writeFileSync(empty, '');
  const chk = run('leak-check.js', [out, '--terms', empty]);   // not this checkout's own terms (it is also an instance)
  assert.equal(chk.status, 0, chk.stdout);
});

test('leak-check in a pure engine checkout (no steward.toml): every tracked file and every new one Git does not ignore', () => {
  // a throwaway Git repo holding a copy of the tool, so "this checkout" is the repo, as in the public engine repo
  const repo = path.join(ROOT, 'pure');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'tools', 'leak-check.js'), path.join(repo, 'tools', 'leak-check.js'));
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.md\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# ok\n');
  fs.writeFileSync(path.join(repo, 'outside-the-allow-list.md'), 'the Secret-Project repo\n');   // never in tools/public.txt
  fs.writeFileSync(path.join(repo, 'ignored.md'), 'secret-project, but Git ignores this file\n');
  git('add', 'README.md', 'tools', '.gitignore');
  const r = spawnSync(process.execPath, [path.join(repo, 'tools', 'leak-check.js'), '--terms', terms], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /in this checkout \(tracked and new\)/);
  assert.match(r.stdout, /outside-the-allow-list\.md:1: a private term \(Secret-Project\)/, 'a new, untracked file is checked too');
  assert.doesNotMatch(r.stdout, /ignored\.md/, 'an ignored file is not');
});

test('publish-guard: outside the Release workflow it refuses, naming every reason', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'publish-guard.js')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_REPOSITORY: 'someone/fork', GITHUB_WORKFLOW_REF: '', PUBLISH_GUARD_OFFLINE: '1' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not running on GitHub Actions/);
  assert.match(r.stderr, /repository is someone\/fork, not pacphi\/workstation-steward/);
  assert.match(r.stderr, /workflow is unknown, not \.github\/workflows\/release\.yml/);
});
