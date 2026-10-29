// Shared by projects/bin/projects.js and ai-tooling/bin/drift.js: project discovery under [projects] roots (D4 in
// docs/architecture.md), the registry, and per-project AI tooling evidence. Read-only: nothing here writes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const C = require('./config.js');
const CFG = C.load().values.projects;

const HOME = os.homedir();
const REPO_ROOT = path.resolve(__dirname, '..');
const ROOTS = CFG.roots;
const REGISTRY = C.instance('projects/registry.toml');   // instance data (D39)

const tilde = p => (p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
const untilde = p => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

// Discovery rules (steward.toml [projects] over lib/config.js defaults): folder names never descended into,
// excluded paths, and the markers that make a non-Git folder a project.
const SKIP = new Set(CFG.skip_dirs);
const SKIP_PATHS = new Set(CFG.exclude);
const MARKERS = CFG.markers;

const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const readJSON = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const toml = p => {
  if (!exists(p)) return null;
  try { return JSON.parse(execFileSync('yq', ['-p', 'toml', '-o', 'json', '.', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
};

// gitKind DIR — 'git' (primary), 'worktree', 'submodule' or null
function gitKind(dir) {
  const g = path.join(dir, '.git');
  let st;
  try { st = fs.lstatSync(g); } catch { return null; }
  if (st.isDirectory()) return 'git';
  const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
  if (!m) return 'git';
  return /\/modules\//.test(m[1]) ? 'submodule' : 'worktree';
}

// worktreeMain DIR — the main checkout a linked worktree belongs to (from its .git file: <main>/.git/worktrees/<name>)
function worktreeMain(dir) {
  try {
    const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8'));
    const gitdir = path.resolve(dir, m[1].trim());
    const i = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    return i >= 0 ? gitdir.slice(0, i) : null;
  } catch { return null; }
}

// Markers match by exact name: macOS filesystems ignore case, so exists('CLAUDE.md') is true for claude.md.
function hasMarker(dir) {
  let names;
  try { names = new Set(fs.readdirSync(dir)); } catch { return false; }
  return MARKERS.some(m => names.has(m));
}

// discover() — every project under the configured roots: [{path, kind, parent}] (kind: git|worktree|submodule|nested-git|dir)
function discover(roots = ROOTS, maxDepth = CFG.max_depth) {
  const found = [];
  for (const root of roots) (function walk(dir, depth, parent) {
    if (depth > maxDepth || SKIP_PATHS.has(dir)) return;
    let kind = gitKind(dir);
    if (kind === 'git' && parent) kind = 'nested-git';
    if (!kind && !parent && depth > 0 && hasMarker(dir)) kind = 'dir';
    if (kind) found.push({ path: dir, kind, parent: kind === 'worktree' ? worktreeMain(dir) || (parent && parent.path) : parent ? parent.path : null });
    const here = kind ? found[found.length - 1] : parent;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1, here);
    }
  })(root, 0, null);
  return found;
}

// loadRegistry() — [{path (absolute), ...fields}] from projects/registry.toml, or []
function loadRegistry() {
  const d = toml(REGISTRY);
  return ((d && d.project) || []).map(p => ({ ...p, abs: untilde(p.path) }));
}

function remoteOf(dir) {
  try {
    const u = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return u.replace(/\/\/[^@/]+@/, '//'); // never keep credentials embedded in a URL
  } catch { return ''; }
}

// servers DIR — MCP servers declared for Claude (.mcp.json) and Codex (.codex/config.toml): [{host, name, cmd}]
function servers(dir) {
  const out = [];
  const mcp = readJSON(path.join(dir, '.mcp.json'));
  for (const [name, v] of Object.entries((mcp && mcp.mcpServers) || {})) {
    out.push({ host: 'claude', file: '.mcp.json', name, cmd: [v.command || '', ...(v.args || [])].join(' ') });
  }
  const codex = toml(path.join(dir, '.codex', 'config.toml'));
  for (const [name, v] of Object.entries((codex && codex.mcp_servers) || {})) {
    out.push({ host: 'codex', file: '.codex/config.toml', name, cmd: [v.command || '', ...(v.args || [])].join(' ') });
  }
  return out;
}

// unpinnedLauncher CMD FORBID — does an MCP launcher fetch an unpinned version (D30)? It does when it names a tag
// from [launchers] forbid (`@latest`), or runs a registry package through npx, bunx or pnpm dlx with no version at
// all, which fetches the newest release on every start just as `@latest` does. A scope's leading `@` isn't a version.
function unpinnedLauncher(cmd, forbid = []) {
  const s = String(cmd || '');
  if (forbid.some(x => s.includes(x))) return true;
  const w = s.trim().split(/\s+/);
  let i = w.findIndex(x => ['npx', 'bunx', 'pnpx'].includes(path.basename(x)));
  if (i >= 0) i += 1;
  else {
    const k = w.findIndex((x, n) => path.basename(x) === 'pnpm' && w[n + 1] === 'dlx');
    if (k < 0) return false;
    i = k + 2;
  }
  let pkg;
  for (; i < w.length; i++) {
    if (w[i] === '-p' || w[i] === '--package') { pkg = w[i + 1]; break; }
    if (w[i].startsWith('--package=')) { pkg = w[i].slice(10); break; }
    if (!w[i].startsWith('-')) { pkg = w[i]; break; }
  }
  if (!pkg || /^[./~]/.test(pkg)) return false; // nothing to run, or a file rather than a registry package
  return pkg.lastIndexOf('@') <= 0;
}

// inertSettingsServers SETTINGS — mcpServers blocks in .claude/settings*.json ({file: data}): Claude Code has no such
// settings key (it reads servers from .mcp.json and ~/.claude.json), so they launch nothing. [{file, names}]
function inertSettingsServers(settings) {
  const out = [];
  for (const [file, data] of Object.entries(settings || {})) {
    const names = Object.keys((data && data.mcpServers) || {});
    if (names.length) out.push({ file, names });
  }
  return out;
}

// sharedAqeCommand CMD {roots, bare} — does an MCP server command run the shared AQE runtime? An explicit path under
// one of `roots` (the runtime's bin, in ~ or expanded form, or its releases folder) does. A bare name does only while
// `bare` holds it: the names a fresh shell resolves to the runtime (drift "aqe on PATH", D33), so the rule flags bare
// names again the moment the `[env] _.path` line goes. `npx …`, `node …` and paths into a stock install don't.
function sharedAqeCommand(cmd, { roots = [], bare = new Set() } = {}) {
  const cmd0 = String(cmd || '').trim().split(/\s+/)[0] || '';
  if (!cmd0) return false;
  if (cmd0.includes('/')) return roots.some(r => r && (cmd0 === r || cmd0.startsWith(r.replace(/\/+$/, '') + '/')));
  return bare.has(cmd0);
}

// evidence DIR — which AI tools a project shows signs of, and the files that show it
function evidence(dir) {
  const ev = { ruflo: [], aqe: [], brain: [] };
  const srv = servers(dir);
  const settings = ['.claude/settings.json', '.claude/settings.local.json'].map(f => [f, readJSON(path.join(dir, f))]);
  if (exists(path.join(dir, '.claude-flow'))) ev.ruflo.push('.claude-flow/');
  for (const [f, s] of settings) {
    if (!s) continue;
    if (s.claudeFlow) ev.ruflo.push(`${f} claudeFlow`);
    const plugins = Object.entries(s.enabledPlugins || {}).filter(([, on]) => on).map(([k]) => k);
    if (plugins.some(k => k.endsWith('@ruflo'))) ev.ruflo.push(`${f} ruflo plugins`);
    if (plugins.some(k => k.startsWith('ruvnet-brain@'))) ev.brain.push(`${f} ruvnet-brain plugin`);
    if (/agentic-qe|aqe-hook\.cjs/.test(JSON.stringify(s.hooks || {}))) ev.aqe.push(`${f} hooks`);
  }
  if (exists(path.join(dir, '.agentic-qe'))) ev.aqe.push('.agentic-qe/');
  for (const s of srv) {
    if (/ruflo|claude-flow/.test(s.name + ' ' + s.cmd)) ev.ruflo.push(`${s.file} ${s.name}`);
    if (/agentic-qe|aqe-mcp/.test(s.name + ' ' + s.cmd)) ev.aqe.push(`${s.file} ${s.name}`);
    if (/ruvnet-brain/.test(s.name + ' ' + s.cmd)) ev.brain.push(`${s.file} ${s.name}`);
  }
  for (const k of Object.keys(ev)) ev[k] = [...new Set(ev[k])];
  return { ev, servers: srv, settings: Object.fromEntries(settings) };
}

// Stack facets (D18, D24): what onboarding adapts to in each project, detected from the project itself rather than
// from a reference project. A stack is named by a marker file at the root; markers found only one folder down make
// the project polyglot. AI tooling wiring is the same on every stack; these decide where files go and what to report.
/** @type {[string, string[]][]} */
const STACKS = [
  ['node', ['package.json']],
  ['maven', ['pom.xml']],
  ['gradle', ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']],
  ['go', ['go.mod']],
  ['rust', ['Cargo.toml']],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']],
  ['ruby', ['Gemfile']],
  ['php', ['composer.json']],
  ['dotnet', ['global.json', 'Directory.Build.props']],
];
// The files onboarding reads or writes, in the order `facets` shows them.
const AI_FILES = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', '.claude/helpers',
  '.claude/hooks/aqe-hook.cjs', '.claude-flow/memory-package.json', '.agentic-qe', 'node_modules', 'CLAUDE.md', 'AGENTS.md'];

const namesIn = dir => { try { return new Set(fs.readdirSync(dir)); } catch { return new Set(); } };
const stacksIn = names => STACKS.filter(([, ms]) => ms.some(m => names.has(m))).map(([s]) => s);

// workspace DIR — the Node workspace tool that makes a repo a monorepo, or null
function workspace(dir, names) {
  if (names.has('pnpm-workspace.yaml')) return 'pnpm';
  if (names.has('nx.json')) return 'nx';
  if (names.has('turbo.json')) return 'turbo';
  if (names.has('lerna.json')) return 'lerna';
  const pj = names.has('package.json') && readJSON(path.join(dir, 'package.json'));
  return pj && pj.workspaces ? 'workspaces' : null;
}

// gitStates DIR [files] — {file: 'tracked'|'ignored'|'untracked'|'absent'|'absent-ignored'|'not-git'} in two Git calls.
// A folder counts as tracked when Git tracks anything inside it. 'absent-ignored': a file onboarding creates there
// would be ignored by the repo's own rules, so it needs no .git/info/exclude entry.
function gitStates(dir, files = AI_FILES) {
  const run = (args, input) => {
    try { return execFileSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { return e.status === 1 ? (e.stdout || '') : null; } // check-ignore exits 1 when nothing matches
  };
  if (!gitKind(dir)) return Object.fromEntries(files.map(f => [f, exists(path.join(dir, f)) ? 'not-git' : 'absent']));
  const tracked = run(['ls-files', '-z', '--', ...files]);
  if (tracked === null) return Object.fromEntries(files.map(f => [f, 'not-git']));
  const t = tracked.split('\0').filter(Boolean);
  const ignored = new Set((run(['check-ignore', '--stdin'], files.join('\n') + '\n') || '').split('\n').filter(Boolean));
  return Object.fromEntries(files.map(f => {
    const isTracked = t.some(x => x === f || x.startsWith(f + '/'));
    const present = exists(path.join(dir, f));
    return [f, isTracked ? 'tracked' : !present ? (ignored.has(f) ? 'absent-ignored' : 'absent') : ignored.has(f) ? 'ignored' : 'untracked'];
  }));
}

// nodeFor DIR — the Node version mise resolves in DIR (what a bare `node` runs there through mise), or a reason
function nodeFor(dir) {
  try {
    const v = execFileSync('mise', ['current', 'node'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return v || 'none';
  } catch (e) { return /trust/i.test(String(e.stderr || '')) ? 'untrusted mise config' : 'unknown'; }
}

// facets DIR [{git, node}] — {stacks, label, workspace, monorepo, sub: [{dir, stacks}], ts, files?, node?}.
// git and node are slower (Git and mise calls), so callers ask for them.
function facets(dir, opts = {}) {
  const names = namesIn(dir);
  const stacks = stacksIn(names);
  const ws = stacks.includes('node') ? workspace(dir, names) : null;
  const cargoWs = names.has('Cargo.toml') && /^\s*\[workspace\]/m.test((() => { try { return fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'); } catch { return ''; } })());
  const sub = [];
  for (const n of names) {
    if (n.startsWith('.') || SKIP.has(n)) continue;
    const p = path.join(dir, n);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    const s = stacksIn(namesIn(p));
    if (s.length) sub.push({ dir: n, stacks: s });
  }
  const subStacks = [...new Set(sub.flatMap(x => x.stacks))].filter(s => !stacks.includes(s));
  const parts = stacks.map(s => s === 'node' ? `node${ws ? `-mono(${ws})` : ''}${names.has('tsconfig.json') ? '/ts' : ''}` : s === 'rust' && cargoWs ? 'rust-ws' : s);
  if (subStacks.length && !ws) parts.push(`subdirs:${subStacks.join(',')}`);
  const out = { stacks, workspace: ws, monorepo: Boolean(ws || cargoWs), ts: names.has('tsconfig.json'), sub, label: parts.join('+') || (sub.length ? 'polyglot' : 'docs/other') };
  if (opts.git) out.files = gitStates(dir);
  if (opts.node) out.node = nodeFor(dir);
  return out;
}

// effective(found, regByPath) — the registry entry that governs a discovered project. A worktree follows its main
// checkout when projects.worktrees is "inherit" (D15) and is ignored when it is "ignore".
function effective(f, regByPath) {
  const own = regByPath.get(f.path);
  if (f.kind !== 'worktree' || CFG.worktrees === 'prompt') return own;
  if (CFG.worktrees === 'ignore') return { path: tilde(f.path), kind: 'worktree', decision: 'ignored', ai: [] };
  const parent = f.parent && regByPath.get(f.parent);
  return parent ? { ...parent, path: tilde(f.path), kind: 'worktree', inherits: parent.path } : own;
}

// shortener(paths) — a function that drops the folder every one of paths shares (with its trailing /), for tables
function shortener(paths) {
  const parts = paths.map(p => p.split('/').slice(0, -1));
  let n = 0;
  while (parts.length && parts.every(x => n < x.length && x[n] === parts[0][n])) n++;
  const pre = n ? parts[0].slice(0, n).join('/') + '/' : '';
  return p => (pre && p.startsWith(pre) ? p.slice(pre.length) : p);
}

module.exports = { shortener, HOME, ROOTS, WORKTREES: CFG.worktrees, effective, REPO_ROOT, REGISTRY, AI_FILES, tilde, untilde, userPath: C.userPath, exists, readJSON, toml, discover, loadRegistry, remoteOf, servers, unpinnedLauncher, inertSettingsServers, sharedAqeCommand, evidence, facets, gitStates, gitKind, worktreeMain, nodeFor };
