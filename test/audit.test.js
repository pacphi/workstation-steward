// Tests for the Node host audit (supply-chain/checks/, supply-chain/bin/audit.js, lib/providers/brew.js; R5c): each
// check against canned command output in a throwaway folder. No network, no real Homebrew, keychain or Docker.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit, localDay } = require('../supply-chain/bin/audit.js');
const { verLt, ageDays } = require('../supply-chain/checks/index.js');
const brew = require('../lib/providers/brew.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-audit-')));
const NOW = new Date('2026-10-27T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

// ctx(commands, extra) — a context whose run answers from `commands` ({'cmd arg …': stdout | {status, stdout}}; a
// function key test is tried last), with Homebrew's API lists in a temporary cache
function ctx(commands = {}, extra = {}) {
  const cache = path.join(ROOT, `cache-${Math.random().toString(36).slice(2)}`);
  put(path.join(cache, 'formula-20261027.json'), JSON.stringify([
    { name: 'git', versions: { stable: '2.52.0' }, revision: 0 },
    { name: 'openssl@3', versions: { stable: '3.6.1' }, revision: 1 },
    { name: 'jq', versions: { stable: '1.8.1' }, revision: 0 },
    { name: 'same', versions: { stable: '1.0' }, revision: 0 },
  ]));
  put(path.join(cache, 'cask-20261027.json'), JSON.stringify([
    { token: 'slack', version: '4.50.0', auto_updates: true, artifacts: [{ app: ['Slack.app'] }] },
    { token: 'iterm2', version: '3.6.5', artifacts: [{ app: ['iTerm.app'] }] },
    { token: 'google-chrome', version: '150.0.1,abc', artifacts: [{ app: ['Google Chrome.app'] }] },
  ]));
  const seen = [];
  const run = (cmd, args = []) => {
    const k = [cmd, ...args].join(' ');
    seen.push(k);
    const v = k in commands ? commands[k] : Object.entries(commands).find(([p]) => p.endsWith('*') && k.startsWith(p.slice(0, -1)))?.[1];
    if (v === undefined) return { status: 1, stdout: '' };
    return typeof v === 'string' ? { status: 0, stdout: v } : v;
  };
  return {
    run, seen, cache, now: NOW, today: '2026-10-27', platform: 'macos', home: path.join(ROOT, 'home'), instance: path.join(ROOT, 'instance'), engine: path.join(__dirname, '..'),
    cfg: { policy: { min_release_age_days: 3 }, paths: { mise_data_dir: path.join(ROOT, 'mise') }, ioc: { extra_roots: [] } },
    policy: { security_exception: [], always_current: [], distrusted_root: [], ioc: [], electron_supported_majors: 3 }, appDirs: [], ...extra,
  };
}
const BREW = { 'brew --prefix': '/opt/homebrew\n' };
const gh = (name, date) => ({ [`gh api repos/Homebrew/homebrew-core/commits?path=Formula/${name[0]}/${name}.rb&per_page=30*`]: `${date}\n` });
const lines = () => { const out = []; return { out, write: s => out.push(s.replace(/\x1b\[[0-9;]*m/g, '')) }; };

test('verLt sorts like sort -V; ageDays counts whole days, -1 when unknown', async () => {
  assert.equal(verLt('1.9', '1.10'), true);
  assert.equal(verLt('1.10', '1.9'), false);
  assert.equal(verLt('3.6.5', '3.6.5'), false);
  assert.equal(verLt('1.2', '1.2.1'), true);
  assert.equal(verLt('1.95.104', '1.95.110'), true);
  assert.equal(ageDays(daysAgo(5), NOW), 5);
  assert.equal(ageDays('', NOW), -1);
  // the local date, as the Bash audit's `date`: 05:00 UTC is still the previous evening west of UTC
  const d = new Date(2026, 9, 27, 23, 30);
  assert.equal(localDay(d), '2026-10-27');
});

test('brew formulae: old enough is an action, young is held, a security exception goes now; tap formulae are left out', async () => {
  const c = ctx({
    ...BREW,
    'brew list --formula --versions': 'git 2.51.0\nopenssl@3 3.6.0\njq 1.7\nsame 1.0\n',
    'brew list --formula --full-name': 'git\nopenssl@3\nsome/tap/jq\nsame\n',
    ...gh('git', daysAgo(10)), ...gh('openssl@3', daysAgo(1)),
    'brew outdated --formula --verbose': 'some/tap/thing (1.0) < 1.1\n',
  });
  const w = lines();
  const r = (await audit(c, { only: ['brew-formulae'], write: w.write }));
  assert.ok(w.out.includes('  ACTION brew: git 2.51.0 -> 2.52.0 (10d old)'), w.out.join('\n'));
  assert.ok(w.out.includes('  held   openssl@3 3.6.0 -> 3.6.1_1 (1d old; eligible in 2d)'));
  assert.ok(!w.out.some(l => / jq /.test(l)), 'jq is a tap formula with the same name as a core one');
  assert.ok(w.out.includes('  tap (as of last brew update): some/tap/thing (1.0) < 1.1'));
  assert.deepEqual(r.actions, ['brew: git 2.51.0 -> 2.52.0 (10d old)']);

  c.policy.security_exception = [{ kind: 'formula', name: 'openssl@3', version: '3.6.1', advisory: 'GHSA-x', expires: '2026-11-01' }, { kind: 'formula', name: 'git', version: '2.52.0', advisory: 'old', expires: '2026-10-01' }];
  const w2 = lines();
  (await audit(c, { only: ['brew-formulae'], write: w2.write }));
  assert.ok(w2.out.includes('  ACTION brew: openssl@3 3.6.0 -> 3.6.1_1 (security exception: GHSA-x)'), 'the version without its _revision');
  assert.ok(w2.out.includes('  ACTION brew: git 2.51.0 -> 2.52.0 (10d old)'), 'an expired exception changes nothing');
});

test('brew casks: one that updates itself is left to the apps check', async () => {
  const c = ctx({ ...BREW, 'brew list --cask --versions': 'slack 4.40.0\niterm2 3.6.4\n', 'gh api repos/Homebrew/homebrew-cask/commits?path=Casks/i/iterm2.rb&per_page=30*': `${daysAgo(4)}\n` });
  const w = lines();
  const r = (await audit(c, { only: ['brew-casks'], write: w.write }));
  assert.deepEqual(r.actions, ['cask: iterm2 3.6.4 -> 3.6.5 (4d old)']);
});

test('apps: behind the cask catalog, always_current, Electron outside its window; App Store apps are skipped', async () => {
  const apps = path.join(ROOT, 'Applications');
  for (const a of ['iTerm.app', 'Google Chrome.app', 'Old.app', 'Store.app']) put(path.join(apps, a, 'Contents', 'Info.plist'), '');
  put(path.join(apps, 'Old.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist'), '');
  put(path.join(apps, 'Store.app', 'Contents', '_MASReceipt', 'receipt'), '');
  const plist = (app, v) => ({ [`defaults read ${path.join(apps, app, 'Contents', 'Info.plist')} CFBundleShortVersionString`]: `${v}\n` });
  const c = ctx({
    ...BREW, ...plist('iTerm.app', '3.6.4'), ...plist('Google Chrome.app', '149.0.0'), ...plist('Old.app', '1.0'),
    [`defaults read ${path.join(apps, 'Old.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist')} CFBundleVersion`]: '30.1.0\n',
    'npm view electron dist-tags.latest': '40.2.0\n',
    'gh api repos/Homebrew/homebrew-cask/commits?path=Casks/i/iterm2.rb&per_page=30*': `${daysAgo(1)}\n`,
    'gh api repos/Homebrew/homebrew-cask/commits?path=Casks/g/google-chrome.rb&per_page=30*': `${daysAgo(0)}\n`,
  }, { appDirs: [apps] });
  c.policy.always_current = ['google-chrome'];
  const w = lines();
  const r = (await audit(c, { only: ['apps'], write: w.write }));
  assert.deepEqual(r.actions, [
    'app: Google Chrome 149.0.0 -> 150.0.1 (0d old; always_current: update now)',
    'app: Old bundles Electron 30.1.0 (supported: 38+); update it, or ask the vendor',
  ]);
  assert.ok(w.out.includes('  held   iTerm 3.6.4 -> 3.6.5 (1d old; matched cask iterm2)'));
  assert.ok(!c.seen.some(k => k.includes('Store.app')), 'an App Store app is left to mas');
});

test('trust: a distrusted root macOS still trusts is an action; denied, it is ok', async () => {
  const root = { name: 'Bad Root', sha256: 'AB12', _source: 'default' };
  const kc = 'security find-certificate -a -Z -c Bad Root /System/Library/Keychains/SystemRootCertificates.keychain';
  const c = ctx({ [kc]: 'SHA-256 hash: ab12\n', 'security dump-trust-settings -d': 'Cert 0: Other\n   ResultDeny\nCert 1: Bad Root\n   ResultTrust\n' }, { policy: { distrusted_root: [root] } });
  const w = lines();
  assert.deepEqual((await audit(c, { only: ['trust'], write: w.write })).actions, ['trust: Bad Root is trusted by macOS; deny it: sudo security add-trusted-cert -d -r deny <pem> (see AGENTS.md)']);
  const d = ctx({ [kc]: 'SHA-256 hash: AB12\n', 'security dump-trust-settings -d': 'Cert 0: Bad Root\n   ResultDeny\n' }, { policy: { distrusted_root: [root] } });
  const w2 = lines();
  assert.deepEqual((await audit(d, { only: ['trust'], write: w2.write })).actions, []);
  assert.ok(w2.out.includes('  ok     Bad Root (default): in macOS system roots, admin trust setting = Deny'));
});

test('docker: a floating tag is an action, a tag without a digest is info, a digest is fine', async () => {
  const c = ctx({ 'docker info': '', 'docker ps --format {{.Image}}\t{{.Names}}': 'ollama/ollama:latest\tollama\nredis:8\tcache\nnginx\tweb\napp@sha256:abc\tpinned\n' });
  const w = lines();
  const r = (await audit(c, { only: ['docker'], write: w.write }));
  assert.deepEqual(r.actions, ['docker: container ollama runs floating ollama/ollama:latest; pin tag@digest', 'docker: container web runs floating nginx; pin tag@digest']);
  assert.ok(w.out.includes('  info   cache: redis:8 (tag, no digest)'));
});

test('ioc: a file, a process, a site-packages file or an image digest is an alert; nothing found is clean', async () => {
  const marker = path.join(ROOT, 'ioc-marker');
  put(marker, '');
  const ioc = [{ name: 'Bad', _source: 'default', files: [marker], processes: ['evil-miner'], site_packages_files: ['cook.pth'], docker_digests: ['sha256:dead'] }, { name: 'Quiet', _source: 'yours', files: ['/nonexistent/x'] }];
  const c = ctx({ 'docker info': '', 'docker images --digests --format {{.Digest}}': 'sha256:dead\n', 'ps -axeww -o pid=,command=': '  101 /usr/bin/evil-miner --x\n', 'find *': '/x/site-packages/cook.pth\n' }, { policy: { ioc } });
  const w = lines();
  const r = (await audit(c, { only: ['ioc'], write: w.write }));
  assert.deepEqual(r.alerts, [`Bad: file present ${marker}`, "Bad: process matching 'evil-miner'", 'Bad: /x/site-packages/cook.pth', 'Bad: docker image with digest sha256:dead']);
  assert.ok(w.out.includes('  clean  Quiet (yours)'));
});

test('platforms: on Linux the macOS-only checks are skipped; Homebrew formulae still run where brew is', async () => {
  const c = ctx({ ...BREW, 'brew list --formula --versions': '', 'brew list --formula --full-name': '' }, { platform: 'linux' });
  const w = lines();
  const r = (await audit(c, { only: ['brew-formulae', 'brew-casks', 'apps', 'app-store', 'macos', 'trust'], write: w.write }));
  assert.deepEqual(r.skipped.sort(), ['app-store', 'apps', 'brew-casks', 'macos', 'trust']);
  assert.ok(w.out.some(l => l.startsWith('==> Homebrew formulae')));
  const none = ctx({}, { platform: 'linux' });
  const w2 = lines();
  (await audit(none, { only: ['brew-formulae'], write: w2.write }));
  assert.ok(w2.out.includes('  brew not found: skipped'), 'no Homebrew: the check says so instead of failing');
});

test('brew provider: the same names and versions lib/lib.sh brew_outdated gives', async () => {
  const c = ctx({ 'brew list --formula --versions': 'git 2.51.0 2.50.0\nsame 1.0\n', 'brew list --formula --full-name': 'git\nsame\n' });
  assert.deepEqual((await brew.outdated(c, 'formula')), [{ name: 'git', have: '2.50.0', want: '2.52.0', auto: false }], 'the last version listed is the one compared');
  assert.equal(brew.canRollback, false);
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
