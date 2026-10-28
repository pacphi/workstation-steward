// End-to-end tests for `projects offboard` (lib/offboard.js plan, apply, undo) on throwaway Git repos and a plain
// folder. Backups and receipts go to a temporary XDG_STATE_HOME. The qualified installs are only read (for the names
// they ship).
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-offboard-')));
process.env.XDG_STATE_HOME = path.join(ROOT, 'state');
process.env.XDG_CONFIG_HOME = path.join(ROOT, 'xdg');
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, 'gitconfig');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
// The real AI tool installs where they exist; small stand-ins where they don't (CI). Before lib/ loads: test/fixtures.js
const FX = require('./fixtures.js').setup(ROOT);
const P = require('../lib/projects.js');
const B = require('../lib/offboard.js');
const F = require('../lib/profiles.js');

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const snapshot = dir => Object.fromEntries(F.listFiles(dir).filter(f => !f.startsWith('.git/')).map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));
const none = dir => ({ path: P.tilde(dir), decision: 'onboarded', ai: [] });
const plan = (dir, o = {}) => B.plan(dir, { entry: none(dir), skipRunning: true, ...o });
const json = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));

// Skipped only if the stand-ins themselves are incomplete
const NEEDS = FX.needs;
const itest = (name, fn) => test(name, { skip: NEEDS }, fn);
// a vendor agent category, command and skill name the qualified Ruflo install ships
const R = NEEDS ? [] : F.render(['ruflo'], ROOT).copies;
const first = to => fs.readdirSync(R.find(c => c.to === to).from).find(n => !n.startsWith('.'));
const [AGENT, COMMAND, SKILL] = NEEDS ? ['x', 'x', 'x'] : [first('.claude/agents'), first('.claude/commands'), first('.claude/skills')];
const HOOK = 'sh -c \'exec node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/hook-handler.cjs" pre-bash\'';

function project() {
  const dir = path.join(ROOT, 'proj');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  // the project's own files, tracked, in the same folders the tools copy into
  write(dir, 'README.md', '# p\n');
  write(dir, '.gitignore', '.claude/settings.json\n.claude/agents/*/\n!.claude/agents/mine/\n.mcp.json\n.codex/\n.claude-flow/\n');
  write(dir, '.claude/agents/mine/reviewer.md', '# mine\n');
  write(dir, `.claude/commands/${COMMAND}`.replace(/\.md$/, '') + '-own.md', '# mine\n');
  write(dir, 'CLAUDE.md', '# rules\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  // tool wiring and copies, untracked or ignored
  write(dir, '.claude/settings.json', JSON.stringify({
    env: { CLAUDE_FLOW_V3_ENABLED: 'true', MY_FLAG: '1' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK }, { type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: HOOK }] }] },
    statusLine: { type: 'command', command: 'node .claude/helpers/statusline.cjs' },
    permissions: { allow: ['Bash(npx claude-flow*)', 'mcp__claude-flow__:*', 'Bash(make test)'], deny: ['Read(./.env)'] },
    claudeFlow: { daemon: { autoStart: false } },
    enabledPlugins: { 'ruflo-swarm@ruflo': true, 'mine@elsewhere': true },
    extraKnownMarketplaces: { ruflo: { source: { source: 'directory', path: '/x' } } },
    includeCoAuthoredBy: false,
  }, null, 4) + '\n');
  write(dir, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['WebSearch'] }, enabledMcpjsonServers: ['ruflo', 'mine'] }, null, 2) + '\n');
  write(dir, '.mcp.json', JSON.stringify({ mcpServers: { ruflo: { command: 'npx', args: ['ruflo@latest'] }, mine: { command: 'my-server' } } }, null, 2) + '\n');
  write(dir, '.codex/config.toml', '# my Codex settings\nmodel = "gpt-x"\n\n[mcp_servers.ruflo]\ncommand = "ruflo"\n\n[mcp_servers.ruflo.tools.memory_store]\napproval_mode = "approve"\n\n[plugins."ruflo-core@ruflo"]\nenabled = true\n\n[shell_environment_policy.set]\nCLAUDE_FLOW_V3_ENABLED = "true"\n');
  write(dir, `.claude/agents/${AGENT}/a.md`, 'vendor\n');
  write(dir, `.claude/commands/${COMMAND}`, 'vendor\n');
  write(dir, `.claude/skills/${SKILL}/SKILL.md`, '---\nname: x\n---\n');
  write(dir, '.claude/skills/my-own/SKILL.md', '---\nname: my-own\nauthor: me\n---\n');
  write(dir, '.agents/skills/source-command-sparc-ask/SKILL.md', '---\nname: a\n---\n');
  write(dir, '.agents/skills/ruv-thing/SKILL.md', '---\nname: ruv-thing\nauthor: rUv\n---\n');
  write(dir, '.claude/helpers/hook-handler.cjs', '// vendor\n');
  write(dir, '.claude/helpers/.LOCKED', 'locked\n');
  write(dir, '.claude/proven-config.json', '{}\n');
  write(dir, '.claude-flow/memory-package.json', '{}\n');
  write(dir, '.swarm/memory.db', 'db');
  write(dir, 'docs/notes/.agentic-qe/memory.db', 'db');
  write(dir, 'node_modules/pkg/.agentic-qe/keep', 'not ours to move');
  write(dir, 'ruvector.db', 'db');
  write(dir, '.mcp.json.bak', '{}\n');
  write(dir, 'stray.json', '{}\n');
  return dir;
}

itest('offboard: stops for a project with AI tools chosen', () => {
  const dir = path.join(ROOT, 'chosen');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  const p = B.plan(dir, { entry: { path: P.tilde(dir), decision: 'onboarded', ai: ['aqe'] }, skipRunning: true });
  assert.match(p.stop, /AI tools are chosen/);
  assert.throws(() => B.apply(p), /AI tools are chosen/);
});

itest('offboard: plans, applies, keeps every tracked and own file, then rolls back exactly', () => {
  const dir = project();
  const before = snapshot(dir);
  const status = git(dir, 'status', '--porcelain');
  const p = plan(dir, { also: ['stray.json', 'README.md'] });
  assert.equal(p.stop, undefined);
  const moved = p.moves.map(m => m.path);
  for (const m of [`.claude/agents/${AGENT}`, `.claude/commands/${COMMAND}`, `.claude/skills/${SKILL}`, '.agents/skills/source-command-sparc-ask',
    '.agents/skills/ruv-thing', '.claude/helpers', '.claude/proven-config.json', '.claude-flow', '.swarm', 'docs/notes/.agentic-qe', 'ruvector.db', '.mcp.json.bak', 'stray.json']) {
    assert.ok(moved.includes(m), `${m} should move: ${JSON.stringify(moved)}`);
  }
  for (const m of ['.claude/agents/mine', 'README.md', '.claude/skills/my-own', 'node_modules/pkg/.agentic-qe']) assert.ok(!moved.some(x => x === m || m.startsWith(x + '/')), `${m} must stay`);
  assert.ok(p.left.some(l => l.startsWith('README.md (--also): tracked')));
  assert.ok(p.left.some(l => l.startsWith('.claude/skills/my-own:')));
  assert.equal(p.configs.find(c => c.path === '.mcp.json').action, 'edit');

  const rp = B.apply(p);
  const rc = JSON.parse(fs.readFileSync(rp, 'utf8'));
  assert.equal(rc.complete, true);
  // tracked files untouched, and git status lost only the untracked paths that moved
  assert.equal(git(dir, 'diff', '--stat'), '');
  for (const f of ['.claude/agents/mine/reviewer.md', 'CLAUDE.md', 'README.md', 'node_modules/pkg/.agentic-qe/keep', '.claude/skills/my-own/SKILL.md']) assert.ok(has(dir, f), f);
  for (const m of moved) assert.ok(!has(dir, m), `${m} still there`);
  assert.ok(!git(dir, 'status', '--porcelain').includes('stray.json'));
  // what's left in each config is the project's own
  const s = json(dir, '.claude/settings.json');
  assert.deepEqual(s.env, { MY_FLAG: '1' });
  assert.deepEqual(s.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] });
  assert.deepEqual(s.permissions, { allow: ['Bash(make test)'], deny: ['Read(./.env)'] });
  assert.deepEqual(s.enabledPlugins, { 'mine@elsewhere': true });
  assert.equal(s.includeCoAuthoredBy, false);
  for (const k of ['statusLine', 'claudeFlow', 'extraKnownMarketplaces']) assert.ok(!(k in s), k);
  assert.match(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'), /^\{\n {4}"/); // its own indent
  assert.deepEqual(json(dir, '.claude/settings.local.json'), { permissions: { allow: ['WebSearch'] }, enabledMcpjsonServers: ['mine'] });
  assert.deepEqual(json(dir, '.mcp.json'), { mcpServers: { mine: { command: 'my-server' } } });
  const codex = fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8');
  assert.match(codex, /^# my Codex settings\nmodel = "gpt-x"\n/);
  assert.ok(!/ruflo|shell_environment_policy/.test(codex), codex);
  // a second plan has nothing left to do
  const again = plan(dir);
  assert.deepEqual([again.configs.length, again.moves.length], [0, 0], JSON.stringify(again.configs.map(c => c.changes)));

  assert.deepEqual(B.changedSince(rc), []);
  B.undo(rc);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(git(dir, 'status', '--porcelain'), status);
});

itest('offboard: a file emptied of tool entries moves whole; a change after the plan stops apply and undoes the rest', () => {
  const dir = path.join(ROOT, 'plain');
  fs.mkdirSync(dir);
  write(dir, '.mcp.json', JSON.stringify({ mcpServers: { 'agentic-qe': { command: 'aqe-mcp' } } }) + '\n');
  write(dir, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK }] }] } }) + '\n');
  write(dir, 'sub/.agentic-qe/witness-keys/k.pem', 'key');
  write(dir, '.swarm/x', 'x');
  const before = snapshot(dir);
  const p = plan(dir);
  assert.equal(p.kind, 'dir');
  assert.deepEqual(p.configs.map(c => [c.path, c.action]), [['.claude/settings.json', 'archive'], ['.mcp.json', 'archive']]);
  assert.deepEqual(p.moves.map(m => m.path).sort(), ['.swarm', 'sub/.agentic-qe']);
  assert.deepEqual(p.rmdirs, ['.claude']);
  write(dir, '.swarm/x', 'changed after the plan');
  assert.throws(() => B.apply(p), /\.swarm changed since the plan/);
  const after = snapshot(dir);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  const rp = B.apply(plan(dir));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['sub']);
  const rc = JSON.parse(fs.readFileSync(rp, 'utf8'));
  const key = rc.entries.find(e => e.path === 'sub/.agentic-qe');
  assert.equal(fs.statSync(path.dirname(P.untilde(key.to))).mode & 0o777, 0o700);
  // the rollback refuses once a moved path exists again
  write(dir, '.swarm/new', 'n');
  assert.deepEqual(B.changedSince(rc), ['.swarm (exists again)']);
});

itest('offboard: refuses while Claude Code, Codex or Node runs in the project', async () => {
  const dir = path.join(ROOT, 'busy');
  fs.mkdirSync(dir);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: dir, stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 300));
    const p = B.plan(dir, { entry: none(dir) });
    assert.match(p.stop || '', /running here: node/);
  } finally { child.kill(); }
});
