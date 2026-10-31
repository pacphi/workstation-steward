// Autonomy (D58): the class and actor the engine gives each step (lib/autonomy.js), the [autonomy] table in
// steward.toml, the work lists (`steward brief --plan`, `steward review --json`) and --unattended in bin/steward.js,
// on throwaway repos with a local bare remote. State goes to a temporary XDG_STATE_HOME. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const A = require('../lib/autonomy.js');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-autonomy-')));
/** @type {NodeJS.ProcessEnv} */
const ENV = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', STEWARD_NO_REFRESH: '1', XDG_STATE_HOME: path.join(ROOT, 'state'), XDG_CONFIG_HOME: path.join(ROOT, 'xdg'),
  GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'), STEWARD_INSTANCE: path.join(REPO, 'examples') };
delete ENV.STEWARD_CONFIG;
delete ENV.STEWARD_UNATTENDED;
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@e.com\n');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let k = 0;

// settings(toml) — a steward.toml for STEWARD_CONFIG: the examples' add-ons, mise's config in the temp folder, and toml
function settings(toml) {
  const f = path.join(ROOT, `steward-${++k}.toml`);
  fs.writeFileSync(f, `schema = 1\n[paths]\nmise_config_dir = "${path.join(ROOT, 'mise')}"\n${toml}\n`);
  return f;
}
const steward = (args, env = {}, input = '') => spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), ...args], { encoding: 'utf8', env: { ...ENV, ...env }, input });

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
const MAINT = { level: 'maintainer', allow: [], deny: [] };
const EVERY = { level: 'maintainer', allow: Object.keys(A.CLASSES), deny: [] };
const who = (cmd, a) => { const c = A.classify(cmd, a); return `${c.actor}${c.class ? `:${c.class}` : ''}`; };

test('classify: the engine labels each step: read-only, a class the level allows, one that asks, and the user\'s', () => {
  assert.equal(who('steward review', ASK), 'agent');
  assert.equal(who('steward config sync', SAFE), 'agent:pull');
  assert.equal(who('steward config sync', ASK), 'agent-with-yes:pull');
  assert.equal(who('DRY_RUN=1 steward sc prune, then steward sc prune', SAFE), 'agent:prune');
  assert.equal(who('steward projects reconcile --all', SAFE), 'agent:reconcile');
  assert.equal(who('gh pr view 3 -R o/r', ASK), 'agent');
  // a step of several takes what its most demanding part needs
  assert.equal(who('steward config sync, then steward sc install-hybrids', SAFE), 'agent-with-yes:install-hybrids');
  assert.equal(who('steward projects scan, then steward projects decide <path>', SAFE), 'agent-with-yes:registry');
  // the maintainer's flows: the level that names them
  assert.equal(who('/steward-maintain release 0.10.0 repin 0.10.0', SAFE), 'agent-with-yes:release-verify');
  assert.equal(who('/steward-maintain release 0.10.0 repin 0.10.0', MAINT), 'agent:release-verify');
  assert.equal(who('/steward-maintain repin 0.10.0', { ...MAINT, deny: ['repin'] }), 'agent-with-yes:repin');
  assert.equal(who('just release-worktree v0.10.0', MAINT), 'agent:repin');
  // a rollback, an install and an engine script are classes of their own
  assert.equal(who('steward projects reconcile --rollback ~/r.json', MAINT), 'agent-with-yes:rollback');
  assert.equal(who('steward doctor --install', MAINT), 'agent-with-yes:install');
  assert.equal(who('~/e/ai-tooling/qualify/aqe/promote.sh 3.15.16', MAINT), 'agent-with-yes:promote');
  assert.equal(who('~/e/ai-tooling/qualify/aqe/run.sh 3.15.17 build', SAFE), 'agent:qualify');
  // allow widens: install-hybrids asks at every level until it is listed
  for (const a of [ASK, SAFE, MAINT]) assert.equal(who('steward sc install-hybrids', a), 'agent-with-yes:install-hybrids');
  assert.equal(who('steward sc install-hybrids', { ...SAFE, allow: ['install-hybrids'] }), 'agent:install-hybrids');
  assert.deepEqual(A.classify(null, SAFE), { class: null, actor: null, steps: [] });
});

test('classify: human-only steps stay the user\'s under every policy, even one that allows every class', () => {
  for (const cmd of ['rm -rf ~/.local/share/ai-tooling/aqe/releases/3.15.16.partial, then ~/e/ai-tooling/qualify/aqe/promote.sh 3.15.16',
    'mv ~/a ~/a.stopped, then ~/e/ai-tooling/qualify/aqe/promote.sh 3.15.16',
    'set [aqe] current = "3.15.16-local.1" in ai-tooling/ai-tooling.toml, then steward config sync',
    'steward skills install', 'gh pr merge 64 --squash', 'sudo security add-trusted-cert x', 'steward no-such-command',
    '~/e/skills/supply-chain/runbook.md (advisories and IOCs)', 'steward ai drift; ~/e/skills/ai-tooling/runbook.md']) {
    for (const a of [ASK, SAFE, MAINT, EVERY]) assert.equal(A.classify(cmd, a).actor, 'human', `${cmd} under ${a.level}`);
  }
});

test('the classes: every writing command has one (or is a person\'s), every level names only real ones', () => {
  const { COMMANDS } = require('../lib/commands.js');
  for (const c of COMMANDS.filter(x => x.writes)) {
    const name = `${c.area} ${c.name}`;
    if (c.area === 'skills') assert.equal(c.class, undefined, `${name} is run by a person`);
    else assert.ok(c.class in A.CLASSES, `${name} has a class`);
    if (c.unattended) assert.ok(c.class, `${name} takes --unattended only with a class`);
  }
  for (const c of COMMANDS.filter(x => !x.writes)) assert.equal(c.unattended, undefined, `${c.area} ${c.name} only reads`);
  for (const [l, cs] of Object.entries(A.LEVELS)) for (const c of cs) assert.ok(c in A.CLASSES, `${l}: ${c}`);
  assert.deepEqual([...A.allowed(SAFE)], ['pull', 'reconcile', 'prune', 'qualify', 'pr-prep']);
  assert.deepEqual([...A.allowed({ level: 'safe', allow: ['upgrade'], deny: ['prune'] })], ['pull', 'reconcile', 'qualify', 'pr-prep', 'upgrade']);
  assert.ok(!A.allowed(ASK).size);
});

test('[autonomy] in steward.toml: the defaults, a level and lists of classes; a wrong level or class is an error', () => {
  const check = toml => spawnSync(process.execPath, [path.join(REPO, 'lib', 'config.js'), '--check'], { encoding: 'utf8', env: { ...ENV, STEWARD_CONFIG: settings(toml) } });
  const ok = check('[autonomy]\nlevel = "maintainer"\nallow = ["install-hybrids"]\ndeny = ["repin"]\nsubagents = 2');
  assert.equal(ok.status, 0, ok.stderr);
  const bad = check('[autonomy]\nlevel = "yolo"\nallow = ["merge", "pull"]');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /autonomy\.level must be ask, safe, maintainer, got yolo/);
  assert.match(bad.stderr, /autonomy\.allow: unknown class "merge"/);
  assert.doesNotMatch(bad.stderr, /"pull"/);
  // with no [autonomy] table, the defaults; steward config says what runs unattended
  const shown = spawnSync(process.execPath, [path.join(REPO, 'lib', 'config.js')], { encoding: 'utf8', env: { ...ENV, STEWARD_CONFIG: settings('') } });
  assert.match(shown.stdout, /\[autonomy\]\n {2}level +safe +\[default\][\s\S]*subagents +4 +\[default\]\n {2}→ unattended: pull, reconcile, prune, qualify, pr-prep/);
});

test('brief: each finding carries its actor and class; the work list unfolds what waits on what, in order', () => {
  const B = require('../lib/brief.js');
  const det = (id, severity, cmd, after) => ({ id, severity, after, check: () => ({ key: id, text: id, cmd, writes: true }) });
  const found = B.run({ autonomy: SAFE }, [
    det('config-behind', 'act', 'steward config sync'),
    det('hybrid-vs-policy', 'act', 'steward sc install-hybrids', ['config-behind']),
    det('soak', 'do', 'DRY_RUN=1 steward sc prune, then steward sc prune', ['hybrid-vs-policy']),
    det('aqe-partial', 'fix', 'rm -rf ~/x.partial, then ~/e/ai-tooling/qualify/aqe/promote.sh 3.15.16'),
    det('review-due', 'do', 'steward review'),
  ]);
  const b = { v: 1, at: 'now', ...B.pick(found) };
  // the briefing still folds them into one next step
  assert.equal(b.next.id, 'aqe-partial');
  assert.equal(b.more[0].cmd, 'steward config sync, then steward sc install-hybrids, then DRY_RUN=1 steward sc prune, then steward sc prune');
  const items = B.workList(b).items;
  assert.deepEqual(items.map(x => [x.id, x.actor, x.class]), [
    ['aqe-partial', 'human', null], ['config-behind', 'agent', 'pull'], ['hybrid-vs-policy', 'agent-with-yes', 'install-hybrids'],
    ['soak', 'agent', 'prune'], ['review-due', 'agent', null]]);
  assert.deepEqual(items[2].after, ['config-behind']);
  assert.equal(items[1].cmd, 'steward config sync', 'each step keeps its own command');
  assert.match(B.planLines(b).join('\n'), /^1\. aqe-partial\n {3}→ rm -rf[^\n]*\[you do this\]\n2\. config-behind\n {3}→ steward config sync {3}\[runs unattended: pull\]/);
  assert.ok(B.RULES.some(r => /actor human: hand the command to the user/.test(r)));
  // the JSON the briefing and the hook hand over carries them too
  assert.equal(B.toJSON(b).next.actor, 'human');
});

test('brief --plan and --plan --json run on a real instance', () => {
  const r = steward(['brief', '--plan', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.v, 1);
  for (const x of j.items) assert.ok(['agent', 'agent-with-yes', 'human'].includes(x.actor), JSON.stringify(x));
  assert.equal(steward(['brief', '--plan']).status, 0);
});

test('review --json: the same item shape; by hand is the user\'s, a gate hold is a wait, a fleet repo is pr-prep', () => {
  const R = require('../lib/review.js');
  const sections = [
    { title: 'Supply chain', items: [{ text: 'app: Foo 1.0', how: 'by hand: update each app' }, { text: 'mise: node', cmd: 'steward sc plan, then steward sc upgrade' }] },
    { title: 'Waiting on the release-age gate', items: [{ text: 'o/r: x (held by the gate)', how: 'wait until 2026-11-01 10:00Z' }, { text: 'o/r: y', how: 'tick it under Pending Approval (after review)' }] },
    { title: 'Pull requests (o/c)', items: [{ text: '#3 bump', cmd: 'gh pr view 3 -R o/c' }] },
    { title: 'Fleet (bot PRs and Dependabot alerts)', items: [], table: { head: ['repo', 'critical', 'high', 'bot PRs'], rows: [['o/a', '1', '', '4']] } },
  ];
  const w = R.workItems(sections, SAFE);
  assert.deepEqual(w.map(x => [x.actor, x.class]), [['human', null], ['agent-with-yes', 'upgrade'], [null, null], ['human', null], ['agent', null], ['agent', 'pr-prep']]);
  assert.equal(w[2].wait, true);
  assert.equal(w[5].text, 'o/a: 1 critical, 4 bot PRs');
  assert.equal(w[5].skill, 'pr-consolidation');
  assert.equal(R.workItems(sections, ASK)[5].actor, 'agent-with-yes');
});

test('--unattended: a command a person runs, one not wired yet, and a class the level doesn\'t allow are refused (exit 4)', () => {
  const ask = settings('[autonomy]\nlevel = "ask"');
  const person = steward(['skills', 'install', '--unattended'], { STEWARD_CONFIG: ask });
  assert.equal(person.status, 4, person.stderr + person.stdout);
  assert.match(person.stderr, /not running "steward skills install" unattended: a person runs this one/);
  const unwired = steward(['sc', 'rollback', '--unattended'], { STEWARD_CONFIG: settings('[autonomy]\nlevel = "maintainer"\nallow = ["rollback"]') });
  assert.equal(unwired.status, 4, unwired.stderr + unwired.stdout);
  assert.match(unwired.stderr, /doesn't run unattended yet/);
  const f = behind();
  const held = steward(['fleet', 'sync', f.work, '--apply', '--unattended'], { STEWARD_CONFIG: settings('[autonomy]\nlevel = "safe"') });
  assert.equal(held.status, 4, held.stderr + held.stdout);
  assert.match(held.stderr, /level = "safe" doesn't allow after-merge\. To let it run unattended: allow = \["after-merge"\] in steward\.toml, or level = "maintainer"/);
  assert.notEqual(git(f.work, 'rev-parse', 'HEAD'), f.tip, 'nothing changed');
  // doctor installs only with --install, so that is refused too; on its own it reads
  const doctor = steward(['doctor', '--install', '--unattended'], { STEWARD_CONFIG: ask });
  assert.equal(doctor.status, 4, doctor.stderr + doctor.stdout);
  assert.match(doctor.stderr, /not running "steward doctor" unattended: it doesn't run unattended yet/);
  // a read-only command takes the flag and runs as ever
  assert.equal(steward(['brief', '--unattended'], { STEWARD_CONFIG: ask }).status, 0);
});

test('--unattended: an allowed class answers its own question, and the receipt says so; the environment alone does not', () => {
  const maint = settings('[autonomy]\nlevel = "maintainer"');
  const f = behind();
  // STEWARD_UNATTENDED from outside is dropped: without the flag, a person answers (and no one does)
  const env = steward(['fleet', 'sync', f.work, '--apply'], { STEWARD_CONFIG: maint, STEWARD_UNATTENDED: '1' });
  assert.equal(env.status, 1, env.stderr + env.stdout);
  assert.notEqual(git(f.work, 'rev-parse', 'HEAD'), f.tip);
  const r = steward(['fleet', 'sync', f.work, '--apply', '--unattended'], { STEWARD_CONFIG: maint });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /unattended: yes to "Drop the edits above and fast-forward\?" \(\[autonomy\] allows after-merge\)/);
  assert.equal(git(f.work, 'rev-parse', 'HEAD'), f.tip);
  const bk = path.join(ENV.XDG_STATE_HOME, 'workstation-steward', 'backups');
  const dir = fs.readdirSync(bk).filter(d => d.startsWith(`sync-${path.basename(f.work)}-`)).pop();
  const receipt = JSON.parse(fs.readFileSync(path.join(bk, dir, 'receipt.json'), 'utf8'));
  assert.equal(receipt.unattended, true);
  assert.equal(receipt.complete, true);
});

test('lib.sh confirm: under --unattended it answers by its class, or says why and exits 4', () => {
  const sh = (cls, env) => spawnSync('bash', ['-c', `source "${path.join(REPO, 'lib', 'lib.sh')}"; confirm "Delete them?" ${cls} && echo YES`], { encoding: 'utf8', env: { ...ENV, ...env }, input: '' });
  const yes = sh('prune', { STEWARD_UNATTENDED: '1', STEWARD_CONFIG: settings('[autonomy]\nlevel = "safe"') });
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /YES/);
  const no = sh('prune', { STEWARD_UNATTENDED: '1', STEWARD_CONFIG: settings('[autonomy]\nlevel = "ask"') });
  assert.equal(no.status, 4);
  assert.match(no.stderr, /not answering "Delete them\?": \[autonomy\] level = "ask" doesn't allow prune/);
  const none = sh('', { STEWARD_UNATTENDED: '1', STEWARD_CONFIG: settings('[autonomy]\nlevel = "maintainer"') });
  assert.equal(none.status, 4, 'a question with no class is a person\'s');
  assert.doesNotMatch(sh('prune', {}).stdout, /YES/, 'attended, an empty answer is a no');
});
