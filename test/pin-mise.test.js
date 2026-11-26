// tools/pin-mise.js (D94): one command moves every mise pin to a release, the workflows' `version:` lines and
// test/containers/matrix.json (version and the linux-arm64 and linux-x64 checksums), with the checksums read from the
// release's SHASUMS256.txt. No network: the sums come from a file or a stand-in fetch. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../tools/pin-mise.js');

const ARM = 'a'.repeat(64);
const X64 = 'b'.repeat(64);
const OLD_ARM = '1'.repeat(64);
const OLD_X64 = '2'.repeat(64);
const SUMS = [
  `${'c'.repeat(64)}  ./mise-v2026.11.12-linux-arm64-musl.tar.gz`,
  `${ARM}  ./mise-v2026.11.12-linux-arm64.tar.gz`,
  `${X64}  ./mise-v2026.11.12-linux-x64.tar.gz`,
  `${'d'.repeat(64)}  ./mise-v2026.11.12-macos-arm64.tar.gz`,
].join('\n');
const MATRIX = { about: 'x', rows: [{ id: 'debian-13', arch: ['amd64', 'arm64'] }], mise: { version: '2026.11.8', sha256: { arm64: OLD_ARM, x64: OLD_X64 } } };
const MATRIX_TEXT = `${JSON.stringify(MATRIX, null, 2)}\n`;
const WORKFLOW = [
  'jobs:',
  '  a:',
  '    steps:',
  '      - uses: jdx/mise-action@abc # v5.2.8',
  '        with:',
  '          version: 2026.11.8',
  '          install: false',
  '      - uses: jdx/mise-action@abc # v5.2.8',
  '        with:',
  '          version: 2026.11.12',
  '  node-version: 26.1.0',
  '',
].join('\n');

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-pin-mise-')));
  const wf = path.join(root, 'workflows');
  fs.mkdirSync(wf);
  fs.writeFileSync(path.join(wf, 'lint.yml'), WORKFLOW);
  fs.writeFileSync(path.join(wf, 'notes.txt'), 'version: 2026.11.8\n');
  const matrix = path.join(root, 'matrix.json');
  fs.writeFileSync(matrix, MATRIX_TEXT);
  return { root, wf, matrix };
}
const io = (t, logs = [], errs = []) => ({ workflows: t.wf, matrix: t.matrix, log: l => logs.push(l), err: l => errs.push(l), fetchSums: async () => SUMS });

test('parseSums: the two Linux tarballs by exact name, not the musl or macOS ones; a missing or malformed line throws', () => {
  assert.deepEqual(P.parseSums(SUMS, '2026.11.12'), { arm64: ARM, x64: X64 });
  assert.throws(() => P.parseSums(SUMS, '2026.11.13'), /no sha256 for mise-v2026.11.13-linux-arm64.tar.gz/);
  assert.throws(() => P.parseSums(`xyz  ./mise-v2026.11.12-linux-arm64.tar.gz\n${X64}  ./mise-v2026.11.12-linux-x64.tar.gz`, '2026.11.12'), /no sha256/);
});

test('pinWorkflow: every mise `version:` line moves; other lines stay; one already on the version counts as unchanged', () => {
  const r = P.pinWorkflow(WORKFLOW, '2026.11.12');
  assert.equal(r.changed, 1);
  assert.equal(r.text.match(/version: 2026\.11\.12/g).length, 2);
  assert.ok(r.text.includes('node-version: 26.1.0'), 'other versions are left alone');
  assert.equal(P.pinWorkflow(r.text, '2026.11.12').changed, 0);
});

test('pinMatrix: the version and both checksums change and nothing else; the same pin is unchanged; a differently formatted file is refused', () => {
  const r = P.pinMatrix(MATRIX_TEXT, '2026.11.12', { arm64: ARM, x64: X64 });
  assert.equal(r.changed, 1);
  const m = JSON.parse(r.text);
  assert.deepEqual(m.mise, { version: '2026.11.12', sha256: { arm64: ARM, x64: X64 } });
  assert.deepEqual(m.rows, MATRIX.rows);
  assert.equal(P.pinMatrix(r.text, '2026.11.12', { arm64: ARM, x64: X64 }).changed, 0);
  assert.throws(() => P.pinMatrix(JSON.stringify(MATRIX), '2026.11.12', { arm64: ARM, x64: X64 }), /refusing to rewrite/);
  assert.throws(() => P.pinMatrix('{"rows":[]}\n', '2026.11.12', { arm64: ARM, x64: X64 }), /no mise block/);
});

test('run: --check changes nothing and exits 1; a real run writes the workflows and matrix.json; a second run says it is pinned', async () => {
  const t = tree();
  const logs = [];
  assert.equal(await P.run(['2026.11.12', '--check'], io(t, logs)), 1);
  assert.equal(fs.readFileSync(t.matrix, 'utf8'), MATRIX_TEXT);
  assert.ok(logs.some(l => l.startsWith('would change') && l.includes('lint.yml')));
  assert.equal(await P.run(['2026.11.12'], io(t, logs)), 0);
  assert.equal(JSON.parse(fs.readFileSync(t.matrix, 'utf8')).mise.sha256.x64, X64);
  assert.ok(!fs.readFileSync(path.join(t.wf, 'lint.yml'), 'utf8').includes('2026.11.8'));
  assert.equal(fs.readFileSync(path.join(t.wf, 'notes.txt'), 'utf8'), 'version: 2026.11.8\n', 'only .yml files are touched');
  const again = [];
  assert.equal(await P.run(['2026.11.12'], io(t, again)), 0);
  assert.deepEqual(again, ['mise 2026.11.12 is already pinned everywhere']);
});

test('run: a bad version, a failed fetch and an unknown release are errors (exit 2) that change nothing', async () => {
  const t = tree();
  const errs = [];
  assert.equal(await P.run(['soon'], io(t, [], errs)), 2);
  assert.match(errs[0], /usage/);
  assert.equal(await P.run(['2026.11.12'], { ...io(t, [], errs), fetchSums: async () => { throw new Error('HTTP 500'); } }), 2);
  assert.match(errs[1], /HTTP 500/);
  assert.equal(await P.run(['2026.12.1'], io(t, [], errs)), 2);
  assert.match(errs[2], /no sha256 for mise-v2026.12.1-linux-arm64/);
  assert.equal(fs.readFileSync(t.matrix, 'utf8'), MATRIX_TEXT);
});
