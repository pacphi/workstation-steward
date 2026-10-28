// ai-tooling/bin/approvals.js on throwaway repos, and the Brain profile's rendering. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-approvals-')));
const PROJECTS = path.join(ROOT, 'projects');
fs.mkdirSync(PROJECTS);
fs.writeFileSync(path.join(ROOT, 'steward.toml'), `[projects]\nroots = ["${PROJECTS}"]\nexclude = []\n[paths]\nstate = "${path.join(ROOT, 'state')}"\n`);
const ENV = { ...process.env, XDG_CONFIG_HOME: path.join(ROOT, 'xdg'), STEWARD_CONFIG: path.join(ROOT, 'steward.toml'), GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'), NO_PROGRESS: '1' };
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '');
const BIN = path.join(__dirname, '..', 'ai-tooling', 'bin', 'approvals.js');
const run = (args, input = '') => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: ENV, input });
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

const CFG = (mode, cmd = 'node') => `# this project's Codex config
[mcp_servers.agentic-qe]
command = "aqe-mcp"
args = []

[mcp_servers.ruvnet-brain]
command = "${cmd}"
args = ["/Users/x/.cache/ruvnet-brain/codex-marketplace/plugin/mcp/server.mjs"]
enabled = true

[mcp_servers.ruvnet-brain.tools.ruvnet_cli_run]
approval_mode = "${mode}"

[mcp_servers.ruvnet-brain.tools.search_ruvnet]
approval_mode = "approve"
`;
function project(name, text, { track = false } = {}) {
  const dir = path.join(PROJECTS, name);
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@e.com'); git(dir, 'config', 'user.name', 't');
  const f = path.join(dir, '.codex', 'config.toml');
  fs.writeFileSync(f, text);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
  if (track) { git(dir, 'add', '.codex/config.toml'); git(dir, 'commit', '-qm', 'x'); }
  return f;
}
const reset = () => { for (const d of fs.readdirSync(PROJECTS)) fs.rmSync(path.join(PROJECTS, d), { recursive: true, force: true }); };

test('plan: finds the auto-approved tool and the bare node, skips tracked files, compliant ones and missing tables; writes nothing', () => {
  reset();
  const a = project('a', CFG('approve'));
  project('tracked', CFG('approve'), { track: true });
  project('ok', CFG('prompt', '/Users/x/.local/share/mise/installs/node/26/bin/node'));
  project('none', '[mcp_servers.agentic-qe]\ncommand = "aqe-mcp"\n');
  const before = fs.readFileSync(a, 'utf8');
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  const out = strip(r.stdout);
  assert.match(out, /apply .*\/a\/\.codex\/config\.toml +ruvnet-brain ruvnet_cli_run: approve → prompt; ruvnet-brain: command node/);
  assert.match(out, /SKIP .*tracked\/.*tracked by Git/);
  assert.doesNotMatch(out, /\/ok\/\.codex|\/none\/\.codex/);
  assert.equal(fs.readFileSync(a, 'utf8'), before);
});

test('apply: "n" changes nothing; "y" changes exactly the two lines, backs up, writes a receipt, and rolls back', () => {
  reset();
  const f = project('a', CFG('approve'));
  const orig = fs.readFileSync(f, 'utf8');
  assert.equal(run(['--apply'], 'n\n').status, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), orig);

  const done = run(['--apply'], 'y\n');
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const now = fs.readFileSync(f, 'utf8');
  const a = orig.split('\n'), b = now.split('\n');
  assert.equal(a.length, b.length);
  const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
  assert.equal(diff.length, 2, JSON.stringify(diff));
  assert.deepEqual(diff.map(d => d[1].replace(/"\/.*\/installs/, '"…/installs')), ['command = "…/installs/node/26/bin/node"', 'approval_mode = "prompt"']);
  assert.match(now, /^# this project's Codex config/); // comments stay
  assert.match(now, /\[mcp_servers\.ruvnet-brain\.tools\.search_ruvnet\]\napproval_mode = "approve"/); // the read-only tool stays approved
  assert.match(strip(run([]).stdout), /already matches/);

  const bk = path.join(ROOT, 'state', 'backups');
  const dir = fs.readdirSync(bk).find(d => d.startsWith('approvals-'));
  const receipt = path.join(bk, dir, 'receipt.json');
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).kind, 'approvals');
  const back = run(['--rollback', receipt], 'y\n');
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(fs.readFileSync(f, 'utf8'), orig);
});

test('apply: a server that already prompts only gets its bare node replaced; a missing approval_mode line is added', () => {
  reset();
  const f = project('p', CFG('prompt'));
  const g = project('m', CFG('approve').replace('approval_mode = "approve"\n\n[mcp_servers.ruvnet-brain.tools.search', '\n[mcp_servers.ruvnet-brain.tools.search'));
  assert.doesNotMatch(fs.readFileSync(g, 'utf8'), /ruvnet_cli_run\]\napproval_mode/);
  assert.equal(run(['--apply'], 'y\n').status, 0);
  assert.match(fs.readFileSync(f, 'utf8'), /command = ".*\/node\/26\/bin\/node"/);
  assert.match(fs.readFileSync(f, 'utf8'), /ruvnet_cli_run\]\napproval_mode = "prompt"/);
  assert.match(fs.readFileSync(g, 'utf8'), /ruvnet_cli_run\]\napproval_mode = "prompt"/);
});

test('rollback refuses when a file changed since', () => {
  reset();
  const f = project('a', CFG('approve'));
  assert.equal(run(['--apply'], 'y\n').status, 0);
  fs.appendFileSync(f, '# edited later\n');
  const bk = path.join(ROOT, 'state', 'backups');
  const dirs = fs.readdirSync(bk).filter(d => d.startsWith('approvals-')).sort();
  const r = run(['--rollback', path.join(bk, dirs[dirs.length - 1], 'receipt.json')], 'y\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing/);
});

test('the Brain profile renders search_ruvnet as approve and ruvnet_cli_run as prompt (even with approvals off), with the stable node', () => {
  const F = require('../lib/profiles.js');
  const full = F.render(['brain'], '/tmp/p', {}).codex.mcp_servers['ruvnet-brain'];
  assert.equal(full.tools.search_ruvnet.approval_mode, 'approve');
  assert.equal(full.tools.ruvnet_cli_run.approval_mode, 'prompt');
  assert.match(full.command, /\/installs\/node\/26\/bin\/node$/);
  const off = F.render(['brain'], '/tmp/p', { approvals: false }).codex.mcp_servers['ruvnet-brain'];
  assert.deepEqual(off.tools, { ruvnet_cli_run: { approval_mode: 'prompt' } });
});
