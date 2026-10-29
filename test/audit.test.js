// Tests for the Node host audit (supply-chain/checks/, supply-chain/bin/audit.js, lib/providers/brew.js; R5c): each
// check against canned command output in a throwaway folder. No network, no real Homebrew, keychain or Docker.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { audit, localDay } = require('../supply-chain/bin/audit.js');
const { ui: makeUi } = require('../lib/ui.js');
const { verLt, appVersion, appBehind, ageDays, caskIds, pickCask } = require('../supply-chain/checks/index.js');
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
    { token: 'brave-browser', version: '1.98.60.0', artifacts: [{ app: ['Brave Browser.app'] }] },
    { token: 'warp', version: '0.2026.10.21.08.25.stable_02', artifacts: [{ app: ['Warp.app'] }] },
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

test('apps: the same release written differently is not behind; a Chromium-based app shows its own version', async () => {
  // 2026-10-28: Brave 156.1.98.60 (1.98.60) against cask 1.98.60.0, and Warp 0.2026.10.21.08.25.02 against cask
  // 0.2026.10.21.08.25.stable_02, were both reported as updates
  assert.equal(appVersion('156.1.98.60', '1.98.60.0'), '1.98.60');
  assert.equal(appBehind('1.98.60', '1.98.60.0'), false);
  assert.equal(appBehind('0.2026.10.21.08.25.02', '0.2026.10.21.08.25.stable_02'), false);
  assert.equal(appBehind('1.98.60', '1.98.62.0'), true);
  assert.equal(appBehind('1.24.2', '1.25.3'), true);
  assert.equal(appBehind('2.0', '1.9'), false);
  const apps = path.join(ROOT, 'Applications-same');
  for (const a of ['Brave Browser.app', 'Warp.app']) put(path.join(apps, a, 'Contents', 'Info.plist'), '');
  const plist = (app, v) => ({ [`defaults read ${path.join(apps, app, 'Contents', 'Info.plist')} CFBundleShortVersionString`]: `${v}\n` });
  const c = ctx({
    ...BREW, ...plist('Brave Browser.app', '156.1.98.58'), ...plist('Warp.app', '0.2026.10.21.08.25.02'),
    'npm view electron dist-tags.latest': '40.2.0\n',
    'gh api repos/Homebrew/homebrew-cask/commits?path=Casks/b/brave-browser.rb&per_page=30*': `${daysAgo(5)}\n`,
  }, { appDirs: [apps] });
  const w = lines();
  const r = (await audit(c, { only: ['apps'], write: w.write }));
  assert.deepEqual(r.actions, ['app: Brave Browser 1.98.58 -> 1.98.60.0 (5d old; vendor updater; matched cask brave-browser by app name)']);
  assert.ok(!w.out.some(l => l.includes('Warp')), w.out.join('\n'));
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

// tty(c, only, o) — the audit drawn on a fake 120-column UTF-8 terminal, colour off: its lines
async function tty(c, only, o = {}) {
  let text = '';
  const u = makeUi({ out: { isTTY: true, columns: 120, write: s => { text += s; } }, env: { LANG: 'en_US.UTF-8', NO_COLOR: '' }, now: () => 0 });
  (await audit(c, { only, ui: u, ...o }));
  return text.split('\n');
}

test('terminal: findings in columns under their check, act-on (by what to do) before held; other lines fold away', async () => {
  const apps = path.join(ROOT, 'Applications-tty');
  for (const a of ['iTerm.app', 'Google Chrome.app', 'Old.app']) put(path.join(apps, a, 'Contents', 'Info.plist'), '');
  put(path.join(apps, 'Old.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist'), '');
  const plist = (app, v) => ({ [`defaults read ${path.join(apps, app, 'Contents', 'Info.plist')} CFBundleShortVersionString`]: `${v}\n` });
  const c = ctx({
    ...BREW, ...plist('iTerm.app', '3.6.4'), ...plist('Google Chrome.app', '149.0.0'), ...plist('Old.app', '1.0'),
    [`defaults read ${path.join(apps, 'Old.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist')} CFBundleVersion`]: '30.1.0\n',
    'npm view electron dist-tags.latest': '40.2.0\n',
    'gh api repos/Homebrew/homebrew-cask/commits?path=Casks/i/iterm2.rb&per_page=30*': `${daysAgo(1)}\n`,
    'gh api repos/Homebrew/homebrew-cask/commits?path=Casks/g/google-chrome.rb&per_page=30*': `${daysAgo(0)}\n`,
    'brew list --formula --versions': 'openssl@3 3.6.0\n', 'brew list --formula --full-name': 'openssl@3\n', ...gh('openssl@3', daysAgo(1)),
    'brew outdated --formula --verbose': 'some/tap/thing (1.0) < 1.1\n',
    'docker info': '', 'docker ps --format {{.Image}}\t{{.Names}}': 'ollama/ollama:latest\tollama\nredis:8\tcache\n',
  }, { appDirs: [apps] });
  c.policy.always_current = ['google-chrome'];
  const out = await tty(c, ['brew-formulae', 'apps', 'docker']);
  const at = s => out.findIndex(l => l.includes(s));
  // Homebrew formulae passed: its held row shows, the tap line is folded away
  assert.match(out[at('Homebrew formulae')], /✔ {2}Homebrew formulae +1 held/);
  assert.match(out[at('Homebrew formulae') + 1], /^ {6}⏸ {2}openssl@3 +3\.6\.0 +→ +3\.6\.1_1 +1d {2}eligible in 2d$/);
  assert.equal(at('some/tap/thing'), -1, out.join('\n'));
  // apps: the two to act on, in columns (grouped by what to do: browsers, then Electron), then the held one
  const a = at('Apps and Electron');
  assert.deepEqual(out.slice(a + 1, a + 4).map(l => l.trim().split(/ {2,}/)), [
    ['⚠', 'Google Chrome', '149.0.0', '→', '150.0.1', '0d', 'always_current'],
    ['⚠', 'Old', 'Electron 30.1.0', '→', '38+'],
    ['⏸', 'iTerm', '3.6.4', '→', '3.6.5', '1d', 'eligible in 2d'],
  ]);
  assert.equal(out[a + 1].indexOf('→'), out[a + 3].indexOf('→'), 'one set of columns');
  // docker has an action, and its info line still folds away
  assert.equal(out.findIndex(l => l.includes('cache: redis:8')), -1);
  // the Summary: each heading once, its findings under it; then where the folded lines are
  const s = at('Summary');
  assert.deepEqual(out.slice(s + 1).filter(Boolean).map(l => l.trim().split(/ {2,}/)), [
    ['by hand: browsers, update now (always_current)'], ['Google Chrome', '149.0.0', '→', '150.0.1', '0d'],
    ['by hand: Electron below 38: update the app, or ask its vendor'], ['Old', 'Electron 30.1.0', '→', '38+'],
    ['by hand: pin each image by tag@digest'], ['ollama', 'ollama/ollama:latest'],
    ['2 check(s) have more lines: steward sc audit --verbose'],
  ]);
  // --verbose shows the folded line, and says nothing about folding
  const v = await tty(c, ['brew-formulae'], { verbose: true });
  assert.ok(v.some(l => l.includes('tap (as of last brew update): some/tap/thing')), v.join('\n'));
  assert.ok(!v.some(l => l.includes('--verbose')));
});

test('terminal: alerts head the Summary; a finding without facts is listed whole under "other"', async () => {
  const c = ctx({ [`node ${path.join(__dirname, '..', 'lib', 'host.js')}`]: 'host policy: fine\nWARN odd_key is not a known setting\n' }, { instance: path.join(ROOT, 'no-instance') });
  c.policy.ioc = [{ name: 'Bad thing', _source: 'default', files: [__filename] }];
  const out = await tty(c, ['host-policy', 'release-age', 'ioc']);
  const s = out.findIndex(l => l.startsWith('Summary'));
  const rest = out.slice(s + 1).filter(Boolean).map(l => l.trim());
  assert.match(rest[0], /^ALERT: an indicator of compromise matched/);
  assert.ok(rest[1].startsWith('Bad thing: file present /'), rest[1]);
  assert.equal(rest[2], 'steward sc release-age 3');
  assert.match(rest[3], /^mise\/config\.toml minimum_release_age +unset +→ +3 day\(s\)$/);
  assert.match(rest[4], /^renovate\.json minimumReleaseAge +unset +→ +3 day\(s\)$/, 'two rows under one heading');
  assert.deepEqual(rest.slice(5), ['other: each line says what to do', 'host.toml odd_key is not a known setting',
    '1 check(s) have more lines: steward sc audit --verbose'], rest.join('\n'));
});

// two casks whose app is Copilot.app, as Homebrew's API has them (2026-10-29): Copilot Money's names its own IDs
const MONEY = { token: 'copilot-money', version: '6.7.0,336-0bbb0dcd', artifacts: [{ app: ['Copilot.app'] }, { zap: [{ trash: ['~/Library/Application Scripts/com.copilot.production*', '~/Library/Group Containers/group.com.copilot.production', '~/Library/Preferences/com.copilot.production.plist'] }] }] };
const OWN = { token: 'copilot-own', version: '1.0', artifacts: [{ app: ['Copilot.app'] }, { uninstall: [{ quit: 'com.microsoft.autoupdate2', pkgutil: 'com.microsoft.m365copilot' }] }] };
const BARE = { token: 'copilot-bare', version: '1.0', artifacts: [{ app: ['Copilot.app'] }] };

test('caskIds and pickCask: a cask from the app\'s vendor; one naming no IDs on its name alone; another vendor\'s is not it', () => {
  assert.deepEqual(caskIds(MONEY), ['com.copilot.production']);
  assert.deepEqual(caskIds(OWN), ['com.microsoft.autoupdate2', 'com.microsoft.m365copilot']);
  assert.deepEqual(caskIds(BARE), []);
  assert.equal(pickCask([MONEY, OWN], 'com.microsoft.m365copilot').cask, OWN, 'the vendor\'s cask, though listed second');
  assert.equal(pickCask([MONEY, BARE], 'com.microsoft.m365copilot').cask, BARE, 'no IDs: the name is all there is');
  assert.equal(pickCask([MONEY], 'com.microsoft.m365copilot').other.c, MONEY);
  assert.equal(pickCask([MONEY], 'com.copilot.production').cask, MONEY);
  assert.equal(pickCask([MONEY], '').cask, MONEY, 'no bundle ID read: as before');
});

test('apps: an app is not compared with another product\'s cask of the same name (Microsoft 365 Copilot vs Copilot Money)', async () => {
  const apps = path.join(ROOT, 'Applications-copilot');
  put(path.join(apps, 'Copilot.app', 'Contents', 'Info.plist'), '');
  const plist = `defaults read ${path.join(apps, 'Copilot.app', 'Contents', 'Info.plist')}`;
  const c = ctx({ ...BREW, [`${plist} CFBundleShortVersionString`]: '156.0.4314.41\n', [`${plist} CFBundleIdentifier`]: 'com.microsoft.m365copilot\n', 'npm view electron dist-tags.latest': '40.2.0\n' }, { appDirs: [apps] });
  put(path.join(c.cache, 'cask-20261027.json'), JSON.stringify([MONEY]));
  const w = lines();
  const r = (await audit(c, { only: ['apps'], write: w.write }));
  assert.deepEqual(r.actions, []);
  assert.ok(!w.out.some(l => l.includes('held')), w.out.join('\n'));
  assert.ok(w.out.includes('  info   Copilot (com.microsoft.m365copilot): cask copilot-money is another app of that name (com.copilot.production); not compared'), w.out.join('\n'));
});
