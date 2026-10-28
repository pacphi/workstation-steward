// Tests for `projects reconcile` (lib/reconcile.js, D42) on throwaway Git repos: onboard with the stand-in installs,
// change the stand-ins as a new release would, then plan, apply and roll back. Always the stand-ins, never the real
// installs, since simulating a release means editing them. Backups and receipts go to a temporary XDG_STATE_HOME.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-reconcile-')));
process.env.XDG_STATE_HOME = path.join(ROOT, 'state');
process.env.XDG_CONFIG_HOME = path.join(ROOT, 'xdg');
process.env.GIT_CONFIG_GLOBAL = path.join(ROOT, 'gitconfig');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
process.env.STEWARD_TEST_FIXTURES = '1';
const FX = require('./fixtures.js').setup(ROOT);
const P = require('../lib/projects.js');
const O = require('../lib/onboard.js');
const F = require('../lib/profiles.js');
const R = require('../lib/reconcile.js');
const TOOLS = ['ruflo', 'aqe', 'brain'];
const itest = (name, fn) => test(name, { skip: FX.needs }, fn);

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => fs.readFileSync(file, 'utf8');
function repo(name, files = {}) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  write(path.join(dir, 'go.mod'), 'module x\n');
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const entry = dir => ({ path: P.tilde(dir), decision: 'onboarded', ai: TOOLS });
const onboard = dir => O.apply(O.plan(dir, { entry: entry(dir) }), { skipTransportCheck: true });
const plan = (dir, take) => R.plan(dir, { entry: entry(dir), take });
const unit = (p, u) => p.units.find(x => x.unit === u);

// The stand-in sources, from the profiles: a new release is an edit here, undone after each test
const src = {};
for (const c of F.render(TOOLS, ROOT).copies) src[`${c.tool}:${c.to}`] = c.from;
const HELPER = '.claude/helpers/router.cjs', SKILL = '.claude/skills/qe-test-generation', HOOK = '.claude/hooks/aqe-hook.cjs';
let undoRelease = [];
// release(copy, rel, text) — the qualified install now ships rel under a tool's copied folder ('<tool>:<to>'), or the
// single copied file itself (rel null), with text; text null drops it
function release(copy, rel, text) {
  const f = rel ? path.join(src[copy], rel) : src[copy];
  const before = fs.existsSync(f) ? read(f) : null;
  undoRelease.push(() => (before === null ? fs.rmSync(f, { force: true }) : fs.writeFileSync(f, before)));
  if (text === null) fs.rmSync(f, { recursive: true, force: true }); else write(f, text);
}
test.afterEach(() => { for (const u of undoRelease.reverse()) u(); undoRelease = []; });

itest('an untouched copy is updated, an edited one kept, and the rest current; rollback puts it back', () => {
  const dir = repo('basic');
  onboard(dir);
  assert.deepEqual(R.todo(plan(dir)), [], 'right after onboarding everything is current');
  release('ruflo:.claude/helpers', 'router.cjs', '// router, new release\n');
  release('aqe:.claude/skills', 'qe-test-generation/SKILL.md', '# qe-test-generation, new release\n');
  release(`aqe:${HOOK}`, null, '// aqe-hook, new release\n');
  write(path.join(dir, SKILL, 'SKILL.md'), '# my own edits\n');
  const p = plan(dir);
  assert.equal(unit(p, HELPER).action, 'update');
  assert.equal(unit(p, HELPER).locked, true, "Ruflo's helpers hold .LOCKED, and are still updated (the steward's own refresh)");
  assert.equal(unit(p, HOOK).action, 'update', 'single copied files too');
  assert.equal(unit(p, SKILL).state, 'edited');
  assert.equal(unit(p, SKILL).action, 'none');
  assert.equal(unit(p, '.claude/skills/swarm-orchestration').state, 'current');
  assert.equal(unit(p, '.claude/skills/swarm-orchestration').tool, 'ruflo', 'the shared name stays Ruflo\'s (D26)');
  assert.match(R.diff(dir, SKILL, path.join(src['aqe:.claude/skills'], 'qe-test-generation')), /my own edits[\s\S]*new release/);

  const rp = R.apply(p);
  assert.equal(read(path.join(dir, HELPER)), '// router, new release\n');
  assert.equal(read(path.join(dir, HOOK)), '// aqe-hook, new release\n');
  assert.equal(read(path.join(dir, SKILL, 'SKILL.md')), '# my own edits\n', 'your edit wins');
  const rc = JSON.parse(read(rp));
  assert.equal(rc.kind, 'reconcile');
  assert.equal(rc.complete, true);
  assert.deepEqual(rc.entries.map(e => e.path).sort(), [HOOK, HELPER].sort());
  assert.deepEqual(R.todo(plan(dir)), [], 'the receipt is the new baseline');

  assert.deepEqual(R.changedSince(rc), []);
  R.undo(rc);
  R.markRolledBack(rp);
  assert.equal(read(path.join(dir, HELPER)), '// stand-in Ruflo helper router.cjs\n');
  // the rolled-back receipt no longer counts: the onboard receipt is the baseline again, so it is behind, not edited
  assert.equal(unit(plan(dir), HELPER).action, 'update');
});

itest('--take takes the new version of an edited unit, and adopts one with no baseline', () => {
  const dir = repo('take');
  write(path.join(dir, '.claude/helpers/statusline.cjs'), '// from an old ruflo init\n');
  onboard(dir);
  release('aqe:.claude/skills', 'qe-test-generation/SKILL.md', '# new\n');
  write(path.join(dir, SKILL, 'SKILL.md'), '# mine\n');
  const before = plan(dir);
  assert.equal(unit(before, '.claude/helpers/statusline.cjs').state, 'yours', 'there before onboarding: no baseline');
  const p = plan(dir, [`./${SKILL}/`, '.claude/helpers/statusline.cjs']);
  assert.equal(unit(p, SKILL).action, 'take');
  assert.equal(unit(p, '.claude/helpers/statusline.cjs').action, 'take');
  R.apply(p);
  assert.equal(read(path.join(dir, SKILL, 'SKILL.md')), '# new\n');
  assert.equal(read(path.join(dir, '.claude/helpers/statusline.cjs')), '// stand-in Ruflo helper statusline.cjs\n');
  assert.deepEqual(plan(dir).units.filter(u => u.state !== 'current').map(u => u.unit), []);
});

itest('a known, unedited vendor copy of an AQE file counts as untouched (D25)', () => {
  const dir = repo('vendor');
  onboard(dir);
  release(`aqe:${HOOK}`, null, '// aqe-hook, new release\n');
  const old = '// aqe-hook as an older AQE release shipped it\n';
  write(path.join(dir, HOOK), old);
  assert.equal(unit(plan(dir), HOOK).state, 'edited', 'not a known vendor file: kept');
  const known = F.knownVendor(); // loaded once and cached, so a test entry holds for this run
  const h = require('crypto').createHash('sha256').update(old).digest('hex');
  known.set(h, { file: HOOK, origin: 'test release' });
  try {
    assert.equal(unit(plan(dir), HOOK).action, 'update');
    known.set(h, { file: '.claude/helpers/brain-checkpoint.cjs', origin: 'test release' });
    assert.equal(unit(plan(dir), HOOK).state, 'edited', 'only for the file it was shipped as');
  } finally { known.delete(h); }
});

itest('a unit with no receipt that is an unedited copy of a published release is updated (known-units.json)', () => {
  const dir = repo('released');
  const old = '// statusline as an older Ruflo release shipped it\n';
  write(path.join(dir, '.claude/helpers/statusline.cjs'), old); // there before onboarding: no receipt
  write(path.join(dir, '.claude/helpers/router.cjs'), '// customized\n');
  onboard(dir);
  assert.equal(unit(plan(dir), '.claude/helpers/statusline.cjs').state, 'yours');
  const released = F.knownUnits(); // loaded once and cached, so a test entry holds for this run
  const u = '.claude/helpers/statusline.cjs';
  const before = released.get(u);
  released.set(u, new Map([[require('crypto').createHash('sha256').update(old).digest('hex'), '@claude-flow/cli 3.0.0…3.1.0']]));
  try {
    const p = plan(dir);
    assert.equal(unit(p, u).action, 'update');
    assert.equal(unit(p, u).released, '@claude-flow/cli 3.0.0…3.1.0');
    assert.equal(unit(p, '.claude/helpers/router.cjs').state, 'yours', 'a copy no release shipped stays yours');
    R.apply(p);
    assert.equal(read(path.join(dir, u)), '// stand-in Ruflo helper statusline.cjs\n');
    assert.equal(unit(plan(dir), u).state, 'current', 'the receipt is its baseline now');
  } finally { if (before) released.set(u, before); else released.delete(u); }
});

itest('missing and no-longer-shipped units are reported, never written', () => {
  const dir = repo('report');
  onboard(dir);
  fs.rmSync(path.join(dir, '.claude/commands/aqe-generate.md'));
  release('ruflo:.claude/agents', 'core/coder.md', null);
  const p = plan(dir);
  assert.equal(unit(p, '.claude/commands/aqe-generate.md').state, 'missing');
  assert.equal(unit(p, '.claude/agents/core/coder.md').state, 'dropped');
  assert.ok(p.units.every(u => !['missing', 'dropped'].includes(u.state) || u.action === 'none'));
  assert.deepEqual(R.todo(p), []);
});

itest('a tracked unit goes through a PR, never written', () => {
  const dir = repo('tracked');
  onboard(dir);
  git(dir, 'add', '-f', HELPER);
  git(dir, 'commit', '-q', '-m', 'track a helper');
  release('ruflo:.claude/helpers', 'router.cjs', '// new\n');
  const p = plan(dir);
  assert.equal(unit(p, HELPER).action, 'pr');
  const rc = JSON.parse(read(R.apply(p)));
  assert.deepEqual(rc.entries, []);
  assert.deepEqual(rc.pr, [HELPER]);
  assert.equal(read(path.join(dir, HELPER)), '// stand-in Ruflo helper router.cjs\n');
});

itest('a unit that changed after the plan stops the apply, and what was applied is undone', () => {
  const dir = repo('raced');
  onboard(dir);
  release('ruflo:.claude/helpers', 'hook-handler.cjs', '// new\n');
  release('ruflo:.claude/helpers', 'router.cjs', '// new\n');
  const p = plan(dir);
  const [first, second] = R.todo(p).map(u => u.unit).sort();
  write(path.join(dir, second), '// edited after the plan\n');
  assert.throws(() => R.apply(p), /changed since the plan/);
  assert.equal(read(path.join(dir, first)), `// stand-in Ruflo helper ${path.basename(first)}\n`, 'the first unit is back');
  assert.equal(read(path.join(dir, second)), '// edited after the plan\n');
});

itest('receipts from before the newest offboard are not baselines', () => {
  const dir = repo('offboarded');
  onboard(dir);
  assert.ok(R.baselines(P.tilde(dir)).has(HELPER));
  const off = path.join(process.env.XDG_STATE_HOME, 'workstation-steward', 'backups', 'offboard-offboarded-x');
  fs.mkdirSync(off, { recursive: true });
  fs.writeFileSync(path.join(off, 'receipt.json'), JSON.stringify({ kind: 'offboard', at: new Date(Date.now() + 1000).toISOString(), project: P.tilde(dir), entries: [], complete: true }));
  assert.equal(R.baselines(P.tilde(dir)).size, 0);
  assert.equal(unit(plan(dir), HELPER).state, 'current', 'still equal to the source');
  release('ruflo:.claude/helpers', 'router.cjs', '// new\n');
  assert.equal(unit(plan(dir), HELPER).state, 'yours');
});

itest('the banner repeats what the last full plan found, and notices a promotion since', () => {
  const dir = repo('banner');
  onboard(dir);
  assert.equal(R.bannerLine(), null, 'no full plan yet: nothing to compare');
  release('ruflo:.claude/helpers', 'router.cjs', '// new\n');
  R.noteSeen([plan(dir)], { all: true });
  assert.deepEqual(R.behind([plan(dir)]).map(b => [b.project, b.update]), [[P.tilde(dir), 1]]);
  assert.match(R.bannerLine(), /^1 project\(s\) behind the qualified AI tools: steward projects reconcile --all$/);
  R.apply(plan(dir));
  R.noteSeen([plan(dir)]); // one project's plan updates only its own line
  assert.equal(R.bannerLine(), null);
  // a promotion: the AQE package the profiles copy from is another version now
  const pkg = path.join(F.placeholders(ROOT).AQE_PKG, 'package.json');
  write(pkg, '{"version":"9.9.9"}\n');
  undoRelease.push(() => fs.rmSync(pkg, { force: true }));
  assert.match(R.bannerLine(), /^aqe changed since the last reconcile check/);
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
