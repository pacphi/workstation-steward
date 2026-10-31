// Progress everywhere, so nothing looks hung (AGENTS.md, "Long commands show progress"): the live timer that npm -g
// installs get (lib/lib.sh run_shown), the timer around the Ruflo policy search, drift's stages on stderr, the AQE gates'
// step lines, the maintainer's gap measurer (tools/progress-gaps.js), and a list of the known long steps that fails when
// one loses its wrapper. A terminal is faked with script(1). Stand-ins for npm; throwaway folders; no network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-progress-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const put = (f, text, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, mode ? { mode } : undefined); };
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// sandbox(name) — an instance whose paths are all inside it, a HOME, and a stand-in npm that takes 2 s, warns, and
// records that it ran
function sandbox(name) {
  const box = path.join(ROOT, name), inst = path.join(box, 'inst'), home = path.join(box, 'home'), stub = path.join(box, 'stub');
  put(path.join(inst, 'steward.toml'), `schema = 1\n[paths]\nstate = "${box}/state"\ncache = "${box}/cache"\nmise_config_dir = "${box}/mise"\n`
    + `ruflo_config_dir = "${box}/no-ruflo"\n[projects]\nmax_depth = 4\n`);
  put(path.join(inst, 'supply-chain', 'hybrids.toml'), '[[hybrid]]\nname = "fake-cli"\nversion = "1.2.3"\nsource = "registry"\n'
    + 'allow_scripts = ["fake-cli", "better-sqlite3"]\nstate_backup = "ruflo-policy"\n');
  put(path.join(home, 'proj', '.claude-flow', 'policy', 'p.json'), '{}');
  put(path.join(stub, 'npm'), `#!/bin/bash\necho "$*" >>"${box}/npm.log"\nsleep 2\necho "npm warn deprecated old-dep@1.0.0: no longer supported" >&2\necho "added 1 package in 2s"\n`, 0o755);
  // node and yq from their install folders: with HOME moved, a mise shim would look for its installs there
  const yq = spawnSync('mise', ['which', 'yq'], { encoding: 'utf8' });
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, STEWARD_INSTANCE: inst, HOME: home, NO_COLOR: '1', PATH: [stub, path.dirname(process.execPath), ...(yq.status === 0 ? [path.dirname(yq.stdout.trim())] : []), process.env.PATH].join(':') };
  for (const k of ['DRY_RUN', 'NO_PROGRESS', 'STEWARD_CONFIG', 'STEWARD_T0']) delete env[k];
  const npmRuns = () => { try { return fs.readFileSync(path.join(box, 'npm.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { box, inst, home, env, npmRuns };
}
// bash(script, env) — run a lib.sh snippet with pipes (not a terminal)
const bash = (script, env) => spawnSync('bash', ['-c', `source ${JSON.stringify(path.join(REPO, 'lib', 'lib.sh'))}; ${script}`], { encoding: 'utf8', env });
// onTTY(script, env) — the same in a pseudo-terminal (script(1)): {status, out}, stdout and stderr as one terminal shows them
function onTTY(script, env) {
  const cmd = `source ${JSON.stringify(path.join(REPO, 'lib', 'lib.sh'))}; ${script}`;
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', 'bash', '-c', cmd] : ['-qec', `bash -c ${JSON.stringify(cmd)}`, '/dev/null'];
  const r = spawnSync('script', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, raw: r.stdout, out: strip(`${r.stdout}${r.stderr}`).replace(/\r/g, '\n') };
}

test('run_shown on a terminal: the command line, a live timer while npm works, then all of npm\'s output (its warning too) and a ✓', () => {
  const s = sandbox('tty');
  const r = onTTY('run_shown npm install -g --allow-scripts=fake-cli,better-sqlite3 fake-cli@1.2.3', s.env);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\$ npm install -g --allow-scripts=fake-cli,better-sqlite3 fake-cli@1\.2\.3/);
  assert.match(r.out, /… npm install … fake-cli@1\.2\.3 [1-9]s/, 'the timer ticked while npm was silent');
  assert.match(r.raw, /\r\x1b\[2K {3}… npm install/, 'it redraws in place');
  const warn = r.out.indexOf('npm warn deprecated old-dep'), added = r.out.indexOf('added 1 package'), tick = r.out.lastIndexOf('… npm install');
  assert.ok(warn > tick && added > tick, `npm's output comes after the timer, in full:\n${r.out}`);
  assert.match(r.out, /✓ npm install … fake-cli@1\.2\.3 \([23]s\)/);
  assert.equal(s.npmRuns().length, 1);
});

test('run_shown: DRY_RUN=1 prints the command and runs nothing; off a terminal or with NO_PROGRESS=1 the output streams as run\'s', () => {
  const s = sandbox('dry');
  const dry = onTTY('run_shown npm install -g fake-cli@1.2.3', { ...s.env, DRY_RUN: '1' });
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /\$ npm install -g fake-cli@1\.2\.3/);
  assert.doesNotMatch(dry.out, /…|✓/);
  assert.equal(s.npmRuns().length, 0, 'npm never ran');

  const piped = bash('run_shown npm install -g fake-cli@1.2.3', s.env);
  assert.equal(piped.status, 0, piped.stderr);
  assert.equal(piped.stdout, '   $ npm install -g fake-cli@1.2.3\nadded 1 package in 2s\n');
  assert.match(piped.stderr, /npm warn deprecated/);
  assert.doesNotMatch(piped.stderr, /…|✓/, 'no timer in a pipe');

  const off = onTTY('run_shown npm install -g fake-cli@1.2.3', { ...s.env, NO_PROGRESS: '1' });
  assert.equal(off.status, 0, off.out);
  assert.match(off.out, /added 1 package/);
  assert.doesNotMatch(off.out, /…|✓/, 'NO_PROGRESS=1: no timer');
  assert.equal(s.npmRuns().length, 2);
});

test('run_shown returns the command\'s status and still shows its output when it fails', () => {
  const s = sandbox('fail');
  put(path.join(s.box, 'stub', 'npm'), '#!/bin/bash\necho "npm error code E404" >&2\nexit 7\n', 0o755);
  const r = onTTY('run_shown npm install -g nope@1 && echo OK || echo "rc=$?"', s.env);
  assert.match(r.out, /npm error code E404/);
  assert.match(r.out, /✗ npm install … nope@1: exit 7 after \d+s/);
  assert.match(r.out, /rc=7/);
});

test('install_hybrids on a terminal: a timer while it finds the Ruflo policy folders, and npm through run_shown; DRY_RUN=1 installs nothing', () => {
  const s = sandbox('hybrids');
  const dry = onTTY('install_hybrids', { ...s.env, DRY_RUN: '1' });
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /✓ finding Ruflo policy folders \(\d+s\)/);
  assert.match(dry.out, /Ruflo policy backup: 1 folder\(s\)/);
  assert.match(dry.out, /\$ npm install -g --allow-scripts=fake-cli,better-sqlite3 fake-cli@1\.2\.3/);
  assert.equal(s.npmRuns().length, 0, 'DRY_RUN=1: npm never ran');
  assert.equal(fs.existsSync(path.join(s.box, 'state')), false, 'DRY_RUN=1: no backup, no receipt');

  const real = onTTY('install_hybrids', s.env);
  assert.equal(real.status, 0, real.out);
  assert.match(real.out, /… npm install … fake-cli@1\.2\.3 [1-9]s/);
  assert.match(real.out, /npm warn deprecated old-dep/);
  assert.match(real.out, /backed up 1 folder\(s\)/);
  assert.deepEqual(s.npmRuns(), ['install -g --allow-scripts=fake-cli,better-sqlite3 fake-cli@1.2.3']);
  assert.ok(fs.existsSync(path.join(s.box, 'state', 'hybrids', 'fake-cli.json')), 'the receipt');
});

test('the Ruflo policy search keeps its exact list of folders when run under quiet (pipes: a start line on stderr)', () => {
  const s = sandbox('dirs');
  put(path.join(s.home, 'b', '.claude-flow', 'policy', 'x'), '');
  const r = bash('quiet "finding Ruflo policy folders" ruflo_policy_dirs; printf "%s\\n" "${QUIET_OUT}"; ruflo_policy_dirs', s.env);
  assert.equal(r.status, 0, r.stderr);
  const [quieted, plain] = [r.stdout.split('\n').slice(0, 2), r.stdout.split('\n').slice(2, 4)];
  assert.deepEqual(quieted, plain);
  assert.deepEqual(plain, [path.join(s.home, 'b', '.claude-flow', 'policy'), path.join(s.home, 'proj', '.claude-flow', 'policy')]);
  assert.match(r.stderr, /… finding Ruflo policy folders\n/);
});

test('steward ai drift: stages on stderr (machine, upstream, projects); stdout and --json are the same as with NO_PROGRESS=1', () => {
  const inst = path.join(ROOT, 'drift-inst'), dev = path.join(ROOT, 'drift-dev'), home = path.join(ROOT, 'drift-home');
  fs.cpSync(path.join(REPO, 'examples'), inst, { recursive: true });
  put(path.join(dev, 'app', 'package.json'), '{}');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(inst, 'steward.toml'), `[projects]\nroots = [${JSON.stringify(dev)}]\n\n[profiles]\nai_tooling = true\nprojects = true\n`);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: home, STEWARD_INSTANCE: inst };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'STEWARD_CONFIG', 'NO_PROGRESS']) delete env[k];
  const drift = (args, e) => spawnSync('node', ['ai-tooling/bin/drift.js', ...args], { cwd: REPO, encoding: 'utf8', env: e });
  for (const args of [['--offline', '--json'], ['--offline']]) {
    const shown = drift(args, env), off = drift(args, { ...env, NO_PROGRESS: '1' });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.stdout, off.stdout, `${args.join(' ')}: stdout is the report alone`);
    assert.equal(off.stderr, '', 'NO_PROGRESS=1: nothing on stderr');
    assert.match(shown.stderr, /^\[1\/3\] machine …$/m);
    assert.match(shown.stderr, /^✓ \[2\/3\] upstream: skipped \(--offline\)/m);
    assert.match(shown.stderr, /^✓ \[3\/3\] projects: 1 project\(s\)/m);
  }
  assert.ok(Array.isArray(JSON.parse(drift(['--offline', '--json'], env).stdout)));
});

test('the AQE gates: mark() writes step lines to stderr only; save() prints and writes the same JSON as before; NO_PROGRESS=1 is silent', () => {
  const qw = path.join(ROOT, 'qw');
  fs.mkdirSync(path.join(qw, 'evidence'), { recursive: true });
  const gate = path.join(ROOT, 'gx.py');
  put(gate, 'import sys, os; sys.path.insert(0, os.environ["QGATES"])\nfrom gatelib import *\nmark("first step")\nmark("second step")\nsave("gx.json", {"a": 1})\n');
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, QW: qw, QSTAGE: qw, QCURRENT: qw, QNODEBIN: path.dirname(process.execPath), QFIX: qw, QGATES: path.join(REPO, 'ai-tooling', 'qualify', 'aqe', 'gates') };
  delete env.NO_PROGRESS;
  const py = e => spawnSync('python3', ['-I', '-B', gate], { encoding: 'utf8', env: e });
  const r = py(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '{\n "a": 1\n}\n');
  assert.equal(fs.readFileSync(path.join(qw, 'evidence', 'gx.json'), 'utf8'), '{\n "a": 1\n}');
  assert.match(r.stderr, /^ {3}… gx: first step \[0:00\]\n {3}… gx: second step \[0:00\]\n$/);
  const off = py({ ...env, NO_PROGRESS: '1' });
  assert.equal(off.stdout, r.stdout);
  assert.equal(off.stderr, '');
  // on a terminal: a live line, then a ✓ with its time when the next step starts
  const args = process.platform === 'darwin' ? ['-q', '/dev/null', 'python3', '-I', '-B', gate] : ['-qec', `python3 -I -B ${gate}`, '/dev/null'];
  const t = spawnSync('script', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(strip(t.stdout), /✓ gx: first step \(0s\)/);
  assert.match(strip(t.stdout), /✓ gx: second step \(0s\)/);
});

// The known long steps, by file and marker: each line that runs one must have its wrapper on the line or within `near`
// lines (a function defined just above or below its quiet call). A step that moves or is renamed fails here too, so the
// list stays true. Gates: every gate marks its steps.
/** @type {[string, RegExp, RegExp, number][]} [file, the slow step, its wrapper, near] */
const LONG = [
  ['lib/lib.sh', /^(?!\s*#)(?!.*ruflo_policy_dirs\(\)).*\bruflo_policy_dirs\b/, /\bquiet\b/, 0],
  ['lib/lib.sh', /^(?!\s*#).*\bnpm install -g\b/, /\brun_shown\b/, 0],
  ['supply-chain/bin/verify', /^(?!\s*#).*npm doctor ping/, /\bquiet\b/, 1],
  ['supply-chain/bin/status', /^(?!\s*(#|log\b)).*\bmise outdated --bump\b/, /\bquiet\b/, 1],
  ['supply-chain/bin/status', /^(?!\s*#).*bin\/mise-self\.js/, /\bquiet\b/, 0],
  ['supply-chain/bin/mise-self-update', /^(?!\s*#).*bin\/mise-self\.js/, /\bquiet\b/, 0],
  ['ai-tooling/bin/drift.js', /^(?!\s*\/\/).*(P\.discover\(\)|pins\.js'\)\.(scan|targets)\(\)|hybrid_receipt_ok|registry\.npmjs\.org|'gh', \['api')/, /\bst\.detail\(/, 2],
  ['supply-chain/checks/index.js', /'mise-self\.js'\), '--plan'\]|\['view', 'electron'|'docker', \['info'\]/, /\bdetail\(ctx, /, 1],
  ['supply-chain/checks/index.js', /'mas', \['outdated'\]|'softwareupdate', \['-l'\]/, /label: /, 0],
  ['lib/coarse.js', /^(?!\s*\/\/).*= (onboard|offboard)\(r\.abs\)/, /\bst\.detail\(/, 8],
  ['lib/coarse.js', /^(?!\s*\/\/).*R\.all\(/, /\brs\.detail\(/, 0],
  ['lib/coarse.js', /^(?!\s*\/\/).*nodejs\.org\/dist\/index\.json'/, /\.stage\(/, 1],
];
const GATES = ['g1', 'g2', 'g3g4', 'g5', 'g6', 'g7', 'g8', 'smoke'];

test('every known long step has a quiet, run_shown or progress wrapper around it', () => {
  const missing = [];
  for (const [file, slow, wrap, near] of LONG) {
    const lines = fs.readFileSync(path.join(REPO, file), 'utf8').split('\n');
    const hits = lines.flatMap((l, i) => (slow.test(l) ? [i] : []));
    assert.ok(hits.length, `${file}: no line matches ${slow} any more; update this list`);
    for (const i of hits) if (!lines.slice(Math.max(0, i - near), i + near + 1).some(x => wrap.test(x))) missing.push(`${file}:${i + 1} ${lines[i].trim().slice(0, 90)}`);
  }
  for (const g of GATES) {
    const text = fs.readFileSync(path.join(REPO, 'ai-tooling', 'qualify', 'aqe', 'gates', `${g}.py`), 'utf8');
    if (!/^\s*mark\(/m.test(text)) missing.push(`gates/${g}.py: no mark() step line`);
  }
  assert.deepEqual(missing, [], 'long steps with no progress around them');
});

test('tools/progress-gaps.js runs read-only by default: writing commands only under DRY_RUN=1, never --apply, only steward', () => {
  const G = require('../tools/progress-gaps.js');
  assert.equal(G.refusal('steward ai drift --offline', false), '');
  assert.equal(G.refusal('DRY_RUN=1 steward sc install-hybrids', false), '');
  assert.match(G.refusal('steward sc install-hybrids', false), /can change things: run it as DRY_RUN=1/);
  assert.match(G.refusal('steward config sync --apply', false), /--apply/);
  assert.match(G.refusal('rm -rf /tmp/x', false), /only steward commands/);
  assert.match(G.refusal('steward no-such thing', false), /not a steward command/);
  assert.equal(G.refusal('steward sc upgrade', true), '', '--allow-writes lifts it');
  for (const c of G.DEFAULTS) assert.equal(G.refusal(c, false), '', c);
  assert.deepEqual(G.args(['--gap', '5', '--', 'steward', 'sc', 'status']).cmds, ['steward sc status'], 'just splits a quoted command; the words are one command again');
  assert.equal(G.args(['--gap', '5']).gap, 5);
  assert.throws(() => G.args(['steward sc status']), /after --/);
  assert.equal(G.args([]).cmds, G.DEFAULTS);
  assert.throws(() => G.args(['--gap', 'x']), /--gap/);
});
