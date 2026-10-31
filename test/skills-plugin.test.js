// lib/skills.js (D48): `steward skills path` builds the plugin folder Claude Code copies, holding only what the config
// turns on; `install` and `uninstall` plan, ask, back up and write a receipt around Claude Code's own command, refuse
// a tracked project file (D6), and leave accepting the plugin's command to a person in their own terminal. A stand-in
// `claude` records what it was asked to do. No network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-skills-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// a temp instance, state and Claude folder; a stand-in claude (and steward) on PATH
function setup(name, toml = '', version = '2.1.312', steward = 'ok') {
  const dir = path.join(ROOT, name);
  for (const d of ['inst', 'state', 'claude', 'bin']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'inst', 'steward.toml'), `schema = 1\n[paths]\nclaude_dir = "${path.join(dir, 'claude')}"\n${toml}`);
  fs.writeFileSync(path.join(dir, 'claude', 'settings.json'), '{ "theme": "dark" }\n');
  const log = path.join(dir, 'claude.log');
  const mark = path.join(dir, 'installed');
  fs.writeFileSync(path.join(dir, 'bin', 'claude'), `#!/bin/sh
case "$*" in
  --version) echo "${version} (Claude Code)"; exit 0 ;;
  "plugin list --json") if [ -f "${mark}" ]; then echo '[{"id":"steward@workstation-steward","scope":"user"}]'; else echo '[]'; fi; exit 0 ;;
  "plugin install"*) touch "${mark}" ;;
  "plugin uninstall"*) rm -f "${mark}" ;;
esac
echo "$(pwd) $*" >> "${log}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bin', 'steward'), steward === 'ok' ? `#!/bin/sh\necho "${dir}"\n` : '#!/bin/sh\necho "steward: no command skills path" >&2; exit 2\n', { mode: 0o755 });
  // not inside a Claude Code session and not a dry run, unless a test says so
  const outside = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && k !== 'DRY_RUN'));
  const env = { ...outside, STEWARD_INSTANCE: path.join(dir, 'inst'), XDG_STATE_HOME: path.join(dir, 'state'), PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, NO_COLOR: '1' };
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(REPO, 'lib', 'skills.js'), ...args], { encoding: 'utf8', input: '', env: { ...env, ...extra } });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const mdir = path.join(dir, 'state', 'workstation-steward', 'skills', 'marketplace');
  return { dir, run, calls, mdir };
}
const receipts = dir => {
  const b = path.join(dir, 'state', 'workstation-steward', 'backups');
  return fs.existsSync(b) ? fs.readdirSync(b).map(d => JSON.parse(fs.readFileSync(path.join(b, d, 'receipt.json'), 'utf8'))) : [];
};

test('skills path: one line, only the skills the config turns on, the same folder for the same content', () => {
  const off = setup('path-off');
  const r = off.run(['path']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1);
  const out = r.stdout.trim();
  assert.deepEqual(fs.readdirSync(path.join(out, 'skills')).sort(), ['fix', 'supply-chain']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'steward');
  assert.equal(off.run(['path']).stdout.trim(), out, 'same content, same folder');

  const on = setup('path-on', '[profiles]\nai_tooling = true\nprojects = true\n[skills]\npr_consolidation = true\n');
  const all = on.run(['path']).stdout.trim();
  assert.deepEqual(fs.readdirSync(path.join(all, 'skills')).sort(), ['ai-tooling', 'fix', 'pr-consolidation', 'projects', 'supply-chain']);
  assert.ok(fs.statSync(path.join(all, 'skills', 'pr-consolidation', 'scripts', 'lock-age.sh')).mode & 0o100, 'scripts stay executable');
});

test('skills path: older folders beyond the last two are removed', () => {
  const s = setup('path-prune');
  const root = path.join(s.dir, 'state', 'workstation-steward', 'skills');
  fs.mkdirSync(root, { recursive: true });
  ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'].forEach((d, i) => {
    fs.mkdirSync(path.join(root, d));
    fs.utimesSync(path.join(root, d), 1000 + i, 1000 + i);
  });
  const out = path.basename(s.run(['path']).stdout.trim());
  assert.deepEqual(fs.readdirSync(root).sort(), ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc', out].sort());
});

test('skills install: user scope runs claude, backs up its settings and writes a receipt; uninstall is the way back', () => {
  const s = setup('install-user');
  const r = s.run(['install', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /accepts: {2}the plugin's command `steward skills path`/);
  assert.ok(s.calls()[0].endsWith(` plugin install steward --marketplace ${s.mdir} --scope user --yes`), s.calls()[0]);
  const copied = JSON.parse(fs.readFileSync(path.join(s.mdir, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(copied.plugins[0].source.command, 'steward skills path', "the engine's own marketplace, not one fetched");
  const [rc] = receipts(s.dir);
  assert.equal(rc.kind, 'skills-install');
  assert.equal(rc.status, 0);
  assert.equal(fs.readFileSync(rc.saved[0].backup, 'utf8'), '{ "theme": "dark" }\n');
  assert.equal(s.run(['uninstall', '--yes']).status, 0);
  assert.match(s.calls()[1], / plugin uninstall steward@workstation-steward --scope user$/);
});

test('skills install --project: local scope, run in the project; a tracked settings.local.json is refused (D6)', () => {
  const s = setup('install-project');
  const proj = path.join(s.dir, 'proj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', proj]);
  const r = s.run(['install', '--project', proj, '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.calls()[0], `${fs.realpathSync(proj)} plugin install steward --marketplace ${s.mdir} --scope local --yes`);
  // a relative folder is read from where steward runs (STEWARD_CWD, as steward init passes it; D49)
  const rel = s.run(['install', '--project', 'proj', '--yes'], { STEWARD_CWD: s.dir });
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(s.calls()[1], s.calls()[0]);

  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), '{}\n');
  execFileSync('git', ['-C', proj, 'add', '-f', '.claude/settings.local.json']);
  const t = s.run(['install', '--project', proj, '--yes']);
  assert.equal(t.status, 1);
  assert.match(t.stderr, /tracked by Git; change it through a PR/);
  assert.equal(s.calls().length, 2, 'claude was not run again');
});

test('skills install: refused inside a Claude Code session, with an old Claude Code, or as a dry run; nothing runs', () => {
  const s = setup('install-refused');
  const inSession = s.run(['install', '--yes'], { CLAUDECODE: '1' });
  assert.equal(inSession.status, 3);
  assert.match(inSession.stderr, /only from your own terminal/);
  const dry = s.run(['install'], { DRY_RUN: '1' });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /DRY_RUN=1: nothing changed/);
  const old = setup('install-old', '', '2.1.200');
  const o = old.run(['install', '--yes']);
  assert.equal(o.status, 1);
  assert.match(o.stderr, /older than 2\.1\.292/);
  const stale = setup('install-stale-steward', '', '2.1.312', 'old');
  const st = stale.run(['install', '--yes']);
  assert.equal(st.status, 1);
  assert.match(st.stderr, /didn't print the plugin's folder .*no command skills path/);
  assert.deepEqual([...s.calls(), ...old.calls(), ...stale.calls()], []);
  assert.deepEqual(receipts(s.dir), []);
  assert.ok(!fs.existsSync(s.mdir), 'nothing written before the yes');
});

test("skills install: claude's exit code alone isn't success; the plugin must be listed", () => {
  const s = setup('install-unlisted');
  fs.writeFileSync(path.join(s.dir, 'bin', 'claude'), `#!/bin/sh\ncase "$*" in --version) echo "2.1.312 (Claude Code)";; "plugin list --json") echo '[]';; *) echo "not run: review the command first";; esac\nexit 0\n`, { mode: 0o755 });
  const r = s.run(['install', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /doesn't show steward@workstation-steward/);
  assert.equal(receipts(s.dir).length, 1, 'the receipt still records what ran');
});

test('init setup: each answer changes one line of the new steward.toml, and the skills follow it', async () => {
  const { walkSetup } = require('../lib/setup.js');
  const s = setup('walk');
  const file = path.join(s.dir, 'inst', 'steward.toml');
  fs.copyFileSync(path.join(REPO, 'examples', 'steward.toml'), file);
  const before = fs.readFileSync(file, 'utf8').split('\n');
  const answers = ['y', 'y', '~/code, ~/work', '1', 'y'];
  const asked = [];
  const out = await walkSetup(file, async q => { asked.push(q); return answers.shift(); }, () => {});
  assert.deepEqual(out, { set: ['profiles.ai_tooling = true', 'profiles.projects = true', 'projects.roots = ["~/code","~/work"]', 'skills.pr_consolidation = true'], install: { project: null } });
  assert.match(asked[2], /\[~\/Development\]: $/, 'the roots question shows the current value');
  const after = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(after.length, before.length);
  const changed = after.filter((l, i) => l !== before[i]);
  assert.deepEqual(changed.map(l => l.split('#')[0].trim()), ['roots = ["~/code", "~/work"]', 'ai_tooling = true', 'projects = true', 'pr_consolidation = true']);
  assert.ok(changed.every(l => l.includes('# ')), 'comments stay');
  const cfg = JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'lib', 'config.js'), '--json'], { encoding: 'utf8', env: { ...process.env, STEWARD_INSTANCE: path.join(s.dir, 'inst') } }));
  assert.deepEqual([cfg.profiles.ai_tooling, cfg.profiles.projects, cfg.skills.pr_consolidation], [true, true, true]);
  assert.deepEqual(fs.readdirSync(path.join(s.run(['path']).stdout.trim(), 'skills')).sort(), ['ai-tooling', 'fix', 'pr-consolidation', 'projects', 'supply-chain']);
});

test('init setup: no to the add-ons, Enter for the roots, one project, and not now each leave the file as it was', async () => {
  const { walkSetup } = require('../lib/setup.js');
  const file = path.join(ROOT, 'walk-defaults.toml');
  fs.copyFileSync(path.join(REPO, 'examples', 'steward.toml'), file);
  const ex = fs.readFileSync(file, 'utf8');
  const run = async answers => walkSetup(file, async () => answers.shift(), () => {});
  assert.deepEqual(await run(['', '', '']), { set: [], install: null });
  assert.deepEqual(await run(['n', 'n', '2', '/tmp/p', 'n']), { set: [], install: { project: '/tmp/p' } });
  assert.deepEqual(await run(['n', 'n', '2', '']), { set: [], install: null }, 'one project with no folder is not now');
  assert.equal(fs.readFileSync(file, 'utf8'), ex);
  const proj = await run(['n', 'y', '', '3']);
  assert.deepEqual(proj, { set: ['profiles.projects = true'], install: null }, 'Enter keeps the roots');
});

test('tomlSet: replaces a value in place, adds a missing key under its header, adds a missing table', () => {
  const W = require('../lib/write.js');
  assert.equal(W.tomlSet('[a]\nk = false   # note\n', 'a', 'k', true), '[a]\nk = true    # note\n');
  assert.equal(W.tomlSet('[a]\n# x\n[b]\nk = 1\n', 'a', 'k', true), '[a]\nk = true\n# x\n[b]\nk = 1\n', 'only [a]');
  assert.equal(W.tomlSet('schema = 1', 'skills', 'pr_consolidation', true), 'schema = 1\n\n[skills]\npr_consolidation = true\n');
});

test('skills: the marketplace lists the steward plugin by command; config and commands agree', () => {
  const S = require('../lib/skills.js');
  const mk = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(mk.name, S.MARKETPLACE);
  assert.deepEqual(mk.plugins.map(p => [p.name, p.source]), [[S.PLUGIN, { source: 'command', command: 'steward skills path' }]]);
  assert.ok(require('../package.json').files.includes('.claude-plugin/'), 'the manifest and the marketplace ship: install registers the installed copy');
  const { COMMANDS } = require('../lib/commands.js');
  assert.ok(!COMMANDS.find(c => c.area === 'skills' && c.name === 'path').writes, 'path is read-only');
  assert.match(fs.readFileSync(path.join(REPO, 'examples', 'steward.toml'), 'utf8'), /^\[skills\]\npr_consolidation = false/m);
});

// the plugin's manifest is generated (D48): the session-start hook, unless [brief] session = false leaves it out
const manifestOf = out => JSON.parse(fs.readFileSync(path.join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
const hooksOf = out => (manifestOf(out).hooks || {}).SessionStart || [];

test('skills path: the folder holds only the manifest and the skills; the hook is in it by default, read-only and short', () => {
  const s = setup('hook-default');
  const out = s.run(['path'], { STEWARD_CHANNEL: 'release' }).stdout.trim();
  assert.deepEqual(fs.readdirSync(out).sort(), ['.claude-plugin', 'skills']);
  assert.deepEqual(fs.readdirSync(path.join(out, '.claude-plugin')), ['plugin.json']);
  const [h, ...rest] = hooksOf(out);
  assert.deepEqual(rest, [], 'one SessionStart entry');
  assert.equal(h.matcher, 'startup|clear|compact');
  assert.ok(!/resume|fork/.test(h.matcher), 'a resumed session already has its context');
  assert.deepEqual(h.hooks, [{ type: 'command', command: 'command -v steward >/dev/null 2>&1 && steward brief --hook || true', timeout: 5 }]);
  assert.ok(h.hooks[0].timeout <= 10, 'seconds');
  assert.deepEqual(Object.keys(manifestOf(out).hooks), ['SessionStart'], 'no other hook');
  // what a release builds is the manifest the repo ships (so `claude --plugin-dir .` and an install agree)
  assert.equal(fs.readFileSync(path.join(out, '.claude-plugin', 'plugin.json'), 'utf8'), fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
});

test('skills path: [brief] session = false leaves the hook out, and the folder (its hash) changes with it', () => {
  const on = setup('hook-on').run(['path'], { STEWARD_CHANNEL: 'release' }).stdout.trim();
  const off = setup('hook-off', '[brief]\nsession = false\n').run(['path'], { STEWARD_CHANNEL: 'release' }).stdout.trim();
  assert.notEqual(path.basename(off), path.basename(on));
  const m = manifestOf(off);
  assert.equal(m.hooks, undefined);
  assert.equal(m.name, 'steward');
  assert.equal(m.license, 'MIT');
  assert.deepEqual(fs.readdirSync(path.join(off, 'skills')).sort(), ['fix', 'supply-chain'], 'the skills are the same');
});

test('skills path: a dev clone\'s build calls steward-dev (with --real, unless its examples are the instance)', () => {
  const s = setup('hook-dev');
  const dev = hooksOf(s.run(['path'], { STEWARD_CHANNEL: 'dev' }).stdout.trim())[0].hooks[0].command;
  assert.equal(dev, 'command -v steward-dev >/dev/null 2>&1 && steward-dev brief --hook --real || true');
  const ex = setup('hook-dev-examples').run(['path'], { STEWARD_CHANNEL: 'dev', STEWARD_INSTANCE: path.join(REPO, 'examples') });
  assert.equal(ex.status, 0, ex.stderr);
  assert.equal(hooksOf(ex.stdout.trim())[0].hooks[0].command, 'command -v steward-dev >/dev/null 2>&1 && steward-dev brief --hook || true');
});

test('skills install: the plan says the plugin carries a read-only session-start briefing, and how to turn it off', () => {
  const on = setup('hook-plan').run(['install'], { DRY_RUN: '1' });
  assert.match(on.stdout, /hook: {5}a read-only session-start briefing \(`steward brief --hook`\)/);
  assert.match(on.stdout, /`\[brief\] session = false` in steward\.toml turns it off/);
  const off = setup('hook-plan-off', '[brief]\nsession = false\n').run(['install'], { DRY_RUN: '1' });
  assert.match(off.stdout, /hook: {5}none \(`\[brief\] session = false` in steward\.toml\)/);
});
