// OS updates on Linux (parity 1e, apt's last box; the owner, 2026-11-03): point releases and kernels already arrive as
// apt packages; this section says when a restart is needed (/run/reboot-required where Ubuntu and Mint write it, and
// the running kernel against the newest installed one everywhere, since Debian writes no file), when a newer release
// of the distribution is out (a note: a release upgrade is a major, by hand), and when this release's free security
// support ends (a note within 90 days, an action once past). Sources: distro-info-data's debian.csv and ubuntu.csv,
// and Mint's release page. A source that can't be fetched or read is "not checked", never "up to date".
// test/osupdates/ holds real copies, fetched 2026-11-03 from salsa.debian.org/debian/distro-info-data (main) and
// www.linuxmint.com/download_all.php. Canned commands, a fake /; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// loaded so each test fails on its own before lib/osupdates.js exists (test first)
const O = (() => { try { return require('../lib/osupdates.js'); } catch { return { FIX: {}, SOURCES: {} }; } })();
const { audit } = require('../supply-chain/bin/audit.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-os-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const DATA = path.join(__dirname, 'osupdates');
const read = f => fs.readFileSync(path.join(DATA, f), 'utf8');
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const lines = () => { const out = []; return { out, write: s => out.push(s.replace(/\x1b\[[0-9;]*m/g, '')) }; };

const OS_RELEASE = {
  debian12: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\nID=debian\n',
  ubuntu2204: 'PRETTY_NAME="Ubuntu 22.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\nID=ubuntu\nID_LIKE=debian\nUBUNTU_CODENAME=jammy\n',
  mint213: 'NAME="Linux Mint"\nVERSION="21.3 (Virginia)"\nID=linuxmint\nID_LIKE="ubuntu debian"\nPRETTY_NAME="Linux Mint 21.3"\nVERSION_ID="21.3"\nVERSION_CODENAME=virginia\nUBUNTU_CODENAME=jammy\n',
  mint223: 'NAME="Linux Mint"\nVERSION="22.3 (Zena)"\nID=linuxmint\nID_LIKE="ubuntu debian"\nPRETTY_NAME="Linux Mint 22.3"\nVERSION_ID="22.3"\nVERSION_CODENAME=zena\nUBUNTU_CODENAME=noble\n',
  lmde7: 'PRETTY_NAME="LMDE 7 (gigi)"\nNAME="LMDE"\nVERSION_ID="7"\nVERSION="7 (gigi)"\nVERSION_CODENAME=gigi\nID=linuxmint\nID_LIKE=debian\nDEBIAN_CODENAME=trixie\n',
};
// sysroot(name, release, files) — a fake / with that os-release and any other files
function sysroot(name, release, files = {}) {
  const r = path.join(ROOT, name);
  put(path.join(r, 'etc', 'os-release'), OS_RELEASE[release]);
  for (const [f, t] of Object.entries(files)) put(path.join(r, f), t);
  return r;
}

test('which: the distribution, its version and the codename its release list knows, from os-release', () => {
  assert.deepEqual(O.which(sysroot('w-deb', 'debian12')), { distro: 'debian', version: '12', codename: 'bookworm', name: 'Debian 12', pretty: 'Debian GNU/Linux 12 (bookworm)' });
  assert.deepEqual(O.which(sysroot('w-ubu', 'ubuntu2204')), { distro: 'ubuntu', version: '22.04', codename: 'jammy', name: 'Ubuntu 22.04', pretty: 'Ubuntu 22.04.5 LTS' });
  assert.deepEqual(O.which(sysroot('w-mint', 'mint213')), { distro: 'mint', version: '21.3', codename: 'virginia', name: 'Linux Mint 21.3', pretty: 'Linux Mint 21.3' });
  assert.deepEqual(O.which(sysroot('w-lmde', 'lmde7')), { distro: 'lmde', version: '7', codename: 'gigi', name: 'LMDE 7', pretty: 'LMDE 7 (gigi)' });
});

test('restartFile: /run/reboot-required and the packages that asked for it; none is no restart', () => {
  const r = sysroot('rf', 'ubuntu2204', { 'run/reboot-required': '*** System restart required ***\n', 'run/reboot-required.pkgs': 'linux-image-5.15.0-202-generic\nlibc6\nlibc6\n' });
  assert.deepEqual(O.restartFile(r), { needed: true, pkgs: ['linux-image-5.15.0-202-generic', 'libc6'] });
  assert.deepEqual(O.restartFile(sysroot('rf-none', 'debian12')), { needed: false, pkgs: [] });
  assert.deepEqual(O.restartFile(sysroot('rf-nopkgs', 'ubuntu2204', { 'run/reboot-required': '' })), { needed: true, pkgs: [] });
});

// canned(map) — ctx.run answering by command: map[cmd] is {status, stdout} or a function of the args
const canned = map => async (cmd, args = []) => { const a = map[cmd]; const r = typeof a === 'function' ? a(args) : a; return r || { status: 127, stdout: '' }; };
const DPKG = [
  'linux-image-5.15.0-25-generic\tinstall ok installed',
  'linux-image-5.15.0-202-generic\tinstall ok installed',
  'linux-image-generic\tinstall ok installed',
  'linux-image-5.15.0-210-generic\tdeinstall ok config-files',
].join('\n');

test('kernel: the running kernel and the newest installed one (signed or unsigned); a removed one doesn\'t count; none installed is null', async () => {
  const ctx = run => ({ run });
  assert.deepEqual(await O.kernel(ctx(canned({ uname: { status: 0, stdout: '5.15.0-25-generic\n' }, 'dpkg-query': { status: 0, stdout: DPKG } }))), { running: '5.15.0-25-generic', newest: '5.15.0-202-generic' });
  assert.deepEqual(await O.kernel(ctx(canned({ uname: { status: 0, stdout: '6.8.0-50-generic\n' }, 'dpkg-query': { status: 0, stdout: 'linux-image-unsigned-6.8.0-50-generic\tinstall ok installed\n' } }))), { running: '6.8.0-50-generic', newest: '6.8.0-50-generic' });
  assert.deepEqual(await O.kernel(ctx(canned({ uname: { status: 0, stdout: '6.12.48+deb13-arm64\n' }, 'dpkg-query': { status: 0, stdout: 'linux-image-6.12.48+deb13-arm64\tinstall ok installed\nlinux-image-6.12.57+deb13-arm64\tinstall ok installed\n' } }))),
    { running: '6.12.48+deb13-arm64', newest: '6.12.57+deb13-arm64' }, 'Debian\'s names');
  assert.equal(await O.kernel(ctx(canned({ uname: { status: 0, stdout: '6.17.8-orbstack\n' }, 'dpkg-query': { status: 1, stdout: '' } }))), null, 'a container: no kernel package');
});

test('fromCsv: free support ends on Debian LTS\'s date (Ubuntu: standard support); the newer release is the newest already out (Ubuntu: LTS only)', () => {
  const deb = read('debian.csv'), ubu = read('ubuntu.csv');
  assert.deepEqual(O.fromCsv(deb, 'debian', 'bookworm', '2026-11-03'), { endsOn: '2028-06-30', newer: { version: '13', codename: 'trixie', name: 'Debian 13 (trixie)' } });
  assert.deepEqual(O.fromCsv(deb, 'debian', 'trixie', '2026-11-03'), { endsOn: '2030-06-30', newer: null }, 'Debian 14 has no release date yet');
  assert.deepEqual(O.fromCsv(ubu, 'ubuntu', 'jammy', '2026-11-03'), { endsOn: '2027-06-01', newer: { version: '26.04 LTS', codename: 'resolute', name: 'Ubuntu 26.04 LTS (resolute)' } });
  assert.deepEqual(O.fromCsv(ubu, 'ubuntu', 'resolute', '2026-11-03'), { endsOn: '2031-05-29', newer: null }, 'a newer interim release doesn\'t count (D-c: LTS only)');
  assert.equal(O.fromCsv(ubu, 'ubuntu', 'nosuchname', '2026-11-03'), null, 'a release the list doesn\'t know');
  assert.equal(O.fromCsv('<html>not a csv</html>', 'debian', 'bookworm', '2026-11-03'), null);
});

test('fromMintPage: Mint\'s release page, by edition (an Ubuntu base is Mint, a Debian one LMDE); a page that no longer parses is null', () => {
  const page = read('mint-download_all.html');
  assert.deepEqual(O.fromMintPage(page, 'mint', '21.3', '2026-11-03'), { endsOn: '2027-04-30', newer: { version: '22.3', name: 'Linux Mint 22.3' } });
  assert.deepEqual(O.fromMintPage(page, 'mint', '22.3', '2026-11-03'), { endsOn: '2029-04-30', newer: null });
  assert.deepEqual(O.fromMintPage(page, 'lmde', '7', '2026-11-03'), { endsOn: null, newer: null }, 'LMDE 7: no end date published');
  assert.equal(O.fromMintPage('<html><body>We moved things around</body></html>', 'mint', '21.3', '2026-11-03'), null);
  assert.equal(O.fromMintPage(page, 'mint', '20.3', '2026-11-03'), null, 'a release the page no longer lists');
});

test('endState: ok, soon within 90 days, past after the day; unknown without a date', () => {
  assert.equal(O.endState('2027-06-01', '2026-11-03'), 'ok');
  assert.equal(O.endState('2027-01-31', '2026-11-03'), 'soon');
  assert.equal(O.endState('2026-11-03', '2026-11-03'), 'soon', 'the last day is still supported');
  assert.equal(O.endState('2026-11-02', '2026-11-03'), 'past');
  assert.equal(O.endState(null, '2026-11-03'), 'unknown');
});

// the audit's check, end to end through audit.js, with canned commands and saved sources
const SOURCES = { 'debian.csv': read('debian.csv'), 'ubuntu.csv': read('ubuntu.csv'), 'download_all.php': read('mint-download_all.html') };
function curl(fail = [], calls = []) {
  return args => {
    const url = args[args.length - 1];
    calls.push(url);
    const k = Object.keys(SOURCES).find(s => url.endsWith(s));
    return k && !fail.includes(k) ? { status: 0, stdout: SOURCES[k] } : { status: 22, stdout: '' };
  };
}
const ctx = (extra = {}) => ({
  now: new Date(`${extra.today || '2026-11-03'}T12:00:00Z`), today: '2026-11-03', home: path.join(ROOT, 'home'), instance: ROOT, engine: path.join(__dirname, '..'),
  cfg: { policy: { min_release_age_days: 3 }, paths: { mise_data_dir: path.join(ROOT, 'mise') } }, appDirs: [], platform: 'linux', family: 'debian', policy: {}, ...extra,
});
const run = (o = {}) => canned({
  uname: { status: 0, stdout: `${o.running || '5.15.0-25-generic'}\n` },
  'dpkg-query': o.dpkg === undefined ? { status: 0, stdout: DPKG } : o.dpkg,
  curl: curl(o.fail, o.calls),
});

test('os-updates on Ubuntu: a restart is an action (the file and the kernel), the newer LTS a note, support\'s end a plain line', async () => {
  const sys = sysroot('a-ubu', 'ubuntu2204', { 'run/reboot-required': '', 'run/reboot-required.pkgs': 'linux-image-5.15.0-202-generic\n' });
  const w = lines();
  const r = await audit(ctx({ sysroot: sys, run: run(), cache: path.join(ROOT, 'cache-a') }), { only: ['os-updates'], write: w.write });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.actions, ['os: restart needed: /run/reboot-required (linux-image-5.15.0-202-generic); the running kernel 5.15.0-25-generic is older than the installed 5.15.0-202-generic']);
  const text = w.out.join('\n');
  assert.ok(text.includes('point updates arrive as apt packages (apt packages, above), new kernels included'), text);
  assert.ok(text.includes('newer release: Ubuntu 26.04 LTS (resolute) is out; a release upgrade is a major: by hand'), text);
  assert.ok(text.includes('free security support until 2027-06-01'), text);
  assert.ok(text.includes('OS updates (Ubuntu 22.04.5 LTS)'), 'the section names the release');
  assert.equal(O.FIX.restart, 'by hand: restart the machine');
});

test('os-updates on Debian: no file, so the kernel alone says a restart is needed; the same kernel is no restart', async () => {
  const sys = sysroot('a-deb', 'debian12');
  const dpkg = { status: 0, stdout: 'linux-image-6.1.0-40-arm64\tinstall ok installed\nlinux-image-6.1.0-41-arm64\tinstall ok installed\n' };
  let r = await audit(ctx({ sysroot: sys, run: run({ running: '6.1.0-40-arm64', dpkg }), cache: path.join(ROOT, 'cache-b') }), { only: ['os-updates'], write: () => {} });
  assert.deepEqual(r.actions, ['os: restart needed: the running kernel 6.1.0-40-arm64 is older than the installed 6.1.0-41-arm64']);
  const w = lines();
  r = await audit(ctx({ sysroot: sys, run: run({ running: '6.1.0-41-arm64', dpkg }), cache: path.join(ROOT, 'cache-b') }), { only: ['os-updates'], write: w.write });
  assert.deepEqual(r.actions, []);
  const text = w.out.join('\n');
  assert.ok(text.includes('no restart needed'), text);
  assert.ok(text.includes('newer release: Debian 13 (trixie) is out; a release upgrade is a major: by hand'), text);
  assert.ok(text.includes('free security support until 2028-06-30'), text);
});

test('os-updates: support ending within 90 days is a note; once past, an action to move by hand', async () => {
  const sys = sysroot('a-end', 'ubuntu2204');
  const same = { running: '5.15.0-202-generic' };
  let w = lines();
  let r = await audit(ctx({ today: '2027-04-01', sysroot: sys, run: run(same), cache: path.join(ROOT, 'cache-c') }), { only: ['os-updates'], write: w.write });
  assert.deepEqual(r.actions, []);
  assert.ok(w.out.join('\n').includes('free security support ends in 61 days (2027-06-01): plan the move'), w.out.join('\n'));
  w = lines();
  r = await audit(ctx({ today: '2027-06-02', sysroot: sys, run: run(same), cache: path.join(ROOT, 'cache-d') }), { only: ['os-updates'], write: w.write });
  assert.deepEqual(r.actions, ["os: Ubuntu 22.04's free security support ended 2027-06-01"]);
  assert.equal(O.FIX.eol, 'by hand: move to a supported release (a major is deliberate)');
});

test('os-updates: a source that can\'t be fetched, or a Mint page that no longer parses, is "not checked", never "up to date"', async () => {
  let w = lines();
  let r = await audit(ctx({ sysroot: sysroot('a-off', 'ubuntu2204'), run: run({ running: '5.15.0-202-generic', fail: ['ubuntu.csv'] }), cache: path.join(ROOT, 'cache-e') }), { only: ['os-updates'], write: w.write });
  let text = w.out.join('\n');
  assert.ok(text.includes('newer release and support end: not checked (ubuntu.csv could not be fetched)'), text);
  assert.ok(!/free security support|newer release: /.test(text.replace('newer release and support end', '')), 'nothing claimed without its source');
  assert.deepEqual(r.actions, []);
  SOURCES['download_all.php'] = '<html><body>We moved things around</body></html>';
  w = lines();
  r = await audit(ctx({ sysroot: sysroot('a-mint', 'mint213'), run: run({ running: '5.15.0-202-generic' }), cache: path.join(ROOT, 'cache-f') }), { only: ['os-updates'], write: w.write });
  SOURCES['download_all.php'] = read('mint-download_all.html');
  text = w.out.join('\n');
  assert.ok(text.includes("newer release and support end: not checked (Mint's release page no longer reads as it did)"), text);
});

test('os-updates on Mint and LMDE: Mint\'s page; LMDE publishes no end date, and says so', async () => {
  let w = lines();
  await audit(ctx({ sysroot: sysroot('a-mint2', 'mint213'), run: run({ running: '5.15.0-202-generic' }), cache: path.join(ROOT, 'cache-g') }), { only: ['os-updates'], write: w.write });
  let text = w.out.join('\n');
  assert.ok(text.includes('newer release: Linux Mint 22.3 is out; a release upgrade is a major: by hand'), text);
  assert.ok(text.includes('free security support until 2027-04-30'), text);
  w = lines();
  await audit(ctx({ sysroot: sysroot('a-lmde', 'lmde7'), run: run({ running: '5.15.0-202-generic' }), cache: path.join(ROOT, 'cache-h') }), { only: ['os-updates'], write: w.write });
  text = w.out.join('\n');
  assert.ok(text.includes('free security support: no end date published (Mint\'s release page)'), text);
  assert.ok(!text.includes('newer release:'), 'LMDE 7 is the newest');
});

test('os-updates in a container: no kernel package, so the restart is checked by the file alone, and says so', async () => {
  const w = lines();
  const r = await audit(ctx({ sysroot: sysroot('a-ctr', 'debian12'), run: run({ running: '6.17.8-orbstack', dpkg: { status: 1, stdout: '' } }), cache: path.join(ROOT, 'cache-i') }), { only: ['os-updates'], write: w.write });
  assert.deepEqual(r.actions, []);
  const text = w.out.join('\n');
  assert.ok(text.includes('restart: no kernel package installed here (a container?): checked by /run/reboot-required only'), text);
  assert.ok(!text.includes('no restart needed'), 'it doesn\'t claim more than it checked');
});

test('os-updates: each source is fetched once a day (cached), and the check runs on the Debian family only', async () => {
  const calls = [], cache = path.join(ROOT, 'cache-j'), sys = sysroot('a-cache', 'ubuntu2204');
  for (let i = 0; i < 2; i++) await audit(ctx({ sysroot: sys, run: run({ calls }), cache }), { only: ['os-updates'], write: () => {} });
  assert.deepEqual(calls, [O.SOURCES.ubuntu], 'one fetch, then the day\'s cache');
  const r = await audit(ctx({ family: 'rhel', sysroot: sys, run: run(), cache }), { only: ['os-updates'], write: () => {} });
  assert.deepEqual(r.skipped, ['os-updates'], 'dnf and zypper bring their own');
});

test('the end-to-end run checks the section too: root writes /run/reboot-required, the user\'s audit must show the restart', () => {
  const sh = fs.readFileSync(path.join(__dirname, 'containers', 'e2e', 'apt.sh'), 'utf8');
  assert.match(sh, /\/run\/reboot-required/);
  const drive = fs.readFileSync(path.join(__dirname, 'containers', 'e2e', 'drive.js'), 'utf8');
  assert.match(drive, /os: restart needed/);
  assert.match(drive, /OS\.SOURCES|osupdates/, 'its newer-release and end-date lines are checked against the live sources');
});
