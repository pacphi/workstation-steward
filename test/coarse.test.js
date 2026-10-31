// The bundled commands (lib/coarse.js, D61): steward ai fix, fleet tidy, projects apply and upgrade. Each plans every
// part, takes one yes, then runs each part through bin/steward.js with --unattended and the user's yes to that part's
// class; a part that stops at a question it may not answer waits on the user (exit 4), a failure stops the rest. The
// record is the fix runner's, and the briefing names one left unfinished. Stand-ins for every part; no network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-coarse-')));
process.env.STEWARD_INSTANCE = path.join(REPO, 'examples');
process.env.XDG_STATE_HOME = path.join(ROOT, 'state');
const K = require('../lib/coarse.js');
const { COMMANDS, find } = require('../lib/commands.js');
const SAFE = { level: 'safe', allow: [], deny: [] };

/** @type {NodeJS.ProcessEnv} */
const BASE = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', STEWARD_NO_REFRESH: '1' };
delete BASE.STEWARD_CONFIG;
const steward = (args, env = {}) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), ...args], { encoding: 'utf8', input: '', env: { ...BASE, ...env } });
// copy(name, level) — the examples as a throwaway instance (cp -RL: never a link back to them), with [autonomy] level
// and both add-ons on, and a throwaway HOME beside it
function copy(name, level) {
  const d = path.join(ROOT, name);
  fs.cpSync(path.join(REPO, 'examples'), d, { recursive: true, dereference: true });
  const f = path.join(d, 'steward.toml');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^level = "safe"/m, `level = "${level}"`).replace(/^ai_tooling = false/m, 'ai_tooling = true').replace(/^projects = false/m, 'projects = true'));
  fs.mkdirSync(path.join(ROOT, `${name}-home`));
  return { STEWARD_INSTANCE: d, HOME: path.join(ROOT, `${name}-home`), XDG_STATE_HOME: path.join(ROOT, `${name}-state`), XDG_CONFIG_HOME: path.join(ROOT, `${name}-home`, '.config') };
}
// stand-ins for npm, mise and ruflo, first on PATH: each records that it ran and fails, so nothing real is installed
const STUBS = path.join(ROOT, 'stubs');
fs.mkdirSync(STUBS);
for (const n of ['npm', 'mise', 'ruflo']) fs.writeFileSync(path.join(STUBS, n), `#!/bin/sh\necho "$0 $*" >> "${path.join(ROOT, 'stub-calls')}"\nexit 1\n`, { mode: 0o755 });
// oneHybrid(env) — a hybrids.toml with one hybrid (the examples have none), so install-hybrids has something to plan
const oneHybrid = env => fs.writeFileSync(path.join(env.STEWARD_INSTANCE, 'supply-chain', 'hybrids.toml'),
  '[[hybrid]]\nname = "ruflo"\nversion = "3.63.9"\nsource = "registry"\nallow_scripts = ["ruflo", "better-sqlite3"]\nstate_backup = "ruflo-policy"\n');
const INDEX = [{ version: 'v26.14.0', security: false }, { version: 'v26.13.1', security: true }, { version: 'v26.12.1', security: false }, { version: 'v24.9.0', security: true }];

test('commands: each bundled command writes, has the class of its most demanding part, takes --unattended, and its parts name it', () => {
  /** @type {[string[], string][]} */
  const want = [[['ai', 'fix'], 'ai-fix'], [['fleet', 'tidy', 'x'], 'prune-merged'], [['projects', 'apply'], 'onboard'], [['upgrade'], 'upgrade']];
  for (const [words, cls] of want) {
    const c = find(words).cmd;
    assert.deepEqual([c.writes, c.class, c.unattended], [true, cls, true], words.join(' '));
    assert.deepEqual(c.run, ['node', 'lib/coarse.js', K.key(c)], words.join(' '));
  }
  const parents = COMMANDS.filter(c => c.parent).map(c => `${c.area} ${c.name} → ${c.parent}`);
  assert.deepEqual(parents.sort(), ['ai approvals → ai fix', 'ai guard → ai fix', 'ai repin → ai fix', 'ai timeouts → ai fix', 'ai transport → ai fix',
    'fleet prune-merged → fleet tidy', 'fleet sync → fleet tidy', 'projects offboard → projects apply', 'projects onboard → projects apply',
    'projects reconcile → projects apply', 'sc install-hybrids → upgrade', 'sc node-patch → upgrade', 'sc upgrade → upgrade']);
  for (const c of COMMANDS.filter(x => x.parent && x.writes && x.name !== 'reconcile' && x.area !== 'fleet')) assert.ok(c.unattended, `${c.area} ${c.name} answers under --unattended`);
});

test('ai fix and fleet tidy: every part, in order; tidy prunes only after the sync', async () => {
  const ai = await K.parts('ai fix', [], {});
  assert.deepEqual(ai.items.map(x => x.cmd), ['repin', 'guard', 'timeouts', 'approvals', 'transport'].map(n => `steward ai ${n}`));
  const t = await K.parts('fleet tidy', ['~/src/app'], {});
  assert.deepEqual(t.items.map(x => [x.cmd, x.after || []]), [['steward fleet sync ~/src/app', []], ['steward fleet prune-merged ~/src/app', ['sync']]]);
});

test('upgrade: a Node security release comes first and names what it does; else hybrids out of step; sc upgrade always', async () => {
  const node = await K.parts('upgrade', [], { node: '26.12.1', nodeIndex: async () => INDEX, hybrids: () => ({ text: 'hybrids out of step with hybrids.toml: ruflo 3.63.5 → 3.63.9' }) });
  assert.deepEqual(node.items.map(x => x.cmd), ['steward sc node-patch 26.14.0', 'steward sc upgrade']);
  assert.match(node.items[0].text, /Node security release 26\.13\.1 .*: to 26\.14\.0.*reinstalls the hybrids.*backs up every Ruflo policy folder/);
  const hyb = await K.parts('upgrade', [], { node: '26.13.1', nodeIndex: async () => INDEX, hybrids: () => ({ text: 'hybrids out of step with hybrids.toml: ruflo 3.63.5 → 3.63.9' }) });
  assert.deepEqual(hyb.items.map(x => x.cmd), ['steward sc install-hybrids', 'steward sc upgrade']);
  assert.match(hyb.items[0].text, /ruflo 3\.63\.5 → 3\.63\.9.*a Ruflo version change backs up its policy folders first/);
  const off = await K.parts('upgrade', [], { node: '26.13.1', nodeIndex: async () => { throw new Error('offline'); }, hybrids: () => null });
  assert.deepEqual(off.items.map(x => x.cmd), ['steward sc upgrade']);
  assert.match(off.notes.join('\n'), /couldn't check for a Node security release \(offline\)/);
});

test('projects apply: onboard, offboard and reconcile where the registry says; a refusal is yours, not a part', async () => {
  const reg = [
    { abs: '/p/a', path: '~/p/a', decision: 'onboarded', ai: ['ruflo'] },
    { abs: '/p/b', path: '~/p/b', decision: 'onboarded', ai: ['aqe'] },
    { abs: '/p/c', path: '~/p/c', decision: 'ignored', ai: [] },
    { abs: '/p/d', path: '~/p/d', decision: 'onboarded', ai: ['ruflo'] },
  ];
  const r = await K.parts('projects apply', [], {
    registry: () => reg, exists: () => true, home: '/p',
    onboard: d => ({ project: d, files: d === '/p/d' ? [] : [{ action: 'edit' }], refusals: d === '/p/b' ? ['mid-merge'] : [] }),
    offboard: d => ({ project: d, n: d === '/p/c' ? 2 : 0, refusals: [] }),
    behind: () => [{ project: '~/p/e', update: 3 }],
  });
  assert.deepEqual(r.items.map(x => x.cmd), ['steward projects onboard ~/a', 'steward projects offboard ~/c', 'steward projects reconcile --all']);
  assert.match(r.notes.join('\n'), /~\/b: onboard refuses: mid-merge/);
});

test('run: one yes reaches each part as --yes-to its own class; exit 4 waits on you; a failure stops the rest', async () => {
  const items = (await K.parts('ai fix', [], {})).items;
  const calls = [];
  const exec = codes => async ({ argv }) => { calls.push(argv.join(' ')); return { code: codes[calls.length - 1] || 0, receipts: [] }; };
  const ok = await K.run(items, { policy: { level: 'ask', allow: [], deny: [] }, yesTo: ['ai-fix'], exec: exec([]) });
  assert.equal(ok.code, 0);
  assert.equal(calls[0], 'ai repin --apply --unattended --yes-to ai-fix');
  assert.equal(calls.length, 5);
  calls.length = 0;
  const wait = await K.run(items, { policy: SAFE, yesTo: ['ai-fix'], exec: exec([0, 4]) });
  assert.equal(wait.code, 4);
  assert.deepEqual(wait.results.map(r => r.outcome), ['done', 'waiting', 'done', 'done', 'done']);
  calls.length = 0;
  const bad = await K.run(items, { policy: SAFE, yesTo: ['ai-fix'], exec: exec([0, 0, 1]) });
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.results.map(r => r.outcome), ['done', 'done', 'failed', 'not-run', 'not-run']);
  calls.length = 0;
  // unattended, with no yes: only what [autonomy] allows runs; the rest waits
  const un = await K.run(items, { policy: SAFE, yesTo: [], exec: exec([]) });
  assert.equal(un.code, 4);
  assert.deepEqual(calls, []);
});

test('the command: plan only without a terminal; --unattended under level "ask" refuses before any part runs', () => {
  const env = copy('ask', 'ask');
  const plan = steward(['ai', 'fix'], env);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /\[1\/5\] .*\n[\s\S]*\[5\/5\] /);
  assert.match(plan.stdout, /plan only: steward ai fix asks once/);
  const un = steward(['fleet', 'tidy', ROOT, '--unattended'], env);
  assert.equal(un.status, 4, un.stderr);
  assert.match(un.stderr, /level = "ask" doesn't allow prune-merged/);
  const part = steward(['ai', 'guard', '--apply', '--unattended'], env);
  assert.equal(part.status, 4, part.stderr);
  assert.match(part.stderr, /level = "ask" doesn't allow ai-fix/);
  assert.equal(fs.existsSync(path.join(env.XDG_STATE_HOME, 'workstation-steward', 'backups')), false, 'nothing ran, nothing recorded');
});

test('install-hybrids: under --unattended it stops (exit 4) unless [autonomy] allows install-hybrids, before installing', () => {
  const env = copy('hyb', 'maintainer');
  oneHybrid(env);
  const r = spawnSync(path.join(REPO, 'supply-chain', 'bin', 'install-hybrids'), [], { encoding: 'utf8',
    env: { ...BASE, ...env, PATH: `${STUBS}:${process.env.PATH}`, STEWARD_UNATTENDED: '1' } });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stderr, /not answering "Install the hybrids .*doesn't allow install-hybrids/);
  assert.equal(fs.existsSync(path.join(ROOT, 'stub-calls')), false, 'npm, mise and ruflo never ran');
  // allowed, it goes on to install: here only as far as the stand-ins
  const ok = copy('hyb-ok', 'maintainer');
  oneHybrid(ok);
  const toml = path.join(ok.STEWARD_INSTANCE, 'steward.toml');
  fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace(/^allow = \[\]/m, 'allow = ["install-hybrids"]'));
  const r2 = spawnSync(path.join(REPO, 'supply-chain', 'bin', 'install-hybrids'), [], { encoding: 'utf8',
    env: { ...BASE, ...ok, PATH: `${STUBS}:${process.env.PATH}`, STEWARD_UNATTENDED: '1' } });
  assert.match(r2.stderr, /unattended: yes to "Install the hybrids/);
  assert.ok(fs.existsSync(path.join(ROOT, 'stub-calls')), 'past the guard, the install steps ran (the stand-ins)');
  fs.rmSync(path.join(ROOT, 'stub-calls'));
});

test('install-hybrids at a terminal: the plan (each hybrid, its scripts, the Ruflo backup), then [y/N]; no installs nothing', () => {
  const env = copy('hyb-ask', 'safe');
  oneHybrid(env);
  const run = input => spawnSync(path.join(REPO, 'supply-chain', 'bin', 'install-hybrids'), [], { encoding: 'utf8', input, env: { ...BASE, ...env, PATH: `${STUBS}:${process.env.PATH}` } });
  const no = run('n\n');
  assert.equal(no.status, 0, no.stdout + no.stderr);
  assert.match(no.stdout, /ruflo@3\.63\.9 +scripts: ruflo,better-sqlite3 +Ruflo policy backup first \(no receipt → 3\.63\.9; its first run migrates the policy state\)/);
  assert.match(no.stdout, /nothing changed/);
  assert.equal(fs.existsSync(path.join(ROOT, 'stub-calls')), false, 'a no installs nothing');
  run('y\n');
  assert.match(fs.readFileSync(path.join(ROOT, 'stub-calls'), 'utf8'), /npm install -g --allow-scripts=ruflo,better-sqlite3 ruflo@3\.63\.9/, 'a yes installs (the stand-in)');
  fs.rmSync(path.join(ROOT, 'stub-calls'));
});

test('end to end: steward ai fix, one yes on stdin: each part runs --apply --unattended --yes-to ai-fix; the record; the briefing', () => {
  const env = copy('e2e', 'ask');
  // no Claude Code settings file: ai guard creates one (test/guard.test.js)
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'ai', 'fix'], { encoding: 'utf8', input: 'y\n', env: { ...BASE, ...env } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const backups = path.join(env.XDG_STATE_HOME, 'workstation-steward', 'backups');
  const dir = fs.readdirSync(backups).find(d => d.startsWith('coarse-ai-fix-'));
  assert.ok(dir, 'the record');
  const rec = JSON.parse(fs.readFileSync(path.join(backups, dir, 'receipt.json'), 'utf8'));
  assert.deepEqual([rec.kind, rec.command, rec.complete, rec.outcome, rec.parts, rec.yes_to], ['coarse', 'ai fix', true, 'done', 5, ['ai-fix']]);
  const home = env.HOME;
  const untilde = p => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  for (const [i, n] of ['repin', 'guard', 'timeouts', 'approvals', 'transport'].entries()) {
    assert.equal(rec.steps[i].outcome, 'done', n);
    const log = fs.readFileSync(untilde(rec.steps[i].logs[0]), 'utf8');
    assert.match(log, new RegExp(`^\\$ steward ai ${n} --apply --unattended --yes-to ai-fix\n`), n);
    for (const f of rec.steps[i].receipts) assert.deepEqual(JSON.parse(fs.readFileSync(untilde(f), 'utf8')).yes_to, ['ai-fix'], `${n}: its receipt records the yes`);
  }
  // the same run left unfinished, its process gone: the briefing names it (without the finished run, which would
  // supersede it)
  fs.rmSync(path.join(backups, dir), { recursive: true });
  const stopped = path.join(backups, 'coarse-ai-fix-20261030T080000');
  fs.mkdirSync(stopped);
  fs.writeFileSync(path.join(stopped, 'receipt.json'), JSON.stringify({ ...rec, at: '2026-10-30T08:00:00.000Z', pid: 999999, complete: false, outcome: 'started', steps: rec.steps.slice(0, 2) }));
  const b = steward(['brief', '--all'], env);
  assert.match(b.stdout, /steward ai fix stopped midway: 2 of 5 part\(s\) done/);
});

test('briefing: a bundled run left unfinished names its command and what it finished; a live one is left alone', () => {
  const B = require('../lib/brief.js');
  const det = B.DETECTORS.find(d => d.id === 'receipt-unfinished');
  const at = new Date('2026-10-30T10:00:00Z');
  const rc = (pid, extra = {}) => ({ kind: 'coarse', command: 'ai fix', name: 'ai fix', at: at.toISOString(), pid, complete: false, steps: [{ outcome: 'done' }, { outcome: 'failed' }], parts: 5, ...extra });
  const f = r => ({ now: new Date(at.getTime() + 3600e3), backups: [{ name: 'coarse-ai-fix-20261030T100000', kind: 'coarse', at, receipt: r, rp: '/s/r.json', hasReceipt: true }] });
  const [x] = det.check(f(rc(999999)));
  assert.match(x.text, /steward ai fix stopped midway: 1 of 5 part\(s\) done/);
  assert.equal(x.cmd, 'steward ai fix');
  assert.deepEqual(det.check(f(rc(process.pid))), [], 'still running');
  const [y] = det.check(f(rc(999999, { command: 'fleet tidy', name: 'fleet tidy', repo: '/r/app', args: ['~/app'] })));
  assert.equal(y.cmd, 'steward fleet tidy ~/app');
});

test('help: a part says which bundled command runs it', () => {
  const env = { STEWARD_INSTANCE: path.join(REPO, 'examples'), XDG_STATE_HOME: path.join(ROOT, 's5') };
  const h = steward(['help', 'ai', 'repin'], env).stdout;
  assert.match(h, /part of: steward ai fix \(runs it with the others, one yes for all\)/);
  const u = steward(['help', 'upgrade'], env).stdout;
  assert.match(u, /runs: steward sc upgrade, steward sc node-patch, steward sc install-hybrids/);
});

test('steward projects --apply: asks each new project its decision, shows the change, records it on a yes', () => {
  const env = copy('pj', 'safe');
  const roots = path.join(ROOT, 'pj-roots');
  for (const n of ['app', 'tool']) { fs.mkdirSync(path.join(roots, n), { recursive: true }); spawnSync('git', ['init', '-q', path.join(roots, n)]); }
  const toml = path.join(env.STEWARD_INSTANCE, 'steward.toml');
  fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace(/^roots = .*$/m, `roots = ["${roots}"]`));
  const reg = path.join(env.STEWARD_INSTANCE, 'projects', 'registry.toml');
  const before = fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8') : '';
  const plan = steward(['projects'], env);
  assert.match(plan.stdout, /new \(2\)[\s\S]*steward projects --apply asks each one's decision/);
  const no = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'projects', '--apply'], { encoding: 'utf8', input: 'i\n\nn\n', env: { ...BASE, ...env } });
  assert.match(no.stdout, /pj-roots\/app: new → ignored \[\]/);
  assert.doesNotMatch(no.stdout, /tool: new/, 'Enter skips one');
  assert.match(no.stdout, /nothing changed/);
  assert.equal(fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8') : '', before, 'a no records nothing');
  const yes = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'projects', '--apply'], { encoding: 'utf8', input: 'o\nruflo\nd\n2026-12-01\ny\n', env: { ...BASE, ...env } });
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /recorded 2/);
  const after = fs.readFileSync(reg, 'utf8');
  assert.match(after, /app"[\s\S]*decision = "onboarded"[\s\S]*ai = \["ruflo"\]/);
  assert.match(after, /tool"[\s\S]*decision = "deferred"[\s\S]*until = "2026-12-01"/);
  // a backup and a receipt first, and a way back
  const rp = yes.stdout.match(/rollback: steward projects decide --rollback (\S+)/)[1].replace(/^~/, env.HOME);
  const rc = JSON.parse(fs.readFileSync(rp, 'utf8'));
  assert.deepEqual([rc.kind, rc.complete, rc.changes.length], ['registry', true, 2]);
  assert.deepEqual(rc.changes.map(c => [c.before, c.after.decision]), [[null, 'onboarded'], [null, 'deferred']]);
  const back = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'projects', 'decide', '--rollback', rp], { encoding: 'utf8', input: 'y\n', env: { ...BASE, ...env } });
  assert.equal(back.status, 0, back.stderr);
  assert.equal(fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8') : '', before, 'the registry as it was');
  assert.equal(JSON.parse(fs.readFileSync(rp, 'utf8')).rolled_back, true);
  // a registry changed since: the rollback refuses
  const again = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'projects', '--apply'], { encoding: 'utf8', input: 'i\ni\ny\n', env: { ...BASE, ...env } });
  const rp2 = again.stdout.match(/rollback: steward projects decide --rollback (\S+)/)[1].replace(/^~/, env.HOME);
  fs.appendFileSync(reg, '# an edit by hand\n');
  const refused = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'projects', 'decide', '--rollback', rp2], { encoding: 'utf8', input: 'y\n', env: { ...BASE, ...env } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing: .*registry\.toml changed since/);
  // a decide that stopped before its write finished (no sha_after): its rollback still puts the backup back
  const stopped = { ...JSON.parse(fs.readFileSync(rp2, 'utf8')), complete: false };
  delete stopped.sha_after;
  fs.writeFileSync(rp2, JSON.stringify(stopped));
  const undo = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'projects', 'decide', '--rollback', rp2], { encoding: 'utf8', input: 'y\n', env: { ...BASE, ...env } });
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(fs.readFileSync(reg, 'utf8'), fs.readFileSync(stopped.backup.replace(/^~/, env.HOME), 'utf8'));
});
