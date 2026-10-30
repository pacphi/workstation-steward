// lib/refresh.js, the briefing's background refresh (D57): it writes only its cache and removes its lock; the reconcile
// seen.json and the review's gate-queue.json stay as they were; the config repo's fetch updates FETCH_HEAD against a
// local bare remote; a second start while one runs does nothing, a left-over lock is taken over; a step's time limit
// and the total cap hold, and a failure is recorded, not thrown; refresh_hours = 0 (and STEWARD_NO_REFRESH, CI) never
// start it. Plus newAndGone() in lib/projects.js and the progress stage of `steward projects scan`.
// No network: npm and mise are stubs on PATH, or an injected runner; git fetches from a folder.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-refresh-')));
const INST = path.join(ROOT, 'instance');
const STATE = path.join(ROOT, 'state');
const DEV = path.join(ROOT, 'dev');
const GITCFG = path.join(ROOT, 'gitconfig');
fs.writeFileSync(GITCFG, '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: GITCFG, GIT_CONFIG_NOSYSTEM: '1', STEWARD_INSTANCE: INST, NO_COLOR: '1', NO_PROGRESS: '' });
delete process.env.STEWARD_NO_REFRESH;
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the instance: projects on (roots in a throwaway folder), AI tooling off; its own Git repo with a bare "GitHub"
write(path.join(INST, 'steward.toml'), `[paths]\nstate = "${STATE}"\ncache = "${path.join(ROOT, 'cache')}"\n\n[projects]\nroots = ["${DEV}"]\n\n[profiles]\nprojects = true\n`);
write(path.join(INST, 'projects', 'registry.toml'), `[[project]]\npath = "${path.join(DEV, 'known')}"\nkind = "git"\ndecision = "ignored"\n\n[[project]]\npath = "${path.join(DEV, 'gone')}"\nkind = "git"\ndecision = "ignored"\n`);
git(ROOT, 'init', '-q', INST);
git(INST, 'add', '-A'); git(INST, 'commit', '-q', '-m', 'first');
git(ROOT, 'clone', '-q', '--bare', INST, path.join(ROOT, 'remote.git'));
git(INST, 'remote', 'add', 'origin', path.join(ROOT, 'remote.git'));
git(INST, 'fetch', '-q', 'origin'); git(INST, 'branch', '-q', '-u', 'origin/main');
// projects under the root: one registered, two new (a repo and a marked folder); one registered is gone
for (const p of ['known', 'new-repo']) git(ROOT, 'init', '-q', path.join(DEV, p));
write(path.join(DEV, 'new-app', 'package.json'), '{}');
// the caches other commands own: the refresh must leave them alone
const SEEN = path.join(STATE, 'reconcile', 'seen.json');
const QUEUE = path.join(STATE, 'review', 'gate-queue.json');
write(SEEN, '{"at":"2026-10-29T00:00:00Z","versions":{},"behind":[]}');
write(QUEUE, '{"at":"2026-10-29T00:00:00Z","items":[]}');
const past = new Date('2026-10-29T00:00:00Z');
for (const f of [SEEN, QUEUE]) fs.utimesSync(f, past, past);
// stubs: npm answers the latest version and its publish time; mise the active Node. Each call leaves a line
const STUBS = path.join(ROOT, 'stubs'), CALLS = path.join(ROOT, 'calls');
fs.mkdirSync(STUBS);
write(path.join(STUBS, 'npm'), `#!/bin/sh\necho npm "$@" >> '${CALLS}'\ncase "$*" in\n  *dist-tags.latest*) echo 0.99.0 ;;\n  *time*) echo '{"created":"2026-10-01T00:00:00.000Z","0.99.0":"2026-10-20T00:00:00.000Z"}' ;;\n  *) exit 1 ;;\nesac\n`);
write(path.join(STUBS, 'mise'), `#!/bin/sh\necho mise "$@" >> '${CALLS}'\necho 26.1.1\n`);
for (const t of ['npm', 'mise']) fs.chmodSync(path.join(STUBS, t), 0o755);

const C = require('../lib/config.js');
const RF = require('../lib/refresh.js');
const VALUES = C.load().values;
// vals(o) — the instance's values with other settings or another state folder
const vals = ({ brief = {}, profiles = {}, state = STATE } = {}) => ({ ...VALUES, paths: { ...VALUES.paths, state }, brief: { ...VALUES.brief, ...brief }, profiles: { ...VALUES.profiles, ...profiles } });
// tree(dir) — every file under dir with its modification time
const tree = dir => {
  const out = {};
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.statSync(p).mtimeMs; } })(dir);
  return out;
};
// spy() — a spawn that records its call and starts nothing
const spy = () => { const calls = []; const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 424242, on() {}, unref() {} }; }; fn.calls = calls; return fn; };
const freshState = () => fs.mkdtempSync(path.join(ROOT, 'st-'));

test('the detached refresh, started by steward brief: writes only brief/refresh.json, removes its lock, fetches the config repo', async () => {
  // GitHub gets a newer commit; this Mac hasn't fetched it
  const work = path.join(ROOT, 'work');
  git(ROOT, 'clone', '-q', path.join(ROOT, 'remote.git'), work);
  write(path.join(work, 'supply-chain', 'hybrids.toml'), '# newer\n');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'newer'); git(work, 'push', '-q');
  const head = git(INST, 'rev-parse', 'HEAD'), status = git(INST, 'status', '--porcelain');
  const fetchHead = path.join(INST, '.git', 'FETCH_HEAD');
  fs.utimesSync(fetchHead, past, past);
  const before = tree(STATE);

  const env = /** @type {any} */ ({ ...process.env, PATH: `${STUBS}:${process.env.PATH}` });
  delete env.CI; delete env.STEWARD_NO_REFRESH;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(REPO, 'lib', 'brief.js')], { encoding: 'utf8', env });
  const briefMs = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  console.log(`# steward brief returned in ${briefMs} ms, with the refresh started behind it`);
  assert.ok(briefMs < 1500, `${briefMs} ms`);
  const { lock, cache } = RF.files(STATE);
  for (let i = 0; i < 300 && (fs.existsSync(lock) || !fs.existsSync(cache)); i++) await sleep(100);
  console.log(`# the refresh finished about ${Date.now() - t0} ms after the briefing started`);
  assert.ok(!fs.existsSync(lock), 'the lock is removed');
  assert.ok(fs.existsSync(cache), 'the cache is written');
  assert.equal(fs.statSync(cache).mode & 0o777, 0o600);

  // only the cache is new; everything else in the state folder is as it was (seen.json, gate-queue.json)
  const after = tree(STATE);
  assert.deepEqual(Object.keys(after).filter(k => !(k in before)), [path.join('brief', 'refresh.json')]);
  for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} changed`);
  assert.equal(fs.statSync(SEEN).mtimeMs, past.getTime());
  assert.equal(fs.statSync(QUEUE).mtimeMs, past.getTime());

  // the fetch: FETCH_HEAD and origin/main moved, the branch and the files did not
  assert.ok(fs.statSync(fetchHead).mtimeMs > past.getTime(), 'FETCH_HEAD updated');
  assert.equal(git(INST, 'rev-parse', 'HEAD'), head);
  assert.equal(git(INST, 'status', '--porcelain'), status);
  const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(c.engine, C.ENGINE_VERSION);
  assert.deepEqual(c.steps.config.data && { behind: c.steps.config.data.behind, ahead: c.steps.config.data.ahead }, { behind: 1, ahead: 0 });
  assert.deepEqual(c.steps.npm.data, { latest: '0.99.0', published: '2026-10-20T00:00:00.000Z' });
  assert.equal(c.steps.projects.data.fresh, 2);
  assert.equal(c.steps.projects.data.gone, 1);
  assert.equal(c.steps.node.data.node, '26.1.1');
  assert.equal(c.steps.drift.skipped, 'the AI tooling add-on is off');
  for (const s of Object.values(c.steps)) assert.equal(typeof s.ms, 'number');
  // what it ran: npm's two reads and mise current node, nothing else
  assert.deepEqual(fs.readFileSync(CALLS, 'utf8').trim().split('\n').sort(), ['mise current node', 'npm view workstation-steward dist-tags.latest', 'npm view workstation-steward time --json']);

  // the briefing reads it: the config repo is behind as of this fetch, the new projects counted
  const B = require('../lib/brief.js');
  const f = B.facts();
  assert.equal(f.config.behind, 1);
  assert.equal(f.refresh.steps.npm.data.latest, '0.99.0');
  const ids = B.run(f).map(x => x.id);
  assert.ok(ids.includes('config-behind'), ids.join(' '));
  assert.ok(ids.includes('projects-new'), ids.join(' '));
});

test('steward brief --refresh: the refresh now, a stage per step on stderr, then the briefing; the lock gone, the cache written', () => {
  const state = freshState();
  const inst = path.join(ROOT, 'inst-fg');
  write(path.join(inst, 'steward.toml'), `[paths]\nstate = "${state}"\n\n[brief]\nfetch = false\n`);
  const env = /** @type {any} */ ({ ...process.env, PATH: `${STUBS}:${process.env.PATH}`, STEWARD_INSTANCE: inst });
  delete env.CI; delete env.STEWARD_NO_REFRESH;
  const r = spawnSync(process.execPath, [path.join(REPO, 'lib', 'brief.js'), '--refresh'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const done = r.stderr.split('\n').filter(l => /^✓ \[\d\/5\] /.test(l));
  assert.equal(done.length, 5, r.stderr);
  assert.match(r.stderr, /^✓ \[1\/5\] fetching your config repo: skipped: \[brief\] fetch = false \(\d+s\)$/m);
  assert.match(r.stderr, /^✓ \[2\/5\] the newest steward on npm: 0\.99\.0, published 2026-10-20 00:00Z \(this is .+\) \(\d+s\)$/m);
  assert.match(r.stderr, /^✓ \[5\/5\] the active Node: 26\.1\.1 \(\d+s\)$/m);
  assert.match(r.stdout, /^steward /m);
  const { lock, cache } = RF.files(state);
  assert.ok(!fs.existsSync(lock), 'no lock left');
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).steps.node.data.node, '26.1.1');
  // a refresh already running: it says so and still shows the briefing
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const busy = spawnSync(process.execPath, [path.join(REPO, 'lib', 'brief.js'), '--refresh'], { encoding: 'utf8', env });
  assert.equal(busy.status, 0, busy.stderr);
  assert.match(busy.stderr, /a refresh is already running \(pid \d+/);
  assert.match(busy.stdout, /^steward /m);
  fs.unlinkSync(lock);
});

test('maybeRefresh: a second start while one runs does nothing; a left-over lock (dead process, or older than 10 minutes) is taken over', () => {
  const state = freshState(), values = vals({ state });
  const { lock } = RF.files(state);
  assert.equal(RF.takeLock(lock).ok, true);
  const s1 = spy();
  const r = RF.maybeRefresh({ values, env: {}, spawnFn: s1 });
  assert.equal(r.started, false);
  assert.match(r.why, /a refresh is running/);
  assert.equal(s1.calls.length, 0);
  // the process that held it is gone
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
  const s2 = spy();
  assert.equal(RF.maybeRefresh({ values, env: {}, spawnFn: s2 }).started, true);
  assert.equal(s2.calls.length, 1);
  assert.deepEqual(s2.calls[0].args.slice(-1), ['--child']);
  assert.equal(s2.calls[0].opts.detached, true);
  assert.equal(s2.calls[0].opts.stdio, 'ignore');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, 424242, 'the lock names the child');
  // alive, but older than 10 minutes
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 11 * 60e3).toISOString() }));
  const s3 = spy();
  assert.equal(RF.maybeRefresh({ values, env: {}, spawnFn: s3 }).started, true);
  RF.releaseLock(lock, 424242);
  assert.ok(!fs.existsSync(lock));
});

test('maybeRefresh: refresh_hours = 0, STEWARD_NO_REFRESH or CI never start it; a cache younger than refresh_hours doesn\'t either', () => {
  const state = freshState();
  const never = spy();
  assert.equal(RF.maybeRefresh({ values: vals({ state, brief: { refresh_hours: 0 } }), env: {}, spawnFn: never }).why, '[brief] refresh_hours = 0');
  assert.equal(RF.maybeRefresh({ values: vals({ state }), env: { STEWARD_NO_REFRESH: '1' }, spawnFn: never }).started, false);
  assert.equal(RF.maybeRefresh({ values: vals({ state }), env: { CI: 'true' }, spawnFn: never }).started, false);
  assert.equal(never.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(state, 'brief')), 'nothing written');
  write(RF.files(state).cache, JSON.stringify({ v: 1, at: new Date(Date.now() - 2 * 3600e3).toISOString(), steps: {} }));
  assert.equal(RF.maybeRefresh({ values: vals({ state }), env: {}, spawnFn: never }).why, 'the cache is fresh');
  assert.equal(never.calls.length, 0);
  const old = spy();
  assert.equal(RF.maybeRefresh({ values: vals({ state, brief: { refresh_hours: 1 } }), env: {}, spawnFn: old }).started, true);
  assert.equal(old.calls.length, 1);
});

test('refresh: a step past its time limit and one that fails are recorded, and the others still run', async () => {
  const state = freshState();
  const run = async cmd => {
    if (cmd === 'npm') return new Promise(() => {});   // never answers
    if (cmd === 'mise') return { code: 1, stdout: '', stderr: 'mise ERROR no version set\nmore', timedOut: false };
    return { code: 0, stdout: '{"found":0,"fresh":0,"gone":0,"first":[],"firstGone":[],"roots":[]}', stderr: '', timedOut: false };
  };
  const steps = RF.STEPS.map(s => ({ ...s, timeout: 200 }));
  const c = await RF.refresh({ values: vals({ state, brief: { fetch: false } }), run, steps });
  assert.deepEqual(c.steps.config, { ok: true, skipped: '[brief] fetch = false', at: c.steps.config.at, ms: c.steps.config.ms });
  assert.equal(c.steps.npm.ok, false);
  assert.equal(c.steps.npm.error, 'ran out of time after 200 ms');
  assert.ok(c.steps.npm.ms >= 190 && c.steps.npm.ms < 1500, String(c.steps.npm.ms));
  assert.equal(c.steps.projects.ok, true);
  assert.equal(c.steps.node.ok, false);
  assert.equal(c.steps.node.error, 'mise current node failed: mise ERROR no version set');
  assert.deepEqual(JSON.parse(fs.readFileSync(RF.files(state).cache, 'utf8')), c);
});

test('refresh: the total cap holds; steps it leaves no time for are marked not run', async () => {
  const state = freshState();
  const run = () => new Promise(r => setTimeout(() => r({ code: 0, stdout: '0.1.0', stderr: '', timedOut: false }), 200));
  const t0 = Date.now();
  const c = await RF.refresh({ values: vals({ state, brief: { fetch: false }, profiles: { projects: false } }), run, cap: 250 });
  const ms = Date.now() - t0;
  assert.ok(ms < 600, `${ms} ms`);
  assert.equal(c.steps.npm.ok, false, JSON.stringify(c.steps.npm));
  assert.match(c.steps.npm.error, /^ran out of time after \d+ ms$/);
  assert.equal(c.steps.node.error, 'not run: the refresh reached its 250 ms limit');
});

test('refresh: drift keeps its DRIFT and WARN lines only; npm\'s publish time comes from its time map', async () => {
  const state = freshState();
  const drift = [{ level: 'ok', area: 'x', msg: 'fine' }, { level: 'DRIFT', area: 'guards', msg: 'off: steward ai guard' }, { level: 'WARN', area: 'retire', msg: 'closed' }, { level: 'info', area: 'y', msg: 'z' }];
  const run = async (cmd, args) => {
    if (cmd === 'npm') return { code: 0, stdout: args.includes('time') ? '[{"0.99.0":"2026-10-20T00:00:00.000Z"}]' : '0.99.0\n', stderr: '', timedOut: false };
    if (cmd === 'mise') return { code: 0, stdout: '26.1.1 \n', stderr: '', timedOut: false };
    if (args.some(a => a.endsWith('drift.js'))) { assert.deepEqual(args.slice(-2), ['--offline', '--json']); return { code: 0, stdout: JSON.stringify(drift), stderr: '[1/3] machine …\n', timedOut: false }; }
    return { code: 1, stdout: '', stderr: 'unexpected', timedOut: false };
  };
  const c = await RF.refresh({ values: vals({ state, brief: { fetch: false }, profiles: { ai_tooling: true, projects: false } }), run });
  assert.deepEqual(c.steps.drift.data, { drift: 1, warn: 1, items: [drift[1], drift[2]] });
  assert.deepEqual(c.steps.npm.data, { latest: '0.99.0', published: '2026-10-20T00:00:00.000Z' });
  assert.deepEqual(c.steps.node.data, { node: '26.1.1' });
  assert.equal(c.steps.projects.skipped, 'the projects add-on is off');
});

test('newAndGone: new projects, registered ones gone, and where the walk is (each root and the folders just under it)', () => {
  const r = spawnSync(process.execPath, ['-e', `const P = require(${JSON.stringify(path.join(REPO, 'lib', 'projects.js'))}); const seen = []; const x = P.newAndGone({ onDir: d => seen.push(d) }); console.log(JSON.stringify({ fresh: x.fresh.map(f => f.path).sort(), gone: x.gone.map(g => g.path), found: x.found.length, reg: x.reg.length, seen }))`], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  const x = JSON.parse(r.stdout);
  assert.deepEqual(x.fresh, [path.join(DEV, 'new-app'), path.join(DEV, 'new-repo')]);
  assert.deepEqual(x.gone, [path.join(DEV, 'gone')]);
  assert.equal(x.found, 3);
  assert.equal(x.reg, 2);
  assert.equal(x.seen[0], DEV);
  assert.ok(x.seen.includes(path.join(DEV, 'new-app')));
  // steward projects scan: a progress stage on stderr names the root; stdout is the same report as before
  const s = spawnSync(process.execPath, [path.join(REPO, 'projects', 'bin', 'projects.js'), 'scan'], { encoding: 'utf8', env: process.env });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stderr, /^\[1\/1\] searching .*dev …$/m);
  assert.match(s.stderr, /^✓ \[1\/1\] searching .*dev: 3 project\(s\), 2 new, 1 gone \(\d+s\)$/m);
  assert.match(s.stdout, /^registry: 2 project\(s\); discovered: 3$/m);
  const j = spawnSync(process.execPath, [path.join(REPO, 'projects', 'bin', 'projects.js'), 'scan', '--json'], { encoding: 'utf8', env: process.env });
  assert.equal(JSON.parse(j.stdout).fresh.length, 2);
});
