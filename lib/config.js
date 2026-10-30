#!/usr/bin/env node
// Effective configuration: built-in defaults, overlaid by steward.toml (or $STEWARD_CONFIG). steward.toml says
// where things are; policy (what's allowed) stays in the area files. D10 in docs/architecture.md.
// The instance (D39) is the folder holding steward.toml and the policy files (mise/, renovate.json,
// supply-chain/{host,hybrids}.toml, verify.tsv, vendor/, ai-tooling/ai-tooling.toml, projects/registry.toml), at the
// same relative paths as in this repo. The engine (this code) finds it: $STEWARD_INSTANCE, else the engine's own
// folder when it holds a steward.toml (a checkout that is both), else ~/.config/workstation-steward.
// $STEWARD_CONFIG still names only the settings file; the policy files stay in the instance.
// Usage: config.js            human-readable, with each value's source
//        config.js --json     effective values as JSON
//        config.js --shell    bash assignments for lib/lib.sh (scalars and indexed arrays)
//        config.js --check    validate only: exit 1 on unknown keys or wrong types
//        config.js --profile <name>   exit 0 when that [profiles] add-on is on; else say so and exit 3
// Area policy files (ai-tooling.toml) name these paths as {{NAME}} placeholders: policy(file) fills them.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const REPO_ROOT = path.resolve(__dirname, '..');   // the engine: this code
// The engine's release (package.json); receipts record it, so a later release knows what an earlier one wrote (D40)
const ENGINE_VERSION = (() => { try { return require('../package.json').version; } catch { return '0.0.0-dev'; } })();
// The instance format (steward.toml `schema`, D40): CURRENT is what this engine writes; READS the formats it accepts.
// A steward.toml without the key is format 1, the format before the key existed.
const SCHEMA = { CURRENT: 1, READS: [1] };
const xdg = (v, d) => process.env[v] || path.join(HOME, d);

// resolveInstance({ env, engineRoot, home, exists }) — { root, source, error? }: where the instance is, and why
function resolveInstance({ env = process.env, engineRoot = REPO_ROOT, home = HOME, exists = fs.existsSync } = {}) {
  if (env.STEWARD_INSTANCE) {
    const given = env.STEWARD_INSTANCE;
    const root = path.resolve(given.startsWith('~/') ? path.join(home, given.slice(2)) : given);
    const error = exists(path.join(root, 'steward.toml')) ? undefined : `STEWARD_INSTANCE=${given}: no steward.toml there`;
    return { root, source: 'env STEWARD_INSTANCE', error };
  }
  if (exists(path.join(engineRoot, 'steward.toml'))) return { root: engineRoot, source: 'engine folder' };
  return { root: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'workstation-steward'), source: '~/.config default' };
}
const INSTANCE = resolveInstance();
const INSTANCE_ROOT = INSTANCE.root;
const FILE = process.env.STEWARD_CONFIG || path.join(INSTANCE_ROOT, 'steward.toml');
// instance(rel) — the absolute path of an instance file, e.g. instance('supply-chain/host.toml')
const instance = rel => path.join(INSTANCE_ROOT, rel);
// A default that follows a tool's own variable when it's set: its value, and `env NAME` as the source
const ENV_DEFAULTS = { mise_data_dir: 'MISE_DATA_DIR', claude_dir: 'CLAUDE_CONFIG_DIR', codex_home: 'CODEX_HOME' };

const DEFAULTS = {
  projects: {
    roots: ['~/Development'],
    exclude: [],
    max_depth: 8,
    // Folders never descended into: dependencies, build output, caches, AI tool state.
    skip_dirs: ['node_modules', '.git', 'vendor', 'dist', 'build', 'target', 'out', '.venv', 'venv', '__pycache__',
      '.next', '.nuxt', '.vite', '.cache', '.gradle', '.idea', 'coverage', '.turbo', 'Pods', 'DerivedData', '.terraform',
      '.swarm', '.agentic-qe', '.claude-flow', '.pnpm-store'],
    extra_skip_dirs: [],
    // A non-Git folder counts as a project when it holds one of these and isn't inside another project.
    markers: ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'go.mod', 'pyproject.toml',
      'Gemfile', 'composer.json', 'AGENTS.md', 'CLAUDE.md', '.claude', '.mcp.json', 'mise.toml'],
    extra_markers: [],
    // Worktrees are temporary: "inherit" follows the parent repo's decision and tools without a registry entry,
    // "ignore" never manages them, "prompt" asks about each one like any other project (D15).
    worktrees: 'inherit',
  },
  paths: {
    state: path.join(xdg('XDG_STATE_HOME', '.local/state'), 'workstation-steward'),
    cache: path.join(xdg('XDG_CACHE_HOME', '.cache'), 'workstation-steward'),
    mise_config_dir: '~/.config/mise',
    // Where the tools keep their installs and settings. mise, Claude Code and Codex each follow their own variable
    // when it's set (MISE_DATA_DIR, CLAUDE_CONFIG_DIR, CODEX_HOME).
    mise_data_dir: process.env.MISE_DATA_DIR || '~/.local/share/mise',
    ai_tooling_root: '~/.local/share/ai-tooling',   // the shared AQE runtime, ruflo-core, the pinned Ruflo marketplace
    claude_dir: process.env.CLAUDE_CONFIG_DIR || '~/.claude',
    claude_json: '~/.claude.json',
    codex_home: process.env.CODEX_HOME || '~/.codex',
    ruflo_config_dir: '~/.config/ruflo',
  },
  // The release-age gate in days, for every area. mise and Renovate keep their own copy (they can't read this
  // file): `steward sc release-age <days>` sets all three, and `steward sc audit` flags any disagreement.
  // soak_days: after an upgrade, Node patch, hybrid install or repin, `steward sc prune` waits this long so the old
  // installs stay available for a quick rollback (lib/soak.js, D20). 0 turns the wait off.
  // review_days: the `steward` banner says a weekly review is due this many days after the last `steward review`; 0 = never.
  policy: { min_release_age_days: 3, soak_days: 3, review_days: 7 },
  // `steward brief` (docs/briefing.md). stale_hours: a fact it reads from another command's cache (the release-age
  // gate's queue from `steward review`, the last full reconcile plan, its own refresh) older than this is shown "as
  // of" its time and only as a wait, never as the next step. 0 = never stale.
  // refresh_hours: when its own cache (<state>/brief/refresh.json) is older than this, `steward brief` starts a
  // read-only refresh in the background (lib/refresh.js, D57): a fetch of your config repo, the newest steward on
  // npm, new projects, AI tooling drift and the active Node. 0 = never, so nothing touches the network unprompted.
  // fetch: whether that refresh runs `git fetch` in your config repo (it changes only what Git knows of GitHub).
  brief: { stale_hours: 48, refresh_hours: 6, fetch: true },
  // Optional areas (D39), off unless steward.toml turns them on: AI tooling (Ruflo, AQE, Brain) and projects
  // (discovery, registry, onboarding). Supply chain and fleet are always on.
  profiles: { ai_tooling: false, projects: false },
  // Claude Code skills beyond each area's own (D48): `steward skills path` adds them to the steward plugin when on.
  skills: { pr_consolidation: false },
  // Folders searched for launcher configs (.mcp.json, .codex/config.toml, .claude/settings*.json) besides the
  // project roots; the user-level Claude Code and Codex configs are always searched.
  launchers: { extra_roots: [] },
  ioc: { extra_roots: [] },
};

const untilde = p => (typeof p === 'string' && p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);
// userPath(p) — a path the user typed, as an absolute path: ~ expanded, a relative one taken from the folder they ran
// steward in (STEWARD_CWD, set by bin/steward.js; scripts run from the engine's area folders, never the user's)
const userPath = p => { const s = p === '~' ? HOME : untilde(String(p)); return path.isAbsolute(s) ? s : path.resolve(process.env.STEWARD_CWD || process.cwd(), s); };
const tilde = p => (typeof p === 'string' && p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);

// readFile() — steward.toml, parsed. yq costs a process, and one command loads the config from every module it
// requires, so the parse is kept while the file stays the same (its mtime, size and inode); a rewrite is read again
let fileMemo = null;
function readFile() {
  let st = null;
  try { st = fs.statSync(FILE, { bigint: true }); } catch { /* absent */ }
  if (!st) { fileMemo = null; return {}; }
  const key = `${st.mtimeNs}:${st.size}:${st.ino}`;
  if (fileMemo && fileMemo.key === key) return structuredClone(fileMemo.data);
  let data;
  try {
    // An empty file (a newcomer's first steward.toml) is all defaults: yq prints null for it
    data = JSON.parse(execFileSync('yq', ['-p', 'toml', '-o', 'json', '.', FILE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) || {};
  } catch (e) { throw new Error(`${tilde(FILE)}: ${String(e.stderr || e.message).trim()}`); }
  fileMemo = { key, data };
  return structuredClone(data);
}

// load({ allowMissing }) — { values, sources, errors }. Paths are expanded; *_dirs/markers lists are merged with their
// extras. A $STEWARD_INSTANCE without a steward.toml is an error, except for the commands that report on the config
// (allowMissing: `steward version`, `steward check`): a release launcher names the default folder before `steward init`
function load({ allowMissing = false } = {}) {
  if (INSTANCE.error && !allowMissing) throw new Error(INSTANCE.error);
  const file = readFile();
  const values = {}, sources = {}, errors = [];
  for (const [sec, defs] of Object.entries(DEFAULTS)) {
    values[sec] = {};
    const given = file[sec] || {};
    for (const k of Object.keys(given)) if (!(k in defs)) errors.push(`unknown key ${sec}.${k}`);
    for (const [k, d] of Object.entries(defs)) {
      let v = d, src = ENV_DEFAULTS[k] && process.env[ENV_DEFAULTS[k]] ? `env ${ENV_DEFAULTS[k]}` : 'default';
      if (k in given) {
        const g = given[k];
        if (Array.isArray(d) !== Array.isArray(g) || (!Array.isArray(d) && typeof g !== typeof d)) {
          errors.push(`${sec}.${k}: expected ${Array.isArray(d) ? 'a list' : typeof d}, got ${Array.isArray(g) ? 'a list' : typeof g}`);
        } else if (typeof d === 'number' && !(Number.isInteger(g) && g >= 0)) {
          errors.push(`${sec}.${k}: expected a whole number of 0 or more, got ${g}`);
        } else { v = g; src = tilde(FILE); }
      }
      values[sec][k] = Array.isArray(v) ? v.map(untilde) : untilde(v);
      sources[`${sec}.${k}`] = src;
    }
  }
  // `schema` is the one top-level key: the instance's format (D40)
  let schema = 1;
  if ('schema' in file) {
    if (Number.isInteger(file.schema) && file.schema >= 1) schema = file.schema;
    else errors.push(`schema: expected a whole number of 1 or more, got ${JSON.stringify(file.schema)}`);
  }
  for (const sec of Object.keys(file)) if (sec !== 'schema' && !(sec in DEFAULTS)) errors.push(`unknown section [${sec}]`);
  if (!['inherit', 'ignore', 'prompt'].includes(values.projects.worktrees)) errors.push(`projects.worktrees must be inherit, ignore or prompt, got ${values.projects.worktrees}`);
  const p = values.projects;
  p.skip_dirs = [...new Set([...p.skip_dirs, ...p.extra_skip_dirs])];
  p.markers = [...new Set([...p.markers, ...p.extra_markers])];
  return { values, sources, errors, file: FILE, schema, schemaGiven: 'schema' in file };
}

// placeholders() — {{NAME}} → path, for the area policy files: the [paths] values policy files may name
function placeholders(values = load().values) {
  const p = values.paths;
  return { MISE_DATA_DIR: p.mise_data_dir, AI_TOOLING_ROOT: p.ai_tooling_root, CLAUDE_DIR: p.claude_dir, CLAUDE_JSON: p.claude_json, CODEX_HOME: p.codex_home, RUFLO_CONFIG_DIR: p.ruflo_config_dir };
}

// fill(v, ph) — v with every {{NAME}} replaced (strings, lists and tables, recursively); an unknown name throws
function fill(v, ph) {
  if (typeof v === 'string') return v.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => { if (!(k in ph)) throw new Error(`unknown placeholder ${m}`); return ph[k]; });
  if (Array.isArray(v)) return v.map(x => fill(x, ph));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ph)]));
  return v;
}

// policy(rel) — an area policy file (path relative to the repo), parsed, with its {{NAME}} paths filled; null when
// it's missing or doesn't parse
const policyCache = {};
function policy(rel) {
  if (rel in policyCache) return policyCache[rel];
  const f = instance(rel);
  let data = null;
  if (fs.existsSync(f)) {
    try { data = JSON.parse(execFileSync('yq', ['-p', 'toml', '-o', 'json', '.', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { data = null; }
  }
  return (policyCache[rel] = data === null ? null : fill(data, placeholders()));
}

// newBackupDir(name) — a fresh, empty folder for one run's backups and receipt: <state>/backups/<name>-<UTC time>,
// claimed atomically, with -2, -3… when another run took that second (sharing one would overwrite its receipt)
function newBackupDir(name) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const base = path.join(load().values.paths.state, 'backups', `${name}-${stamp}`);
  fs.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    try { fs.mkdirSync(dir, { mode: 0o700 }); return dir; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

module.exports = { load, untilde, userPath, tilde, newBackupDir, placeholders, fill, policy, instance, resolveInstance, HOME, REPO_ROOT, INSTANCE_ROOT, INSTANCE, ENGINE_VERSION, SCHEMA };

if (require.main === module) {
  const mode = process.argv[2] || '';
  let cfg;
  try { cfg = load(); } catch (e) { console.error(`ERROR ${e.message}`); process.exit(1); }
  const { values, sources, errors } = cfg;
  if (mode === '--json') { console.log(JSON.stringify(values, null, 1)); process.exit(errors.length ? 1 : 0); }
  if (mode === '--profile') {
    const name = process.argv[3];
    if (!(name in values.profiles)) { console.error(`ERROR unknown profile "${name}" (${Object.keys(values.profiles).join(', ')})`); process.exit(2); }
    if (values.profiles[name]) process.exit(0);
    console.error(`The ${name.replace('_', ' ')} add-on is off (${tilde(cfg.file)} [profiles] ${name} = false). Turn it on there to use these commands.`);
    process.exit(3);
  }
  if (mode === '--shell') {
    // Single-quoted for bash; arrays as indexed arrays (bash 3.2 has no associative arrays).
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
    console.log(`STEWARD_INSTANCE_ROOT=${q(INSTANCE_ROOT)}`);
    console.log(`STEWARD_ENGINE_VERSION=${q(ENGINE_VERSION)}`);
    for (const [sec, kv] of Object.entries(values)) {
      for (const [k, v] of Object.entries(kv)) {
        const name = `STEWARD_${sec}_${k}`.toUpperCase();
        console.log(Array.isArray(v) ? `${name}=(${v.map(q).join(' ')})` : `${name}=${q(v)}`);
      }
    }
    for (const e of errors) console.log(`echo ${q('WARN steward config: ' + e)} >&2`);
    process.exit(0);
  }
  if (mode === '--check') { for (const e of errors) console.error(`ERROR ${e}`); process.exit(errors.length ? 1 : 0); }
  console.log(`instance:    ${tilde(INSTANCE_ROOT)}   [${INSTANCE.source}]`);
  console.log(`config file: ${tilde(cfg.file)}${fs.existsSync(cfg.file) ? '' : ' (absent: defaults only)'}`);
  for (const [sec, kv] of Object.entries(values)) {
    console.log(`[${sec}]`);
    for (const [k, v] of Object.entries(kv)) {
      if (k === 'extra_skip_dirs' || k === 'extra_markers') continue;
      const shown = Array.isArray(v) ? (v.length > 6 ? `${v.slice(0, 6).map(tilde).join(', ')} … (${v.length})` : v.map(tilde).join(', ')) : tilde(String(v));
      const src = sources[`${sec}.${k}`] === 'default' && ['skip_dirs', 'markers'].includes(k) && values[sec][`extra_${k}`]?.length ? 'default + extra_' + k : sources[`${sec}.${k}`];
      const missing = ['roots', 'mise_config_dir', 'mise_data_dir', 'ai_tooling_root', 'claude_dir'].includes(k) && [].concat(v).some(x => !fs.existsSync(x)) ? '  (MISSING)' : '';
      console.log(`  ${k.padEnd(16)} ${shown}${missing}   [${src}]`);
    }
  }
  // the config folder as a Git repository (D50); read here, after this module has loaded, since it needs it
  for (const l of require('./configrepo.js').describe(require('./configrepo.js').state(INSTANCE_ROOT))) console.log(l);
  if (errors.length) { console.log(''); for (const e of errors) console.log(`ERROR ${e}`); process.exit(1); }
}
