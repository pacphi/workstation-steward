// lib/review.js: how the weekly review turns each area's output into its report. Fixed inputs; no network, and the
// review itself (which runs the audit and reads GitHub) is not run. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.STEWARD_INSTANCE = process.env.STEWARD_INSTANCE || path.join(__dirname, '..', 'examples');
const { auditItems, driftItems, fleetTable, render } = require('../lib/review.js');

// the audit off a terminal: each finding as its check finds it, then again under the Summary
const AUDIT = [
  '\x1b[1;34m==>\x1b[0m mise (newest past the gate) \x1b[2m[0:01]\x1b[0m',
  '  \x1b[1;33mACTION\x1b[0m mise: 2026.10.18 -> 2026.10.19 (4d old): steward sc upgrade-tool mise',
  '\x1b[1;34m==>\x1b[0m Homebrew \x1b[2m[0:02]\x1b[0m',
  '  \x1b[1;33mACTION\x1b[0m brew: python@3.15 3.15.1 -> 3.15.2 (3d old)',
  '  \x1b[1;33mACTION\x1b[0m cask: some-cask 1.0 -> 1.1 (4d old)',
  '\x1b[1;34m==>\x1b[0m Apps \x1b[2m[0:03]\x1b[0m',
  '  \x1b[1;33mACTION\x1b[0m app: Editor bundles Electron 39.2.3 (supported: 43+); update it, or ask the vendor',
  '  \x1b[1;33mACTION\x1b[0m app: Browser 1.0 -> 1.1 (0d old; always_current: update now)',
  '  \x1b[1;33mACTION\x1b[0m appstore: 123  Chat  (4.52 -> 4.53)',
  '  \x1b[1;33mACTION\x1b[0m docker: container db runs floating db:latest; pin tag@digest',
  '  \x1b[1;31mALERT\x1b[0m some-ioc: file present /tmp/x',
  '\x1b[1;34m==>\x1b[0m Summary: 8 action(s), 1 alert(s) \x1b[2m[0:04]\x1b[0m',
  '  ALERT  some-ioc: file present /tmp/x',
  '  ACTION mise: 2026.10.18 -> 2026.10.19 (4d old): steward sc upgrade-tool mise',
  '  ACTION brew: python@3.15 3.15.1 -> 3.15.2 (3d old)',
  '  ACTION cask: some-cask 1.0 -> 1.1 (4d old)',
  '  ACTION app: Editor bundles Electron 39.2.3 (supported: 43+); update it, or ask the vendor',
  '  ACTION app: Browser 1.0 -> 1.1 (0d old; always_current: update now)',
  '  ACTION appstore: 123  Chat  (4.52 -> 4.53)',
  '  ACTION docker: container db runs floating db:latest; pin tag@digest',
  '  Next: steward sc plan (Homebrew + mise); apps, App Store, macOS and trust are manual.',
].join('\n');

test('auditItems: each finding once, though the audit prints it twice off a terminal', () => {
  const items = auditItems(AUDIT);
  assert.equal(items.length, 8);
  assert.equal(new Set(items.map(i => i.text)).size, 8);
});

test('auditItems: a timed-out audit (no Summary) still gives the findings it printed', () => {
  assert.equal(auditItems(AUDIT.slice(0, AUDIT.indexOf('==> Summary'))).length, 8);
});

test('auditItems: each finding gets what fixes it: its own command, steward sc upgrade, or a step by hand', () => {
  const by = Object.fromEntries(auditItems(AUDIT).map(i => [i.text.split(':')[0] + (i.text.includes('Browser') ? '+' : ''), i]));
  assert.deepEqual(by.mise, { text: 'mise: 2026.10.18 -> 2026.10.19 (4d old)', cmd: 'steward sc upgrade-tool mise' });
  assert.equal(by.brew.cmd, 'steward sc plan, then steward sc upgrade');
  assert.equal(by.cask.cmd, 'steward sc plan, then steward sc upgrade');
  for (const k of ['app', 'app+', 'appstore', 'docker']) { assert.equal(by[k].cmd, undefined, k); assert.match(by[k].how, /^by hand: /, k); }
  assert.equal(by.app.text, 'app: Editor bundles Electron 39.2.3 (supported: 43+)');
  assert.match(by.ALERT.cmd, /supply-chain\/runbook\.md/);
});

test('driftItems: a project finding that names its fix files under it without repeating the path', () => {
  const items = driftItems([
    { level: 'DRIFT', area: 'project', msg: '/w/p: chose ruflo but has none of its files: steward projects onboard /w/p' },
    { level: 'DRIFT', area: 'project', msg: '/w/p: chose aqe but has none of its files: steward projects onboard /w/p' },
    { level: 'WARN', area: 'project', msg: '/w/p: AQE hooks set transport v1 inline: steward projects onboard /w/p --replace-older' },
    { level: 'DRIFT', area: 'project', msg: '/w/p: Ruflo present but autoStart is unset' },
    { level: 'WARN', area: 'aqe upstream', msg: '3.15.14 published' },
    { level: 'ok', area: 'ruflo', msg: 'fine' },
  ]);
  assert.equal(items.length, 5);
  assert.equal(items[0].text, 'DRIFT: chose ruflo but has none of its files');
  // onboard and onboard --replace-older for one project: the second does all the first does, so both list under it
  assert.deepEqual(items.slice(0, 3).map(i => i.cmd), Array(3).fill('steward projects onboard /w/p --replace-older'));
  assert.match(items[3].text, /^DRIFT: project: \/w\/p: Ruflo present/);
  assert.match(items[3].cmd, /^steward ai drift; /);
  assert.equal(items[4].text, 'WARN: aqe upstream: 3.15.14 published');
});

test('fleetTable: worst first (critical, high, medium, low, then bot PRs), blanks for none', () => {
  const t = fleetTable([
    { repo: 'o/prs', bots: 40, sev: {} },
    { repo: 'o/high', bots: 1, sev: { high: 9 } },
    { repo: 'o/crit', bots: 0, sev: { critical: 1, low: 2 } },
    { repo: 'o/high2', bots: 5, sev: { high: 9 } },
  ]);
  assert.deepEqual(t.head, ['repo', 'critical', 'high', 'medium', 'low', 'bot PRs']);
  assert.deepEqual(t.rows.map(r => r[0]), ['o/crit', 'o/high2', 'o/high', 'o/prs']);
  assert.deepEqual(t.rows[0], ['o/crit', '1', '', '', '2', '']);
});

test('render: each shared command shows once over its items; items with their own keep theirs; tables count', () => {
  const { md, n } = render([
    { title: 'Supply chain', items: auditItems(AUDIT) },
    { title: 'Pull requests', items: [{ text: '#1 a', cmd: 'gh pr view 1' }, { text: '#2 b', cmd: 'gh pr view 2' }] },
    { title: 'Fleet', items: [], note: '2 repos checked', table: fleetTable([{ repo: 'o/a', bots: 3, sev: {} }]) },
    { title: 'Projects', items: [], note: 'nothing new or gone' },
  ], new Date('2026-10-29T12:00:00Z'), false);
  assert.equal(n, 11);
  assert.ok(md.startsWith('# Steward review, 2026-10-29\n\n11 item(s) to decide.'));
  assert.equal(md.split('steward sc plan, then steward sc upgrade').length - 1, 1);
  assert.ok(md.includes('### → `steward sc plan, then steward sc upgrade`\n\n- brew: python@3.15 3.15.1 -> 3.15.2 (3d old)\n- cask: some-cask'));
  assert.ok(md.includes('### → by hand: update each app (its own updater), or ask its vendor\n\n- app: Editor'));
  assert.ok(md.includes('- #1 a  \n  → `gh pr view 1`\n- #2 b  \n  → `gh pr view 2`'));
  assert.ok(md.includes('## Fleet · 1\n\n2 repos checked\n\n| repo | critical | high | medium | low | bot PRs |\n| --- | ---: |'));
  assert.ok(md.includes('## Projects\n\nnothing new or gone'));
});
