// The command surface (lib/commands.js, `steward help`, PR 9): every command has a tier and a group, the default help
// shows only the everyday commands and one "N more" line, --all groups match the list, an old name runs its new form
// with a one-line notice on stderr, and the top-level everyday commands exist. Throwaway state; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const K = require('../lib/commands.js');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-surface-')));
/** @type {NodeJS.ProcessEnv} */
const BASE = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', STEWARD_NO_REFRESH: '1', XDG_STATE_HOME: path.join(ROOT, 'state'), XDG_CONFIG_HOME: path.join(ROOT, 'xdg') };
delete BASE.STEWARD_CONFIG;
const steward = (args, env = {}) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), ...args],
  { encoding: 'utf8', env: { ...BASE, STEWARD_INSTANCE: path.join(REPO, 'examples'), ...env } });
const label = c => `steward${c.area ? ` ${c.area}` : ''}${c.name ? ` ${c.name}` : ''}`;
const EVERYDAY = ['steward', 'steward review', 'steward fix', 'steward upgrade', 'steward config sync', 'steward projects', 'steward rollback', 'steward doctor'];

test('commands: every command and built-in has a tier and a known group; an alias names a real command', () => {
  const all = [...K.COMMANDS, ...K.BUILTINS];
  for (const c of all) {
    assert.ok(['everyday', 'advanced', 'internal'].includes(c.tier), `${label(c)}: tier ${c.tier}`);
    assert.ok(c.group in K.GROUPS, `${label(c)}: group ${c.group}`);
  }
  for (const c of K.COMMANDS.filter(x => x.aliasOf)) {
    const to = K.find(c.aliasOf.split(' '));
    assert.ok(to && !to.cmd.aliasOf, `${label(c)} → ${c.aliasOf}: not a command`);
  }
  assert.deepEqual(K.everyday().map(label), EVERYDAY, 'the everyday set, in this order');
  for (const c of K.everyday()) assert.ok(c.when, `${label(c)}: an everyday command says when to use it`);
});

test('help: the default shows the everyday commands only, then one "N more" line', () => {
  const r = steward(['help']);
  assert.equal(r.status, 0, r.stderr);
  for (const l of EVERYDAY) assert.match(r.stdout, new RegExp(`^  ${l}( |$)`, 'm'), l);
  assert.doesNotMatch(r.stdout, /steward sc audit|steward ai drift|steward skills path/, 'no advanced or internal commands');
  const more = K.listed({}).filter(c => c.tier !== 'everyday').length;
  assert.ok(more > 10);
  assert.match(r.stdout, new RegExp(`^${more} more for specific jobs: steward help --all`, 'm'));
  for (const l of r.stdout.split('\n')) assert.ok(l.length <= 110, `fits a terminal: ${l}`);
});

test('help --all: grouped as lib/commands.js says, read-only or writes on each line, aliases at the end, internal hidden', () => {
  const out = steward(['help', '--all']).stdout;
  const heads = Object.values(K.GROUPS).map(g => out.indexOf(`\n${g}`));
  for (const [i, g] of Object.values(K.GROUPS).entries()) assert.ok(heads[i] >= 0, `heading ${g}`);
  assert.deepEqual([...heads].sort((a, b) => a - b), heads, 'groups in the order GROUPS gives');
  const groupAt = at => Object.keys(K.GROUPS)[heads.filter(h => h <= at).length - 1];
  for (const c of K.listed({})) {
    const at = out.search(new RegExp(`\\n  ${label(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( .*)?  (read-only|writes)\\n`));
    assert.ok(at >= 0, `${label(c)} with its mark`);
    assert.equal(groupAt(at), c.group, `${label(c)} under ${K.GROUPS[c.group]}`);
  }
  const old = out.indexOf('\nOld names that still work');
  assert.ok(old > Math.max(...heads), 'aliases at the end');
  assert.match(out.slice(old), /steward sc status → steward sc plan/);
  assert.doesNotMatch(out, /steward skills path/);
  assert.match(steward(['help', '--all', '--internal']).stdout, /\n {2}steward skills path {2}read-only\n/);
});

test('help <command>: usage, what it writes, its way back, its old names; area help uses the same layout', () => {
  const up = steward(['help', 'upgrade']).stdout;
  assert.match(up, /^steward upgrade/m);
  assert.match(up, /writes: shows its plan and asks first \(class upgrade\)/);
  assert.match(up, /way back: steward rollback/);
  const plan = steward(['help', 'sc', 'plan']).stdout;
  assert.match(plan, /read-only/);
  assert.match(plan, /old name: steward sc status/);
  const area = steward(['help', 'sc']).stdout;
  assert.match(area, /\nSupply chain/);
  assert.match(area, /\n {2}steward upgrade .*writes\n/, 'the area lists its top-level commands too');
  assert.doesNotMatch(area, /\nAI tooling/);
  assert.equal(steward(['help', 'nosuch']).status, 2);
});

test('alias: sc status runs sc plan with a one-line notice on stderr, never on stdout', () => {
  assert.equal(K.find(['sc', 'status']).cmd, K.find(['sc', 'plan']).cmd);
  // a config in a newer format: both stop at the format check, before any script runs (no network)
  const newer = path.join(ROOT, 'newer');
  fs.mkdirSync(newer);
  fs.writeFileSync(path.join(newer, 'steward.toml'), 'schema = 9\n');
  const env = { STEWARD_INSTANCE: newer };
  const a = steward(['sc', 'status'], env);
  const b = steward(['sc', 'plan'], env);
  assert.match(a.stderr, /^steward: "steward sc status" is now "steward sc plan"; the old name keeps working\.$/m);
  assert.doesNotMatch(a.stdout, /is now/);
  assert.doesNotMatch(b.stderr, /is now/);
  assert.equal(a.status, 1, a.stderr);
  assert.equal(a.stderr.split('\n').slice(1).join('\n'), b.stderr, 'then the same run as the new name');
});

test('top level: projects, upgrade and rollback run their area commands; a wrong word is still a wrong word', () => {
  for (const [top, area] of [[['projects'], ['projects', 'scan']], [['upgrade'], ['sc', 'upgrade']], [['rollback'], ['sc', 'rollback']]]) {
    const t = K.find(top).cmd;
    const a = K.find(area).cmd;
    assert.deepEqual([t.cwd, t.run, t.writes, t.class, t.profile], [a.cwd, a.run, a.writes, a.class, a.profile], top.join(' '));
  }
  const wrong = steward(['projects', 'nosuch']);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /no command "projects nosuch"/);
  const off = path.join(ROOT, 'off');
  fs.mkdirSync(off);
  fs.writeFileSync(path.join(off, 'steward.toml'), '[profiles]\nprojects = false\n');
  assert.equal(steward(['projects'], { STEWARD_INSTANCE: off }).status, 3, 'the add-on gate holds for the top-level form');
});

test('doctor: the version, the config format and the add-ons, then the prerequisites; --json stays pure JSON', () => {
  const r = steward(['doctor', '--area', 'core']);
  assert.match(r.stdout, /^workstation-steward (dev|release) /m);
  assert.match(r.stdout, /^ok {5}config format 1: current/m);
  assert.match(r.stdout, /^ok {5}add-ons: /m);
  const j = steward(['doctor', '--area', 'core', '--json']);
  assert.doesNotThrow(() => JSON.parse(j.stdout), j.stdout.slice(0, 200));
});

test('doctor: still runs on a bare machine (no yq to read the config): it says so, then the prerequisites', () => {
  // doctor.js runs on plain Node so it can name what is missing; its header must not need yq either
  const r = steward(['doctor', '--area', 'core'], { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` });
  assert.notEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /ENOENT/);
  assert.match(r.stdout, /yq/, "doctor's table names yq");
});
