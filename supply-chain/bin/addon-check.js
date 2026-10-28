// Load every native addon our CLIs depend on, from wherever the active install keeps it.
// Exit 1 if any fails. Paths follow mise's npm: (aube) layout and npm -g layout.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { values } = require('../../lib/config.js').load();
// Only the AI tooling add-on's tools carry native addons: with it off there is nothing to check (the install check
// found verify failing on a machine without them)
if (!values.profiles.ai_tooling) {
  console.log('  skipped: the AI tooling add-on is off ([profiles] ai_tooling), and only its tools carry native addons');
  process.exit(0);
}
const installs = path.join(values.paths.mise_data_dir, 'installs');
const npmRoot = execFileSync('npm', ['root', '-g']).toString().trim();
// Each finder returns where a tool keeps its modules, or null when this machine doesn't have the tool: a tool that
// isn't installed is reported, not a failure; one that is installed and won't load is
const latest = tool => {
  const dir = path.join(installs, tool);
  if (!fs.existsSync(dir)) return null;
  const v = fs.readdirSync(dir).filter(d => /^\d/.test(d) && !fs.lstatSync(path.join(dir, d)).isSymbolicLink()).sort().pop();
  return v ? path.join(dir, v) : null;
};
const aube = (tool, prefix) => {
  const at = latest(tool);
  const store = at && path.join(at, 'node_modules/.mise');
  const hit = store && fs.existsSync(store) && fs.readdirSync(store).find(d => d.startsWith(prefix));
  return hit ? path.join(store, hit, 'node_modules') : null;
};
const npmG = name => (fs.existsSync(path.join(npmRoot, name)) ? path.join(npmRoot, name) : null);

/** @type {[string, string | null, string, boolean?][]} */
const checks = [
  ['npm-agentic-qe', aube('npm-agentic-qe', 'agentic-qe@'), 'better-sqlite3', true],
  ['npm-agentic-qe', aube('npm-agentic-qe', 'agentic-qe@'), 'hnswlib-node'],
  ['npm-ruvector', aube('npm-ruvector', 'ruvector@'), 'ruvector-core-darwin-arm64'],
  ['npm-claude-flow-codex', aube('npm-claude-flow-codex', '@claude-flow+codex@'), '@napi-rs/keyring'],
  ['npm -g ruflo', npmG('ruflo'), 'better-sqlite3', true],
  ['npm -g ruflo', npmG('ruflo'), 'hnswlib-node'],
  ['npm -g ruflo', npmG('ruflo'), 'sharp'],
  ['npm -g agentdb', npmG('agentdb'), 'hnswlib-node'],
  ['npm -g agentdb', npmG('agentdb'), 'argon2'],
];
let failed = 0;
console.log(`  node ${process.version} modules=${process.versions.modules}`);
for (const [where, base, mod, query] of checks) {
  if (!base) { console.log(`  --   ${where} → ${mod}: not installed`); continue; }
  try {
    const m = require(require.resolve(mod, { paths: [base, path.join(base, 'node_modules')] }));
    if (query) new m(':memory:').prepare('select 1').get();
    console.log(`  ok   ${where} → ${mod}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${where} → ${mod} :: ${String(e.message).split('\n')[0].slice(0, 100)}`);
  }
}
process.exit(failed ? 1 : 0);
