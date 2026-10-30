// lib/brief.js: each detector found and not found, the order of the next step, the output, and a whole run against a
// throwaway instance and state that touches no network (a stub gh, npm, curl and mise would leave a marker). The
// detectors read a facts object, so most cases build one by hand with the field names the real receipts use.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-brief-')));
const INST = path.join(ROOT, 'instance');
const STATE = path.join(ROOT, 'state');
const CACHE = path.join(ROOT, 'cache');
const AIT = path.join(ROOT, 'ai-tooling');
// git with no global or system config (no signing, no hooks), the same for the tests and for brief.js
const GITCFG = path.join(ROOT, 'gitconfig');
fs.writeFileSync(GITCFG, '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: GITCFG, GIT_CONFIG_NOSYSTEM: '1', STEWARD_INSTANCE: INST, NO_COLOR: '1' });
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

// the instance: AI tooling and projects on, its own Git repo with a bare "GitHub" next to it
write(path.join(INST, 'steward.toml'), `[paths]\nstate = "${STATE}"\ncache = "${CACHE}"\nai_tooling_root = "${AIT}"\n\n[profiles]\nai_tooling = true\nprojects = true\n`);
write(path.join(INST, 'supply-chain', 'hybrids.toml'), '[[hybrid]]\nname = "toolbox"\nversion = "1.2.0"\nsource = "registry"\nallow_scripts = ["toolbox"]\n');
write(path.join(INST, 'ai-tooling', 'ai-tooling.toml'), '[aqe]\nruntime = "{{AI_TOOLING_ROOT}}/aqe"\ncurrent = "3.15.16-local.1"\nbased_on = "3.15.16"\n\n[launch]\nnode = "{{AI_TOOLING_ROOT}}/node/bin/node"\nruflo = "{{AI_TOOLING_ROOT}}/ruflo"\nruvector = "{{AI_TOOLING_ROOT}}/ruvector"\n\n[ruflo_core]\nruntime = "{{AI_TOOLING_ROOT}}/ruflo-core"\n\n[ruflo]\nmarketplace = "{{AI_TOOLING_ROOT}}/ruflo/marketplace"\n');
write(path.join(INST, 'projects', 'registry.toml'), '# none\n');
git(ROOT, 'init', '-q', INST);
git(INST, 'add', '-A'); git(INST, 'commit', '-q', '-m', 'first');
git(ROOT, 'clone', '-q', '--bare', INST, path.join(ROOT, 'remote.git'));
git(INST, 'remote', 'add', 'origin', path.join(ROOT, 'remote.git'));
git(INST, 'fetch', '-q', 'origin'); git(INST, 'branch', '-q', '-u', 'origin/main');
// the hybrid installed as the policy here says, a day ago; the AQE runtime at the policy's release
write(path.join(STATE, 'hybrids', 'toolbox.json'), JSON.stringify({ name: 'toolbox', version: '1.2.0', allow_scripts: 'toolbox', node: '26.1.0', installed_at: new Date(Date.now() - 864e5).toISOString().replace(/\.\d+Z$/, 'Z'), engine: '0.9.0' }));
fs.mkdirSync(path.join(AIT, 'aqe', 'releases', '3.15.16-local.1'), { recursive: true });
fs.symlinkSync('releases/3.15.16-local.1', path.join(AIT, 'aqe', 'current'));
write(path.join(STATE, 'review', 'last-review.json'), JSON.stringify({ at: new Date().toISOString(), items: 0 }));

const B = require('../lib/brief.js');
const CR = require('../lib/configrepo.js');

const NOW = new Date('2026-10-30T12:00:00Z');
const ago = min => new Date(NOW.getTime() - min * 60e3);
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
// bk(name, receipt, minutes) — a backup folder as facts() reports it; name gets a time stamp when it has none
const bk = (name, receipt, min = 60) => {
  const at = ago(min), full = /\d{8}T\d{6}/.test(name) ? name : `${name}-${stamp(at)}`;
  const dir = path.join(STATE, 'backups', full);
  return { name: full, dir, rp: path.join(dir, 'receipt.json'), receipt, hasReceipt: Boolean(receipt), kind: (receipt && receipt.kind) || (full.match(/^(aqe-promote|repin-release|onboard|sync|mise-self-update)-/) || [])[1] || null, at };
};
// facts(o) — every field the detectors read, all quiet, overridden by o
const facts = (o = {}) => {
  const config = { dir: INST, repo: true, slug: 'someone/steward-config', branch: 'main', upstream: 'origin/main', changed: [], kinds: {}, ahead: 0, behind: 0, fetchedAt: null, upstreamFiles: [], ...(o.config || {}) };
  return {
    now: NOW, state: STATE, instance: INST, engine: '/opt/steward', profiles: { ai_tooling: true, projects: true }, policy: {},
    soak: { running: false, awaitingPrune: false, until: null, newest: null }, hybrids: { policy: [], receipts: {} }, backups: [], aqe: null, repin: null,
    reconcile: null, gate: null, review: { due: false, age: 1, days: 7 }, ...o, config, configNeeds: CR.needs(config),
  };
};
const found = (f, id) => B.run(f).filter(x => x.id === id);
const one = (f, id) => { const r = found(f, id); assert.equal(r.length, 1, `${id}: ${JSON.stringify(r)}`); return r[0]; };
const none = (f, id) => assert.deepEqual(found(f, id), [], id);
const RUFLO_LIKE = { name: 'toolbox', version: '1.2.0', allow_scripts: 'toolbox' };
const hreceipt = (v, scripts = 'toolbox') => ({ name: 'toolbox', version: v, allow_scripts: scripts, node: '26.1.0', installed_at: '2026-10-29T10:00:00Z', engine: '0.9.0' });
const aqe = o => ({ runtime: path.join(AIT, 'aqe'), current: '3.15.16-local.1', policyCurrent: '3.15.16-local.1', basedOn: '3.15.16', releases: ['3.15.12-local.1', '3.15.16-local.1'], partial: [], qualified: true, lastPromote: null, ...o });

// --- receipt-unfinished
test('receipt-unfinished: an onboard that stopped midway names its rollback; undone, finished, fresh or superseded ones don\'t count', () => {
  const r = { kind: 'onboard', at: ago(60).toISOString(), engine: '0.9.0', project: '~/work/demo-app', tools: ['aqe'], backup: '~/x', entries: [{ path: '.mcp.json', action: 'create' }], exclude: null, pr: [], complete: false };
  const x = one(facts({ backups: [bk('onboard-demo-app', r)] }), 'receipt-unfinished');
  assert.match(x.cmd, /^steward projects onboard --rollback .*onboard-demo-app-\d{8}T\d{6}\/receipt\.json$/);
  assert.equal(x.writes, true);
  assert.equal(x.skill, 'projects');
  none(facts({ backups: [bk('onboard-demo-app', { ...r, undone: true })] }), 'receipt-unfinished');
  none(facts({ backups: [bk('onboard-demo-app', { ...r, complete: true })] }), 'receipt-unfinished');
  none(facts({ backups: [bk('onboard-demo-app', r, 5)] }), 'receipt-unfinished');
  none(facts({ backups: [bk('onboard-demo-app', r, 90), bk('onboard-demo-app', { ...r, at: ago(30).toISOString(), complete: true }, 30)] }), 'receipt-unfinished');
});

test('receipt-unfinished: a config sync is never sent to --rollback (it refuses an unfinished one); a refused carry is finished', () => {
  const r = { kind: 'config-sync', at: ago(60).toISOString(), engine: '0.9.0', repo: INST, branch: 'main', upstream: 'origin/main', before: 'a'.repeat(40), after: null, commits: [], files: [], carried: null, complete: false };
  const x = one(facts({ backups: [bk('config-sync', r)] }), 'receipt-unfinished');
  assert.equal(x.cmd, 'steward config sync');
  assert.doesNotMatch(`${x.cmd} ${x.rollback || ''}`, /--rollback/);
  none(facts({ backups: [bk('config-sync', { ...r, restored: 'nothing changed: both change the same lines of mise/config.toml' })] }), 'receipt-unfinished');
  const send = { kind: 'config-sync-send', at: ago(60).toISOString(), engine: '0.9.0', repo: INST, base: 'main', upstream: 'origin/main', branch: 'steward/sync-20261030-1100', origHead: 'b'.repeat(40), tip: null, files: ['x'], commits: [], pr: null, complete: false };
  assert.equal(one(facts({ backups: [bk('config-sync-send', send)] }), 'receipt-unfinished').cmd, 'steward config sync');
});

test('receipt-unfinished: a config sync that set edits aside counts while they are still in the stash', () => {
  const repo = path.join(ROOT, 'stash-repo');
  git(ROOT, 'init', '-q', repo);
  write(path.join(repo, 'a.toml'), 'x = 1\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'a');
  write(path.join(repo, 'a.toml'), 'x = 2\n'); git(repo, 'stash', 'push', '-q', '-m', 'steward config sync: copies');
  const sha = git(repo, 'rev-parse', 'stash@{0}');
  const r = { kind: 'config-sync', at: ago(60).toISOString(), engine: '0.9.0', repo, branch: 'main', upstream: 'origin/main', before: 'a'.repeat(40), after: null, commits: [], files: ['a.toml'],
    carried: { files: ['a.toml'], copies: path.join(STATE, 'backups', 'x', 'edits'), sha256: {}, stash: sha }, complete: false };
  const later = bk('config-sync', { ...r, at: ago(10).toISOString(), carried: null, complete: true }, 10);
  const x = one(facts({ backups: [bk('config-sync', r, 60), later] }), 'receipt-unfinished');
  assert.match(x.cmd, /stash list, then steward config sync$/);
  assert.match(x.text, new RegExp(`git stash ${sha.slice(0, 7)}`));
  assert.doesNotMatch(`${x.cmd} ${x.why}`, /config sync --rollback/);
  git(repo, 'stash', 'drop', '-q');
  none(facts({ backups: [bk('config-sync', r, 60), later] }), 'receipt-unfinished');
});

test('receipt-unfinished: a declared updater still "started" names its rollback; a failed one is finished', () => {
  const r = { kind: 'updater-signed_data', at: ago(60).toISOString(), engine: '0.9.0', name: 'sigs', class: 'signed_data', why: 'x', before: '', backups: [], outcome: 'started', rollback: 'steward sc rollback ~/state/backups/updater-sigs/receipt.json' };
  assert.equal(one(facts({ backups: [bk('updater-sigs', r)] }), 'receipt-unfinished').cmd, r.rollback);
  none(facts({ backups: [bk('updater-sigs', { ...r, outcome: 'failed: apply exited 1' })] }), 'receipt-unfinished');
});

// --- backup-no-receipt
test('backup-no-receipt: an AQE promote that stopped after the store backup; hand-made, policy, fresh and superseded folders don\'t count', () => {
  const f = o => facts({ aqe: aqe({ current: '3.15.12-local.1' }), ...o });
  const x = one(f({ backups: [bk('aqe-promote', null)] }), 'backup-no-receipt');
  assert.equal(x.cmd, '/opt/steward/ai-tooling/qualify/aqe/promote.sh 3.15.16');
  assert.match(x.text, /current is 3\.15\.12-local\.1/);
  none(f({ backups: [bk('demo-app-sync', null), bk('ruflo-policy-20261030-120000', null), bk('config-local-edits', null)] }), 'backup-no-receipt');
  none(f({ backups: [bk('aqe-promote', null, 5)] }), 'backup-no-receipt');
  const repin = { kind: 'release-worktree', at: ago(30).toISOString(), from: { tag: 'v0.8.1', commit: 'c'.repeat(40) }, to: { tag: 'v0.9.0', commit: 'd'.repeat(40) }, backups: ['steward', 'steward-dev'], rollback: 'x' };
  assert.equal(one(f({ backups: [bk('repin-release', null, 90)] }), 'backup-no-receipt').cmd, 'steward version');
  none(f({ backups: [bk('repin-release', null, 90), bk('repin-release', repin, 30)] }), 'backup-no-receipt');
  none(f({ backups: [bk('aqe-promote', null, 90), bk('aqe-promote', { kind: 'aqe-promote', at: ago(30).toISOString(), release: '3.15.16-local.1', previous: '3.15.12-local.1', qualification: '~/q/receipt.json', storeFiles: 2, treeSha256: 'e'.repeat(64), files: [] }, 30)] }), 'backup-no-receipt');
});

// --- aqe-partial
test('aqe-partial: a leftover releases/<r>.partial says remove it, then promote again', () => {
  const x = one(facts({ aqe: aqe({ partial: ['3.15.16-local.1.partial'], current: '3.15.12-local.1' }) }), 'aqe-partial');
  assert.match(x.cmd, /^rm -rf .*\/aqe\/releases\/3\.15\.16-local\.1\.partial, then \/opt\/steward\/ai-tooling\/qualify\/aqe\/promote\.sh 3\.15\.16$/);
  none(facts({ aqe: aqe() }), 'aqe-partial');
});

// --- repin-unfinished
test('repin-unfinished (maintainers): the release channel isn\'t at the last repin receipt\'s commit', () => {
  const receipt = { kind: 'release-worktree', at: ago(60).toISOString(), from: { tag: 'v0.8.1', commit: 'c'.repeat(40) }, to: { tag: 'v0.9.0', commit: 'd'.repeat(40) }, backups: ['steward', 'steward-dev'], rollback: 'just release-worktree v0.8.1 (in the clone), or copy these launchers back' };
  const x = one(facts({ repin: { dir: '/r', head: 'c'.repeat(40), receipt, rp: '/r/receipt.json', at: ago(60) } }), 'repin-unfinished');
  assert.equal(x.cmd, 'just release-worktree v0.9.0');
  assert.equal(x.rollback, receipt.rollback);
  none(facts({ repin: { dir: '/r', head: 'd'.repeat(40), receipt, rp: '/r/receipt.json', at: ago(60) } }), 'repin-unfinished');
  none(facts(), 'repin-unfinished');
});

// --- aqe-vs-policy
test('aqe-vs-policy: promoted ahead of the policy, or the policy ahead of the runtime, each with its step', () => {
  const ahead = one(facts({ aqe: aqe({ current: '3.15.16-local.1', policyCurrent: '3.15.12-local.1' }) }), 'aqe-vs-policy');
  assert.match(ahead.cmd, /set \[aqe\] current = "3\.15\.16-local\.1" in ai-tooling\/ai-tooling\.toml, then steward config sync/);
  none(facts({ aqe: aqe({ policyCurrent: '3.15.12-local.1' }), config: { behind: 1, upstreamFiles: ['ai-tooling/ai-tooling.toml'] } }), 'aqe-vs-policy');
  const behind = { current: '3.15.12-local.1', releases: ['3.15.12-local.1'] };
  assert.equal(one(facts({ aqe: aqe(behind) }), 'aqe-vs-policy').cmd, '/opt/steward/ai-tooling/qualify/aqe/promote.sh 3.15.16');
  assert.equal(one(facts({ aqe: aqe({ ...behind, qualified: false }) }), 'aqe-vs-policy').cmd, '/opt/steward/ai-tooling/qualify/aqe/run.sh 3.15.16 build');
  assert.match(one(facts({ aqe: aqe({ current: '3.15.12-local.1' }) }), 'aqe-vs-policy').text, /a promote stopped before the switch/);
  none(facts({ aqe: aqe() }), 'aqe-vs-policy');
});

// --- hybrid-vs-policy
test('hybrid-vs-policy: behind, ahead, missing or new scripts against hybrids.toml; in step says nothing', () => {
  const f = r => facts({ hybrids: { policy: [{ ...RUFLO_LIKE }], receipts: r ? { toolbox: r } : {} } });
  assert.match(one(f(hreceipt('1.1.9')), 'hybrid-vs-policy').text, /toolbox 1\.1\.9 → 1\.2\.0/);
  const ahead = one(f(hreceipt('1.3.0')), 'hybrid-vs-policy');
  assert.match(ahead.text, /toolbox 1\.3\.0 installed, hybrids\.toml says 1\.2\.0/);
  assert.match(ahead.why, /raise hybrids\.toml instead/);
  assert.match(one(f(null), 'hybrid-vs-policy').text, /toolbox 1\.2\.0 not installed/);
  assert.match(one(f(hreceipt('1.2.0', 'toolbox,other')), 'hybrid-vs-policy').text, /allowed install scripts changed/);
  none(f(hreceipt('1.2.0')), 'hybrid-vs-policy');
});

// --- config-*
test('config: behind (with the files GitHub changed), changed here, not pushed; in step says nothing', () => {
  const b = one(facts({ config: { behind: 2, upstreamFiles: ['supply-chain/hybrids.toml', 'mise/config.toml'] } }), 'config-behind');
  assert.equal(b.cmd, 'steward config sync');
  assert.match(b.text, /2 newer commit\(s\) on origin\/main: supply-chain\/hybrids\.toml, mise\/config\.toml/);
  assert.equal(one(facts({ config: { changed: ['mise/config.toml'] } }), 'config-changed').cmd, 'steward config sync');
  assert.equal(one(facts({ config: { ahead: 1 } }), 'config-ahead').cmd, 'steward config sync');
  for (const id of ['config-behind', 'config-changed', 'config-ahead', 'config-pr']) none(facts(), id);
});

// --- soak, projects, gate, review
test('soak: a running one waits (never the next step); one that ended asks for the prune', () => {
  const run = one(facts({ soak: { running: true, awaitingPrune: false, until: new Date('2026-11-02T10:00:00Z'), newest: null } }), 'soak');
  assert.equal(run.severity, 'wait');
  assert.equal(B.pick(B.run(facts({ soak: { running: true, until: new Date('2026-11-02T10:00:00Z') } }))).next, null);
  assert.equal(one(facts({ soak: { running: false, awaitingPrune: true, until: ago(600), newest: { kind: 'hybrid', at: ago(5000) } } }), 'soak').cmd, 'DRY_RUN=1 steward sc prune, then steward sc prune');
  none(facts(), 'soak');
});

test('projects-behind, gate-cleared, review-due: the banner lines and the last review, each with its command', () => {
  assert.equal(one(facts({ reconcile: '2 project(s) behind the qualified AI tools: steward projects reconcile --all' }), 'projects-behind').cmd, 'steward projects reconcile --all');
  assert.equal(one(facts({ gate: '3 queued update(s) cleared the gate since the last review: steward review' }), 'gate-cleared').cmd, 'steward review');
  assert.match(one(facts({ review: { due: true, age: 9, days: 7 } }), 'review-due').text, /last 9 days ago/);
  assert.match(one(facts({ review: { due: true, age: null, days: 7 } }), 'review-due').text, /never run/);
  for (const id of ['projects-behind', 'gate-cleared', 'review-due']) none(facts(), id);
});

test('unreadable: a source that can\'t be read is said, as a wait; the rest of the briefing stands', () => {
  const p = B.pick(B.run(facts({ errors: [{ what: 'the last reconcile check', message: 'no [launch] table' }], review: { due: true, age: 8, days: 7 } })));
  assert.equal(p.next.id, 'review-due');
  assert.match(p.waiting[0].text, /couldn't read the last reconcile check: no \[launch\] table/);
});

// --- order
test('order: GitHub has a new hybrids.toml → sync first, then install-hybrids (not the other way round)', () => {
  const p = B.pick(B.run(facts({ config: { behind: 1, upstreamFiles: ['supply-chain/hybrids.toml'] }, hybrids: { policy: [{ ...RUFLO_LIKE }], receipts: { toolbox: hreceipt('1.2.0') } } })));
  assert.equal(p.next.id, 'config-behind');
  assert.equal(p.next.cmd, 'steward config sync, then steward sc install-hybrids');
  assert.equal(p.next.writes, true);
  assert.ok(!p.findings.some(x => x.id === 'hybrid-vs-policy'));
});

test('order: the soak ended but a hybrid is out of step → install first, then the prune; through a sync, all three', () => {
  const soak = { running: false, awaitingPrune: true, until: ago(600), newest: { kind: 'hybrid', at: ago(5000) } };
  const hyb = { policy: [{ ...RUFLO_LIKE }], receipts: { toolbox: hreceipt('1.1.0') } };
  const p = B.pick(B.run(facts({ soak, hybrids: hyb })));
  assert.equal(p.next.id, 'hybrid-vs-policy');
  assert.equal(p.next.cmd, 'steward sc install-hybrids, then DRY_RUN=1 steward sc prune, then steward sc prune');
  assert.equal(p.more.length, 0);
  const q = B.pick(B.run(facts({ soak, hybrids: hyb, config: { behind: 1, upstreamFiles: ['supply-chain/hybrids.toml'] } })));
  assert.equal(q.next.cmd, 'steward config sync, then steward sc install-hybrids, then DRY_RUN=1 steward sc prune, then steward sc prune');
});

test('order: fix before act before do, whatever the detector order', () => {
  const r = { kind: 'reconcile', at: ago(60).toISOString(), engine: '0.9.0', project: '~/work/demo-app', tools: ['ruflo'], backup: '~/x', entries: [], pr: [], complete: false };
  const p = B.pick(B.run(facts({ review: { due: true, age: 8, days: 7 }, config: { ahead: 1 }, backups: [bk('reconcile-demo-app', r)] })));
  assert.equal(p.next.id, 'receipt-unfinished');
  assert.deepEqual(p.more.map(x => x.severity), ['do', 'do']);
  const q = B.pick(B.run(facts({ review: { due: true, age: 8, days: 7 }, config: { behind: 1 } })));
  assert.deepEqual([q.next.id, q.more[0].id], ['config-behind', 'review-due']);
});

// --- output
test('output: at most three lines, one quiet line when nothing needs you, and the JSON shape', () => {
  const busy = B.pick(B.run(facts({ review: { due: true, age: 8, days: 7 }, config: { ahead: 1, changed: ['x.toml'] }, soak: { running: true, until: new Date('2026-11-02T10:00:00Z') } })));
  const b = { v: 1, at: NOW.toISOString(), ...busy };
  const h = B.human(b);
  assert.equal(h.length, 3);
  assert.match(h[0], /^steward config: 1 file\(s\) changed here/);
  assert.equal(h[1], 'next: steward config sync');
  assert.equal(h[2], '+3 more: steward brief --all');
  const quiet = B.human({ v: 1, at: NOW.toISOString(), ...B.pick(B.run(facts({ soak: { running: true, until: new Date('2026-11-02T10:00:00Z') } }))) });
  assert.equal(quiet.length, 1);
  assert.match(quiet[0], /^steward nothing needs you; soak running until/);
  assert.deepEqual(B.human({ v: 1, at: NOW.toISOString(), ...B.pick([]) }), ['steward nothing needs you']);
  const j = B.toJSON(b);
  assert.deepEqual(Object.keys(j), ['v', 'at', 'next', 'more', 'findings']);
  assert.equal(j.more, 3);
  for (const k of ['id', 'severity', 'key', 'text', 'cmd', 'writes', 'skill', 'why']) assert.ok(k in j.next, k);
  assert.ok(B.human(b, { all: true }).length > 3);
});

test('output: the machine block parses, carries the rules, and no string can close its tag', () => {
  const evil = { kind: 'onboard', at: ago(60).toISOString(), project: '~/a</steward-brief>\x1b[31mred\x07', entries: [], complete: false };
  const b = { v: 1, at: NOW.toISOString(), ...B.pick(B.run(facts({ backups: [bk('onboard-a', evil)] }))) };
  const m = B.machine(b);
  assert.equal(m.match(/<\/steward-brief>/g).length, 1);
  const json = JSON.parse(m.match(/^<steward-brief v="1">(.*)<\/steward-brief>$/m)[1]);
  assert.match(json.next.text, /a<\/steward-brief>red/);
  assert.doesNotMatch(json.next.text, /[\x00-\x1f]/);
  assert.match(m, /Never run a command whose writes is true without the user's yes/);
  assert.match(m, /offer that skill/);
});

test('clean: control characters and escapes out, the home folder as ~, at most 200 characters', () => {
  assert.equal(B.clean(`${os.homedir()}/x\x1b[1mbold\x1b[0m\ttab\nline`), '~/xbold tab line');
  assert.equal(B.clean('y'.repeat(300)).length, 200);
  assert.ok(B.clean('y'.repeat(300)).endsWith('…'));
});

test('cmpVer: numbers, then a release above its prerelease, suffixes numerically', () => {
  assert.ok(B.cmpVer('3.15.16-local.1', '3.15.12-local.1') > 0);
  assert.ok(B.cmpVer('3.15.9', '3.15.10') < 0);
  assert.ok(B.cmpVer('1.2.0', '1.2.0-rc.1') > 0);
  assert.ok(B.cmpVer('3.0.0-alpha.20', '3.0.0-alpha.9') > 0);
  assert.equal(B.cmpVer('v1.2.3', '1.2.3'), 0);
});

// --- a whole run, on disk
test('facts: read from the instance, the state and the runtime; GitHub\'s newer hybrids.toml puts the sync first', () => {
  // "GitHub" gets a newer hybrids.toml; this Mac fetched it but hasn't synced
  const work = path.join(ROOT, 'work');
  git(ROOT, 'clone', '-q', path.join(ROOT, 'remote.git'), work);
  write(path.join(work, 'supply-chain', 'hybrids.toml'), fs.readFileSync(path.join(INST, 'supply-chain', 'hybrids.toml'), 'utf8').replace('1.2.0', '1.3.0'));
  git(work, 'commit', '-q', '-am', 'toolbox 1.3.0'); git(work, 'push', '-q');
  git(INST, 'fetch', '-q');
  const f = B.facts();
  assert.equal(f.config.behind, 1);
  assert.deepEqual(f.config.upstreamFiles, ['supply-chain/hybrids.toml']);
  assert.deepEqual(f.hybrids.policy, [{ name: 'toolbox', version: '1.2.0', allow_scripts: 'toolbox' }]);
  assert.equal(f.hybrids.receipts.toolbox.version, '1.2.0');
  assert.equal(f.aqe.current, '3.15.16-local.1');
  assert.equal(f.soak.running, true);
  assert.equal(f.review.due, false);
  const b = B.brief();
  assert.equal(b.next.cmd, 'steward config sync, then steward sc install-hybrids');
});

test('a run touches no network and takes under a second: a stub gh, npm, curl and mise would leave a marker', () => {
  const stubs = path.join(ROOT, 'stubs'), marker = path.join(ROOT, 'network-marker');
  fs.mkdirSync(stubs);
  for (const t of ['gh', 'npm', 'curl', 'mise']) { fs.writeFileSync(path.join(stubs, t), `#!/bin/sh\necho ${t} "$@" >> '${marker}'\nexit 1\n`); fs.chmodSync(path.join(stubs, t), 0o755); }
  const env = { ...process.env, PATH: `${stubs}:${process.env.PATH}`, STEWARD_INSTANCE: INST };
  const seen = path.join(STATE, 'reconcile', 'seen.json');
  write(seen, JSON.stringify({ at: NOW.toISOString(), versions: {}, behind: [] }));
  const before = fs.statSync(seen).mtimeMs;
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [path.join(REPO, 'lib', 'brief.js')], { encoding: 'utf8', env });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`# steward brief took ${ms.toFixed(0)} ms`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(marker), `called: ${fs.existsSync(marker) && fs.readFileSync(marker, 'utf8')}`);
  assert.ok(ms < 1000, `${ms} ms`);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length <= 3, r.stdout);
  assert.equal(lines[1], 'next: steward config sync, then steward sc install-hybrids');
  assert.equal(fs.statSync(seen).mtimeMs, before);
  assert.ok(!fs.existsSync(path.join(STATE, 'review', 'gate-queue.json')));
  assert.ok(!fs.existsSync(path.join(STATE, 'brief')));
  const j = spawnSync(process.execPath, [path.join(REPO, 'lib', 'brief.js'), '--json'], { encoding: 'utf8', env });
  assert.equal(JSON.parse(j.stdout).next.id, 'config-behind');
});
