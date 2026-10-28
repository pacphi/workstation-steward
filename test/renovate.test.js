// The Renovate rules (D39, D40): renovate/steward.json is the preset config repos extend at a release tag. Until the
// public repo has a tag to extend, the instance's renovate.json and examples/renovate.json carry the same rules
// inline, so this keeps them equal to the preset plus their own keys. And every action the public workflows use is
// pinned to a full commit SHA with a version comment. No network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../lib/config.js');

const REPO = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const PRESET = read(path.join(REPO, 'renovate', 'steward.json'));
// a config repo's own keys: which managers it enables, what it ignores, its description and schema
const OWN = new Set(['$schema', 'description', 'enabledManagers', 'ignoreDeps', 'extends']);
const POLICY = ['minimumReleaseAge', 'internalChecksFilter', 'osvVulnerabilityAlerts', 'vulnerabilityAlerts'];
const strip = rules => rules.map(({ description, ...r }) => r);   // descriptions may word things for their reader

test('renovate: the instance and the examples carry exactly the preset rules, plus their own keys', () => {
  for (const f of [path.join(REPO, 'examples', 'renovate.json'), C.instance('renovate.json')]) {
    if (!fs.existsSync(f)) continue;
    const cfg = read(f);
    for (const k of POLICY) assert.deepEqual(cfg[k], PRESET[k], `${f}: ${k}`);
    assert.deepEqual(strip(cfg.packageRules), strip(PRESET.packageRules), `${f}: packageRules differ from renovate/steward.json`);
    for (const k of Object.keys(cfg)) assert.ok(OWN.has(k) || POLICY.includes(k) || k === 'packageRules', `${f}: ${k} isn't a preset or repo-own key`);
  }
});

test('renovate: the public repo pins actions by digest and extends its own preset', () => {
  const pub = read(path.join(REPO, '.github', 'renovate.json'));
  assert.ok(pub.extends.includes('helpers:pinGitHubActionDigests'));
  assert.ok(pub.extends.includes('local>pacphi/workstation-steward//renovate/steward'));
  assert.deepEqual([...pub.enabledManagers].sort(), ['github-actions', 'mise', 'npm']);
});

test('workflows: every action the public repo runs is pinned to a commit SHA with a version comment', () => {
  const listed = fs.readFileSync(path.join(REPO, 'tools', 'public.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => /^\.github\/workflows\/.+\.ya?ml$/.test(l));
  assert.ok(listed.length > 0);
  for (const f of listed) {
    for (const line of fs.readFileSync(path.join(REPO, f), 'utf8').split('\n').filter(l => /^\s*-?\s*uses:/.test(l))) {
      assert.match(line, /uses: [\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+(\.\d+)*$/, `${f}: ${line.trim()}`);
    }
  }
});
