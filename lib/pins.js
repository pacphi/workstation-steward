#!/usr/bin/env node
// Find launcher configs that point into a version-specific install folder (…/mise/installs/<tool>/<version>/…),
// which breaks when that version is pruned and keeps running it after an upgrade. Read-only.
// Scans the launcher files of every folder under steward.toml [projects] roots and [launchers] extra_roots, plus
// the user-level Claude Code and Codex configs, and the scripts those launchers run: each project's AQE hook shim
// (node_modules/.bin/agentic-qe) and the shared AQE runtime's bin/aqe and bin/aqe-mcp in every release, since an
// AQE rollback points `current` at an older one (2026-10-25: all of them ran Node 26.4.0 by its exact path).
// Usage: pins.js                      every version-specific reference: file, install, count (TSV)
//        pins.js <install-dir>...     only references into these install folders (exit 1 if any)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./config.js');

const { values } = C.load();
// .claude-flow/memory-package.json: Ruflo's memory hook loads @claude-flow/memory from its distPath.
const FILES = new Set(['.mcp.json', 'settings.json', 'settings.local.json', 'config.toml', 'memory-package.json']);
const PARENT_OK = { 'settings.json': '.claude', 'settings.local.json': '.claude', 'config.toml': '.codex', 'memory-package.json': '.claude-flow' };
const HOME_FILES = [values.paths.claude_json, path.join(values.paths.claude_dir, 'settings.json'), path.join(values.paths.codex_home, 'config.toml'), C.untilde('~/.mcp.json')];
const SKIP = new Set(values.projects.skip_dirs.filter(d => d !== '.git'));
SKIP.add('.git');
const EXCLUDE = new Set(values.projects.exclude);
const INSTALLS = path.join(values.paths.mise_data_dir, 'installs');
// …/mise/installs/<tool>/<version>/… where <version> starts with a digit. mise's alias links (26, 26.4, 0.3)
// follow the newest install in their line, but a link can still point at a version prune would remove
// (26.4 → 26.4.0), so a link counts as pinned when its target is prunable.
const RE = new RegExp(INSTALLS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([^/"\'\\s]+)/([0-9][^/"\'\\s]*)/', 'g');

// aqeRuntimeBins() — real paths of bin/aqe and bin/aqe-mcp in every release of the shared AQE runtime
// (ai-tooling.toml [aqe] runtime). Real paths only: current/ links to one of them, and listing both would
// back up and rewrite the same file twice.
function aqeRuntimeBins() {
  let runtime;
  try { runtime = C.untilde(C.policy('ai-tooling/ai-tooling.toml').aqe.runtime); } catch { return []; }
  const out = [];
  let releases;
  try { releases = fs.readdirSync(path.join(runtime, 'releases')); } catch { return []; }
  for (const r of releases) for (const b of ['aqe', 'aqe-mcp']) {
    const f = path.join(runtime, 'releases', r, 'bin', b);
    try { if (fs.statSync(f).isFile()) out.push(fs.realpathSync(f)); } catch { /* no such bin in this release */ }
  }
  return out;
}

function launcherFiles() {
  const out = HOME_FILES.filter(f => fs.existsSync(f)).concat(aqeRuntimeBins());
  const roots = [...values.projects.roots, ...values.launchers.extra_roots];
  for (const root of roots) (function walk(dir, depth) {
    if (depth > values.projects.max_depth + 2 || EXCLUDE.has(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && FILES.has(e.name) && (!PARENT_OK[e.name] || path.basename(dir) === PARENT_OK[e.name])) out.push(p);
      else if (e.isDirectory() && e.name === '.claude-flow') {
        // A state folder the walk skips, except the one launcher file it holds.
        const mp = path.join(p, 'memory-package.json');
        if (fs.existsSync(mp)) out.push(mp);
      } else if (e.isDirectory() && e.name === 'node_modules') {
        // Skipped too, except the AQE hook shim, which routes `npx agentic-qe` to the shared runtime.
        const shim = path.join(p, '.bin', 'agentic-qe');
        try { if (fs.lstatSync(shim).isFile()) out.push(shim); } catch { /* no shim */ }
      } else if (e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name)) walk(p, depth + 1);
    }
  })(root, 0);
  return [...new Set(out)];
}

// scan() — [{file, install, tool, version, count, alias}] for every version-specific reference
let prunable = null;
// prunableDirs() — real paths of every install `mise ls --prunable` would remove
function prunableDirs() {
  if (prunable) return prunable;
  prunable = new Set();
  let out = '';
  try { out = execFileSync('mise', ['ls', '--prunable'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return prunable; }
  for (const line of out.split('\n')) {
    const [tool, ver] = line.trim().split(/\s+/);
    if (!tool || !ver) continue;
    try { prunable.add(fs.realpathSync(execFileSync('mise', ['where', `${tool}@${ver}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())); } catch { /* not installed */ }
  }
  return prunable;
}

// launchText(file, text) — the part of a launcher file that can launch something, or null when that's all of it.
// In Claude settings, a reference inside permissions (allow/deny/ask rules) launches nothing. In ~/.claude.json only
// the mcpServers (top level and per project) launch anything; the rest holds history, such as past prompts.
const CLAUDE_JSON = values.paths.claude_json;
function launchText(f, txt) {
  if (f === CLAUDE_JSON) {
    try {
      const j = JSON.parse(txt);
      return JSON.stringify([j.mcpServers, ...Object.values(j.projects || {}).map(p => p && p.mcpServers)]);
    } catch { return null; }
  }
  if (!/settings(\.local)?\.json$/.test(f)) return null;
  try { const j = JSON.parse(txt); delete j.permissions; return JSON.stringify(j); } catch { return null; }
}

// targets() — [{file, target}] for every path under the folders that hold mise's installs and the AI tooling root
// (both ~/.local/share by default: mise installs, the AQE runtime, the Ruflo
// launcher) that a launcher config points at and that doesn't exist: a launcher that fails, or a Ruflo memory
// hook that silently falls back. Stable links (node/26/…) aren't version pins, so only this catches a link that
// moved to a version whose layout differs (a Ruflo upgrade moving @claude-flow/memory) or a line that went away.
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SHARE = new RegExp(`(?:${[...new Set([values.paths.mise_data_dir, values.paths.ai_tooling_root].map(p => path.dirname(p)))].map(esc).join('|')})/[^"'\\s,;)]+`, 'g');
function targets() {
  const out = [];
  for (const f of launcherFiles()) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const t = launchText(f, txt) ?? txt;
    for (const m of new Set(t.match(SHARE) || [])) {
      const target = m.replace(/\\+$/, '');
      if (!fs.existsSync(target)) out.push({ file: f, target });
    }
  }
  return out;
}

function scan() {
  const hits = [];
  for (const f of launcherFiles()) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const counts = {};
    for (const m of txt.matchAll(RE)) {
      const install = path.join(INSTALLS, m[1], m[2]);
      counts[install] = (counts[install] || 0) + 1;
    }
    const launchTxt = launchText(f, txt);
    for (const [install, count] of Object.entries(counts)) {
      let alias = false, target = install;
      try { alias = fs.lstatSync(install).isSymbolicLink(); if (alias) target = fs.realpathSync(install); } catch { /* missing install: a broken launcher */ }
      const targetPrunable = prunableDirs().has(target);
      if (alias && !targetPrunable) continue; // a link that follows its line and can't be pruned away is stable
      const [tool, version] = path.relative(INSTALLS, install).split(path.sep);
      const permissionOnly = launchTxt !== null && !launchTxt.includes(install + '/');
      hits.push({ file: f, install, target, alias, targetPrunable, tool, version, count, exists: fs.existsSync(install), permissionOnly });
    }
  }
  return hits;
}

module.exports = { scan, targets, launcherFiles };

if (require.main === module) {
  const want = process.argv.slice(2).map(p => path.resolve(C.untilde(p)));
  // Permission-only references don't block a prune: a rule naming a removed install just never matches.
  const hits = scan().filter(h => (!want.length || want.includes(h.install) || want.includes(h.target)) && !(want.length && h.permissionOnly));
  for (const h of hits) console.log([C.tilde(h.file), C.tilde(h.install), h.count, h.exists ? 'exists' : 'MISSING'].join('\t'));
  process.exit(want.length && hits.length ? 1 : 0);
}
