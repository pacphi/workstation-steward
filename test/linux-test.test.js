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

test('matrix.json: the newest of each distribution the Linux release needs, each pinned by tag and digest', () => {
  const m = L.loadMatrix(MATRIX);
  assert.deepEqual(L.validate(m), []);
  assert.deepEqual(m.rows.map(r => r.id), ['debian', 'ubuntu', 'fedora', 'leap', 'tumbleweed']);
  for (const r of m.rows) {
    assert.ok(FAMILIES.includes(r.family), `${r.id}: family`);
    assert.match(r.image, /^[a-z0-9./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/, `${r.id}: image names a digest`);
    assert.ok(fs.existsSync(path.join(REPO, 'test', 'containers', `${r.family}.Dockerfile`)), `${r.id}: its Dockerfile`);
  }
  assert.match(m.mise.sha256.arm64, /^[0-9a-f]{64}$/);
  assert.match(m.mise.sha256.x64, /^[0-9a-f]{64}$/);
});

test('validate: names what is wrong with a row or the mise pin', () => {
  const bad = { rows: [{ id: 'x', family: 'debain', image: 'debian:13' }], mise: { version: '', sha256: { arm64: 'zz' } } };
  assert.deepEqual(L.validate(bad), [
    'x: family must be one of debian, rhel, suse, arch, alpine, void, gentoo, slackware, nixos (not debain)',
    'x: image must name a digest (image:tag@sha256:<64 hex>)',
    'mise: version is missing',
    'mise: sha256.arm64 must be 64 hex characters',
    'mise: sha256.x64 must be 64 hex characters',
  ]);
  const exc = { rows: [{ id: 'tw', family: 'suse', image: `opensuse/tumbleweed:latest@sha256:${'a'.repeat(64)}`, gate_exception: { why: 'w', decided: 'owner' } }], mise: { version: '1', sha256: { arm64: 'a'.repeat(64), x64: 'b'.repeat(64) } } };
  assert.deepEqual(L.validate(exc), ['tw: gate_exception needs why, decided and expires (YYYY-MM-DD)'], 'an exception to the release-age gate says why, who and until when');
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
