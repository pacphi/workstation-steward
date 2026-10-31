// lib/fix.js, `steward fix` (D59): what the runner does with each step, on a stand-in runner (no command runs), then
// end to end through bin/steward.js on throwaway repos with a local bare remote. --yes-to in bin/steward.js and
// lib/autonomy.js. State goes to a temporary XDG_STATE_HOME. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const F = require('../lib/fix.js');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-fix-')));
/** @type {NodeJS.ProcessEnv} */
const ENV = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', STEWARD_NO_REFRESH: '1', XDG_STATE_HOME: path.join(ROOT, 'state'), XDG_CONFIG_HOME: path.join(ROOT, 'xdg'),
  GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'), STEWARD_INSTANCE: path.join(REPO, 'examples') };
for (const k of ['STEWARD_CONFIG', 'STEWARD_UNATTENDED', 'STEWARD_YES_TO']) delete ENV[k];
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@e.com\n');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let k = 0;
const settings = toml => { const f = path.join(ROOT, `steward-${++k}.toml`); fs.writeFileSync(f, `schema = 1\n[paths]\nmise_config_dir = "${path.join(ROOT, 'mise')}"\n${toml}\n`); return f; };
const steward = (args, env = {}) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), ...args], { encoding: 'utf8', env: { ...ENV, ...env }, input: '' });

// a work clone one commit behind its bare remote
function behind() {
  const id = ++k, remote = path.join(ROOT, `r${id}.git`), seed = path.join(ROOT, `seed${id}`), work = path.join(ROOT, `work${id}`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: ENV });
  execFileSync('git', ['clone', '-q', remote, seed], { env: ENV, stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'a.txt'), '1\n'); git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'one'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '-q', remote, work], { env: ENV, stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'a.txt'), '2\n'); git(seed, 'commit', '-qam', 'two'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  return { work, tip: git(seed, 'rev-parse', 'HEAD') };
}

const SAFE = { level: 'safe', allow: [], deny: [] };
const ASK = { level: 'ask', allow: [], deny: [] };
const item = (id, cmd, o = {}) => ({ id, text: id, cmd, actor: 'agent', after: [], ...o });
const how = (x, a = SAFE, yes = []) => F.disposition(x, a, yes).how;

test('disposition: run, ask, terminal, yours, skill or wait, from the command and the policy, not the list\'s word for it', () => {
  assert.equal(how(item('a', 'steward review')), 'run');
  assert.equal(how(item('a', 'steward config sync')), 'run');
  assert.equal(how(item('a', 'steward config sync'), ASK), 'ask');
  assert.equal(how(item('a', 'steward config sync'), ASK, ['pull']), 'run', 'the user\'s yes to the class');
  assert.equal(how(item('a', 'DRY_RUN=1 steward sc prune, then steward sc prune')), 'run');
  assert.equal(how(item('a', 'steward fleet prune-merged ~/r')), 'ask');
  // a writing command that doesn't take --unattended asks its own questions, in a terminal
  assert.equal(how(item('a', 'steward sc link')), 'terminal');
  // install-hybrids answers under --unattended (D61): it needs a yes, which the fix skill asks for
  assert.equal(how(item('a', 'steward sc install-hybrids')), 'ask');
  assert.equal(how(item('a', 'steward config sync, then steward sc link')), 'terminal');
  // a list that calls a step agent doesn't make it one: the class is checked against the policy here
  assert.equal(how(item('a', 'steward sc link', { actor: 'agent' }), { level: 'maintainer', allow: [], deny: [] }), 'terminal');
  // the user's, whatever the list says, and anything that isn't a steward command
  assert.equal(how(item('a', 'steward config sync', { actor: 'human' })), 'yours');
  // a steward command only a person runs stays theirs, even called agent, even with a yes for this run
  assert.equal(how(item('a', 'steward skills install', { actor: 'agent' })), 'yours');
  assert.equal(how(item('a', 'steward skills install', { actor: 'agent' }), { level: 'maintainer', allow: Object.keys(require('../lib/autonomy.js').CLASSES), deny: [] }, ['pull']), 'yours');
  for (const cmd of ['rm -rf ~/x', 'touch ~/x', 'gh pr merge 64', 'steward projects decide <path>', 'steward config sync; rm -rf ~', 'steward review > ~/x', 'steward no-such']) {
    assert.equal(how(item('a', cmd)), 'yours', cmd);
  }
  assert.equal(how(item('a', '/steward-maintain release 0.10.0')), 'skill');
  assert.equal(how(item('a', '~/e/ai-tooling/qualify/aqe/run.sh 3.15.17 build')), 'skill');
  assert.equal(how({ id: 'a', text: 'o/r: 2 bot PRs', skill: 'pr-consolidation', actor: 'agent' }), 'skill');
  assert.equal(how({ id: 'a', text: 'app', how: 'by hand: update it', actor: 'human' }), 'yours');
  assert.equal(how({ id: 'a', text: 'x', how: 'wait until 11-01', wait: true }), 'wait');
});

test('argv: a writing command gets --apply where it takes one, --unattended and the user\'s --yes-to; a read stays as is', () => {
  const a = (cmd, o) => F.argv(F.stewardPart(cmd), o);
  assert.deepEqual(a('steward config sync'), ['config', 'sync', '--apply', '--unattended']);
  assert.deepEqual(a('steward sc prune'), ['sc', 'prune', '--unattended']);
  assert.deepEqual(a('steward fleet prune-merged ~/r', { yesTo: ['prune-merged'] }), ['fleet', 'prune-merged', '~/r', '--apply', '--unattended', '--yes-to', 'prune-merged']);
  assert.deepEqual(a('steward review'), ['review']);
  assert.deepEqual(a('DRY_RUN=1 steward sc prune'), ['sc', 'prune']);
  assert.deepEqual(F.stewardPart('DRY_RUN=1 steward sc prune').env, { DRY_RUN: '1' });
  assert.deepEqual(a('steward sc install-hybrids', { attended: true }), ['sc', 'install-hybrids']);
  assert.deepEqual(a('steward projects reconcile --rollback ~/r.json'), ['projects', 'reconcile', '--rollback', '~/r.json', '--unattended']);
});

// fake(codes) — a stand-in exec: records each call, answers with the code given for its first two words
function fake(codes = {}) {
  const calls = [];
  const exec = async x => { calls.push(x); const key = x.argv.slice(0, 2).join(' '); return { code: codes[key] ?? 0, receipts: codes[`${key}:receipt`] ? [codes[`${key}:receipt`]] : [], tail: codes[`${key}:tail`] || '' }; };
  return { calls, exec };
}

test('work: the policy decides what runs; a human step and a shell command never run; a step waits on its after', async () => {
  const f = fake({ 'config sync': 4, 'config sync:tail': 'not answering "mise install"' });
  const items = [
    item('aqe-partial', 'rm -rf ~/x.partial, then ~/e/ai-tooling/qualify/aqe/promote.sh 3.15.16', { actor: 'human' }),
    item('config-behind', 'steward config sync'),
    item('hybrid-vs-policy', 'steward sc install-hybrids', { after: ['config-behind'], actor: 'agent-with-yes' }),
    item('review-due', 'steward review'),
    item('merge', 'gh pr merge 64'),
  ];
  const r = await F.work(items, { policy: SAFE, exec: f.exec });
  assert.deepEqual(r.results.map(x => [x.id, x.outcome]), [['aqe-partial', 'yours'], ['config-behind', 'waiting'], ['hybrid-vs-policy', 'skipped'], ['review-due', 'done'], ['merge', 'yours']]);
  assert.deepEqual(f.calls.map(c => c.argv.join(' ')), ['config sync --apply --unattended', 'review'], 'nothing else ran');
  assert.match(r.results[1].why, /a question it may not answer: not answering "mise install"/);
  assert.match(r.results[2].why, /waits on config-behind/);
  assert.equal(r.failed, null);
});

test('work: the first failure stops the run, with the rollback from the step or its receipt; the rest is not run', async () => {
  const rc = path.join(ROOT, 'receipt.json');
  fs.writeFileSync(rc, JSON.stringify({ kind: 'reconcile', rollback: 'steward projects reconcile --rollback ~/r.json' }));
  const f = fake({ 'projects reconcile': 1, 'projects reconcile:receipt': rc, 'projects reconcile:tail': 'a copy changed since' });
  const r = await F.work([item('soak', 'DRY_RUN=1 steward sc prune, then steward sc prune'), item('projects-behind', 'steward projects reconcile --all'), item('review-due', 'steward review')], { policy: SAFE, exec: f.exec });
  assert.deepEqual(r.results.map(x => x.outcome), ['done', 'failed', 'not-run']);
  assert.equal(r.failed, 'projects-behind');
  assert.equal(r.results[1].rollback, 'steward projects reconcile --rollback ~/r.json');
  assert.match(r.results[1].why, /steward projects reconcile --all exited 1: a copy changed since/);
  assert.deepEqual(f.calls.map(c => [c.argv.join(' '), c.env]), [['sc prune', { DRY_RUN: '1' }], ['sc prune --unattended', {}], ['projects reconcile --all --apply --unattended', {}]]);
  const s = F.summary(r.results).join('\n');
  assert.match(s, /^done \(1\):\n {2}soak\n/m);
  assert.match(s, /failed \(1\):\n {2}projects-behind\n {4}steward projects reconcile --all\n {4}failed: [^\n]+\n {4}receipt [^\n]+\n {4}rollback: steward projects reconcile --rollback ~\/r\.json/);
  assert.match(s, /not run \(1\):\n {2}review-due/);
});

test('work: from Claude a step that needs a yes waits, naming the one command for it; at a terminal it asks', async () => {
  const items = [item('prune-merged', 'steward fleet prune-merged ~/r'), item('hybrids', 'steward sc link', { actor: 'agent-with-yes' })];
  const quiet = fake();
  const r = await F.work(items, { policy: SAFE, exec: quiet.exec });
  assert.deepEqual(r.results.map(x => x.outcome), ['waiting', 'waiting']);
  assert.match(r.results[0].why, /steward fix --apply --only prune-merged --yes-to prune-merged$/);
  assert.match(r.results[1].why, /run it in your terminal: steward sc link$/);
  assert.equal(quiet.calls.length, 0);
  // at a terminal: a yes, then a no
  const t = fake();
  const answers = [true, false];
  const r2 = await F.work(items, { policy: SAFE, exec: t.exec, tty: true, ask: async () => answers.shift() });
  assert.deepEqual(r2.results.map(x => x.outcome), ['done', 'declined']);
  assert.deepEqual(t.calls.map(c => [c.argv.join(' '), c.attended]), [['fleet prune-merged ~/r --apply --unattended --yes-to prune-merged', false]]);
  // a terminal step runs with its own questions (attended)
  const t2 = fake();
  await F.work([items[1]], { policy: SAFE, exec: t2.exec, tty: true, ask: async () => true });
  assert.deepEqual(t2.calls.map(c => [c.argv.join(' '), c.attended]), [['sc link', true]]);
  // --only with the user's yes
  const o = fake();
  const r3 = await F.work(items, { policy: SAFE, exec: o.exec, only: 'prune-merged', yesTo: ['prune-merged'] });
  assert.deepEqual(r3.results.map(x => [x.id, x.outcome]), [['prune-merged', 'done']]);
});

test('--yes-to: only with --unattended, a real class, and it widens the run it is given to, no more', () => {
  assert.match(steward(['fleet', 'sync', ROOT, '--yes-to', 'fleet-sync']).stderr, /--yes-to goes with --unattended/);
  assert.match(steward(['fleet', 'sync', ROOT, '--unattended', '--yes-to', 'merge']).stderr, /--yes-to takes a class .*got "merge"/);
  const ask = settings('[autonomy]\nlevel = "ask"');
  const f = behind();
  const held = steward(['fleet', 'sync', f.work, '--apply', '--unattended'], { STEWARD_CONFIG: ask });
  assert.equal(held.status, 4, held.stderr);
  const r = steward(['fleet', 'sync', f.work, '--apply', '--unattended', '--yes-to', 'fleet-sync'], { STEWARD_CONFIG: ask });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /unattended: yes to "Drop the edits above and fast-forward\?" \(your yes to fleet-sync for this run \(--yes-to\)\)/);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), f.tip);
  const bk = path.join(ENV.XDG_STATE_HOME, 'workstation-steward', 'backups');
  const rc = JSON.parse(fs.readFileSync(path.join(bk, fs.readdirSync(bk).filter(d => d.startsWith(`sync-${path.basename(f.work)}-`)).pop(), 'receipt.json'), 'utf8'));
  assert.equal(rc.unattended, true);
  assert.deepEqual(rc.yes_to, ['fleet-sync']);
  // a yes to one class answers no other, and STEWARD_YES_TO from outside is dropped
  const other = steward(['fleet', 'sync', behind().work, '--apply', '--unattended', '--yes-to', 'pull'], { STEWARD_CONFIG: ask });
  assert.equal(other.status, 4);
  const env = steward(['fleet', 'sync', behind().work, '--apply', '--unattended'], { STEWARD_CONFIG: ask, STEWARD_YES_TO: 'fleet-sync' });
  assert.equal(env.status, 4);
  // bash confirm reads the grant too
  const sh = spawnSync('bash', ['-c', `source "${path.join(REPO, 'lib', 'lib.sh')}"; confirm "Delete them?" prune && echo YES`], { encoding: 'utf8', input: '', env: { ...ENV, STEWARD_UNATTENDED: '1', STEWARD_YES_TO: 'prune', STEWARD_CONFIG: ask } });
  assert.match(sh.stdout, /YES/, sh.stderr);
});

test('steward fix end to end: the plan changes nothing; --apply runs the allowed step, hands over the rest, writes a record', () => {
  const f = behind();
  const canary = path.join(ROOT, `canary-${++k}`);
  fs.writeFileSync(canary, 'keep\n');
  const list = path.join(ROOT, `list-${k}.json`);
  fs.writeFileSync(list, JSON.stringify({ items: [
    { id: 'sync', text: 'the checkout is behind', cmd: `steward fleet sync ${f.work}`, actor: 'agent', after: [] },
    { id: 'rm', text: 'a forged step', cmd: `rm ${canary}`, actor: 'agent', after: [] },
    { id: 'hybrids', text: 'hybrids out of step', cmd: 'steward sc install-hybrids', actor: 'agent-with-yes', after: ['sync'] },
  ] }));
  const safe = settings('[autonomy]\nlevel = "safe"');
  const plan = steward(['fix', '--from', list, '--json'], { STEWARD_CONFIG: safe });
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).items.map(x => x.plan.how), ['run', 'yours', 'ask']);
  assert.equal(JSON.parse(plan.stdout).subagents, 4);
  assert.notEqual(git(f.work, 'rev-parse', 'HEAD'), f.tip, 'the plan ran nothing');
  const r = steward(['fix', '--apply', '--from', list, '--json'], { STEWARD_CONFIG: safe });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.results.map(x => [x.id, x.outcome]), [['sync', 'done'], ['rm', 'yours'], ['hybrids', 'waiting']]);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), f.tip);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'keep\n', 'a shell command in the list never runs');
  assert.equal(j.results[0].receipts.length, 1);
  const home = os.homedir();
  const untilde = p => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  assert.equal(JSON.parse(fs.readFileSync(untilde(j.results[0].receipts[0]), 'utf8')).unattended, true);
  const rec = JSON.parse(fs.readFileSync(untilde(j.receipt), 'utf8'));
  assert.equal(rec.kind, 'fix'); assert.equal(rec.complete, true); assert.equal(rec.outcome, 'done');
  assert.match(fs.readFileSync(untilde(rec.steps[0].logs[0]), 'utf8'), /^\$ steward fleet sync .* --apply --unattended\n/);
  // --yes-to is for one step
  assert.match(steward(['fix', '--apply', '--from', list, '--yes-to', 'fleet-sync'], { STEWARD_CONFIG: safe }).stderr, /--yes-to needs --only <id>/);
  assert.match(steward(['fix', '--apply', '--from', list, '--only', 'nope'], { STEWARD_CONFIG: safe }).stderr, /no step "nope"/);
});

test('brief: a fix run that stopped midway is a finding, but not while its process is still running', () => {
  const B = require('../lib/brief.js');
  const at = new Date(Date.now() - 60 * 60e3);
  const facts = pid => ({ now: new Date(), autonomy: SAFE, backups: [{ name: 'fix-20261031T000000Z', dir: '/x', rp: '/x/receipt.json', hasReceipt: true, kind: 'fix', at,
    receipt: { kind: 'fix', at: at.toISOString(), pid, complete: false, steps: [{ outcome: 'done' }, { outcome: 'done' }] } }] });
  const det = B.DETECTORS.filter(d => d.id === 'receipt-unfinished');
  assert.deepEqual(B.run(facts(process.pid), det), [], 'still running');
  const [x] = B.run(facts(99999999), det);
  assert.equal(x.text, 'fix stopped midway (2 step(s) done)', 'the briefing adds "steward " before it');
  assert.equal(x.cmd, 'steward brief --all');
  assert.equal(x.skill, 'fix');
});
