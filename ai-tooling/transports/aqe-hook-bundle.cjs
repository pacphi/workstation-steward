#!/usr/bin/env node
'use strict';
// AQE hook transport v2 (D24). Source of record for the file `just projects onboard` installs at ai-tooling.toml
// [aqe] hook_transport. A project's settings.local.json sets AQE_HOOK_BUNDLE to it; AQE's own aqe-hook.cjs and
// brain-checkpoint.cjs resolve AQE_HOOK_BUNDLE before anything else and run it with their node, so every hook
// reaches the shared, patched runtime on any stack, never the stock `aqe` on PATH, with AQE's files unchanged.
// v1 (transports/v1/aqe-shared-cli.cjs, the migration's) forwarded only; v2 also binds the hook to its project,
// as the node_modules/.bin/agentic-qe shims did: root, store, session cache off, and the project's own embedder
// endpoint from its .mcp.json (empty otherwise: the offline model). Values already in the environment win.
// Retire it when ai-tooling.toml [[retire]] says (no local patches, stock AQE qualified, stores bound without it).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The runtime this file sits in (<runtime>/transports/v2/), else the default runtime location.
const installed = path.resolve(__dirname, '..', '..', 'current', 'bin', 'aqe');
const runtime = fs.existsSync(installed) ? installed : path.join(os.homedir(), '.local/share/ai-tooling/aqe/current/bin/aqe');

function projectRoot(env) {
  if (env.AQE_PROJECT_ROOT) return env.AQE_PROJECT_ROOT;
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
}

function embedder(root) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    const e = (((m.mcpServers || {})['agentic-qe'] || {}).env || {}).AQE_EMBEDDER_ENDPOINT;
    return typeof e === 'string' ? e : '';
  } catch { return ''; }
}

const env = { ...process.env };
const root = path.resolve(projectRoot(env));
// The runtime refuses these too; stop here so a hook never binds a home-wide or system-wide store.
if (root === path.resolve(os.homedir()) || root === path.parse(root).root) {
  process.stderr.write(`[aqe-hook-bundle] refusing project root ${root}\n`);
  process.exit(1);
}
env.AQE_PROJECT_ROOT = root;
if (!env.AQE_MEMORY_PATH) env.AQE_MEMORY_PATH = path.join(root, '.agentic-qe', 'memory.db');
if (!env.AQE_SESSION_CACHE) env.AQE_SESSION_CACHE = 'off';
if (env.AQE_EMBEDDER_ENDPOINT === undefined) env.AQE_EMBEDDER_ENDPOINT = embedder(root);
if (env.AQE_HOOK_SHIM_TRACE) {
  try { fs.appendFileSync(env.AQE_HOOK_SHIM_TRACE, `${new Date().toISOString()} bundle-v2 project=${root} args=${process.argv.slice(2).join(' ')}\n`); } catch { /* tracing is best effort */ }
}

const r = spawnSync(runtime, process.argv.slice(2), { stdio: 'inherit', env, cwd: process.cwd(), timeout: Number(env.AQE_HOOK_TIMEOUT_MS) || 22000 });
if (r.error) process.exit(1);
process.exit(Number.isInteger(r.status) ? r.status : 1);
