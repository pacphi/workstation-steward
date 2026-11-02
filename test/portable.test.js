// The engine's shell and helpers on macOS (BSD), GNU and busybox alike (parity 0.3): lib/lib.sh's tmpfile, cp_clone,
// mv_onto, sha256_of and node_tarball; lib/timeout.js and lib/subst.js in place of perl; offboarding's process check
// on Linux from /proc; and a guard that fails when engine Bash goes back to a BSD-only form. `just linux-test` runs the
// same tests on each Linux distribution (D65). Throwaway folders, stand-ins on PATH, no network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-portable-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const put = (f, text, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, mode ? { mode } : undefined); };
// sh(script, env) — bash with lib/lib.sh sourced (against the example instance), from a throwaway folder
const sh = (script, env = {}) => spawnSync('bash', ['-c', `source "${REPO}/lib/lib.sh" >/dev/null 2>&1; ${script}`], {
  encoding: 'utf8', cwd: ROOT, env: { ...process.env, STEWARD_INSTANCE: path.join(REPO, 'examples'), NO_PROGRESS: '1', ...env },
});
const sha = (algo, f) => crypto.createHash(algo).update(fs.readFileSync(f)).digest('hex');

test('tmpfile: a new empty file under TMPDIR named after its argument, which every mktemp accepts', () => {
  const tmp = path.join(ROOT, 'tmp');
  fs.mkdirSync(tmp);
  const r = sh('tmpfile steward-quiet', { TMPDIR: tmp });
  assert.equal(r.status, 0, r.stderr);
  const f = r.stdout.trim();
  assert.equal(path.dirname(f), tmp);
  assert.match(path.basename(f), /^steward-quiet\.[A-Za-z0-9]{6,}$/);
  assert.equal(fs.statSync(f).size, 0);
});

test('quiet and run_shown work where mktemp -t has no template (GNU): the blocker of the first Linux baseline', () => {
  const r = sh('quiet "say hi" echo hi; echo "rc=$? out=${QUIET_OUT}"');
  assert.match(r.stdout, /rc=0 out=hi/, r.stderr);
  const s = sh('rc=0; run_shown false || rc=$?; echo "rc=${rc}"');
  assert.match(s.stdout, /rc=1/, s.stderr);
});

test('cp_clone: a folder or a file, modes and times kept; the copy is independent of the source', () => {
  const src = path.join(ROOT, 'clone-src');
  put(path.join(src, 'sub', 'a.txt'), 'one\n', 0o640);
  const t = new Date('2026-10-01T00:00:00Z');
  fs.utimesSync(path.join(src, 'sub', 'a.txt'), t, t);
  const dst = path.join(ROOT, 'clone-dst');
  const r = sh(`cp_clone "${src}" "${dst}" && cp_clone "${src}/sub/a.txt" "${ROOT}/one-file.txt"`);
  assert.equal(r.status, 0, r.stderr);
  const st = fs.statSync(path.join(dst, 'sub', 'a.txt'));
  assert.equal(st.mode & 0o777, 0o640);
  assert.equal(st.mtime.toISOString(), t.toISOString());
  assert.equal(fs.readFileSync(path.join(ROOT, 'one-file.txt'), 'utf8'), 'one\n');
  fs.writeFileSync(path.join(dst, 'sub', 'a.txt'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(src, 'sub', 'a.txt'), 'utf8'), 'one\n');
});

test('mv_onto: a new link replaces the old one, never moving into the folder the old one points at', () => {
  const box = path.join(ROOT, 'links');
  fs.mkdirSync(path.join(box, 'releases', 'r1'), { recursive: true });
  fs.mkdirSync(path.join(box, 'releases', 'r2'), { recursive: true });
  fs.symlinkSync('releases/r1', path.join(box, 'current'));
  fs.symlinkSync('releases/r2', path.join(box, 'current.new'));
  const r = sh(`mv_onto "${box}/current.new" "${box}/current"`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readlinkSync(path.join(box, 'current')), 'releases/r2');
  assert.ok(!fs.existsSync(path.join(box, 'current.new')));
  assert.deepEqual(fs.readdirSync(path.join(box, 'releases', 'r1')), [], 'nothing moved into the old target');
});

test('sha256_of and the SHA256 and SHA1 commands: the same digests whichever tool the machine has', () => {
  const f = path.join(ROOT, 'digest.txt');
  put(f, 'steward\n');
  const r = sh(`sha256_of "${f}"; "\${SHA256[@]}" "${f}"; "\${SHA1[@]}" "${f}"`);
  assert.equal(r.status, 0, r.stderr);
  const [a, b, c] = r.stdout.trim().split('\n');
  assert.equal(a, sha('sha256', f));
  assert.equal(b.split(/\s+/)[0], sha('sha256', f));
  assert.equal(c.split(/\s+/)[0], sha('sha1', f));
});

test('node_tarball: the official tarball for this OS and CPU', () => {
  const bin = path.join(ROOT, 'uname-bin');
  put(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo "$FAKE_OS";; -m) echo "$FAKE_ARCH";; esac\n', 0o755);
  const at = (os_, arch) => sh('node_tarball 26.13.0', { PATH: `${bin}:${process.env.PATH}`, FAKE_OS: os_, FAKE_ARCH: arch }).stdout.trim();
  assert.equal(at('Darwin', 'arm64'), 'node-v26.13.0-darwin-arm64.tar.gz');
  assert.equal(at('Darwin', 'x86_64'), 'node-v26.13.0-darwin-x64.tar.gz');
  assert.equal(at('Linux', 'aarch64'), 'node-v26.13.0-linux-arm64.tar.gz');
  assert.equal(at('Linux', 'x86_64'), 'node-v26.13.0-linux-x64.tar.gz');
});

test('timeout.js: the command\'s own exit code; 142 (as perl\'s alarm gave) when it runs out of time', () => {
  const T = path.join(REPO, 'lib', 'timeout.js');
  const ok = spawnSync(process.execPath, [T, '5', 'sh', '-c', 'echo out; exit 3'], { encoding: 'utf8' });
  assert.equal(ok.status, 3);
  assert.equal(ok.stdout, 'out\n');
  const t0 = Date.now();
  const late = spawnSync(process.execPath, [T, '1', 'sleep', '20'], { encoding: 'utf8' });
  assert.equal(late.status, 142);
  assert.ok(Date.now() - t0 < 10e3, 'stopped at its limit');
  const none = spawnSync(process.execPath, [T, '5', 'no-such-command-here'], { encoding: 'utf8' });
  assert.equal(none.status, 127);
});

test('subst.js: replaces the matching lines in place, keeps the mode, and leaves a file without a match as it was', () => {
  const S = path.join(REPO, 'lib', 'subst.js');
  const f = path.join(ROOT, 'steward.toml');
  put(f, '[policy]\nmin_release_age_days = 3\nsoak_days = 3\n', 0o600);
  const r = spawnSync(process.execPath, [S, f, '^(min_release_age_days *= *)[0-9]+', '$15'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), '[policy]\nmin_release_age_days = 5\nsoak_days = 3\n');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const j = path.join(ROOT, 'renovate.json');
  put(j, '{\n  "minimumReleaseAge": "3 days"\n}\n');
  spawnSync(process.execPath, [S, j, '("minimumReleaseAge": *")[^"]*"', '$15 days"']);
  assert.equal(fs.readFileSync(j, 'utf8'), '{\n  "minimumReleaseAge": "5 days"\n}\n');
  const before = fs.readFileSync(f, 'utf8');
  assert.equal(spawnSync(process.execPath, [S, f, '^nothing_here = .*', 'x']).status, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('offboarding\'s process check on Linux: /proc names Claude Code, Codex and Node working in the folder or under it', () => {
  const { running } = require('../lib/offboard.js');
  const proc = path.join(ROOT, 'proc');
  const pid = (n, comm, cwd) => { put(path.join(proc, String(n), 'comm'), `${comm}\n`); fs.symlinkSync(cwd, path.join(proc, String(n), 'cwd')); };
  pid(101, 'claude', '/srv/work/proj');
  pid(102, 'node', '/srv/work/proj/sub');
  pid(103, 'codex', '/srv/work/other');
  pid(104, 'bash', '/srv/work/proj');
  pid(105, 'node', '/srv/work/project-two');
  fs.mkdirSync(path.join(proc, 'self'));
  put(path.join(proc, 'uptime'), '1 1\n');
  assert.deepEqual(running('/srv/work/proj', { platform: 'linux', proc }), ['claude (pid 101)', 'node (pid 102)']);
  assert.deepEqual(running('/srv/work/none', { platform: 'linux', proc }), []);
});

test('refresh: a step with less than its minimum time left is marked not run, never started (the Debian baseline race)', async () => {
  const RF = require('../lib/refresh.js');
  const t = [0, 0, 248, 248];   // start; step a starts at 0 and ends at 248; step b would start with 2 ms of a 250 ms cap left
  let i = 0;
  const now = () => new Date(Date.parse('2026-11-02T00:00:00Z') + t[Math.min(i++, t.length - 1)]);
  let started = 0;
  const step = name => ({ name, label: name, timeout: 1000, when: () => null, fn: async () => { started++; return 'x'; } });
  const values = { paths: { state: path.join(ROOT, 'refresh-state') }, brief: {}, profiles: {} };
  const c = await RF.refresh({ values, run: async () => ({}), now, cap: 250, steps: [step('a'), step('b')] });
  assert.equal(c.steps.a.ok, true);
  assert.equal(c.steps.b.error, 'not run: the refresh reached its 250 ms limit');
  assert.equal(started, 1, 'b never started');
});

// The forms that work on macOS only, and where each now lives instead
/** @type {[RegExp, string][]} */
const BSD_ONLY = [
  [/mktemp -t\b/, 'tmpfile'],
  [/\bcp -[A-Za-z]*c[A-Za-z]*\b/, 'cp_clone'],
  [/'-Rpc'/, 'a copy that tries a reflink on Linux'],
  [/\bmv -h\b/, 'mv_onto'],
  [/\bdate (-u )?-v/, 'Node for date arithmetic'],
  [/\bperl\b/, 'lib/timeout.js or lib/subst.js'],
  [/(?<![.\w])shasum\b/, 'sha256_of, SHA256 or SHA1'],
];
// a helper's own BSD-only line says so with a marker comment, `bsd-ok: <why>`, so nothing else slips through
const OK = /(#|\/\/) bsd-ok: \S/;

test('no engine shell or script falls back to a BSD-only form outside the helpers (parity 0.3)', () => {
  const files = spawnSync('git', ['ls-files', 'lib', 'bin', 'supply-chain/bin', 'ai-tooling/bin', 'ai-tooling/qualify', 'projects/bin', 'fleet/bin', 'tools'], { cwd: REPO, encoding: 'utf8' })
    .stdout.split('\n').filter(f => f && !/\.(md|json|toml|tsv|txt|cjs)$/.test(f));
  assert.ok(files.length > 20);
  const found = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/^\s*(#|\/\/)/.test(l)) return;
      for (const [re, use] of BSD_ONLY) if (re.test(l) && !OK.test(l)) found.push(`${f}:${i + 1} (use ${use})`);
    });
  }
  assert.deepEqual(found, []);
});
