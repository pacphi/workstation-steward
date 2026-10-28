#!/usr/bin/env node
// The publish guard (D46): `npm publish` goes ahead only from the release workflow of this package's own repository,
// on a clean checkout of exactly the release tag, with a package that holds nothing private and a version npm doesn't
// have yet. It runs as the workflow's step and again as npm's prepublishOnly, so a publish typed in any clone refuses.
// Read-only. Exit 0 = go; 1 = refused, with every reason. PUBLISH_GUARD_OFFLINE=1 skips the registry lookup (tests).
// Usage: publish-guard.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const env = process.env;
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...o });
const why = [];

// repo(url) — owner/name from a package.json repository URL
const repo = url => (String(url || '').match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1];
const own = repo(pkg.repository && pkg.repository.url);

// 1. the release workflow of this package's own repository, on GitHub Actions
if (env.GITHUB_ACTIONS !== 'true') why.push('not running on GitHub Actions: releases publish only from the Release workflow');
if (!own) why.push('package.json has no GitHub repository URL to compare with');
else if (env.GITHUB_REPOSITORY !== own) why.push(`repository is ${env.GITHUB_REPOSITORY || 'unknown'}, not ${own}`);
if (!/\/\.github\/workflows\/release\.yml@/.test(env.GITHUB_WORKFLOW_REF || '')) why.push(`workflow is ${env.GITHUB_WORKFLOW_REF || 'unknown'}, not .github/workflows/release.yml`);

// 2. a clean checkout of exactly the release tag
const tag = `v${pkg.version}`;
const at = run('git', ['tag', '--points-at', 'HEAD']);
if (at.status !== 0 || !at.stdout.split('\n').includes(tag)) why.push(`HEAD is not tagged ${tag}`);
const dirty = run('git', ['status', '--porcelain']);
if (dirty.status !== 0 || dirty.stdout.trim()) why.push('the checkout has uncommitted changes');

// 3. the package holds only the allow-listed files, and nothing private in them (the leak check's structural rules)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-publish-'));
const packed = run('npm', ['pack', '--pack-destination', tmp, '--json', '--ignore-scripts']);
if (packed.status !== 0) why.push(`npm pack failed: ${(packed.stderr || '').trim().split('\n').pop()}`);
else {
  // npm 11 prints [ {…} ]; npm 12 prints { <name>: {…} }
  const j = JSON.parse(packed.stdout);
  const info = Array.isArray(j) ? j[0] : j[pkg.name] || Object.values(j)[0];
  const unpack = path.join(tmp, 'unpacked');
  fs.mkdirSync(unpack);
  run('tar', ['-xzf', path.join(tmp, info.filename), '-C', unpack]);
  const leak = run(process.execPath, [path.join(__dirname, 'leak-check.js'), path.join(unpack, 'package'), '--terms', '/dev/null']);
  if (leak.status !== 0) why.push(`the package fails the leak check:\n${leak.stdout.trim()}`);
  if (info.files.some(f => /^(tools|test|archive|owner)\//.test(f.path))) why.push('the package holds development or private files (tools/, test/, archive/, owner/)');
}
fs.rmSync(tmp, { recursive: true, force: true });

// 4. a version npm doesn't have yet
if (env.PUBLISH_GUARD_OFFLINE !== '1') {
  const seen = run('npm', ['view', `${pkg.name}@${pkg.version}`, 'version', '--json']);
  if (seen.status === 0 && seen.stdout.trim()) why.push(`${pkg.name}@${pkg.version} is already on npm`);
}

if (why.length) {
  console.error(`publish-guard: refusing to publish ${pkg.name}@${pkg.version}:`);
  for (const w of why) console.error(`  - ${w}`);
  process.exitCode = 1;
} else console.log(`publish-guard: ${pkg.name}@${pkg.version} from ${own} at ${tag}: go`);
