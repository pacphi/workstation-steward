// Tests for known vulnerabilities (lib/vulns.js, the audit's vulns check, steward sc vulns; D65): the inventory from
// canned `mise ls --json` and throwaway install folders, every feed kind against canned answers, severity, the ignore
// list, and how the review lifts the findings. No network: every fetch goes through ctx.run.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../lib/vulns.js');
const H = require('../lib/host.js');
const { audit } = require('../supply-chain/bin/audit.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-vulns-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); };

const OSV = 'https://api.osv.dev/v1';
const FEEDS = [
  { name: 'osv', kind: 'osv-api', url: OSV },
  { name: 'nodejs', kind: 'nodejs', url: 'https://nodejs.org/dist/index.json' },
  { name: 'kev', kind: 'kev', url: 'https://kev.example/kev.json' },
];
// records: the OSV database these tests use
const REC = {
  'GHSA-aaaa-aaaa-aaaa': {
    id: 'GHSA-aaaa-aaaa-aaaa', aliases: ['CVE-2026-0001'], summary: 'tool itself', database_specific: { severity: 'HIGH' },
    affected: [{ package: { ecosystem: 'npm', name: 'cooltool' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.1' }] }] }],
  },
  'GHSA-bbbb-bbbb-bbbb': {
    id: 'GHSA-bbbb-bbbb-bbbb', aliases: ['CVE-2026-0002'], summary: 'inside', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    affected: [{ package: { ecosystem: 'npm', name: 'leftish' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '1.2.4' }] }] }],
  },
  'GHSA-cccc-cccc-cccc': {
    id: 'GHSA-cccc-cccc-cccc', summary: 'low one', database_specific: { severity: 'LOW' },
    affected: [{ package: { ecosystem: 'npm', name: 'leftish' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '9.0.0' }] }] }],
  },
};

// machine(name) — a mise install folder with an npm tool (a lockfile holding the tool and leftish), a hybrid in the
// active Node, and the `mise ls --json` that names them
function machine(name) {
  const dir = path.join(ROOT, name);
  const tool = path.join(dir, 'installs', 'npm-cooltool', '2.0.0');
  put(path.join(tool, 'aube-lock.yaml'), "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      cooltool:\n        specifier: 2.0.0\n        version: 2.0.0\n\n"
    + "packages:\n\n  cooltool@2.0.0:\n    resolution: {integrity: sha512-x}\n\n  leftish@1.2.3:\n    resolution: {integrity: sha512-y}\n\n  '@scope/thing@0.1.0(peer@1.0.0)':\n    resolution: {integrity: sha512-z}\n\n"
    + 'snapshots:\n\n  cooltool@2.0.0: {}\n');
  const node = path.join(dir, 'installs', 'node', '26.12.1');
  put(path.join(node, 'lib', 'node_modules', 'hybridy', 'package.json'), { name: 'hybridy', version: '3.0.0' });
  put(path.join(node, 'lib', 'node_modules', 'hybridy', 'node_modules', 'leftish', 'package.json'), { name: 'leftish', version: '1.2.3' });
  put(path.join(node, 'lib', 'node_modules', 'hybridy', 'node_modules', '@s', 'deep', 'package.json'), { name: '@s/deep', version: '0.0.1' });
  const ls = {
    'npm:cooltool': [{ version: '2.0.0', install_path: tool, installed: true, active: true }],
    node: [{ version: '26.12.1', install_path: node, installed: true, active: true }],
    'aqua:cli/cli': [{ version: '2.1.0', install_path: path.join(dir, 'x'), installed: true, active: true }],
    gh: [{ version: '2.0.0', installed: true, active: false }, { version: '2.1.0', installed: true, active: true }],
  };
  return { dir, ls };
}

// ctx(m, answers) — a context whose run answers mise ls, OSV (from REC; querybatch matched by package), nodejs.org
// and KEV; answers overrides any of them by URL ({url: null} = no answer)
function ctx(m, answers = {}, extra = {}) {
  const seen = [];
  const run = async (cmd, args = []) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'mise' && args.join(' ') === 'ls --json') return { status: 0, stdout: JSON.stringify(m.ls) };
    if (cmd !== 'curl') return { status: 1, stdout: '' };
    const url = args[args.length - 1];
    if (url in answers) return answers[url] === null ? { status: 22, stdout: '' } : { status: 0, stdout: JSON.stringify(answers[url]) };
    if (url === `${OSV}/querybatch`) {
      const { queries } = JSON.parse(args[args.indexOf('-d') + 1]);
      return { status: 0, stdout: JSON.stringify({ results: queries.map(q => ({ vulns: Object.values(REC).filter(r => V.affects(r, q.package.ecosystem, q.package.name, q.version)).map(r => ({ id: r.id, modified: 'x' })) })) }) };
    }
    if (url.startsWith(`${OSV}/vulns/`)) { const r = REC[decodeURIComponent(url.slice(`${OSV}/vulns/`.length))]; return r ? { status: 0, stdout: JSON.stringify(r) } : { status: 22, stdout: '' }; }
    if (url === 'https://nodejs.org/dist/index.json') return { status: 0, stdout: JSON.stringify([{ version: 'v26.13.0', security: false }, { version: 'v26.12.1', security: false }]) };
    if (url === 'https://kev.example/kev.json') return { status: 0, stdout: JSON.stringify({ vulnerabilities: [{ cveID: 'CVE-2026-0002' }] }) };
    return { status: 22, stdout: '' };
  };
  return {
    run, seen, now: new Date('2026-11-02T12:00:00Z'), today: '2026-11-02', platform: 'macos', instance: path.join(m.dir, 'instance'), engine: path.join(__dirname, '..'),
    cfg: { policy: { min_release_age_days: 3 }, paths: {} }, policy: { advisory_feed: FEEDS, advisory_ignore: [] }, ...extra,
  };
}
const plain = async c => { const out = []; const r = await audit(c, { only: ['vulns'], write: s => out.push(s.replace(/\x1b\[[0-9;]*m/g, '')) }); return { ...r, out }; };

test('ecosystemOf: npm, pipx, cargo and go tools have an ecosystem; core, aqua, github, asdf and vfox tools have none', () => {
  assert.deepEqual(V.ecosystemOf('npm:@scope/x'), { ecosystem: 'npm', name: '@scope/x' });
  assert.deepEqual(V.ecosystemOf('pipx:black'), { ecosystem: 'PyPI', name: 'black' });
  assert.deepEqual(V.ecosystemOf('cargo:ripgrep'), { ecosystem: 'crates.io', name: 'ripgrep' });
  assert.deepEqual(V.ecosystemOf('go:github.com/a/b/cmd/c'), { ecosystem: 'Go', name: 'github.com/a/b' });
  for (const t of ['node', 'gh', 'aqua:cli/cli', 'github:a/b', 'asdf:a/b', 'vfox:a/b']) assert.equal(V.ecosystemOf(t), null, t);
});

test('lockPackages reads an aube/pnpm lockfile\'s packages (peer suffixes dropped) and a package-lock.json', () => {
  const yaml = "lockfileVersion: '9.0'\npackages:\n\n  a@1.0.0:\n    resolution: {}\n\n  '@s/b@2.0.0(peer@1.0.0)':\n    resolution: {}\nsnapshots:\n\n  c@3.0.0: {}\n";
  assert.deepEqual(V.lockPackages('aube-lock.yaml', yaml), [{ name: 'a', version: '1.0.0' }, { name: '@s/b', version: '2.0.0' }]);
  const lock = { packages: { '': { name: 'root', version: '1.0.0' }, 'node_modules/x': { version: '1.1.0' }, 'node_modules/x/node_modules/@s/y': { version: '0.2.0' }, 'node_modules/l': { link: true } } };
  assert.deepEqual(V.lockPackages('package-lock.json', JSON.stringify(lock)), [{ name: 'x', version: '1.1.0' }, { name: '@s/y', version: '0.2.0' }]);
});

test('inventory: the active installs, the packages inside an npm tool and a hybrid, Node, and the tools with no ecosystem', async () => {
  const m = machine('inv');
  const inv = await V.inventory(ctx(m));
  const has = (tool, name, version, top) => inv.packages.some(p => p.tool === tool && p.name === name && p.version === version && p.top === top);
  assert.ok(has('npm:cooltool', 'cooltool', '2.0.0', true));
  assert.ok(has('npm:cooltool', 'leftish', '1.2.3', false));
  assert.ok(has('npm:cooltool', '@scope/thing', '0.1.0', false));
  assert.ok(has('npm -g hybridy', 'hybridy', '3.0.0', true));
  assert.ok(has('npm -g hybridy', 'leftish', '1.2.3', false));
  assert.ok(has('npm -g hybridy', '@s/deep', '0.0.1', false));
  assert.equal(inv.node, '26.12.1');
  assert.deepEqual(inv.uncovered.sort(), ['aqua:cli/cli', 'gh']);
});

test('affects and fixedIn: introduced/fixed and last_affected ranges, listed versions, the lowest newer fix', () => {
  const r = { affected: [{ package: { ecosystem: 'npm', name: 'p' }, versions: ['0.9.0'], ranges: [{ type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '1.2.4' }, { introduced: '2.0.0' }, { last_affected: '2.1.0' }] }] }] };
  assert.equal(V.affects(r, 'npm', 'p', '0.9.0'), true);
  assert.equal(V.affects(r, 'npm', 'p', '1.2.3'), true);
  assert.equal(V.affects(r, 'npm', 'p', '1.2.4'), false);
  assert.equal(V.affects(r, 'npm', 'p', '2.1.0'), true);
  assert.equal(V.affects(r, 'npm', 'p', '2.1.1'), false);
  assert.equal(V.affects(r, 'npm', 'other', '1.2.3'), false);
  assert.equal(V.affects(r, 'PyPI', 'p', '1.2.3'), false);
  assert.equal(V.fixedIn(r, 'npm', 'p', '1.2.3'), '1.2.4');
  assert.equal(V.cmpVer('1.10.0', '1.9.9') > 0, true);
  assert.equal(V.cmpVer('1.2.0-rc.1', '1.2.0') < 0, true);
});

test('severity: the reviewed label first, else the CVSS v3 base score; a v4 vector alone is unknown', () => {
  assert.equal(V.cvss3('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H'), 7.4);   // GHSA-p6mc-m468-83gw, rated HIGH
  assert.equal(V.cvss3('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(V.cvss3('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
  assert.equal(V.cvss3('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'), null);
  assert.equal(V.severityOf({ database_specific: { severity: 'MODERATE' }, severity: [{ score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }), 'moderate');
  assert.equal(V.severityOf({ database_specific: { severity: 'MEDIUM' } }), 'moderate');
  assert.equal(V.severityOf({ severity: [{ score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }), 'critical');
  assert.equal(V.severityOf({ severity: [{ score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N' }] }), 'unknown');
  assert.equal(V.serious({ severity: 'unknown', kev: false }), true, 'an unrated finding counts with high');
  assert.equal(V.serious({ severity: 'low', kev: true }), true, 'a known-exploited one counts whatever its rating');
  assert.equal(V.serious({ severity: 'moderate', kev: false }), false);
});

test('lookup: the tool itself with its fix, packages inside tools, a low one, KEV marked, worst first', async () => {
  const m = machine('lookup');
  const c = ctx(m);
  const { findings, failed, checked } = await V.lookup(c, FEEDS, await V.inventory(c));
  assert.deepEqual(failed, []);
  assert.deepEqual(checked, ['osv', 'nodejs', 'kev']);
  const tool = findings.find(f => f.id === 'GHSA-aaaa-aaaa-aaaa');
  assert.equal(tool.severity, 'high');
  assert.equal(tool.fixed, '2.0.1');
  assert.equal(V.fixCommand(tool), 'steward sc upgrade-tool npm:cooltool 2.0.1');
  const inside = findings.filter(f => f.id === 'GHSA-bbbb-bbbb-bbbb');
  assert.deepEqual(inside.map(f => f.pkg.tool).sort(), ['npm -g hybridy', 'npm:cooltool']);
  assert.ok(inside.every(f => f.kev && f.severity === 'critical' && V.fixCommand(f) === ''));
  assert.equal(findings[0].id, 'GHSA-bbbb-bbbb-bbbb', 'known exploited first');
  assert.ok(findings.some(f => f.id === 'GHSA-cccc-cccc-cccc' && f.severity === 'low'));
});

test('a feed that gives no answer is not checked, never clean', async () => {
  const m = machine('down');
  const r = await plain(ctx(m, { [`${OSV}/querybatch`]: null, 'https://kev.example/kev.json': null }));
  const text = r.out.join('\n');
  assert.match(text, /ACTION vuln-feed: osv not checked/);
  assert.match(text, /ACTION vuln-feed: kev not checked/);
  assert.doesNotMatch(text, /^ {2}clean /m, 'no clean line when a feed was not read');
  assert.match(text, /checked with nodejs:/);
});

test('every feed turned off says nothing was checked', async () => {
  const m = machine('off');
  const r = await plain(ctx(m, {}, { policy: { advisory_feed: [], advisory_ignore: [] } }));
  assert.match(r.out.join('\n'), /ACTION vuln-feed: every advisory_feed is turned off/);
});

test('Node: a newer security release on the active line is a finding with node-patch as its fix', async () => {
  const m = machine('node');
  const c = ctx(m, { 'https://nodejs.org/dist/index.json': [{ version: 'v26.13.1', security: true }, { version: 'v26.13.0', security: true }, { version: 'v26.12.1', security: false }, { version: 'v25.9.0', security: true }] });
  const { findings } = await V.lookup(c, FEEDS, await V.inventory(c));
  const n = findings.find(f => f.pkg.ecosystem === 'node');
  assert.equal(n.fixed, '26.13.1');
  assert.equal(V.fixCommand(n), 'steward sc node-patch 26.13.1');
});

test('the check: serious findings are actions (the tool\'s with its command, a tool\'s inside ones as one), the rest info', async () => {
  const m = machine('check');
  const r = await plain(ctx(m));
  const text = r.out.join('\n');
  assert.match(text, /ACTION vuln: npm:cooltool 2\.0\.0: GHSA-aaaa-aaaa-aaaa high, fixed in 2\.0\.1 https:\/\/osv\.dev\/vulnerability\/GHSA-aaaa-aaaa-aaaa: steward sc upgrade-tool npm:cooltool 2\.0\.1/);
  assert.match(text, /ACTION vuln: npm -g hybridy: 1 serious advisory in 1 package\(s\) inside it \(GHSA-bbbb-bbbb-bbbb\)/);
  assert.match(text, /info {3}npm:cooltool: leftish 1\.2\.3 inside it: GHSA-cccc-cccc-cccc low/);
  assert.match(text, /not covered \(no advisory ecosystem; not the same as clean\): aqua:cli\/cli, gh/);
  assert.equal(r.alerts.length, 0, 'a vulnerability is never an IOC alert');
});

test('advisory_ignore: an unexpired entry silences that advisory for that package and version only; an expired one says so', async () => {
  const m = machine('ignore');
  const ignore = [
    { id: 'CVE-2026-0001', name: 'cooltool', version: '2.0.0', reason: 'we never call the affected API', expires: '2026-12-01' },
    { id: 'GHSA-bbbb-bbbb-bbbb', name: 'leftish', version: '1.2.3', reason: 'old', expires: '2026-10-01' },
  ];
  const r = await plain(ctx(m, {}, { policy: { advisory_feed: FEEDS, advisory_ignore: ignore } }));
  const text = r.out.join('\n');
  assert.match(text, /ignored until 2026-12-01: GHSA-aaaa-aaaa-aaaa in cooltool 2\.0\.0/, 'matched by its alias');
  assert.doesNotMatch(text, /ACTION vuln: npm:cooltool 2\.0\.0/);
  assert.match(text, /advisory_ignore GHSA-bbbb-bbbb-bbbb \(leftish 1\.2\.3\) expired 2026-10-01: shown again/);
  assert.match(text, /ACTION vuln: npm -g hybridy/);
});

test('osv-dir: the instance\'s own OSV records are matched locally; a file that isn\'t OSV JSON is reported', async () => {
  const m = machine('dir');
  const c = ctx(m);
  put(path.join(c.instance, 'supply-chain', 'advisories', 'ours.json'), {
    id: 'LOCAL-2026-1', summary: 'our incident', database_specific: { severity: 'CRITICAL' },
    affected: [{ package: { ecosystem: 'npm', name: '@s/deep' }, versions: ['0.0.1'] }],
  });
  put(path.join(c.instance, 'supply-chain', 'advisories', 'broken.json'), '{nope');
  const feeds = [{ name: 'ours', kind: 'osv-dir', path: 'supply-chain/advisories' }];
  const { findings, failed } = await V.lookup(c, feeds, await V.inventory(c));
  assert.deepEqual(findings.map(f => `${f.id} ${f.pkg.tool} ${f.severity}`), ['LOCAL-2026-1 npm -g hybridy critical']);
  assert.match(failed[0].error, /1 file\(s\) aren't OSV JSON \(broken\.json\)/);
  assert.ok(!c.seen.some(s => s.startsWith('curl')), 'a folder feed makes no network call');
});

test('host.toml: advisory_feed merges with the engine\'s defaults and [off]; bad feeds and incomplete ignores are left out', () => {
  const defaults = { advisory_feed: FEEDS };
  const mine = {
    advisory_feed: [{ name: 'mirror', kind: 'osv-api', url: 'https://osv.internal.example/v1', ecosystems: ['npm'] }, { name: 'bad', kind: 'command', run: 'scan' }, { name: 'plain', kind: 'osv-api', url: 'http://x' }],
    off: { advisory_feed: ['kev'] },
    advisory_ignore: [{ id: 'GHSA-x', name: 'a', version: '1', reason: 'r', expires: '2027-01-01' }, { id: 'GHSA-y', name: 'b' }],
  };
  const { policy, warnings } = H.merge(defaults, mine, 'macos', null);
  assert.deepEqual(policy.advisory_feed.map(f => f.name), ['osv', 'nodejs', 'mirror']);
  assert.ok(warnings.some(w => /advisory_feed bad \(yours\): kind must be osv-api, osv-dir, nodejs, kev; left out/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some(w => /advisory_feed plain \(yours\): url must start with https:\/\//.test(w)));
  assert.deepEqual(policy.advisory_ignore.map(e => e.id), ['GHSA-x']);
  assert.ok(warnings.some(w => /advisory_ignore GHSA-y: needs version; left out/.test(w)));
});

test('the engine\'s defaults ship the osv, nodejs and kev feeds, each usable', () => {
  const { policy, warnings } = H.merge(JSON.parse(require('child_process').execFileSync('yq', ['-p', 'toml', '-o', 'json', '.', H.DEFAULTS_FILE], { encoding: 'utf8' })), {}, 'macos', null);
  assert.deepEqual(policy.advisory_feed.map(f => `${f.name}:${f.kind}`), ['osv:osv-api', 'nodejs:nodejs', 'kev:kev']);
  assert.deepEqual(warnings.filter(w => w.includes('advisory')), []);
});

test('the review lifts a fix command with a mise tool key in it, and gives the others their by-hand step', () => {
  const R = require('../lib/review.js');
  const items = R.auditItems([
    '==> Summary: 3 action(s), 0 alert(s) [0:05]',
    '  ACTION vuln: npm:cooltool 2.0.0: GHSA-aaaa-aaaa-aaaa high, fixed in 2.0.1 https://osv.dev/vulnerability/GHSA-aaaa-aaaa-aaaa: steward sc upgrade-tool npm:cooltool 2.0.1',
    '  ACTION vuln: npm -g hybridy: 1 serious advisory in 1 package(s) inside it (GHSA-b); update it when a release carries the fixes (steward sc vulns --verbose lists them)',
    '  ACTION vuln-feed: osv not checked (no answer); what it would have found is missing',
  ].join('\n'));
  assert.equal(items[0].cmd, 'steward sc upgrade-tool npm:cooltool 2.0.1');
  assert.match(items[0].text, /^vuln: npm:cooltool 2\.0\.0: GHSA-aaaa-aaaa-aaaa high, fixed in 2\.0\.1 https:\/\/osv\.dev/);
  assert.match(items[1].how, /update the tool when a release carries the fix/);
  assert.match(items[2].how, /check the network or the feed/);
});

test('[vulns] settings: defaults, overrides key by key, and a wrong kind or unknown key keeps the default', () => {
  assert.deepEqual(V.settings({}).values, V.SETTINGS);
  const { values, problems } = V.settings({ action_severity: 'critical', parallel: 99, inside_tools: 'yes', colour: 'blue', unrated: 'moderate' });
  assert.equal(values.action_severity, 'critical');
  assert.equal(values.unrated, 'moderate');
  assert.equal(values.parallel, V.SETTINGS.parallel);
  assert.equal(values.inside_tools, true);
  assert.deepEqual(problems, ['parallel must be a whole number from 1 to 32', 'inside_tools must be true or false', 'unknown key colour (action_severity, unrated, exploited_always_action, inside_tools, hybrids, list_not_covered, batch_size, parallel, timeout_seconds)']);
  const { policy, warnings } = H.merge({ vulns: { action_severity: 'high', batch_size: 500 } }, { vulns: { action_severity: 'moderate', batch_size: 0 } }, 'macos', null);
  assert.equal(policy.vulns.action_severity, 'moderate');
  assert.equal(policy.vulns.batch_size, 500);
  assert.ok(warnings.includes('[vulns] batch_size must be a whole number from 1 to 1000; the default is kept'), warnings.join('\n'));
});

test('[vulns] settings change what is an action and what is looked at', async () => {
  const m = machine('settings');
  const base = ctx(m);
  const policy = s => ({ advisory_feed: FEEDS, advisory_ignore: [], vulns: V.settings(s).values });
  // moderate and up, KEV not special, unrated as low: the low finding stays info, the critical inside is still an action
  let text = (await plain(ctx(m, {}, { policy: policy({ action_severity: 'critical', exploited_always_action: false }) }))).out.join('\n');
  assert.doesNotMatch(text, /ACTION vuln: npm:cooltool 2\.0\.0/, 'high is below critical');
  assert.match(text, /ACTION vuln: npm -g hybridy: 1 serious advisory/, 'the inside one is critical');
  assert.match(text, /serious \(critical and up\)/);
  // only the tools themselves: nothing inside is looked at, so only the tool's own advisory is found
  text = (await plain(ctx(m, {}, { policy: policy({ inside_tools: false, hybrids: false, list_not_covered: false }) }))).out.join('\n');
  assert.match(text, /ACTION vuln: npm:cooltool 2\.0\.0: GHSA-aaaa/);
  assert.doesNotMatch(text, /leftish|hybridy|not covered/);
  // the request timeout reaches curl
  await plain(ctx(m, {}, { policy: policy({ timeout_seconds: 9 }) }));
  assert.ok(base.seen.length === 0);
  const c = ctx(m, {}, { policy: policy({ timeout_seconds: 9, batch_size: 1 }) });
  await plain(c);
  assert.ok(c.seen.some(x => x.startsWith('curl -fsS -m 9 ')));
  assert.ok(c.seen.filter(x => x.endsWith('/querybatch')).length >= 3, 'one package version per request');
});
