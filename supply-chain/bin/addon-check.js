// Load every native addon our CLIs depend on, from wherever the active install keeps it.
// Exit 1 if any fails. Paths follow mise's npm: (aube) layout and npm -g layout.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const installs = path.join(require('../../lib/config.js').load().values.paths.mise_data_dir, 'installs');
const npmRoot = execFileSync('npm', ['root', '-g']).toString().trim();
const latest = tool => {
  const dir = path.join(installs, tool);
  const v = fs.readdirSync(dir).filter(d => /^\d/.test(d) && !fs.lstatSync(path.join(dir, d)).isSymbolicLink()).sort().pop();
  return path.join(dir, v);
};
const aube = (tool, prefix) => {
  const store = path.join(latest(tool), 'node_modules/.mise');
  return path.join(store, fs.readdirSync(store).find(d => d.startsWith(prefix)), 'node_modules');
};

/** @type {[string, string, boolean?][]} */
const checks = [
  [aube('npm-agentic-qe', 'agentic-qe@'), 'better-sqlite3', true],
  [aube('npm-agentic-qe', 'agentic-qe@'), 'hnswlib-node'],
  [aube('npm-ruvector', 'ruvector@'), 'ruvector-core-darwin-arm64'],
  [aube('npm-claude-flow-codex', '@claude-flow+codex@'), '@napi-rs/keyring'],
  [path.join(npmRoot, 'ruflo'), 'better-sqlite3', true],
  [path.join(npmRoot, 'ruflo'), 'hnswlib-node'],
  [path.join(npmRoot, 'ruflo'), 'sharp'],
  [path.join(npmRoot, 'agentdb'), 'hnswlib-node'],
  [path.join(npmRoot, 'agentdb'), 'argon2'],
];
let failed = 0;
console.log(`  node ${process.version} modules=${process.versions.modules}`);
for (const [base, mod, query] of checks) {
  const where = base.startsWith(npmRoot) ? 'npm -g ' + path.relative(npmRoot, base) : path.relative(installs, base).split('/')[0];
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
