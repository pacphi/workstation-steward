// Tests for remediation (D66): steward sc vulns-fix (supply-chain/bin/vulns-fix.js) and steward sc isolate
// (supply-chain/bin/isolate.js), the brief's isolated and isolate-lost detectors, and the vulns check's suggestions.
// Throwaway folders, canned feeds, a stand-in for every command; nothing touches this machine's mise or config.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const V = require('../lib/vulns.js');
const F = require('../supply-chain/bin/vulns-fix.js');
const I = require('../supply-chain/bin/isolate.js');
const B = require('../lib/brief.js');
const { audit } = require('../supply-chain/bin/audit.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-remediate-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); };
const OSV = 'https://api.osv.dev/v1';
const FEEDS = [{ name: 'osv', kind: 'osv-api', url: OSV }, { name: 'nodejs', kind: 'nodejs', url: 'https://nodejs.org/dist/index.json' }];
const rec = (id, eco, name, events, sev, extra = {}) => ({ id, database_specific: { severity: sev }, affected: [{ package: { ecosystem: eco, name }, ranges: [{ type: 'SEMVER', events }] }], ...extra });
const REC = [
  rec('GHSA-fix1', 'npm', 'cooltool', [{ introduced: '0' }, { fixed: '2.0.1' }], 'HIGH'),
  rec('GHSA-fix2', 'npm', 'cooltool', [{ introduced: '0' }, { fixed: '2.0.3' }], 'CRITICAL'),
  rec('GHSA-old1', 'npm', 'cooltool', [{ introduced: '0' }, { fixed: '1.6.0' }], 'CRITICAL'),
  rec('GHSA-nofix', 'npm', 'nofix', [{ introduced: '0' }], 'CRITICAL'),
  rec('GHSA-owned', 'npm', 'agentic-qe', [{ introduced: '0' }, { fixed: '9.0.0' }], 'HIGH'),
  rec('GHSA-hyb', 'npm', 'hybridy', [{ introduced: '0' }, { fixed: '3.0.1' }], 'HIGH'),
  rec('GHSA-low', 'npm', 'cooltool', [{ introduced: '0' }, { fixed: '9.9.9' }], 'LOW'),
];

// machine(name) — mise installs: cooltool 2.0.0 (active) and 1.5.0 (unused), nofix 1.0.0, agentic-qe 3.0.0 (AI-owned),
// Node 26.12.1 with the hybrid hybridy 3.0.0 and its command link
function machine(name) {
  const dir = path.join(ROOT, name);
  const npmTool = (tool, version) => { const d = path.join(dir, 'installs', `npm-${tool}`, version); put(path.join(d, 'aube-lock.yaml'), `lockfileVersion: '9.0'\npackages:\n\n  ${tool}@${version}:\n    resolution: {}\n`); return d; };
  const node = path.join(dir, 'installs', 'node', '26.12.1');
  put(path.join(node, 'lib', 'node_modules', 'hybridy', 'package.json'), { name: 'hybridy', version: '3.0.0' });
  put(path.join(node, 'lib', 'node_modules', 'hybridy', 'cli.js'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(node, 'bin'), { recursive: true });
  fs.symlinkSync('../lib/node_modules/hybridy/cli.js', path.join(node, 'bin', 'hybridy'));
  fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(node, 'bin', 'npm'));
  const ls = {
    'npm:cooltool': [{ version: '1.5.0', install_path: npmTool('cooltool', '1.5.0'), installed: true, active: false }, { version: '2.0.0', install_path: npmTool('cooltool', '2.0.0'), installed: true, active: true }],
    'npm:nofix': [{ version: '1.0.0', install_path: npmTool('nofix', '1.0.0'), installed: true, active: true }],
    'npm:agentic-qe': [{ version: '3.0.0', install_path: npmTool('agentic-qe', '3.0.0'), installed: true, active: true }],
    node: [{ version: '26.12.1', install_path: node, installed: true, active: true }],
  };
  const inst = path.join(dir, 'instance');
  put(path.join(inst, 'mise', 'config.toml'), '[tools]\n"npm:cooltool" = "2.0.0"\n"npm:nofix" = "1.0.0"\n\n[settings]\nexperimental = true\n');
  put(path.join(inst, 'mise', 'mise.lock'), '# lock\n');
  put(path.join(inst, 'supply-chain', 'host.toml'), '# mine\nalways_current = []\n');
  return { dir, ls, node, inst, state: path.join(dir, 'state') };
}
function ctx(m, extra = {}) {
  const run = async (cmd, args = []) => {
    if (cmd === 'mise' && args.join(' ') === 'ls --json') return { status: 0, stdout: JSON.stringify(m.ls) };
    if (cmd !== 'curl') return { status: 1, stdout: '' };
    const url = args[args.length - 1];
    if (url === `${OSV}/querybatch`) {
      const { queries } = JSON.parse(args[args.indexOf('-d') + 1]);
      return { status: 0, stdout: JSON.stringify({ results: queries.map(q => ({ vulns: REC.filter(r => V.affects(r, q.package.ecosystem, q.package.name, q.version)).map(r => ({ id: r.id })) })) }) };
    }
    if (url.startsWith(`${OSV}/vulns/`)) { const r = REC.find(x => x.id === url.slice(`${OSV}/vulns/`.length)); return r ? { status: 0, stdout: JSON.stringify(r) } : { status: 22, stdout: '' }; }
    if (url === 'https://nodejs.org/dist/index.json') return { status: 0, stdout: JSON.stringify([{ version: 'v26.13.0', security: true }, { version: 'v26.12.1', security: false }]) };
    return { status: 22, stdout: '' };
  };
  return { run, now: new Date('2026-11-02T12:00:00Z'), today: '2026-11-02', platform: 'macos', instance: m.inst, engine: path.join(__dirname, '..'), cfg: { policy: {}, paths: {} },
    policy: { advisory_feed: FEEDS, advisory_ignore: [], vulns: V.SETTINGS }, aiOwned: ['npm:agentic-qe', 'ruflo', 'npm -g ruflo'], ...extra };
}
const withVulns = (m, s, extra = {}) => ctx(m, { policy: { advisory_feed: FEEDS, advisory_ignore: [], vulns: V.settings(s).values }, ...extra });

test('vulns-fix plan: the highest fix per tool, an exception each, unused vulnerable installs, Node next, the rest waits or is handed over', async () => {
  const m = machine('plan');
  const p = await F.plan(ctx(m));
  assert.deepEqual(p.upgrades.map(u => `${u.tool} ${u.have}->${u.version} ${u.advisories.map(a => a.id).join(',')}`), ['npm:cooltool 2.0.0->2.0.3 GHSA-fix2,GHSA-fix1']);
  assert.deepEqual(p.exceptions, [{ kind: 'mise', name: 'npm:cooltool', version: '2.0.3', advisory: 'https://osv.dev/vulnerability/GHSA-fix2', expires: '2026-11-09' }]);
  assert.deepEqual(p.cleanup.map(c => `${c.tool}@${c.version} ${c.advisories.map(a => a.id).sort().join(',')}`), ['npm:cooltool@1.5.0 GHSA-fix1,GHSA-fix2,GHSA-old1']);
  assert.equal(p.node.version, '26.13.0');
  assert.ok(p.held.some(h => /^npm:nofix 1\.0\.0: GHSA-nofix \(critical\): no fixed release yet; steward sc isolate npm:nofix switches it off meanwhile$/.test(h)), p.held.join('\n'));
  assert.ok(p.handed.some(h => /^npm:agentic-qe 3\.0\.0: GHSA-owned: AI tooling owns it/.test(h)));
  assert.ok(p.handed.some(h => /^npm -g hybridy 3\.0\.0: GHSA-hyb, fixed in 3\.0\.1: set its version in hybrids\.toml, then steward sc install-hybrids$/.test(h)));
  assert.ok(!JSON.stringify(p).includes('GHSA-low'), 'a low finding is not vulns-fix\'s');
});

test('vulns-fix plan follows [vulns]: fix_skip_gate never, cleanup off, a running soak, a pinned install, an ignored advisory', async () => {
  const m = machine('plan-settings');
  let p = await F.plan(withVulns(m, { fix_skip_gate: 'never', cleanup: false }));
  assert.deepEqual(p.upgrades, []);
  assert.deepEqual(p.exceptions, []);
  assert.deepEqual(p.cleanup, []);
  assert.ok(p.held.some(h => /fix_skip_gate = "never", so steward sc upgrade takes it/.test(h)));
  p = await F.plan(withVulns(m, { cleanup_skip_soak: 'never' }), { soakRunning: true });
  assert.ok(p.held.some(h => /^npm:cooltool@1\.5\.0 \(unused\).*the soak is running/.test(h)));
  p = await F.plan(ctx(m, { pinned: async dirs => new Set(dirs.filter(d => d.includes('1.5.0'))) }));
  assert.ok(p.held.some(h => /a launcher config still points into it/.test(h)));
  p = await F.plan(ctx(m, { policy: { advisory_feed: FEEDS, vulns: V.SETTINGS, advisory_ignore: [{ id: 'GHSA-fix2', name: 'cooltool', version: '2.0.0', reason: 'r', expires: '2027-01-01' }] } }));
  assert.equal(p.upgrades[0].version, '2.0.1', 'the ignored advisory no longer asks for 2.0.3');
  await assert.rejects(F.plan(ctx(m, { policy: { advisory_feed: [], vulns: V.SETTINGS } })), /every advisory_feed is turned off/);
});

// files(m) — the three files vulns-fix can change, in m's instance
const files = m => ({ host: path.join(m.inst, 'supply-chain', 'host.toml'), miseConfig: path.join(m.inst, 'mise', 'config.toml'), miseLock: path.join(m.inst, 'mise', 'mise.lock') });

test('vulns-fix apply: backups, the exception in host.toml (comments kept), each step through its command, verify, a receipt; rollback undoes it', async () => {
  const m = machine('apply');
  const p = await F.plan(ctx(m));
  const calls = [];
  const exec = (cmd, args, env) => { calls.push([path.basename(cmd), ...args, ...(env.STEWARD_DEFER_VERIFY ? ['(deferred verify)'] : [])].join(' ')); return 0; };
  const dir = path.join(m.dir, 'backup'); fs.mkdirSync(dir);
  const r = F.apply(p, { dir, exec, files: files(m), write: () => {} });
  assert.equal(r.outcome, 'done');
  assert.deepEqual(calls, ['upgrade-tool npm:cooltool 2.0.3 (deferred verify)', 'mise uninstall npm:cooltool@1.5.0', 'verify']);
  const host = fs.readFileSync(files(m).host, 'utf8');
  assert.match(host, /^# mine\n/);
  const parsed = JSON.parse(spawnSync('yq', ['-p', 'toml', '-o', 'json', '.', files(m).host], { encoding: 'utf8' }).stdout);
  assert.deepEqual(parsed.security_exception, [{ kind: 'mise', name: 'npm:cooltool', version: '2.0.3', advisory: 'https://osv.dev/vulnerability/GHSA-fix2', expires: '2026-11-09' }]);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  assert.equal(receipt.kind, 'vulns-fix');
  assert.ok(fs.existsSync(path.join(dir, 'host')));
  // rollback: host.toml back as it was, the removed install reinstalled
  const back = [];
  assert.equal(F.rollback(path.join(dir, 'receipt.json'), { exec: (c, a) => { back.push([c, ...a].join(' ')); return 0; }, write: () => {} }), 0);
  assert.equal(fs.readFileSync(files(m).host, 'utf8'), '# mine\nalways_current = []\n');
  assert.deepEqual(back, ['mise install npm:cooltool@1.5.0', 'mise reshim']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8')).undone);
});

test('vulns-fix: a failed step marks the receipt failed (brief finds it); rollback keeps a file changed since', async () => {
  const m = machine('apply-fail');
  const p = await F.plan(ctx(m));
  const dir = path.join(m.dir, 'backup'); fs.mkdirSync(dir);
  const r = F.apply(p, { dir, exec: cmd => (path.basename(cmd) === 'upgrade-tool' ? 3 : 0), files: files(m), write: () => {} });
  assert.match(r.outcome, /^failed: upgrade npm:cooltool@2\.0\.3$/);
  fs.appendFileSync(files(m).host, '# edited later\n');
  const out = [];
  assert.equal(F.rollback(dir, { exec: () => 0, write: s => out.push(s) }), 1);
  assert.ok(out.some(l => /kept .*host\.toml: it changed after vulns-fix/.test(l)));
  assert.match(fs.readFileSync(files(m).host, 'utf8'), /# edited later/);
});

test('isolate: refuses Node, isolate_never, AI-owned tools, unknown tools, a second isolation and a tool with no reason', () => {
  const m = machine('refuse');
  const base = { ls: m.ls, nodeDir: m.node, s: V.SETTINGS, owned: ['npm:agentic-qe'], config: path.join(m.inst, 'mise', 'config.toml'), state: { tools: {} }, reason: 'r', advisories: [] };
  assert.match(I.planIsolate({ ...base, tool: 'node' }).why, /isolate_never/);
  assert.match(I.planIsolate({ ...base, tool: 'npm:cooltool', s: V.settings({ isolate_never: ['npm:cooltool'] }).values }).why, /isolate_never/);
  assert.match(I.planIsolate({ ...base, tool: 'npm:agentic-qe' }).why, /AI tooling owns npm:agentic-qe: the ai-tooling skill decides/);
  assert.equal(I.planIsolate({ ...base, tool: 'npm:agentic-qe', s: V.settings({ isolate_ai_owned: true }).values }).ok, true);
  assert.match(I.planIsolate({ ...base, tool: 'nope' }).why, /neither a mise tool nor an npm -g hybrid/);
  assert.match(I.planIsolate({ ...base, tool: 'npm:cooltool', state: { tools: { 'npm:cooltool': { at: 'x' } } } }).why, /already isolated/);
  assert.match(I.planIsolate({ ...base, tool: 'npm:cooltool', reason: '' }).why, /give the reason with --why/);
});

test('isolate a mise tool: disable_tools in mise/config.toml (the rest kept), reshim, the record; --undo takes it out again', () => {
  const m = machine('iso-mise');
  const config = path.join(m.inst, 'mise', 'config.toml');
  const state = { tools: {} }, stateFile = path.join(m.state, 'isolated.json');
  const p = I.planIsolate({ tool: 'npm:nofix', ls: m.ls, nodeDir: m.node, s: V.SETTINGS, owned: [], config, state, reason: '', advisories: [{ id: 'GHSA-nofix', severity: 'critical' }] });
  assert.equal(p.ok, true);
  const calls = [];
  const dir = path.join(m.dir, 'b1'); fs.mkdirSync(dir);
  const r = I.isolate(p, { dir, stateDir: m.state, stateFile, state, reason: '', advisories: [{ id: 'GHSA-nofix' }], exec: (c, a) => { calls.push([c, ...a].join(' ')); return 0; } });
  assert.equal(r.outcome, 'done');
  assert.deepEqual(I.disabled(config), ['npm:nofix']);
  assert.match(fs.readFileSync(config, 'utf8'), /experimental = true/);
  assert.deepEqual(calls, ['mise reshim']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tools), ['npm:nofix']);
  const dir2 = path.join(m.dir, 'b2'); fs.mkdirSync(dir2);
  I.undo('npm:nofix', { dir: dir2, stateFile, state, exec: () => 0 });
  assert.deepEqual(I.disabled(config), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tools, {});
});

test('isolate a hybrid: only its command links move aside (npm\'s stay); --undo puts them back, and refuses over a new file', () => {
  const m = machine('iso-hyb');
  const state = { tools: {} }, stateFile = path.join(m.state, 'isolated.json');
  const p = I.planIsolate({ tool: 'hybridy', ls: m.ls, nodeDir: m.node, s: V.SETTINGS, owned: [], config: path.join(m.inst, 'mise', 'config.toml'), state, reason: 'GHSA-hyb, no release yet', advisories: [] });
  assert.equal(p.target.tool, 'npm -g hybridy');
  assert.deepEqual(p.change.links.map(l => path.basename(l.from)), ['hybridy']);
  const dir = path.join(m.dir, 'b1'); fs.mkdirSync(dir);
  I.isolate(p, { dir, stateDir: m.state, stateFile, state, reason: 'GHSA-hyb, no release yet', advisories: [], exec: () => 0 });
  assert.ok(!fs.existsSync(path.join(m.node, 'bin', 'hybridy')));
  assert.ok(fs.lstatSync(path.join(m.node, 'bin', 'npm')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(m.state, 'isolated', 'hybridy', 'bin', 'hybridy')).isSymbolicLink());
  put(path.join(m.node, 'bin', 'hybridy'), 'someone else');
  assert.throws(() => I.undo('hybridy', { dir, stateFile, state, exec: () => 0 }), /exists again/);
  fs.rmSync(path.join(m.node, 'bin', 'hybridy'));
  const dir2 = path.join(m.dir, 'b2'); fs.mkdirSync(dir2);
  I.undo('hybridy', { dir: dir2, stateFile, state, exec: () => 0 });
  assert.equal(fs.readlinkSync(path.join(m.node, 'bin', 'hybridy')), '../lib/node_modules/hybridy/cli.js');
});

test('brief: an isolated tool waits with its undo; one mise no longer ignores is a fix; a stopped vulns-fix is found', () => {
  const at = '2026-11-01T10:00:00Z';
  const f = { isolated: { 'npm:nofix': { kind: 'mise', at, advisories: [{ id: 'GHSA-nofix' }] }, 'npm -g hybridy': { kind: 'hybrid', at, reason: 'no release yet' } }, disableTools: [] };
  const pick = id => B.DETECTORS.find(d => d.id === id).check(f);
  assert.deepEqual(pick('isolated').map(x => x.text), ['npm:nofix is isolated since 2026-11-01 (GHSA-nofix)', 'npm -g hybridy is isolated since 2026-11-01 (no release yet)']);
  assert.deepEqual(pick('isolate-lost').map(x => x.key), ['isolate-lost:npm:nofix'], 'a hybrid is not in disable_tools');
  f.disableTools = ['npm:nofix'];
  assert.deepEqual(pick('isolate-lost'), []);
  assert.deepEqual(B.DETECTORS.find(d => d.id === 'isolated').check({}), [], 'facts without the record');
});

test('the vulns check suggests isolate for an urgent finding, names vulns-fix, and leaves AI tooling\'s tools to its skill', async () => {
  const m = machine('suggest');
  const out = [];
  await audit(ctx(m), { only: ['vulns'], write: s => out.push(s.replace(/\x1b\[[0-9;]*m/g, '')) });
  const text = out.join('\n');
  assert.match(text, /ACTION vuln: npm:nofix 1\.0\.0: GHSA-nofix critical, no fixed release yet https:\/\/osv\.dev\/vulnerability\/GHSA-nofix: steward sc isolate npm:nofix/);
  assert.match(text, /ACTION vuln: npm:agentic-qe 3\.0\.0: GHSA-owned high, fixed in 9\.0\.0 https:\/\/osv\.dev\/vulnerability\/GHSA-owned; AI tooling owns it \(the ai-tooling skill\)$/m);
  assert.match(text, /steward sc vulns-fix takes every fix named above in one plan/);
  const quiet = [];
  await audit(withVulns(m, { isolate_suggest: false }), { only: ['vulns'], write: s => quiet.push(s) });
  assert.doesNotMatch(quiet.join('\n'), /steward sc isolate/);
});

test('exceptionText: TOML that parses, one table per entry', () => {
  const t = F.exceptionText([{ kind: 'mise', name: 'npm:a"b', version: '1.0.1', advisory: 'https://osv.dev/vulnerability/X', expires: '2026-11-09' }]);
  const f = path.join(ROOT, 'exc.toml'); fs.writeFileSync(f, t);
  const j = JSON.parse(spawnSync('yq', ['-p', 'toml', '-o', 'json', '.', f], { encoding: 'utf8' }).stdout);
  assert.equal(j.security_exception[0].name, 'npm:a"b');
});
