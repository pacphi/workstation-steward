// End-to-end tests for `projects onboard --apply` (lib/onboard.js apply, undo) on throwaway Git repos of three
// stacks. Backups and receipts go to a temporary XDG_STATE_HOME. The qualified installs are only read.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-onboard-')));
process.env.XDG_STATE_HOME = path.join(ROOT, 'state');
// Git in these throwaway repos must not see the user's own config or ignore file (the D28 guard ignores .mcp.json
// and .claude-flow/ machine-wide, which would change what the plans create and exclude).
process.env.XDG_CONFIG_HOME = path.join(ROOT, 'xdg');
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, 'gitconfig');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
// The real AI tool installs where they exist; small stand-ins where they don't (CI). Before lib/ loads: test/fixtures.js
const FX = require('./fixtures.js').setup(ROOT);
const P = require('../lib/projects.js');
const O = require('../lib/onboard.js');
const F = require('../lib/profiles.js');
const TOOLS = ['ruflo', 'aqe', 'brain'];
// Skipped only if the stand-ins themselves are incomplete
const NEEDS = FX.needs;
const itest = (name, fn) => test(name, { skip: NEEDS }, fn);

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
function repo(name, files, commit) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  git(dir, 'add', ...commit);
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
// snapshot(dir) — every file under dir (with .git/info/exclude) and its hash, for "back exactly as it was"
function snapshot(dir) {
  const out = {};
  for (const f of F.listFiles(dir).filter(f => !f.startsWith('.git/') || f === '.git/info/exclude')) out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  return out;
}
const entry = dir => ({ path: P.tilde(dir), decision: 'onboarded', ai: TOOLS });
const plan = dir => O.plan(dir, { entry: entry(dir) });
const apply = (dir, p) => O.apply(p || plan(dir), { skipTransportCheck: true });
const pending = p => p.files.filter(f => f.action === 'edit' || f.action === 'create').map(f => f.path);
const json = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

const OLD_AQE_ROUTE = `env AQE_HOOK_BUNDLE='/old/v1.cjs' node "\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" route --json`;
const CODEX = '# the project\'s own Codex settings\nmodel = "gpt-x"\n\n[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"  # theirs\n\n[mcp_servers.agentic-qe.env]\nAQE_PROJECT_ROOT = "/somewhere"\n';

const node = repo('node-mono', {
  'package.json': '{"name":"mono","private":true,"workspaces":["packages/*"]}\n',
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'packages/a/package.json': '{"name":"a"}\n',
}, ['.']);
// untracked, not ignored: the project's own settings with an older AQE hook form, and a commented Codex config
write(node, '.claude/settings.json', JSON.stringify({ model: 'mine', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: OLD_AQE_ROUTE }] }] } }, null, 4) + '\n');
write(node, '.codex/config.toml', CODEX);

const maven = repo('maven', { 'pom.xml': '<project/>\n', '.gitignore': '.claude/\n.claude-flow/\n.mcp.json\n.codex/\n' }, ['.']);

const rust = repo('rust-ws', {
  'Cargo.toml': '[workspace]\nmembers = ["a"]\n',
  'a/Cargo.toml': '[package]\nname = "a"\n',
  '.gitignore': '.claude/skills/*\n!.claude/skills/own-skill/\n',
  '.claude/skills/own-skill/SKILL.md': '# mine\n',
}, ['.']);

itest('node monorepo: creates with excludes, keeps its own values, never doubles a hook', () => {
  const before = snapshot(node);
  const p = plan(node);
  assert.deepEqual(O.refusals(p, { skipTransportCheck: true }), []);
  assert.ok(p.exclude.includes('/.mcp.json') && p.exclude.includes('/.claude-flow/memory-package.json'), JSON.stringify(p.exclude));
  // .claude/ is already listed as untracked (its settings.json), so files created inside it get no entry
  assert.ok(!p.exclude.some(e => e.startsWith('/.claude/')), JSON.stringify(p.exclude));
  assert.ok(p.notes.some(n => /lands in \.claude\/, which `git status` already lists/.test(n)));
  const ignoredHere = (() => { try { git(node, 'check-ignore', '-q', '--no-index', '.claude/settings.local.json'); return true; } catch { return false; } })();
  assert.equal(p.files.find(f => f.path === '.claude/settings.local.json').state, ignoredHere ? 'absent-ignored' : 'absent');
  const rp = apply(node, p);
  const rc = JSON.parse(fs.readFileSync(rp, 'utf8'));
  assert.equal(rc.complete, true);
  assert.deepEqual(pending(plan(node)), [], 'a second plan has nothing left');
  const s = json(node, '.claude/settings.json');
  assert.equal(s.model, 'mine');
  assert.deepEqual(Object.keys(s).slice(0, 2), ['model', 'hooks'], 'existing keys keep their order');
  assert.ok(fs.readFileSync(path.join(node, '.claude/settings.json'), 'utf8').startsWith('{\n    "model"'), 'indent kept');
  const routes = s.hooks.UserPromptSubmit.flatMap(g => g.hooks).filter(h => /aqe-hook\.cjs"? route/.test(h.command));
  assert.equal(routes.length, 1, 'the older AQE route hook is kept, not doubled');
  assert.equal(json(node, '.claude/settings.local.json').env.AQE_HOOK_BUNDLE, P.untilde(F.POLICY.aqe.hook_transport));
  const codex = fs.readFileSync(path.join(node, '.codex/config.toml'), 'utf8');
  assert.ok(codex.startsWith(CODEX.trimEnd().split('\n').slice(0, 5).join('\n')), 'the Codex file keeps its own lines first');
  assert.match(codex, /command = "aqe-mcp" {2}# theirs/);
  assert.match(codex, /AQE_PROJECT_ROOT = "\/somewhere"\nAQE_MEMORY_PATH = /);
  assert.equal(P.toml(path.join(node, '.codex/config.toml')).mcp_servers['agentic-qe'].env.AQE_SESSION_CACHE, 'off');
  const status = git(node, 'status', '--porcelain');
  assert.doesNotMatch(status, /\.mcp\.json|settings\.local|\.claude-flow|\?\? \.claude\/skills/, 'created files stay out of git status');
  assert.deepEqual(O.changedSince(rc), []);
  O.undo(rc);
  assert.deepEqual(snapshot(node), before, 'rollback leaves the project exactly as it was');
});

itest('node monorepo: an AQE hook runs through transport v2 to the shared runtime', () => {
  apply(node);
  const trace = path.join(ROOT, 'trace.log');
  const r = spawnSync('node', [path.join(node, '.claude/hooks/aqe-hook.cjs'), 'route', '--json'], {
    cwd: node, encoding: 'utf8', input: '{}', timeout: 60000,
    env: { ...process.env, HOME: FX.home, CLAUDE_PROJECT_DIR: node, AQE_HOOK_BUNDLE: path.join(P.REPO_ROOT, 'ai-tooling/transports/aqe-hook-bundle.cjs'), AQE_HOOK_SHIM_TRACE: trace },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(trace, 'utf8'), new RegExp(`bundle-v2 project=${node} args=hooks route`));
});

itest('maven: the repo already ignores the AI files, so no exclude entries', () => {
  const p = plan(maven);
  assert.deepEqual(p.exclude.filter(e => /^\/\.(claude|mcp|codex|claude-flow)/.test(e)), []);
  const rc = JSON.parse(fs.readFileSync(apply(maven, p), 'utf8'));
  assert.equal(rc.exclude, null);
  assert.equal(git(maven, 'status', '--porcelain'), '');
  assert.deepEqual(pending(plan(maven)), []);
});

itest('rust workspace: new names in a partly tracked folder are edits, its own skill untouched', () => {
  const p = plan(rust);
  const skills = p.files.filter(f => f.path === '.claude/skills');
  assert.ok(skills.every(f => f.state === 'tracked' && f.action === 'edit'), JSON.stringify(skills.map(f => [f.state, f.action])));
  apply(rust, p);
  assert.equal(fs.readFileSync(path.join(rust, '.claude/skills/own-skill/SKILL.md'), 'utf8'), '# mine\n');
  assert.doesNotMatch(git(rust, 'status', '--porcelain'), /skills/);
});

itest('a failure partway through is undone from the receipt', () => {
  const dir = repo('fails', { 'go.mod': 'module x\n' }, ['.']);
  write(dir, '.codex/config.toml', CODEX);
  const before = snapshot(dir);
  const p = plan(dir);
  fs.chmodSync(path.join(dir, '.codex'), 0o500); // the Codex config, written last among configs, can't be replaced
  try {
    assert.throws(() => apply(dir, p), /EACCES|permission/i);
  } finally { fs.chmodSync(path.join(dir, '.codex'), 0o755); }
  assert.deepEqual(snapshot(dir), before, 'everything applied before the failure is undone');
});

itest('a file that changed after the plan stops the apply', () => {
  const dir = repo('raced', { 'go.mod': 'module x\n' }, ['.']);
  write(dir, '.mcp.json', '{"mcpServers":{}}\n');
  const p = plan(dir);
  write(dir, '.mcp.json', '{"mcpServers":{"mine":{"command":"x"}}}\n');
  assert.throws(() => apply(dir, p), /changed since the plan/);
  assert.equal(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'), '{"mcpServers":{"mine":{"command":"x"}}}\n');
});

itest('rollback refuses when something it wrote has changed since', () => {
  const dir = repo('edited-after', { 'go.mod': 'module x\n' }, ['.']);
  const rc = JSON.parse(fs.readFileSync(apply(dir), 'utf8'));
  write(dir, '.mcp.json', '{}\n');
  assert.deepEqual(O.changedSince(rc), ['.mcp.json']);
});

itest('a folder holding only ignored files is not listed, so a file created in it gets an entry', () => {
  const dir = repo('only-ignored', { 'go.mod': 'module x\n', '.gitignore': '.claude/settings.local.json\n' }, ['.']);
  write(dir, '.claude/settings.local.json', '{}\n');
  const p = plan(dir);
  assert.ok(p.exclude.includes('/.claude/settings.json'), JSON.stringify(p.exclude));
  apply(dir, p);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'git status stays empty');
});

itest('a folder outside Git gets no exclude entries', () => {
  const dir = path.join(ROOT, 'not-git');
  fs.mkdirSync(dir);
  write(dir, 'go.mod', 'module x\n');
  const p = plan(dir);
  assert.deepEqual(p.exclude, []);
  const rc = JSON.parse(fs.readFileSync(apply(dir, p), 'utf8'));
  assert.equal(rc.complete, true);
  assert.equal(rc.exclude, null);
});

itest('--replace-older swaps transport v1 inline hooks for the profile\'s, and rollback puts them back', () => {
  const dir = repo('v1-inline', { 'go.mod': 'module x\n', '.gitignore': '.claude/\n' }, ['.']);
  const v1 = sub => `env AQE_HOOK_BUNDLE='/x/transports/v1/aqe-shared-cli.cjs' node "\${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" ${sub} --json`;
  write(dir, '.claude/settings.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: v1('route'), timeout: 5 }] }], PreToolUse: [{ matcher: '^Task$', hooks: [{ type: 'command', command: v1('pre-task'), timeout: 5 }] }] } }, null, 2) + '\n');
  const before = snapshot(dir);
  const kept = O.plan(dir, { entry: entry(dir) });
  assert.ok(kept.files.find(f => f.path === '.claude/settings.json').kept.every(k => k.includes('--replace-older')));
  const p = O.plan(dir, { entry: entry(dir), replaceOlder: true });
  const rc = JSON.parse(fs.readFileSync(apply(dir, p), 'utf8'));
  const text = fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8');
  assert.doesNotMatch(text, /transports\/v1|"\^Task\$"/);
  const s = json(dir, '.claude/settings.json');
  assert.equal(s.hooks.UserPromptSubmit.flatMap(g => g.hooks).filter(h => /aqe-hook\.cjs"? route/.test(h.command)).length, 1);
  assert.deepEqual(pending(O.plan(dir, { entry: entry(dir), replaceOlder: true })), []);
  O.undo(rc);
  assert.deepEqual(snapshot(dir), before);
});

itest('--fix-keep-off sets the keep-off values in settings.json and nothing else; rollback restores them', () => {
  const dir = repo('keepoff', { 'go.mod': 'module x\n', '.gitignore': '.claude/\n' }, ['.']);
  const own = { model: 'mine', claudeFlow: { daemon: { autoStart: true, port: 7 }, agentTeams: { coordination: { autoAssignOnIdle: true, other: 1 } } } };
  write(dir, '.claude/settings.json', JSON.stringify(own, null, 2) + '\n');
  const reported = O.plan(dir, { entry: entry(dir) });
  assert.deepEqual(reported.keepoff.map(k => k.key).sort(), ['claudeFlow.agentTeams.coordination.autoAssignOnIdle', 'claudeFlow.daemon.autoStart']);
  const before = snapshot(dir);
  const p = O.plan(dir, { entry: entry(dir), fixKeepOff: true });
  assert.deepEqual(p.keepoff, [], 'nothing left to report once the plan fixes them');
  assert.equal(p.files.find(f => f.path === '.claude/settings.json').changes.filter(c => c.startsWith('~ claudeFlow')).length, 2);
  const rc = JSON.parse(fs.readFileSync(apply(dir, p), 'utf8'));
  const s = json(dir, '.claude/settings.json');
  assert.equal(s.claudeFlow.daemon.autoStart, false);
  assert.equal(s.claudeFlow.agentTeams.coordination.autoAssignOnIdle, false);
  assert.equal(s.model, 'mine');
  assert.equal(s.claudeFlow.daemon.port, 7);
  assert.equal(s.claudeFlow.agentTeams.coordination.other, 1);
  assert.deepEqual(O.plan(dir, { entry: entry(dir), fixKeepOff: true }).keepoff, []);
  O.undo(rc);
  assert.deepEqual(snapshot(dir), before);
});

itest('--remove-unpinned removes only keep-off launchers that fetch an unpinned version, from .mcp.json and Codex', () => {
  const dir = repo('unpinned', { 'go.mod': 'module x\n', '.gitignore': '.mcp.json\n.codex/\n.claude/\n' }, ['.']);
  write(dir, '.mcp.json', JSON.stringify({ mcpServers: {
    ruflo: { command: 'npx', args: ['-y', 'ruflo@latest', 'mcp', 'start'] },
    'flow-nexus': { command: 'npx', args: ['-y', 'flow-nexus@latest', 'mcp', 'start'] },
    'ruv-swarm': { command: 'npx', args: ['-y', 'ruv-swarm', 'mcp', 'start'] }, // no version: as unpinned as @latest
    mine: { command: 'npx', args: ['-y', 'my-tool@latest'] },
  } }, null, 2) + '\n');
  write(dir, '.codex/config.toml', 'model = "x"\n\n[mcp_servers.flow-nexus]\ncommand = "npx"\nargs = ["-y", "flow-nexus@latest", "mcp", "start"]\n\n[mcp_servers.flow-nexus.tools.sandbox_create]\napproval_mode = "approve"\n\n[mcp_servers.ruv-swarm]\ncommand = "npx"\nargs = ["ruv-swarm", "mcp", "start"]\n');
  const before = snapshot(dir);
  const p = O.plan(dir, { entry: entry(dir), removeUnpinned: true });
  assert.equal(p.files.find(f => f.path === '.mcp.json').changes.filter(c => c.startsWith('- ')).length, 3);
  const rc = JSON.parse(fs.readFileSync(apply(dir, p), 'utf8'));
  const m = json(dir, '.mcp.json').mcpServers;
  assert.equal(m.ruflo, undefined);
  assert.equal(m['flow-nexus'], undefined);
  assert.equal(m['ruv-swarm'], undefined);
  assert.ok(m.mine, 'a launcher not on the keep-off list stays, @latest or not');
  const cx = P.toml(path.join(dir, '.codex/config.toml'));
  assert.equal(cx.mcp_servers['flow-nexus'], undefined);
  assert.equal(cx.mcp_servers['ruv-swarm'], undefined);
  assert.equal(cx.model, 'x');
  assert.deepEqual(pending(O.plan(dir, { entry: entry(dir), removeUnpinned: true })).filter(f => f === '.mcp.json' || f === '.codex/config.toml'), []);
  O.undo(rc);
  assert.deepEqual(snapshot(dir), before);
});

itest('two applies to one project in the same second each keep their own receipt', () => {
  const dir = repo('same-second', { 'go.mod': 'module x\n' }, ['.']);
  const r1 = apply(dir);
  O.undo(JSON.parse(fs.readFileSync(r1, 'utf8')));
  const r2 = apply(dir);
  assert.notEqual(path.dirname(r1), path.dirname(r2));
  assert.equal(JSON.parse(fs.readFileSync(r1, 'utf8')).complete, true, 'the first receipt is intact');
  assert.equal(JSON.parse(fs.readFileSync(r2, 'utf8')).complete, true);
  // which release and profile revisions wrote it, for `projects reconcile` (D40)
  const r = JSON.parse(fs.readFileSync(r2, 'utf8'));
  assert.equal(r.engine, require('../package.json').version);
  assert.deepEqual(Object.keys(r.profiles).sort(), [...TOOLS].sort());
  for (const h of Object.values(r.profiles)) assert.match(h, /^[0-9a-f]{64}$/);
});

itest('newBackupDir never hands out a folder twice', () => {
  const C = require('../lib/config.js');
  const a = C.newBackupDir('clash'), b = C.newBackupDir('clash'), c = C.newBackupDir('clash');
  assert.equal(new Set([a, b, c]).size, 3);
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
