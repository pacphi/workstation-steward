// tools/upstream-watch.js (D52): the maintainer's weekly watch on shipped key pins. Each entry is unchanged, changed,
// could not be checked (a network or HTTP error, or no match) or skipped (no watch URL); the hash is the one the
// steward checks a machine's copy with (lib/updaters.js pinState); and --issues opens one issue per changed entry,
// comments only when the hash moved again, and creates the owner-decision label if it's missing. A stand-in fetch and
// gh; throwaway folders; no network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const W = require('../tools/upstream-watch.js');
const U = require('../lib/updaters.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-upstream-watch-')));
const KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAreviewed\n-----END PUBLIC KEY-----';
const MATCH = '-----BEGIN PUBLIC KEY-----[\\s\\S]*?-----END PUBLIC KEY-----';
const URL = 'https://raw.githubusercontent.com/example/tool/main/kb/update.mjs';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const file = key => `// the tool's updater\nconst PUBLIC_KEY = \`${key}\`;\nexport default PUBLIC_KEY;\n`;
const entry = (o = {}) => ({ name: 'tool-kb', class: 'signed_data', pin: { file: '~/tool/update.mjs', match: MATCH, sha256: sha(KEY), watch: URL, ...o } });

// fetchOf(map) — a stand-in fetch: a URL's text, a {status}, or an Error to throw; records each URL asked for
function fetchOf(map) {
  const asked = [];
  const f = async url => {
    asked.push(url);
    const v = map[url];
    if (v instanceof Error) throw v;
    if (v && typeof v === 'object') return { ok: false, status: v.status, text: async () => '' };
    return { ok: true, status: 200, text: async () => v };
  };
  return Object.assign(f, { asked });
}

// ghOf(state) — a stand-in gh CLI over {labels, issues}; records each call
function ghOf(state) {
  const calls = [];
  const ok = stdout => ({ status: 0, stdout, stderr: '' });
  const gh = (args, input) => {
    calls.push({ args, input });
    const [a, b] = args;
    if (a === 'label' && b === 'list') return ok(JSON.stringify(state.labels.map(name => ({ name }))));
    if (a === 'label' && b === 'create') { state.labels.push(args[2]); return ok(''); }
    if (a === 'issue' && b === 'list') return ok(JSON.stringify(state.issues.map(({ number, title }) => ({ number, title }))));
    if (a === 'issue' && b === 'view') { const i = state.issues.find(x => x.number === Number(args[2])); return ok(JSON.stringify({ body: i.body, comments: i.comments })); }
    if (a === 'issue' && b === 'create') {
      const number = 100 + state.issues.length;
      state.issues.push({ number, title: args[args.indexOf('--title') + 1], body: input, comments: [] });
      return ok(`https://github.com/example/engine/issues/${number}\n`);
    }
    if (a === 'issue' && b === 'comment') { state.issues.find(x => x.number === Number(args[2])).comments.push({ body: input }); return ok(''); }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return Object.assign(gh, { calls });
}

test('watch: an upstream file whose key still hashes to the pin is unchanged', async () => {
  const [r] = await W.watch([entry()], { fetch: fetchOf({ [URL]: file(KEY) }) });
  assert.equal(r.state, 'unchanged', JSON.stringify(r));
  assert.equal(r.have, sha(KEY));
});

test('watch: a rotated key upstream is changed, with the new hash', async () => {
  const rotated = KEY.replace('reviewed', 'rotated');
  const [r] = await W.watch([entry()], { fetch: fetchOf({ [URL]: file(rotated) }) });
  assert.equal(r.state, 'changed', JSON.stringify(r));
  assert.equal(r.have, sha(rotated));
  assert.equal(r.pinned, sha(KEY));
});

test('watch: an upstream file where match finds nothing could not be checked, and says so', async () => {
  const [r] = await W.watch([entry()], { fetch: fetchOf({ [URL]: '// the key moved to another file\n' }) });
  assert.equal(r.state, 'unknown');
  assert.match(r.why, /^no match/);
});

test('watch: a network error or an HTTP error could not be checked, never taken as a change', async () => {
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const [n] = await W.watch([entry()], { fetch: fetchOf({ [URL]: err }) });
  assert.equal(n.state, 'unknown');
  assert.match(n.why, /^network: fetch failed \(ENOTFOUND\)/);
  const [h] = await W.watch([entry()], { fetch: fetchOf({ [URL]: { status: 404 } }) });
  assert.equal(h.state, 'unknown');
  assert.match(h.why, /^HTTP 404/);
});

test('watch: a pin without a watch URL is skipped and not fetched; an entry with no pin is not listed', async () => {
  const f = fetchOf({});
  const out = await W.watch([entry({ watch: undefined }), { name: 'no-pin', class: 'gated' }], { fetch: f });
  assert.deepEqual(out.map(r => [r.name, r.state]), [['tool-kb', 'skipped']]);
  assert.deepEqual(f.asked, []);
});

test('watch: hashes the same text pinState hashes on a machine, so a pin that holds locally is unchanged upstream', async () => {
  const local = path.join(ROOT, 'update.mjs');
  fs.writeFileSync(local, file(KEY));
  const u = entry({ file: local });
  const here = U.pinState(u);
  assert.equal(here.ok, true);
  const [r] = await W.watch([u], { fetch: fetchOf({ [URL]: fs.readFileSync(local, 'utf8') }) });
  assert.equal(r.have, here.have);
  assert.equal(r.state, 'unchanged');
});

test('issues: a change opens one issue labelled owner-decision, creating the label when the repository lacks it', () => {
  const state = { labels: ['bug'], issues: [] };
  const gh = ghOf(state);
  const changed = { name: 'tool-kb', state: 'changed', url: URL, pinned: sha(KEY), have: sha('new') };
  const out = W.fileIssues([changed, { name: 'other', state: 'unchanged' }], { gh, repo: 'example/engine', runUrl: 'https://github.com/example/engine/actions/runs/1' });
  assert.deepEqual(out, [{ name: 'tool-kb', action: 'created', number: 100 }]);
  assert.ok(state.labels.includes(W.LABEL));
  assert.equal(state.issues.length, 1);
  const create = gh.calls.find(c => c.args[0] === 'issue' && c.args[1] === 'create').args;
  assert.equal(create[create.indexOf('--label') + 1], 'owner-decision');
  assert.equal(create[create.indexOf('--repo') + 1], 'example/engine');
  assert.ok(state.issues[0].body.includes(W.marker('tool-kb', sha('new'))));
  assert.ok(state.issues[0].body.includes('https://github.com/example/tool/commits/main/kb/update.mjs'), 'links the file history');
  assert.ok(state.issues[0].body.includes('docs/maintainers.md#a-shipped-default-changed-upstream'), 'links the runbook');
});

test('issues: the next run finds the open issue by its title; the same hash adds nothing, a new one adds a comment', () => {
  const state = { labels: ['owner-decision'], issues: [] };
  const gh = ghOf(state);
  const r = { name: 'tool-kb', state: 'changed', url: URL, pinned: sha(KEY), have: sha('new') };
  W.fileIssues([r], { gh, repo: 'example/engine', runUrl: '' });
  assert.ok(!gh.calls.some(c => c.args[0] === 'label' && c.args[1] === 'create'), 'an existing label is left alone');
  assert.deepEqual(W.fileIssues([r], { gh, repo: 'example/engine', runUrl: '' }), [{ name: 'tool-kb', action: 'already', number: 100 }]);
  const again = { ...r, have: sha('newer') };
  assert.deepEqual(W.fileIssues([again], { gh, repo: 'example/engine', runUrl: '' }), [{ name: 'tool-kb', action: 'commented', number: 100 }]);
  assert.equal(state.issues.length, 1, 'one issue per entry');
  assert.equal(state.issues[0].comments.length, 1);
  assert.deepEqual(W.fileIssues([again], { gh, repo: 'example/engine', runUrl: '' }), [{ name: 'tool-kb', action: 'already', number: 100 }]);
});

test('issues: nothing changed means no gh call at all', () => {
  const gh = ghOf({ labels: [], issues: [] });
  assert.deepEqual(W.fileIssues([{ name: 'tool-kb', state: 'unchanged' }, { name: 'x', state: 'unknown', why: 'HTTP 500' }], { gh, repo: 'example/engine', runUrl: '' }), []);
  assert.deepEqual(gh.calls, []);
});

test('main: exit 0 unchanged, 10 changed, 1 could not check; --issues files only in the package\'s own repository', async () => {
  const toml = path.join(ROOT, 'defaults.toml');
  fs.writeFileSync(toml, `[[updater]]\nname = "tool-kb"\nclass = "signed_data"\n[updater.pin]\nfile = "~/tool/update.mjs"\nmatch = '${MATCH}'\nsha256 = "${sha(KEY)}"\nwatch = "${URL}"\n`);
  const quiet = () => {};
  const env = /** @type {NodeJS.ProcessEnv} */ ({});
  assert.equal(await W.main(['--file', toml], { fetch: fetchOf({ [URL]: file(KEY) }), env, print: quiet }), 0);
  assert.equal(await W.main(['--file', toml], { fetch: fetchOf({ [URL]: file('rotated') }), env, print: quiet }), 1, 'no key text at all is no match');
  assert.equal(await W.main(['--file', toml], { fetch: fetchOf({ [URL]: file(KEY.replace('reviewed', 'rotated')) }), env, print: quiet }), 10);
  // another repository (a private copy of the engine): reported, not filed
  const gh = ghOf({ labels: [], issues: [] });
  const lines = [];
  const other = /** @type {NodeJS.ProcessEnv} */ ({ GITHUB_REPOSITORY: 'someone/private-copy' });
  assert.equal(await W.main(['--file', toml, '--issues'], { fetch: fetchOf({ [URL]: file(KEY.replace('reviewed', 'rotated')) }), gh, env: other, print: l => lines.push(l) }), 10);
  assert.deepEqual(gh.calls, []);
  assert.ok(lines.some(l => l.startsWith('issues: not filed')), lines.join('\n'));
  // its own repository: the change goes to its issue, and the run passes
  const own = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).repository.url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)[1];
  const summary = path.join(ROOT, 'summary.md');
  const ci = /** @type {NodeJS.ProcessEnv} */ ({ GITHUB_REPOSITORY: own, GITHUB_RUN_ID: '7', GITHUB_STEP_SUMMARY: summary });
  const gh2 = ghOf({ labels: [], issues: [] });
  assert.equal(await W.main(['--file', toml, '--issues'], { fetch: fetchOf({ [URL]: file(KEY.replace('reviewed', 'rotated')) }), gh: gh2, env: ci, print: quiet }), 0);
  assert.ok(gh2.calls.some(c => c.args[0] === 'issue' && c.args[1] === 'create'));
  assert.match(fs.readFileSync(summary, 'utf8'), /tool-kb: CHANGED/);
});
