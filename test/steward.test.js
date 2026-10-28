// bin/steward.js and lib/commands.js: every command's script exists, help, version, check and the config format, the add-on gate, argument checks, and init (refuses to overwrite, asks,
// writes a receipt that starts no soak). Throwaway instances and state; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { COMMANDS } = require('../lib/commands.js');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-cli-')));
/** @type {NodeJS.ProcessEnv} */
const BASE = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', XDG_STATE_HOME: path.join(ROOT, 'state'), XDG_CONFIG_HOME: path.join(ROOT, 'xdg') };
delete BASE.STEWARD_CONFIG;
const steward = (args, env = {}, input = '') => spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), ...args],
  { encoding: 'utf8', input, env: { ...BASE, STEWARD_INSTANCE: path.join(REPO, 'examples'), ...env } });
const instance = (name, toml) => { const d = path.join(ROOT, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'steward.toml'), toml); return d; };

test('commands: the script behind every command exists', () => {
  for (const c of COMMANDS) {
    const exe = c.run[0] === 'node' ? path.join(REPO, c.cwd, c.run[1]) : path.join(REPO, c.cwd, c.run[0]);
    assert.ok(fs.existsSync(exe), `${c.area} ${c.name}: ${exe} is missing`);
  }
});

test('help and version: lists every command; reports the engine, the instance and its format', () => {
  const h = steward(['help']).stdout;
  for (const c of COMMANDS) assert.ok(h.includes(`steward ${c.area ? `${c.area} ` : ''}${c.name}`), c.name);
  assert.match(h, /AI tooling.*\(off: steward\.toml \[profiles\] ai_tooling = false\)/);
  const v = steward(['version']).stdout;
  assert.match(v, new RegExp(`workstation-steward (dev|release) ${require('../package.json').version.replace(/\./g, '\\.')} `));
  assert.match(v, /instance: .*examples +\[env STEWARD_INSTANCE\]/);
  assert.match(v, /format: +schema 1;/);
});

test('check: format current, older, newer, missing; exit 0 only when nothing is wanted', () => {
  const ok = steward(['check']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /config format 1: current/);
  const none = steward(['check'], { STEWARD_INSTANCE: instance('noschema', '[profiles]\nprojects = true\n') });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /add `schema = 1`/);
  const newer = steward(['check'], { STEWARD_INSTANCE: instance('newer', 'schema = 9\n') });
  assert.equal(newer.status, 1);
  assert.match(newer.stdout, /WANTS .*written by a newer steward.*upgrade the engine/);
  const bad = steward(['check'], { STEWARD_INSTANCE: instance('bad', 'schema = "one"\n') });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /schema: expected a whole number/);
});

test('version and check: a named instance with no steward.toml yet (a fresh release launcher) is explained, not a stop', () => {
  const fresh = path.join(ROOT, 'fresh');
  fs.mkdirSync(fresh);
  const v = steward(['version'], { STEWARD_INSTANCE: fresh });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /no steward\.toml yet: steward init/);
  const c = steward(['check'], { STEWARD_INSTANCE: fresh });
  assert.equal(c.status, 1, c.stderr);
  assert.match(c.stdout, /WANTS {2}no steward\.toml at .*: steward init/);
  const use = steward(['sc', 'host'], { STEWARD_INSTANCE: fresh });
  assert.equal(use.status, 2, 'a command that uses the config still refuses');
  assert.match(use.stderr, /no steward\.toml there/);
});

test('run: a config in a format this engine does not read is refused, not half-read', () => {
  const inst = instance('future', 'schema = 9\n');
  const r = steward(['sc', 'soak'], { STEWARD_INSTANCE: inst });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /your config is format 9; this engine \(.*\) reads 1\. Upgrade the engine first/);
  assert.equal(steward(['config', '--json'], { STEWARD_INSTANCE: inst }).status, 0, 'config still runs, to help fix it');
});

test('run: the add-on gate, missing arguments, unknown commands, and a passthrough', () => {
  const gated = steward(['projects', 'scan']);
  assert.equal(gated.status, 3);
  assert.match(gated.stderr, /projects add-on is off/);
  const short = steward(['sc', 'tool-age', 'npm:x']);
  assert.equal(short.status, 2);
  assert.match(short.stderr, /usage: steward sc tool-age <npm:tool> <version>/);
  assert.equal(steward(['sc', 'nope']).status, 2);
  assert.equal(steward(['nope']).status, 2);
  const cfg = steward(['config', '--json']);
  assert.equal(cfg.status, 0, cfg.stderr);
  assert.equal(JSON.parse(cfg.stdout).profiles.projects, false);
});

test('init: plans, asks, never overwrites, writes a receipt that starts no soak', () => {
  const target = path.join(ROOT, 'mine');
  const no = steward(['init', target], {}, 'n\n');
  assert.equal(no.status, 0);
  assert.match(no.stdout, /create steward\.toml/);
  assert.ok(!fs.existsSync(target), 'nothing written on "n"');
  const yes = steward(['init', target], {}, 'y\n');
  assert.equal(yes.status, 0, yes.stderr);
  for (const f of ['steward.toml', 'mise/config.toml', 'supply-chain/host.toml', 'projects/registry.toml']) assert.ok(fs.existsSync(path.join(target, f)), f);
  assert.match(yes.stdout, /export STEWARD_INSTANCE=/);
  const again = steward(['init', target], {}, 'y\n');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /a config is already at/);
  const dirs = fs.readdirSync(path.join(ROOT, 'state', 'workstation-steward', 'backups')).filter(d => d.startsWith('init-'));
  assert.equal(dirs.length, 1);
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'workstation-steward', 'backups', dirs[0], 'receipt.json'), 'utf8'));
  assert.equal(r.kind, 'init');
  assert.equal(r.engine, require('../package.json').version);
  const soak = spawnSync(process.execPath, [path.join(REPO, 'lib', 'soak.js'), '--gate'], { encoding: 'utf8', env: { ...BASE, STEWARD_INSTANCE: target } });
  assert.equal(soak.status, 0, 'an init receipt starts no soak');
  // a partly filled folder is refused too
  const partial = path.join(ROOT, 'partial'); fs.mkdirSync(path.join(partial, 'mise'), { recursive: true });
  fs.writeFileSync(path.join(partial, 'mise', 'config.toml'), '# mine\n');
  const clash = steward(['init', partial, '--yes']);
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /never overwrites: mise\/config\.toml/);
  assert.equal(fs.readFileSync(path.join(partial, 'mise', 'config.toml'), 'utf8'), '# mine\n');
});

test('a relative path argument is read from the folder steward runs in, not the engine (2026-10-28)', () => {
  const inst = path.join(ROOT, 'relpath-inst');
  fs.cpSync(path.join(REPO, 'examples'), inst, { recursive: true });
  const toml = path.join(inst, 'steward.toml');
  fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace(/^projects = false/m, 'projects = true'));
  const proj = path.join(ROOT, 'relpath-proj');
  fs.mkdirSync(proj);
  spawnSync('git', ['init', '-q'], { cwd: proj });
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), 'projects', 'facets', '.'], { cwd: proj, encoding: 'utf8', env: { ...BASE, STEWARD_INSTANCE: inst } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], proj, 'facets . names the folder it ran in');
});
