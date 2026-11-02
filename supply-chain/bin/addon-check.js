// Load every native addon our CLIs depend on, from wherever the active install keeps it.
// Exit 1 if any fails. Paths follow mise's npm: (aube) layout and npm -g layout.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ruvectorAddon(platform, arch, glibc) — the prebuilt add-on @ruvector/core ships for this OS, CPU and C library (its
// optionalDependencies, 0.1.33: darwin x64 and arm64, linux x64 and arm64 on glibc, win32 x64), or null where it ships
// none (musl, other CPUs): then there is nothing to load, which is not a failure (parity 0.7)
function ruvectorAddon(platform, arch, glibc) {
  if (!['x64', 'arm64'].includes(arch)) return null;
  if (platform === 'darwin') return `ruvector-core-darwin-${arch}`;
  if (platform === 'linux') return glibc ? `ruvector-core-linux-${arch}-gnu` : null;
  if (platform === 'win32') return arch === 'x64' ? 'ruvector-core-win32-x64-msvc' : null;
  return null;
}
// glibc() — this Node's glibc version on Linux, or null (musl, or not Linux)
const glibc = () => { try { return /** @type {any} */ (process.report.getReport()).header.glibcVersionRuntime || null; } catch { return null; } };

// main() — load each native addon and report; exit 1 if any fails. Run only when this script is run, never on require
function main() {
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
  const RUVECTOR = ruvectorAddon(process.platform, process.arch, glibc());
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
    ...(RUVECTOR ? [/** @type {[string, string | null, string, boolean?]} */ (['npm-ruvector', aube('npm-ruvector', 'ruvector@'), RUVECTOR])] : []),
    ['npm-claude-flow-codex', aube('npm-claude-flow-codex', '@claude-flow+codex@'), '@napi-rs/keyring'],
    ['npm -g ruflo', npmG('ruflo'), 'better-sqlite3', true],
    ['npm -g ruflo', npmG('ruflo'), 'hnswlib-node'],
    ['npm -g ruflo', npmG('ruflo'), 'sharp'],
    ['npm -g agentdb', npmG('agentdb'), 'hnswlib-node'],
    ['npm -g agentdb', npmG('agentdb'), 'argon2'],
  ];
  let failed = 0;
  if (!RUVECTOR) console.log('  --   npm-ruvector → no prebuilt add-on for this platform');
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
}

module.exports = { ruvectorAddon };

if (require.main === module) main();
