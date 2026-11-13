// Local container tests for each Linux distribution (parity 0.9, tools/linux-test.js): `just linux-test` builds one
// image per row of test/containers/matrix.json and runs `just test` in a throwaway container with no network; `just
// linux-clean` removes what those runs made. Everything they create carries one label, and only labelled things are
// ever removed. No Docker here: the docker commands are canned.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../tools/linux-test.js');
const { FAMILIES } = require('../lib/platform.js');

const REPO = path.join(__dirname, '..');
const MATRIX = path.join(REPO, 'test', 'containers', 'matrix.json');

test('matrix.json: the oldest and newest of each distribution the Linux release needs (parity 1c, D-c), each pinned by tag and digest', () => {
  const m = L.loadMatrix(MATRIX);
  assert.deepEqual(L.validate(m), []);
  assert.deepEqual(m.rows.map(r => r.id), ['debian-12', 'debian-13', 'ubuntu-22.04', 'ubuntu-26.04', 'mint-21.3', 'mint-22.3', 'lmde-7', 'fedora-44', 'fedora-45', 'leap-16.0', 'tumbleweed']);
  for (const r of m.rows) {
    assert.ok(FAMILIES.includes(r.family), `${r.id}: family`);
    assert.match(r.image, /^[a-z0-9./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/, `${r.id}: image names a digest`);
    assert.ok(fs.existsSync(path.join(REPO, 'test', 'containers', `${r.family}.Dockerfile`)), `${r.id}: its Dockerfile`);
    assert.ok(r.id === r.distro || r.id.startsWith(`${r.distro}-`), `${r.id}: named <distro>-<version>`);
  }
  // the support caps (owner, 2026-11-03): the distribution's own free security support, Debian LTS included
  const until = Object.fromEntries(m.rows.map(r => [r.id, r.supported_until && r.supported_until.date]));
  assert.equal(until['debian-12'], '2028-06-30');
  assert.equal(until['ubuntu-22.04'], '2027-06-01');
  assert.equal(until['mint-21.3'], '2027-04-30');
  assert.equal(until['mint-22.3'], '2029-04-30');
  // Mint publishes amd64 images only; Mint 22.3's image ships Ubuntu's base-files, so its row puts Mint's back
  for (const id of ['mint-21.3', 'mint-22.3', 'lmde-7']) assert.deepEqual(m.rows.find(r => r.id === id).arch, ['amd64'], `${id}: amd64 only`);
  assert.deepEqual(m.rows.find(r => r.id === 'mint-22.3').extra, ['base-files=13ubuntu10mint22.3.0']);
  assert.match(m.mise.sha256.arm64, /^[0-9a-f]{64}$/);
  assert.match(m.mise.sha256.x64, /^[0-9a-f]{64}$/);
});

const GOOD = { id: 'debian-13', distro: 'debian', family: 'debian', role: 'newest', image: `debian:13@sha256:${'a'.repeat(64)}`, supported_until: { date: '2030-06-30', source: 's' } };
const PIN = { version: '1', sha256: { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) } };

test('validate: names what is wrong with a row or the mise pin', () => {
  const bad = { rows: [{ id: 'x', family: 'debain', image: 'debian:13' }], mise: { version: '', sha256: { arm64: 'zz' } } };
  assert.deepEqual(L.validate(bad), [
    'x: family must be one of debian, rhel, suse, arch, alpine, void, gentoo, slackware, nixos (not debain)',
    'x: image must name a digest (image:tag@sha256:<64 hex>)',
    'x: distro is missing, and the id must be <distro> or <distro>-<version>',
    'x: role must be one of oldest, newest, rolling',
    'x: supported_until needs a date (YYYY-MM-DD, or null with why) and its source',
    'mise: version is missing',
    'mise: sha256.arm64 must be 64 hex characters',
    'mise: sha256.x64 must be 64 hex characters',
  ]);
  const exc = { rows: [{ id: 'tw', distro: 'tw', family: 'suse', role: 'rolling', image: `opensuse/tumbleweed:latest@sha256:${'a'.repeat(64)}`, gate_exception: { why: 'w', decided: 'owner' } }], mise: PIN };
  assert.deepEqual(L.validate(exc), ['tw: gate_exception needs why, decided and expires (YYYY-MM-DD)'], 'an exception to the release-age gate says why, who and until when; a rolling row has no end date');
  assert.deepEqual(L.validate({ rows: [GOOD], mise: PIN }), []);
  assert.deepEqual(L.validate({ rows: [{ ...GOOD, supported_until: { date: null, why: 'not published', source: 's' } }], mise: PIN }), [], 'no published end date: null, with why');
  assert.deepEqual(L.validate({ rows: [{ ...GOOD, arch: ['amd64', 'sparc'] }], mise: PIN }), ['debian-13: arch must list amd64 and/or arm64']);
  assert.deepEqual(L.validate({ rows: [{ ...GOOD, extra: ['base-files'] }], mise: PIN }), ['debian-13: extra must list package=version pins']);
  assert.deepEqual(L.validate({ rows: [GOOD, { ...GOOD }], mise: PIN }), ['debian-13: the id is used twice']);
});

test('select: a row by id, a distribution\'s rows by its name, or all; anything else is named', () => {
  const rows = [{ id: 'debian-12', distro: 'debian' }, { id: 'debian-13', distro: 'debian' }, { id: 'ubuntu-26.04', distro: 'ubuntu' }];
  assert.deepEqual(L.select(rows, []).rows.map(r => r.id), ['debian-12', 'debian-13', 'ubuntu-26.04']);
  assert.deepEqual(L.select(rows, ['all']).rows.length, 3);
  assert.deepEqual(L.select(rows, ['debian']).rows.map(r => r.id), ['debian-12', 'debian-13'], 'just linux-test debian runs both');
  assert.deepEqual(L.select(rows, ['debian-12', 'ubuntu']).rows.map(r => r.id), ['debian-12', 'ubuntu-26.04']);
  assert.deepEqual(L.select(rows, ['debain']).unknown, ['debain']);
});

test('rowX64: a row whose images are amd64 only runs as amd64 on an arm64 Mac too', () => {
  assert.equal(L.rowX64({ arch: ['amd64'] }, false), true);
  assert.equal(L.rowX64({}, false), false);
  assert.equal(L.rowX64({}, true), true);
  assert.equal(L.rowX64({ arch: ['amd64', 'arm64'] }, false), false);
});

test('notes: a row past its support end, and a gate exception past its expiry, are said loudly; nothing fails', () => {
  const rows = [{ ...GOOD, id: 'ubuntu-22.04', supported_until: { date: '2027-06-01', source: 's' } }, GOOD,
    { id: 'tw', role: 'rolling', gate_exception: { why: 'w', decided: 'owner, 2026-11-02', expires: '2026-11-05' } }];
  assert.deepEqual(L.notes(rows, '2026-11-03'), ['note: tw runs under a release-age gate exception (owner, 2026-11-02; expires 2026-11-05)']);
  assert.deepEqual(L.notes(rows, '2027-06-02'), [
    'PAST SUPPORT: ubuntu-22.04 was supported until 2027-06-01 (s): drop the row',
    'note: tw runs under a release-age gate exception (owner, 2026-11-02; expires 2026-11-05): EXPIRED, move it to an image past the gate',
  ]);
});

test('ci: every row\'s id for the CI matrix, and each note as a GitHub warning (parity T.1)', () => {
  const m = { rows: [GOOD, { ...GOOD, id: 'ubuntu-22.04', distro: 'ubuntu', supported_until: { date: '2027-06-01', source: 's' } }], mise: PIN };
  assert.deepEqual(L.ci(m, '2026-11-03'), { rows: ['debian-13', 'ubuntu-22.04'], warnings: [] });
  assert.deepEqual(L.ci(m, '2027-06-02').warnings, ['::warning title=linux-test::PAST SUPPORT: ubuntu-22.04 was supported until 2027-06-01 (s): drop the row']);
  assert.deepEqual(L.ci(L.loadMatrix(MATRIX), '2026-11-03').rows, L.loadMatrix(MATRIX).rows.map(r => r.id), 'all rows (owner, 2026-11-03)');
});

test('the mise in the images is the mise the CI workflows pin', () => {
  const m = L.loadMatrix(MATRIX);
  for (const f of ['test.yml', 'lint.yml', 'install-check.yml']) {
    const text = fs.readFileSync(path.join(REPO, '.github', 'workflows', f), 'utf8');
    const pins = [...text.matchAll(/^\s+version: (\d{4}\.\d+\.\d+)\s*$/gm)].map(x => x[1]);
    assert.ok(pins.length, `${f}: a mise pin`);
    for (const v of pins) assert.equal(v, m.mise.version, `${f} pins mise ${v}`);
  }
});

const ROW = { id: 'debian', family: 'debian', image: `debian:13@sha256:${'a'.repeat(64)}`, role: 'newest' };
const MISE = { version: '2026.10.21', sha256: { arm64: 'b'.repeat(64), x64: 'c'.repeat(64) } };

test('imageTag: steward-test/<id>:<hash of the Dockerfile, the base and mise>, so a change makes a new tag', () => {
  const t = L.imageTag(ROW, 'FROM x\n', MISE);
  assert.match(t, /^steward-test\/debian:[0-9a-f]{12}$/);
  assert.equal(L.imageTag(ROW, 'FROM x\n', MISE), t, 'stable');
  assert.notEqual(L.imageTag(ROW, 'FROM y\n', MISE), t, 'the Dockerfile changes it');
  assert.notEqual(L.imageTag({ ...ROW, image: `debian:13@sha256:${'d'.repeat(64)}` }, 'FROM x\n', MISE), t, 'the base changes it');
  assert.notEqual(L.imageTag(ROW, 'FROM x\n', { ...MISE, version: '2026.10.22' }), t, 'mise changes it');
});

test('buildArgs: the label, the base, mise with its checksum for this CPU, the family\'s Dockerfile', () => {
  const a = L.buildArgs(ROW, { tag: 'steward-test/debian:abc', mise: MISE, context: '/ctx' });
  assert.deepEqual(a, ['build', '--label', `${L.LABEL}=1`, '--build-arg', `BASE=${ROW.image}`, '--build-arg', 'MISE_VERSION=2026.10.21',
    '--build-arg', 'MISE_ARCH=arm64', '--build-arg', `MISE_SHA256=${'b'.repeat(64)}`, '-f', '/ctx/test/containers/debian.Dockerfile', '-t', 'steward-test/debian:abc', '/ctx/test/containers']);
  const x = L.buildArgs(ROW, { tag: 't', mise: MISE, context: '/ctx', x64: true });
  assert.ok(x.includes('--platform') && x[x.indexOf('--platform') + 1] === 'linux/amd64');
  assert.ok(x.includes('MISE_ARCH=x64') && x.includes(`MISE_SHA256=${'c'.repeat(64)}`));
});

test('buildArgs: a row\'s extra pins go to the build (Mint 22.3 takes back Mint\'s own base-files)', () => {
  const a = L.buildArgs({ ...ROW, extra: ['base-files=13ubuntu10mint22.3.0'] }, { tag: 't', mise: MISE, context: '/ctx' });
  assert.ok(a.includes('EXTRA=base-files=13ubuntu10mint22.3.0'), a.join(' '));
  assert.ok(!L.buildArgs(ROW, { tag: 't', mise: MISE, context: '/ctx' }).some(x => x.startsWith('EXTRA=')), 'none without');
  const df = fs.readFileSync(path.join(REPO, 'test', 'containers', 'debian.Dockerfile'), 'utf8');
  assert.match(df, /^ARG EXTRA/m);
  assert.match(df, /--allow-downgrades/, 'a pin older than what the image has (Ubuntu\'s base-files) is put back on purpose');
});

test('e2e: apt\'s, dnf\'s and zypper\'s families run it; the others say it comes with their provider (parity 1c, dnf 1c, zypper 1c)', () => {
  assert.equal(L.e2eRefusal({ id: 'debian-13', family: 'debian' }), null);
  assert.equal(L.e2eRefusal({ id: 'fedora-44', family: 'rhel' }), null);
  assert.equal(L.e2eRefusal({ id: 'leap-16.0', family: 'suse' }), null);
  assert.match(L.e2eRefusal({ id: 'arch', family: 'arch' }), /arch: --e2e comes with the arch family's provider/);
  assert.ok(L.e2eArgs({ tag: 't', name: 'n', checkout: '/c', family: 'rhel' }).includes('/src/test/containers/e2e/dnf.sh'));
  assert.ok(L.e2eArgs({ tag: 't', name: 'n', checkout: '/c', family: 'suse' }).includes('/src/test/containers/e2e/zypper.sh'));
});

test('e2eArgs: network on, writable, started as root (for sudo and the seed), the checkout read-only, labelled, removed after', () => {
  const a = L.e2eArgs({ tag: 'steward-test/debian-13:abc', name: 'steward-e2e-debian-13-1', checkout: '/src/ws', x64: true });
  const has = (...xs) => { const i = a.indexOf(xs[0]); return i >= 0 && xs.every((x, k) => a[i + k] === x); };
  assert.equal(a[0], 'run');
  assert.ok(has('--rm') && has('--label', `${L.LABEL}=1`) && has('--name', 'steward-e2e-debian-13-1'));
  assert.ok(!a.includes('none') && !a.includes('--read-only'), 'the real repos need the network');
  assert.ok(has('--user', 'root'));
  assert.ok(has('-v', '/src/ws:/src:ro'));
  assert.ok(has('--platform', 'linux/amd64'));
  assert.ok(a.includes('/src/test/containers/e2e/apt.sh'), 'the e2e script, from the read-only checkout');
  for (const f of ['apt.sh', 'dnf.sh', 'zypper.sh', 'drive.js']) assert.ok(fs.existsSync(path.join(REPO, 'test', 'containers', 'e2e', f)), f);
});

test('drive: patchIssued finds the issued time zypper shows for a patch, in epoch seconds or a date; none is null (zypper 1c)', () => {
  const D = require('./containers/e2e/drive.js');
  // as zypper 1.14 on Leap 16.0 writes it (2026-11-13): <license/> and <source/> come before the date
  const xml = '<update-list><update kind="patch" name="openSUSE-Leap-16.0-2045" edition="1" arch="noarch" status="needed" category="security" severity="important">' +
    '<summary>Security update for pcre2</summary><description>…</description><license/><source url="http://download.opensuse.org/update/leap/16.0/oss" alias="openSUSE:repo-oss"/>' +
    '<issue-date time_t="1793812179" text="2026-11-04T17:09:39Z"/></update>' +
    '<update name="openSUSE-Leap-16.0-9" kind="patch"><license/><issue-date text="2026-11-05 10:00:00"/></update><update name="x" kind="patch"/></update-list>';
  assert.equal(D.patchIssued(xml, 'openSUSE-Leap-16.0-2045'), '2026-11-04T17:09:39.000Z');
  assert.equal(D.patchIssued(xml, 'openSUSE-Leap-16.0-9'), '2026-11-05T10:00:00.000Z');
  assert.equal(D.patchIssued(xml, 'x'), null);
  assert.equal(D.patchIssued(xml, 'missing'), null);
  assert.equal(D.planLines('take   libpcre2-8-0 10.45-160000.4.1 -> 10.45-160000.5.1 (security patch: openSUSE-Leap-16.0-2026-12)')[0].pocket, 'openSUSE-Leap-16.0-2026-12');
});

test('drive: planLines reads apt\'s security pocket and dnf\'s security advisory alike (dnf 1c)', () => {
  const D = require('./containers/e2e/drive.js');
  assert.deepEqual(D.planLines('  take   openssl-libs 1:3.5.4-2.fc44 -> 1:3.5.9-1.fc44 (security advisory: FEDORA-2026-12f3f3d569)\n')[0],
    { act: 'take', name: 'openssl-libs', have: '1:3.5.4-2.fc44', want: '1:3.5.9-1.fc44', days: null, from: null, pocket: 'FEDORA-2026-12f3f3d569' });
  assert.equal(D.planLines('take   libc6 2.41-12+deb13u1 -> 2.41-12+deb13u2 (security pocket: trixie-security)')[0].pocket, 'trixie-security');
  assert.deepEqual(D.planLines('hold   tzdata 2026c-1.fc44 -> 2026f-1.fc44 (1d old, Bodhi)')[0].from, 'Bodhi');
});

test('drive: answers a prompt only once its text has been seen (readline swallows answers sent early, 1b)', () => {
  const D = require('./containers/e2e/drive.js');
  const r = D.responder([{ expect: 'Apply these upgrades? [y/N]', send: 'y' }, { expect: 'Do you want to continue? [Y/n]', send: 'y' }]);
  assert.deepEqual(r('plan…\n'), []);
  assert.deepEqual(r('Apply these upg'), [], 'half a prompt is not a prompt');
  assert.deepEqual(r('rades? [y/N] '), ['y\n']);
  assert.deepEqual(r('Do you want to continue? [Y/n] '), ['y\n']);
  assert.deepEqual(r('more output'), []);
  assert.equal(r.pending(), 0, 'every answer was given');
  const early = D.responder([{ expect: 'B?', send: 'b' }]);
  assert.deepEqual(early('A? '), []);
  assert.equal(early.pending(), 1, 'a prompt that never came is named');
});

test('runArgs: removed after the run, no network, read-only, non-root, the checkout read-only, work on tmpfs, labelled and named', () => {
  const a = L.runArgs({ tag: 'steward-test/debian:abc', name: 'steward-test-debian-20261101T120000', checkout: '/src/ws' });
  const has = (...xs) => { const i = a.indexOf(xs[0]); return i >= 0 && xs.every((x, k) => a[i + k] === x); };
  assert.equal(a[0], 'run');
  assert.ok(has('--rm'));
  assert.ok(has('--name', 'steward-test-debian-20261101T120000'));
  assert.ok(has('--label', `${L.LABEL}=1`));
  assert.ok(has('--network', 'none'));
  assert.ok(has('--read-only'));
  assert.ok(has('--user', 'steward'));
  assert.ok(has('-v', '/src/ws:/src:ro'));
  assert.ok(a.includes('/work:exec,mode=1777') && a.includes('/tmp:exec,mode=1777'), 'work and temp on tmpfs');
  assert.ok(has('-e', 'STEWARD_TEST_FIXTURES=1'));
  assert.equal(a.filter(x => x === '-v').length, 1, 'one mount only: the checkout');
  assert.ok(a.includes('steward-test/debian:abc'));
});

test('emulated: a row run as amd64 on an arm64 host is emulated, and its tests are told so (looser timing limits; owner, 2026-11-03)', () => {
  assert.equal(L.emulated({ arch: ['amd64'] }, false, 'arm64'), true, 'Mint on an Apple-silicon Mac');
  assert.equal(L.emulated({}, true, 'arm64'), true, '--x64 on an Apple-silicon Mac');
  assert.equal(L.emulated({ arch: ['amd64'] }, true, 'x64'), false, 'Mint on CI: native');
  assert.equal(L.emulated({}, false, 'arm64'), false, 'Debian on a Mac: native');
  const on = L.runArgs({ tag: 't', name: 'n', checkout: '/c', x64: true, emulated: true });
  assert.ok(on.join(' ').includes('-e STEWARD_TEST_EMULATED=1'), on.join(' '));
  assert.ok(!L.runArgs({ tag: 't', name: 'n', checkout: '/c' }).includes('STEWARD_TEST_EMULATED=1'), 'only when emulated');
});

// docker's `--format '{{json .}}'` lines: Labels is "k=v,k2=v2"
const j = o => JSON.stringify(o);
const MIXED = {
  containers: [j({ ID: 'c1', Names: 'steward-test-debian-1', Labels: `${L.LABEL}=1`, State: 'exited' }), j({ ID: 'c2', Names: 'my-postgres', Labels: 'app=db', State: 'running' }),
    j({ ID: 'c3', Names: 'steward-test-fedora-2', Labels: `x=y,${L.LABEL}=1`, State: 'running' })].join('\n'),
  images: [j({ ID: 'i1', Repository: 'steward-test/debian', Tag: 'abc', Size: '412MB', Labels: `${L.LABEL}=1` }), j({ ID: 'i2', Repository: 'postgres', Tag: '17', Size: '300MB', Labels: '' }),
    j({ ID: 'i3', Repository: '<none>', Tag: '<none>', Size: '410MB', Labels: `${L.LABEL}=1` })].join('\n'),
  volumes: [j({ Name: 'pgdata', Labels: '' }), j({ Name: 'leftover', Labels: `${L.LABEL}=1` })].join('\n'),
  networks: [j({ ID: 'n1', Name: 'bridge', Labels: '' }), j({ ID: 'n2', Name: 'proj_default', Labels: 'com.docker.compose.project=proj' })].join('\n'),
};

test('cleanPlan: only labelled containers, images, volumes and networks; someone else\'s are never listed', () => {
  const p = L.cleanPlan(MIXED);
  assert.deepEqual(p.containers.map(c => c.ID), ['c1', 'c3']);
  assert.deepEqual(p.images.map(i => i.ID), ['i1', 'i3']);
  assert.deepEqual(p.volumes.map(v => v.Name), ['leftover']);
  assert.deepEqual(p.networks, []);
  assert.deepEqual(L.cleanCommands(p), [
    ['rm', '-f', 'c1', 'c3'],
    ['image', 'rm', '-f', 'i1', 'i3'],
    ['volume', 'rm', 'leftover'],
  ]);
  assert.deepEqual(L.cleanCommands(L.cleanPlan({ containers: '', images: '', volumes: '', networks: '' })), [], 'nothing to do');
});

test('staleTags: after a build, the older tags of that row only', () => {
  const imgs = [j({ ID: 'a', Repository: 'steward-test/debian', Tag: 'new', Labels: `${L.LABEL}=1` }), j({ ID: 'b', Repository: 'steward-test/debian', Tag: 'old', Labels: `${L.LABEL}=1` }),
    j({ ID: 'c', Repository: 'steward-test/fedora', Tag: 'old', Labels: `${L.LABEL}=1` }), j({ ID: 'd', Repository: 'steward-test/debian', Tag: 'mine', Labels: '' })].join('\n');
  assert.deepEqual(L.staleTags(imgs, 'debian', 'new'), ['steward-test/debian:old']);
});

test('onInterrupt: a run stopped by Ctrl-C or kill removes its container', async () => {
  const calls = [];
  const stop = L.onInterrupt('steward-test-debian-1', async args => { calls.push(args); return { status: 0 }; });
  await stop();
  assert.deepEqual(calls, [['rm', '-f', 'steward-test-debian-1']]);
});

test('counts and summary: per row, and the exit code is 0 only when every row passed', () => {
  assert.deepEqual(L.counts('ℹ tests 392\nℹ suites 0\nℹ pass 371\nℹ fail 21\n'), { total: 392, pass: 371, fail: 21 });
  assert.deepEqual(L.counts('no summary here'), null);
  const ok = L.summary([{ id: 'debian', status: 'pass', total: 392, pass: 392, fail: 0, secs: 130, log: '/l/debian.txt' }]);
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.lines, ['debian      ✓ 392/392 pass · 2m 10s · /l/debian.txt']);
  const mixed = L.summary([
    { id: 'debian', status: 'fail', total: 392, pass: 371, fail: 21, secs: 130, log: '/l/debian.txt' },
    { id: 'fedora', status: 'build-failed', secs: 40, log: '/l/fedora.txt' },
    { id: 'leap', status: 'pass', total: 392, pass: 392, fail: 0, secs: 5, log: '/l/leap.txt' },
  ]);
  assert.equal(mixed.code, 1);
  assert.deepEqual(mixed.lines, [
    'debian      ✗ 371/392 pass · 21 fail · 2m 10s · /l/debian.txt',
    'fedora      ✗ the image did not build · 40s · /l/fedora.txt',
    'leap        ✓ 392/392 pass · 5s · /l/leap.txt',
  ]);
});

test('images: docker images\' JSON carries no labels, so ours are listed by a label filter and marked (the first real run listed none)', () => {
  assert.deepEqual(L.IMAGES, ['images', '--filter', `label=${L.LABEL}=1`, '--format', '{{json .}}']);
  // what `docker images --format '{{json .}}'` really prints: no Labels field
  const raw = j({ ID: '30216ad76d89', Repository: 'steward-test/debian', Tag: '74af6771a2ed', Size: '1.17GB' });
  assert.deepEqual(L.cleanPlan({ images: raw }).images, [], 'unmarked, nothing matches: the bug');
  const marked = L.markOurs(raw);
  assert.deepEqual(L.cleanPlan({ images: marked, containers: '', volumes: '', networks: '' }).images.map(i => i.ID), ['30216ad76d89']);
  assert.deepEqual(L.staleTags(L.markOurs([raw, j({ ID: 'x', Repository: 'steward-test/debian', Tag: 'old' })].join('\n')), 'debian', '74af6771a2ed'), ['steward-test/debian:old']);
});

// A rolling row's pin and its age (the owner, 2026-11-04): Tumbleweed's only multi-arch tag is rebuilt about daily, so
// Renovate's 3-day gate may never let it move. The image's own build date is a fixed timestamp, so the age comes from
// git: when its digest entered matrix.json. Past 30 days, a warning, never a failure.
const TW = { id: 'tumbleweed', role: 'rolling', image: `opensuse/tumbleweed:latest@sha256:${'b'.repeat(64)}` };

test('notes: a rolling row pinned more than 30 days ago is a stale pin; 30 days is not', () => {
  assert.deepEqual(L.notes([TW], '2026-12-02', { tumbleweed: '2026-11-02' }), []);
  assert.deepEqual(L.notes([TW], '2026-12-03', { tumbleweed: '2026-11-02' }), [
    "STALE PIN: tumbleweed pinned since 2026-11-02 (31 days): Renovate hasn't moved it; repin by hand",
  ]);
});

test('notes: a rolling row whose pin date git can\'t see says so; a fixed release is never checked', () => {
  assert.deepEqual(L.notes([TW], '2026-11-05', { tumbleweed: null }), [
    "PIN AGE UNKNOWN: tumbleweed: git can't see when its digest was pinned (a shallow checkout?)",
  ]);
  assert.deepEqual(L.notes([TW], '2026-11-05'), [], 'no pin dates given: nothing said (the pure callers)');
  assert.deepEqual(L.notes([{ ...GOOD }], '2027-01-01', { 'debian-13': '2026-01-01' }), [], 'only rolling rows');
});

test('ci: a stale or unknown pin is a GitHub warning', () => {
  const m = { rows: [GOOD, TW], mise: PIN };
  assert.deepEqual(L.ci(m, '2026-12-03', { tumbleweed: '2026-11-02' }).warnings, [
    "::warning title=linux-test::STALE PIN: tumbleweed pinned since 2026-11-02 (31 days): Renovate hasn't moved it; repin by hand",
  ]);
  assert.deepEqual(L.ci(m, '2026-11-05', { tumbleweed: null }).warnings, [
    "::warning title=linux-test::PIN AGE UNKNOWN: tumbleweed: git can't see when its digest was pinned (a shallow checkout?)",
  ]);
});

test('pinnedSince: the day the row\'s digest was committed to matrix.json, or null outside git', () => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pin-'));
  const f = path.join(dir, 'test', 'containers', 'matrix.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  assert.equal(L.pinnedSince(TW, f), null, 'not a git repo');
  const git = (args, date) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  git(['init', '-q']);
  fs.writeFileSync(f, JSON.stringify({ rows: [TW] }, null, 1));
  git(['add', '-A']); git(['commit', '-qm', 'pin'], '2026-11-02T12:00:00Z');
  fs.writeFileSync(f, JSON.stringify({ rows: [{ ...TW, extra: ['x'] }] }, null, 1));
  git(['commit', '-qam', 'another change, same digest'], '2026-11-20T12:00:00Z');
  assert.equal(L.pinnedSince(TW, f), '2026-11-02');
  assert.equal(L.pinnedSince({ ...TW, image: `opensuse/tumbleweed:latest@sha256:${'c'.repeat(64)}` }, f), null, 'a digest git never saw');
  const shallow = path.join(dir, 'shallow');
  spawnSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow]);
  assert.equal(L.pinnedSince(TW, path.join(shallow, 'test', 'containers', 'matrix.json')), null,
    'a shallow clone sees only its tip, which would look like a fresh pin');
});

test('matrix.json: no gate exception is left once its image passes the gate (Tumbleweed, 2026-11-04)', () => {
  assert.deepEqual(L.loadMatrix(MATRIX).rows.filter(r => r.gate_exception).map(r => r.id), []);
});

test('test.yml: the rows job checks out full history, so git can date the rolling pins', () => {
  const y = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'test.yml'), 'utf8');
  const rows = y.split(/\n {2}rows:\n/)[1].split(/\n {2}[a-z-]+:\n/)[0];
  assert.match(rows, /fetch-depth: 0/);
});
