// supply-chain/bin/verify, and the scripts `steward sc upgrade` runs, on a stand-in toolchain. Two things a real run
// (2026-10-29) got wrong: every upgrade-tool verified on its own, so a 7-tool plan verified 8 times (STEWARD_DEFER_VERIFY
// now leaves it to the end of the upgrade, and upgrade-tool on its own still verifies), and verify warned about a stale
// PATH for the shared AQE runtime, which comes first on PATH by design (D24). Stand-ins for mise, npm, brew and gh come
// first on PATH; a stand-in CLI in verify.tsv counts verify's runs. Every path the scripts write comes from the
// sandbox's steward.toml, and HOME stays as it is, so mise's shims still find the real node and yq. Throwaway folders;
// no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-verify-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const put = (f, text, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, mode ? { mode } : undefined); };
const cli = (f, extra = '') => put(f, `#!/bin/bash\n${extra}echo "ok"\n`, 0o755);
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// sandbox(name, {aiTooling, tsv}) — an instance, a mise config, stand-ins, and run(script, args, env): its result
function sandbox(name, { aiTooling = false, tsv = ['countme\t--version\t0\tok'] } = {}) {
  const box = path.join(ROOT, name);
  const inst = path.join(box, 'inst'), stub = path.join(box, 'stub'), which = path.join(box, 'mise-which');
  put(path.join(inst, 'steward.toml'), `schema = 1\n[paths]\nmise_config_dir = "${box}/mise"\nmise_data_dir = "${box}/mise-data"\n`
    + `state = "${box}/state"\ncache = "${box}/cache"\nai_tooling_root = "${box}/ai"\n[profiles]\nai_tooling = ${aiTooling}\n`);
  put(path.join(inst, 'supply-chain', 'verify.tsv'), `${tsv.join('\n')}\n`);
  put(path.join(inst, 'ai-tooling', 'ai-tooling.toml'), '[aqe]\nruntime = "{{AI_TOOLING_ROOT}}/aqe"\n');
  put(path.join(box, 'mise', 'config.toml'), '[tools]\n');
  // mise: `which` answers from mise-which/ when a tool is there (mise's own copy), else PATH; `upgrade … bad` fails as
  // a backend error did on the owner's Mac; everything else succeeds quietly. Every call is logged.
  put(path.join(stub, 'mise'), `#!/bin/bash
echo "$*" >>"${box}/mise.log"
case "$1" in
  which) if [[ -x "${which}/$2" ]]; then echo "${which}/$2"; else command -v "$2"; fi ;;
  upgrade) [[ "$*" == *bad* ]] && { echo "mise ERROR Failed to install bad: option 'exe' is not used by the github backend" >&2; exit 1; } ;;
  self-update) echo "mise ERROR self-update failed (stand-in)" >&2; exit 1 ;;
esac
exit 0
`, 0o755);
  put(path.join(stub, 'npm'), `#!/bin/bash\n[[ "$1" == root ]] && echo "${box}/npm-root"\nexit 0\n`, 0o755);
  for (const b of ['brew', 'gh']) put(path.join(stub, b), '#!/bin/bash\nexit 1\n', 0o755);
  cli(path.join(stub, 'countme'), `echo run >>"${box}/verify.count"\n`);
  const run = (script, args = [], env = {}, pre = []) => {
    /** @type {NodeJS.ProcessEnv} */
    const e = { ...process.env, STEWARD_INSTANCE: inst, NO_PROGRESS: '1', NO_COLOR: '1', PATH: [...pre, stub, process.env.PATH].join(':'), ...env };
    delete e.STEWARD_DEFER_VERIFY; delete e.DRY_RUN; delete e.STEWARD_CONFIG;
    Object.assign(e, env);
    const r = spawnSync(script, args, { encoding: 'utf8', env: e, cwd: box });
    return { ...r, out: strip(`${r.stdout}${r.stderr}`) };
  };
  const count = () => { try { return fs.readFileSync(path.join(box, 'verify.count'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const miseLog = () => { try { return fs.readFileSync(path.join(box, 'mise.log'), 'utf8'); } catch { return ''; } };
  return { box, inst, stub, which, run, count, miseLog };
}
const BIN = n => path.join(REPO, 'supply-chain', 'bin', n);

test('upgrade-tool on its own verifies before it locks; with STEWARD_DEFER_VERIFY=1 it leaves that to steward sc upgrade', () => {
  const s = sandbox('alone');
  const r = s.run(BIN('upgrade-tool'), ['npm:typescript']);
  assert.equal(r.status, 0, r.out);
  assert.equal(s.count(), 1, 'verified once');
  assert.match(r.out, /CLIs \(verify\.tsv\)/);
  assert.match(s.miseLog(), /^lock --global npm:typescript$/m);

  const d = sandbox('deferred');
  const r2 = d.run(BIN('upgrade-tool'), ['npm:typescript'], { STEWARD_DEFER_VERIFY: '1' });
  assert.equal(r2.status, 0, r2.out);
  assert.equal(d.count(), 0, 'not verified');
  assert.match(r2.out, /verify: left to the end of steward sc upgrade/);
  assert.match(d.miseLog(), /^lock --global npm:typescript$/m, 'still locks');
  assert.ok(fs.readdirSync(path.join(d.box, 'state', 'changes')).length === 1, 'still writes its receipt');
});

test('steward sc upgrade\'s apply on the real scripts: a failed tool and a failed mise self-update, the rest still run, verify once, exit 1', () => {
  const s = sandbox('apply');
  const plan = { packages: [], tools: ['npm:a', 'github:example/bad', 'npm:b'], updaters: [], miseSelf: '2026.10.19' };
  const o = { backups: path.join(s.box, 'mise', 'backups'), stateBackups: path.join(s.box, 'state', 'backups') };
  const js = `require(${JSON.stringify(BIN('upgrade.js'))}).apply(${JSON.stringify(plan)}, ${JSON.stringify(o)}).then(c => { process.exitCode = c; })`;
  const r = s.run(process.execPath, ['-e', js]);
  assert.equal(r.status, 1, r.out);
  assert.equal(s.count(), 1, `verify ran ${s.count()} times`);
  assert.deepEqual(s.miseLog().split('\n').filter(l => l.startsWith('upgrade ')), ['upgrade --bump --no-prune npm:a', 'upgrade --bump --no-prune github:example/bad', 'upgrade --bump --no-prune npm:b']);
  assert.match(r.out, /✗ mise tool github:example\/bad \(exit 1\)\n\s+way back: if it changed the config, steward sc rollback \S+config\.toml\.\d{8}-\d{6}(-\d+)? /);
  assert.match(r.out, /✗ mise self-update to 2026\.10\.19 \(exit 1\)\n\s+way back: if mise changed, steward sc rollback mise/);
  assert.match(r.out, /ERROR 2 step\(s\) of this upgrade failed/);
  assert.ok(!/==> done\. Remaining manual items/.test(r.out), 'the run never ends in "done"');
  assert.match(r.out, /==> not done: fix each failed step/);
  // back to back, the tools can share a second: each still gets its own backup, so none overwrites another's
  assert.equal(fs.readdirSync(path.join(s.box, 'mise', 'backups')).filter(n => n.startsWith('config.toml.')).length, 3);
});

// The shared AQE runtime: releases/<v>/bin, with current/ linking to one, and current/bin first on PATH (D24)
function aqeBox(name, aiTooling) {
  const s = sandbox(name, { aiTooling, tsv: ['agentic-qe\t--version\t0\tok', 'steward-test-tool\t--version\t0\tok'] });
  const rel = path.join(s.box, 'ai', 'aqe', 'releases', '3.15.12-local.1', 'bin');
  cli(path.join(rel, 'agentic-qe'));
  fs.symlinkSync(path.join(s.box, 'ai', 'aqe', 'releases', '3.15.12-local.1'), path.join(s.box, 'ai', 'aqe', 'current'));
  const stale = path.join(s.box, 'stale');   // an old install dir a long-lived shell kept on PATH
  cli(path.join(stale, 'steward-test-tool'));
  for (const b of ['agentic-qe', 'steward-test-tool']) cli(path.join(s.which, b));   // where mise resolves each
  return { ...s, verify: () => s.run(BIN('verify'), [], {}, [path.join(s.box, 'ai', 'aqe', 'current', 'bin'), stale]) };
}

test('verify: the shared AQE runtime ahead of mise\'s copy gets no stale-PATH warning; any other mismatch still does', () => {
  const r = aqeBox('aqe-on', true).verify();
  assert.equal(r.status, 0, r.out);
  assert.ok(!/WARN agentic-qe:/.test(r.out), r.out);
  assert.match(r.out, /WARN steward-test-tool: this shell's PATH resolves .*\/stale\/steward-test-tool; mise resolves/);
});

test('verify: without the AI tooling add-on there is no shared runtime, so the warning stays for every mismatch', () => {
  const r = aqeBox('aqe-off', false).verify();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARN agentic-qe: this shell's PATH resolves .*\/aqe\/current\/bin\/agentic-qe; mise resolves/);
  assert.match(r.out, /WARN steward-test-tool:/);
});

test('verify: npm doctor runs under a timer (quiet), its "Not ok" exit is no failure, and each check\'s result line still prints', () => {
  const s = sandbox('doctor');
  const pre = path.join(s.box, 'doctor-npm');
  put(path.join(pre, 'npm'), '#!/bin/bash\n[[ "$1" == doctor ]] || exit 0\n'
    + 'printf "Checking npm ping\\nOk\\n\\nChecking npm version\\nNot ok\\nUse npm v12.1.0\\nChecking node version\\nOk\\ncurrent: v26.1.0\\n"\nexit 1\n', 0o755);
  const r = s.run(BIN('verify'), [], {}, [pre]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^ {2}Checking npm version: Not ok \(Use npm v12\.1\.0\)$/m);
  assert.match(r.stdout, /^ {2}Checking node version: Ok \(current: v26\.1\.0\)$/m);
  assert.match(r.stderr, /… npm doctor\n/);
  assert.match(strip(r.stderr), /✓ npm doctor \(\d+s\)/);
  assert.match(r.out, /all checks passed/);
});
