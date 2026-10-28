// Stand-ins for the qualified AI tool installs (the Ruflo CLI's .claude folders, the shared AQE runtime and package, the
// hook transport) so the onboarding and offboarding tests run on a machine without them (CI, a new Mac). Where the real
// installs exist, the tests use them instead, as integration tests; STEWARD_TEST_FIXTURES=1 forces the stand-ins.
// Call setup(root) BEFORE requiring anything from lib/: it points STEWARD_CONFIG at a steward.toml whose [paths] lead
// into the stand-in tree, and lib/config.js reads that once, when first loaded.
// The stand-ins are small but shaped like the real ones: helpers, skills, commands and agents (one skill name both
// tools ship, for D26), AQE's two hook files, a runtime bin/aqe that exits 0, and the steward's transport v2.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const put = (file, text, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, mode ? { mode } : undefined); };

// What a stand-in AQE hook does: hand its arguments to the bundle AQE_HOOK_BUNDLE names, as AQE's own shim does
const HOOK = `#!/usr/bin/env node
// stand-in for agentic-qe's .claude/hooks/aqe-hook.cjs (test/fixtures.js)
const { spawnSync } = require('child_process');
const bundle = process.env.AQE_HOOK_BUNDLE;
if (!bundle) process.exit(0);
const r = spawnSync(process.execPath, [bundle, 'hooks', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(Number.isInteger(r.status) ? r.status : 1);
`;

function build(home) {
  const share = path.join(home, '.local', 'share');
  const cli = path.join(share, 'mise', 'installs', 'node', '26', 'lib', 'node_modules', 'ruflo', 'node_modules', '@claude-flow', 'cli', '.claude');
  for (const f of ['hook-handler.cjs', 'statusline.cjs', 'router.cjs']) put(path.join(cli, 'helpers', f), `// stand-in Ruflo helper ${f}\n`);
  put(path.join(cli, 'helpers', 'helpers.manifest.json'), '{}\n');
  for (const s of ['swarm-orchestration', 'sparc-methodology']) put(path.join(cli, 'skills', s, 'SKILL.md'), `# ${s} (stand-in)\n`);
  for (const c of ['claude-flow-help.md', 'claude-flow-swarm.md']) put(path.join(cli, 'commands', c), `# ${c} (stand-in)\n`);
  put(path.join(cli, 'agents', 'core', 'coder.md'), '# coder (stand-in)\n');
  put(path.join(cli, 'agents', 'swarm', 'hierarchical-coordinator.md'), '# coordinator (stand-in)\n');

  const aqe = path.join(share, 'ai-tooling', 'aqe');
  const pkg = path.join(aqe, 'current', 'node_modules', 'agentic-qe', '.claude');
  put(path.join(pkg, 'hooks', 'aqe-hook.cjs'), HOOK, 0o755);
  put(path.join(pkg, 'helpers', 'brain-checkpoint.cjs'), '// stand-in brain-checkpoint.cjs\n');
  // AQE also ships swarm-orchestration: with both tools chosen, AQE's copy skips it (D26)
  for (const s of ['qe-test-generation', 'swarm-orchestration']) put(path.join(pkg, 'skills', s, 'SKILL.md'), `# ${s} (AQE stand-in)\n`);
  put(path.join(pkg, 'commands', 'aqe-generate.md'), '# aqe-generate (stand-in)\n');
  put(path.join(pkg, 'agents', 'qe', 'qe-test-generator.md'), '# qe-test-generator (stand-in)\n');
  put(path.join(aqe, 'current', 'bin', 'aqe'), '#!/bin/sh\n# stand-in AQE runtime\nexit 0\n', 0o755);
  fs.mkdirSync(path.join(aqe, 'transports', 'v2'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'ai-tooling', 'transports', 'aqe-hook-bundle.cjs'), path.join(aqe, 'transports', 'v2', 'aqe-hook-bundle.cjs'));
  for (const d of [path.join(share, 'ai-tooling', 'ruflo-core', 'current'), path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.config', 'ruflo')]) fs.mkdirSync(d, { recursive: true });
}

// missingInSubprocess() — test/installs.js's answer for the current config, without loading lib/ in this process
const missingInSubprocess = env => {
  const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).missing(["ruflo","aqe","brain"])))', path.join(__dirname, 'installs.js')], { encoding: 'utf8', env });
  try { return JSON.parse(r.stdout); } catch { return 'could not check the installs'; }
};

// setup(root) — { used, home, needs }: used = the stand-ins are in place; needs = why the tests still can't run, or false
function setup(root) {
  const force = process.env.STEWARD_TEST_FIXTURES === '1';
  if (!force && !missingInSubprocess(process.env)) return { used: false, home: process.env.HOME, needs: false };
  const home = path.join(root, 'fixture-home');
  build(home);
  const share = path.join(home, '.local', 'share');
  const cfg = path.join(root, 'fixture-steward.toml');
  fs.writeFileSync(cfg, `schema = 1\n\n[paths]\nmise_data_dir = "${path.join(share, 'mise')}"\nai_tooling_root = "${path.join(share, 'ai-tooling')}"\nclaude_dir = "${path.join(home, '.claude')}"\nclaude_json = "${path.join(home, '.claude.json')}"\ncodex_home = "${path.join(home, '.codex')}"\nruflo_config_dir = "${path.join(home, '.config', 'ruflo')}"\n\n[profiles]\nai_tooling = true\nprojects = true\n`);
  process.env.STEWARD_CONFIG = cfg;
  // ai-tooling.toml names the pinned Ruflo marketplace by commit under the AI tooling root; make that folder too
  const needs = missingInSubprocess(process.env);
  return { used: true, home, needs: needs && `the test stand-ins are incomplete: ${needs}` };
}

module.exports = { setup, build };
