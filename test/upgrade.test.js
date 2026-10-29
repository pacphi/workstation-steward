// The Node plan behind `steward sc plan` and `steward sc upgrade` (supply-chain/bin/upgrade.js, R5c PR 3): Homebrew
// formulae and casks, mise tools and mise itself from canned command output, with the lines the Bash plan printed.
// And applying it: every step's exit status counts, one failure doesn't stop the rest, the end lists each failure with
// its way back and exits 1, and verify runs once (a real run on 2026-10-29 hid a failed tool behind "done" and
// verified 8 times). No network, no real Homebrew or mise: the steps are stand-ins that record their calls.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { plan, apply, crossesMajor } = require('../supply-chain/bin/upgrade.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-upgrade-')));
const NOW = new Date('2026-10-27T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const ENGINE = path.join(__dirname, '..');

function ctx(commands) {
  const cache = path.join(ROOT, 'cache');
  put(path.join(cache, 'formula-20261027.json'), JSON.stringify([
    { name: 'git', versions: { stable: '2.52.0' }, revision: 0 },
    { name: 'openssl@3', versions: { stable: '3.6.1' }, revision: 1 },
    { name: 'jq', versions: { stable: '1.8.1' }, revision: 0 },
  ]));
  put(path.join(cache, 'cask-20261027.json'), JSON.stringify([
    { token: 'slack', version: '4.50.0', auto_updates: true },
    { token: 'iterm2', version: '3.6.5' },
  ]));
  const run = async (cmd, args = []) => {
    const k = [cmd, ...args].join(' ');
    const v = k in commands ? commands[k] : Object.entries(commands).find(([p]) => p.endsWith('*') && k.startsWith(p.slice(0, -1)))?.[1];
    if (v === undefined) return { status: 1, stdout: '' };
    return typeof v === 'string' ? { status: 0, stdout: v } : v;
  };
  return {
    run, cache, now: NOW, today: '2026-10-27', platform: 'macos', home: ROOT, engine: ENGINE,
    cfg: { policy: { min_release_age_days: 3 }, profiles: { ai_tooling: false }, paths: {} },
    policy: { security_exception: [{ kind: 'formula', name: 'openssl@3', version: '3.6.1', advisory: 'GHSA-x', expires: '2026-11-01' }] },
  };
}
const gh = (repo, file, date) => ({ [`gh api repos/Homebrew/${repo}/commits?path=${file}&per_page=30*`]: `${date}\n` });

test('crossesMajor: a major, or a 0.x minor, is a deliberate step; a non-numeric version never is', () => {
  assert.equal(crossesMajor('1.2.3', '1.3.0'), false);
  assert.equal(crossesMajor('1.9.0', '2.0.0'), true);
  assert.equal(crossesMajor('16.15', '18'), true);
  assert.equal(crossesMajor('0.7.23', '0.7.24'), false);
  assert.equal(crossesMajor('0.7.23', '0.8.0'), true);
  assert.equal(crossesMajor('liberica-25.0.4.1+1', 'liberica-25.0.5'), false);
});

test('plan: takes what is old enough or excepted, holds the rest, and says what is manual, skipped or AI-owned', async () => {
  const c = ctx({
    'brew --prefix': '/opt/homebrew\n',
    'brew list --formula --versions': 'git 2.51.0\nopenssl@3 3.6.0\njq 1.7\n',
    'brew list --formula --full-name': 'git\nopenssl@3\nsome/tap/jq\n',
    'brew list --cask --versions': 'slack 4.40.0\niterm2 3.6.4\n',
    ...gh('homebrew-core', 'Formula/g/git.rb', daysAgo(10)), ...gh('homebrew-core', 'Formula/o/openssl@3.rb', daysAgo(1)),
    ...gh('homebrew-cask', 'Casks/i/iterm2.rb', daysAgo(1)),
    'brew outdated --formula --verbose': 'some/tap/thing (1.0) < 1.1\n',
    'mise outdated --bump --json': JSON.stringify({
      node: { current: '26.12.1', latest: '26.13.0', bump: null, requested: '26' },
      gh: { current: '2.103.1', latest: '2.103.2', bump: null, requested: 'latest' },
      postgres: { current: '16.15', latest: '18', bump: '18', requested: '16' },
      'npm:renovate': { current: '44.176.1', latest: '44.181.5', bump: '44.181.5', requested: '44.176.1' },
      same: { current: '1.0', latest: '1.0', bump: null, requested: 'latest' },
    }),
    [`node ${path.join(ENGINE, 'supply-chain', 'bin', 'mise-self.js')} --plan`]: 'take\t2026.10.18\t2026.10.19\t3d old\tfalse\n',
  });
  const lines = [], sections = [];
  const p = await plan(c, { section: (_n, t) => sections.push(t), line: l => lines.push(l), warn: () => {} });
  assert.deepEqual(lines, [
    'take   git 2.51.0 -> 2.52.0 (10d old)',
    'take   openssl@3 3.6.0 -> 3.6.1_1 (security exception: GHSA-x)',
    'manual tap formula (review its release, then brew upgrade): some/tap/thing (1.0) < 1.1',
    'hold   iterm2 3.6.4 -> 3.6.5 (1d old)',
    'manual node 26.12.1 -> 26.13.0: steward sc node-patch <version> (hybrids reinstall)',
    'take   gh 2.103.1 -> 2.103.2',
    'skip   postgres 16.15 -> 18 (major: upgrade deliberately with steward sc upgrade-tool postgres <version>)',
    'take   npm:renovate 44.176.1 -> 44.181.5',
    'take   mise 2026.10.18 -> 2026.10.19 (3d old)',
  ]);
  assert.deepEqual(p, { formulae: ['git', 'openssl@3'], casks: [], tools: ['gh', 'npm:renovate'], updaters: [], miseSelf: '2026.10.19' });
  assert.deepEqual(sections, ['Homebrew formulae', 'Homebrew casks (self-updating casks are left to their own updaters)', 'mise tools (mise already applies minimum_release_age)', 'Declared updaters ([[updater]]: signed_data, always_current and an unexpired exception skip the gate)', "mise itself (D38: the gate and advisories decide; Homebrew's mise is judged with the formulae)"]);
});

test('plan: a declared updater that is behind is taken when its class skips the gate, held when gated; a changed key or an unclear check is skipped (D52)', async () => {
  const u = (name, cls, extra = {}) => ({ name, class: cls, why: 'w', check: `check-${name}`, apply: 'a', backup: ['b'], expires: '2026-11-01', ...extra });
  const c = ctx({
    'brew --prefix': '/opt/homebrew\n', 'brew list --formula --versions': '', 'brew list --formula --full-name': '', 'brew list --cask --versions': '', 'mise outdated --bump --json': '{}',
    'bash -c check-data': { status: 10, stdout: 'BEHIND\n' }, 'bash -c check-always': { status: 10, stdout: '' }, 'bash -c check-exc': { status: 10, stdout: '' },
    'bash -c check-expired': { status: 10, stdout: '' }, 'bash -c check-current': { status: 0, stdout: '' }, 'bash -c check-offline': { status: 2, stdout: '' },
  });
  c.policy.updater = [u('data', 'signed_data'), u('always', 'always_current'), u('exc', 'exception'), u('expired', 'exception', { expires: '2026-10-26' }), u('current', 'signed_data'), u('offline', 'signed_data'),
    u('rotated', 'signed_data', { pin: { file: path.join(ROOT, 'missing.mjs'), match: 'x', sha256: 'ab' } })];
  const lines = [];
  const p = await plan(c, { section: () => {}, line: l => lines.push(l), warn: () => {} });
  assert.deepEqual(p.updaters, ['data', 'always', 'exc']);
  assert.deepEqual(lines.filter(l => !l.includes(' mise ')), [
    'take   data (signed_data: skips the gate)',
    'take   always (always_current: never held)',
    'take   exc (exception: skips the gate until it expires)',
    'hold   expired (gated: a declared source has no release date; apply it yourself after review)',
    "skip   offline (its check couldn't tell: exit 2)",
    'skip   rotated (its signing key changed: steward sc audit)',
  ]);
});

// applyWith(p, fails, o) — apply(p) with stand-in steps: each call is recorded as {name, args, env}; a call whose
// name+args contains a key of `fails` exits with its value (and runs its side effect, when it's a function). The
// printed lines come back with colour stripped.
async function applyWith(p, fails = {}, o = {}) {
  const calls = [], out = [];
  const record = async (cmd, args, env) => {
    const name = path.basename(cmd), key = [name, ...args].join(' ');
    calls.push({ name, args, env });
    for (const [k, v] of Object.entries(fails)) if (key.includes(k)) return typeof v === 'function' ? v() : v;
    return 0;
  };
  const keep = { log: console.log, error: console.error };
  console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push(a.join(' '));
  let code;
  try { code = await apply(p, { script: record, step: record, dry: false, ...o }); } finally { Object.assign(console, keep); }
  return { code, calls, lines: out.join('\n').replace(/\x1b\[[0-9;]*m/g, '').split('\n') };
}
const PLAN = { formulae: ['git'], casks: [], tools: ['npm:renovate', 'github:gastownhall/beads', 'gh'], updaters: [], miseSelf: '' };

test('apply: a failed tool doesn\'t stop the others; the end names it with its way back, and the run exits 1, never "done"', async () => {
  const backups = path.join(ROOT, 'apply-backups');
  fs.mkdirSync(backups, { recursive: true });
  put(path.join(backups, 'config.toml.20261029-100000'), 'from an earlier tool\n');
  // upgrade-tool backs the config up before mise fails, as on the owner's Mac
  const beads = () => { put(path.join(backups, 'config.toml.20261029-100105'), 'before beads\n'); return 1; };
  const r = await applyWith(PLAN, { 'github:gastownhall/beads': beads }, { backups });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls.filter(c => c.name === 'upgrade-tool').map(c => c.args[0]), PLAN.tools, 'every tool ran, the ones after the failure too');
  assert.ok(r.lines.some(l => /ERROR mise tool github:gastownhall\/beads failed \(exit 1\); the other steps still run/.test(l)), 'reported as it happened');
  const i = r.lines.findIndex(l => /ERROR 1 step\(s\) of this upgrade failed/.test(l));
  assert.ok(i >= 0, r.lines.join('\n'));
  assert.equal(r.lines[i + 1].trim(), '✗ mise tool github:gastownhall/beads (exit 1)');
  assert.match(r.lines[i + 2], /way back: if it changed the config, steward sc rollback .*config\.toml\.20261029-100105 /);
  assert.ok(!r.lines.some(l => /\bdone\b/.test(l.replace('not done', ''))), 'never "done"');
  assert.ok(r.lines.some(l => /^==> not done: fix each failed step/.test(l)));
});

test('apply: a failed brew step and a failed declared updater are listed too', async () => {
  const r = await applyWith({ ...PLAN, tools: ['gh'], updaters: ['kb'] }, { 'brew upgrade': 1, '--apply kb': 2 });
  assert.equal(r.code, 1);
  assert.ok(r.lines.some(l => l.includes('✗ brew upgrade --formula git (exit 1)')));
  assert.ok(r.lines.some(l => l.includes('✗ declared updater kb (exit 2)')));
  assert.ok(r.lines.some(l => /ERROR 2 step\(s\) of this upgrade failed/.test(l)));
});

test('apply: a failed mise self-update exits 1 and says whether a binary backup was made', async () => {
  const stateBackups = path.join(ROOT, 'apply-state');
  fs.mkdirSync(stateBackups, { recursive: true });
  const r = await applyWith({ ...PLAN, tools: [], formulae: [], miseSelf: '2026.10.19' }, { 'mise-self-update': 1 }, { stateBackups });
  assert.equal(r.code, 1);
  assert.ok(r.lines.some(l => l.includes('✗ mise self-update to 2026.10.19 (exit 1)')));
  assert.ok(r.lines.some(l => l.includes('stopped before its binary backup')), r.lines.join('\n'));
  const made = () => { fs.mkdirSync(path.join(stateBackups, 'mise-self-update-20261029T100000Z'), { recursive: true }); return 1; };
  const r2 = await applyWith({ ...PLAN, tools: [], formulae: [], miseSelf: '2026.10.19' }, { 'mise-self-update': made }, { stateBackups });
  assert.ok(r2.lines.some(l => l.includes('way back: if mise changed, steward sc rollback mise')), r2.lines.join('\n'));
});

test('apply: verify runs once, at the end; the steps are told to leave it (STEWARD_DEFER_VERIFY=1); all good says done', async () => {
  const r = await applyWith({ ...PLAN, miseSelf: '2026.10.19' });
  assert.equal(r.code, 0);
  assert.equal(r.calls.filter(c => c.name === 'verify').length, 1);
  assert.equal(r.calls.at(-1).name, 'verify', 'after every step');
  for (const c of r.calls.filter(c => c.name === 'upgrade-tool' || c.name === 'mise-self-update')) assert.equal(c.env && c.env.STEWARD_DEFER_VERIFY, '1', c.name);
  assert.ok(r.lines.some(l => /^==> done\. Remaining manual items/.test(l)));
  assert.ok(r.lines.some(l => /^==> mise tool 3\/3: gh/.test(l)), 'a counter for long plans');
});

test('apply: a failed verify keeps its message and exit code', async () => {
  const r = await applyWith(PLAN, { verify: 1 });
  assert.equal(r.code, 1);
  assert.ok(r.lines.includes('ERROR verification failed; mise: steward sc rollback; Homebrew: brew reinstall the previous bottle'));
  assert.ok(!r.lines.some(l => /done\./.test(l)));
});

test('apply: a dry run verifies nothing and says nothing changed', async () => {
  const r = await applyWith(PLAN, {}, { dry: true });
  assert.equal(r.code, 0);
  assert.equal(r.calls.filter(c => c.name === 'verify').length, 0);
  assert.ok(r.lines.some(l => /^==> dry run: nothing changed/.test(l)));
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
