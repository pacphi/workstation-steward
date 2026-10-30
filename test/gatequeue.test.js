// lib/gatequeue.js and its part of lib/review.js (D56): Renovate's Dependency Dashboard read into the release-age
// gate's queue, each update's clear time and next step, the review's section and the banner line. A fake runner
// stands in for gh and npm; the state folder is a temporary XDG_STATE_HOME. No network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-gate-')));
process.env.XDG_STATE_HOME = ROOT;
process.env.STEWARD_INSTANCE = process.env.STEWARD_INSTANCE || path.join(__dirname, '..', 'examples');
const STATE = path.join(ROOT, 'workstation-steward');
const GQ = require('../lib/gatequeue.js');
const { gateSection, render } = require('../lib/review.js');

// a dashboard as Renovate writes it: the three waiting headings, then Detected Dependencies and the manual job
const BODY = [
  'This issue lists Renovate updates and detected dependencies. Read the [Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/) docs to learn more.',
  '',
  '## Pending Approval',
  '',
  'The following branches are pending approval. To create them, click on a checkbox below.',
  '',
  ' - [ ] <!-- approve-branch=renovate/npm-agent-browser-0.x -->chore(deps): update dependency npm:agent-browser to v0.39.4',
  ' - [ ] <!-- approve-branch=renovate/npm-left-pad-1.x -->chore(deps): update dependency npm:left-pad to v1.4.0',
  '',
  '## Awaiting Schedule',
  '',
  'The following updates are awaiting their schedule. To get an update now, click on a checkbox below.',
  '',
  ' - [ ] <!-- unschedule-branch=renovate/mise-tools -->chore(deps): update mise tools to latest (`coder`, `pnpm`, `uv`)',
  '',
  '## Pending Status Checks',
  '',
  'The following updates await pending status checks. To force their creation now, click on a checkbox below.',
  '',
  ' - [ ] <!-- unpend-branch=renovate/npm-agentic-qe-3.x -->chore(deps): update dependency npm:agentic-qe to v3.15.17',
  ' - [ ] <!-- unpend-branch=renovate/jdx-mise-action-5.x -->chore(deps): update jdx/mise-action action to v5.2.4',
  ' - [ ] <!-- unpend-branch=renovate/node-26.x -->chore(deps): update node.js to v26.13.0',
  ' - [ ] <!-- unpend-branch=renovate/flyctl-0.x-lockfile -->chore(deps): update dependency flyctl to latest',
  ' - [ ] <!-- unpend-branch=renovate/node-26.x -->chore(deps): update dependency @types/node to v26.6.6',
  'a line Renovate never writes',
  '',
  '## Detected Dependencies',
  '',
  '<details><summary>mise (1)</summary>',
  ' - `node 26.12.1` → [Updates: `26.13.0`]',
  '</details>',
  '',
  '---',
  '',
  '- [ ] <!-- manual job -->Check this box to trigger a request for Renovate to run again on this repository',
].join('\n');

// publish times, as npm and GitHub report them
const NPM = { 'agent-browser': { '0.39.4': '2026-10-26T05:52:35Z' }, 'agentic-qe': { '3.15.17': '2026-10-28T14:18:43.173Z' }, '@types/node': { '26.6.6': '2026-10-28T18:36:36.455Z' } };
const GH = { 'jdx/mise-action/releases/tags/v5.2.4': '2026-10-27T10:06:24Z', 'nodejs/node/releases/tags/v26.13.0': '2026-10-28T16:57:41Z' };
const calls = [];
const fakeRun = (dashboards) => async (cmd, args) => {
  calls.push([cmd, ...args].join(' '));
  if (cmd === 'npm') return NPM[args[1]] ? JSON.stringify(NPM[args[1]]) : null;
  if (cmd === 'gh' && args[0] === 'api') { const k = args[1].replace(/^repos\//, ''); return GH[k] ? JSON.stringify({ published_at: GH[k] }) : null; }
  if (cmd === 'gh' && args[0] === 'issue') { const repo = args[args.indexOf('--repo') + 1]; return repo in dashboards ? JSON.stringify(dashboards[repo]) : null; }
  return null;
};
const NOW = new Date('2026-10-30T12:00:00Z');
const OWNED = new Set(['npm:agentic-qe', 'npm:agent-browser']);

test('parseDashboard: the three waiting headings, each checkbox with its dep and version; everything else skipped', () => {
  const items = GQ.parseDashboard(BODY);
  assert.deepEqual(items.map(i => [i.section, i.dep, i.version]), [
    ['pending-approval', 'npm:agent-browser', '0.39.4'],
    ['pending-approval', 'npm:left-pad', '1.4.0'],
    ['awaiting-schedule', 'mise tools', null],
    ['pending-checks', 'npm:agentic-qe', '3.15.17'],
    ['pending-checks', 'jdx/mise-action', '5.2.4'],
    ['pending-checks', 'node.js', '26.13.0'],
    ['pending-checks', 'flyctl', null],
    ['pending-checks', '@types/node', '26.6.6'],
  ]);
  assert.equal(items[0].title, 'chore(deps): update dependency npm:agent-browser to v0.39.4');
  assert.equal(items[6].branch, 'renovate/flyctl-0.x-lockfile');
  assert.deepEqual(GQ.parseDashboard(''), []);
  assert.deepEqual(GQ.parseDashboard('## Open\n\n - [ ] chore(deps): update dependency x to v1.0.0'), []);
});

test('parseTitle: with or without a Conventional Commit prefix, a [SECURITY] tag, or a digest', () => {
  assert.deepEqual(GQ.parseTitle('Update dependency jdx/mise to v2026.10.24'), { dep: 'jdx/mise', version: '2026.10.24' });
  assert.deepEqual(GQ.parseTitle('fix(deps): update dependency npm:x to v1.2.3 [SECURITY]'), { dep: 'npm:x', version: '1.2.3' });
  assert.deepEqual(GQ.parseTitle('chore(deps): update actions/checkout digest to abc1234'), { dep: 'actions/checkout digest', version: null });
  assert.deepEqual(GQ.parseTitle('chore(deps): lock file maintenance'), { dep: null, version: null });
});

test('clearsAt: published plus the gate in days; unknown stays unknown', () => {
  assert.equal(GQ.clearsAt(new Date('2026-10-28T14:18:43Z'), 3).toISOString(), '2026-10-31T14:18:43.000Z');
  assert.equal(GQ.clearsAt('2026-10-28T14:18:43Z', 7).toISOString(), '2026-11-04T14:18:43.000Z');
  assert.equal(GQ.clearsAt(null, 3), null);
});

test('publishedAt: npm for npm: and scoped names, GitHub releases for owner/repo and Node, null for "latest"', async () => {
  const run = fakeRun({});
  assert.equal((await GQ.publishedAt('npm:agentic-qe', '3.15.17', run)).toISOString(), '2026-10-28T14:18:43.173Z');
  assert.equal((await GQ.publishedAt('@types/node', '26.6.6', run)).toISOString(), '2026-10-28T18:36:36.455Z');
  assert.equal((await GQ.publishedAt('jdx/mise-action', '5.2.4', run)).toISOString(), '2026-10-27T10:06:24.000Z');
  assert.equal((await GQ.publishedAt('node.js', '26.13.0', run)).toISOString(), '2026-10-28T16:57:41.000Z');
  assert.equal(await GQ.publishedAt('flyctl', null, run), null);
  assert.equal(await GQ.publishedAt('mise tools', null, run), null);
  // a bare name counts only when npm has that exact version (a mise tool by the same name is not the npm package)
  assert.equal(await GQ.publishedAt('biome', '2.6.4', run), null);
  // npm 12 wraps the time map in an array
  assert.equal((await GQ.publishedAt('npm:wrapped', '2.0.0', async () => '[{"created":"2026-01-01T00:00:00Z","2.0.0":"2026-10-02T00:00:00Z"}]')).toISOString(), '2026-10-02T00:00:00.000Z');
  // a release tagged without the v is found too
  assert.equal((await GQ.publishedAt('acme/cli', '1.0.0', async (_c, a) => (a[1] === 'repos/acme/cli/releases/tags/1.0.0' ? '{"published_at":"2026-10-01T00:00:00Z"}' : null))).toISOString(), '2026-10-01T00:00:00.000Z');
});

test('nextStep: wait, cleared, approval (AI-owned or not), schedule, 0.x, Node', () => {
  const at = s => new Date(s);
  const step = (i, o = {}) => GQ.nextStep(i, { aiOwned: OWNED, now: NOW, ...o });
  assert.equal(step({ section: 'pending-checks', dep: 'npm:x', version: '1.2.3', clearsAt: at('2026-10-31T06:17:11Z') }), 'wait until 2026-10-31 06:17Z');
  assert.equal(step({ section: 'pending-checks', dep: 'npm:x', version: '1.2.3', clearsAt: at('2026-10-29T06:17:11Z') }), 'Renovate opens the PR');
  assert.equal(step({ section: 'pending-checks', dep: 'flyctl', version: null, clearsAt: null, branch: 'renovate/flyctl-0.x-lockfile' }),
    'Renovate opens the PR once it clears (it times it); 0.x: a minor is a major; read its changes');
  assert.equal(step({ section: 'pending-checks', dep: 'npm:@openai/codex', version: '0.166.0', clearsAt: at('2026-11-01T19:56:19Z') }),
    'wait until 2026-11-01 19:56Z; 0.x: a minor is a major; read its changes');
  assert.equal(step({ section: 'pending-approval', dep: 'npm:agentic-qe', version: '3.15.17', clearsAt: at('2026-10-29T00:00:00Z') }), 'qualify first (skills/ai-tooling/runbook.md), then tick it');
  assert.equal(step({ section: 'pending-approval', dep: 'npm:left-pad', version: '1.4.0', clearsAt: at('2026-10-31T00:00:00Z') }), 'review, then tick it; it clears the gate 2026-10-31 00:00Z');
  assert.equal(step({ section: 'awaiting-schedule', dep: 'mise tools', version: null, clearsAt: null }), 'waits for its schedule; past the gate already');
  assert.equal(step({ section: 'pending-checks', dep: 'node.js', version: '26.13.0', clearsAt: at('2026-10-31T16:57:41Z') }), 'wait until 2026-10-31 16:57Z; after the merge: steward sc node-patch 26.13.0');
  assert.equal(step({ section: 'pending-checks', dep: 'npm:agentic-qe', version: '3.15.17', clearsAt: at('2026-10-31T14:18:43Z') }), 'wait until 2026-10-31 14:18Z; qualify it before the merge (skills/ai-tooling/runbook.md)');
  assert.equal(GQ.nextStep({ section: 'pending-approval', dep: 'npm:agentic-qe', version: '3.15.17', clearsAt: null }, { now: NOW }), 'review, then tick it');
});

test('queue: every repo read once, cleared first then by clear time, unknown times last; the cache written', async () => {
  const cache = path.join(ROOT, 'q', 'gate-queue.json');
  const run = fakeRun({ 'acme/tools-config': [{ number: 3, body: BODY }], 'acme/widgets': [], 'acme/empty': [{ number: 9, body: '## Detected Dependencies\n' }] });
  const q = await GQ.queue({ repos: ['acme/tools-config', 'acme/widgets', 'acme/gone', 'acme/tools-config', null, 'acme/empty'], now: NOW, run, days: 3, aiOwned: OWNED, cache });
  assert.deepEqual(q.unreadable, ['acme/gone']);
  assert.deepEqual(q.none, ['acme/widgets']);
  assert.equal(calls.filter(c => c.includes('--repo acme/tools-config')).length, 1);
  assert.ok(calls.some(c => c === 'gh issue list --repo acme/tools-config --state open --author app/renovate --search Dependency Dashboard in:title --json number,body'));
  assert.deepEqual(q.rows.map(r => r.dep), ['npm:agent-browser', 'jdx/mise-action', 'npm:agentic-qe', 'node.js', '@types/node', 'flyctl', 'npm:left-pad', 'mise tools']);
  assert.deepEqual(q.rows.map(r => r.clearsAt && r.clearsAt.toISOString().slice(0, 16)), ['2026-10-29T05:52', '2026-10-30T10:06', '2026-10-31T14:18', '2026-10-31T16:57', '2026-10-31T18:36', null, null, null]);
  const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(c.at, NOW.toISOString());
  assert.deepEqual(Object.keys(c.rows[0]).sort(), ['clearsAt', 'next', 'repo', 'section', 'title']);
  assert.equal(c.rows[2].next, 'wait until 2026-10-31 14:18Z; qualify it before the merge (skills/ai-tooling/runbook.md)');
});

test('bannerLine: counts what cleared since the review that cached it; nothing otherwise', () => {
  const cache = { at: '2026-10-30T12:00:00Z', rows: [
    { clearsAt: '2026-10-29T05:52:35Z' },   // cleared before the review: the review already said so
    { clearsAt: '2026-10-31T14:18:43Z' },
    { clearsAt: '2026-10-31T16:57:41Z' },
    { clearsAt: null },
  ] };
  assert.equal(GQ.bannerLine(cache, new Date('2026-10-30T13:00:00Z')), null);
  assert.equal(GQ.bannerLine(cache, new Date('2026-10-31T15:00:00Z')), '1 queued update(s) cleared the gate since the last review: steward review');
  assert.equal(GQ.bannerLine(cache, new Date('2026-11-01T00:00:00Z')), '2 queued update(s) cleared the gate since the last review: steward review');
  assert.equal(GQ.bannerLine(null), null);
  assert.equal(GQ.bannerLine({ at: 'x' }), null);
});

test('review: "Waiting on the release-age gate" lists each update with its next step, cleared first', async () => {
  const run = fakeRun({ 'acme/tools-config': [{ number: 3, body: BODY }], 'acme/widgets': [] });
  const s = await gateSection(['acme/tools-config', 'acme/widgets', 'acme/tools-config'], { now: NOW, run, days: 3, aiOwned: OWNED, cache: path.join(ROOT, 'r', 'gate-queue.json') });
  assert.equal(s.title, 'Waiting on the release-age gate');
  assert.equal(s.items.length, 8);
  assert.equal(s.items[0].text, 'acme/tools-config: update dependency npm:agent-browser to v0.39.4 (waits for a tick, cleared 2026-10-29 05:52Z)');
  assert.equal(s.items[0].how, 'qualify first (skills/ai-tooling/runbook.md), then tick it; 0.x: a minor is a major; read its changes');
  assert.match(s.note, /^2 repo\(s\) read, 1 with no Dependency Dashboard\. 2 past the gate\. Read-only: never tick "Pending Status Checks"/);
  const { md } = render([s], NOW, false);
  assert.ok(md.includes('## Waiting on the release-age gate · 8'));
  assert.ok(md.includes('- acme/tools-config: update jdx/mise-action action to v5.2.4 (held by the gate, cleared 2026-10-30 10:06Z)  \n  → Renovate opens the PR\n'));
  assert.ok(md.includes('- acme/tools-config: update node.js to v26.13.0 (held by the gate, clears 2026-10-31 16:57Z)  \n  → wait until 2026-10-31 16:57Z; after the merge: steward sc node-patch 26.13.0\n'));
  assert.ok(md.includes('- acme/tools-config: update mise tools to latest (`coder`, `pnpm`, `uv`) (waits for its schedule)  \n  → waits for its schedule; past the gate already'));
  assert.ok(md.indexOf('agent-browser') < md.indexOf('mise-action') && md.indexOf('mise-action') < md.indexOf('agentic-qe'));
});

test('review: an empty queue says nothing waits', async () => {
  const s = await gateSection(['acme/widgets'], { now: NOW, run: fakeRun({ 'acme/widgets': [] }), days: 3, aiOwned: OWNED, cache: false });
  assert.deepEqual(s.items, []);
  assert.equal(s.note, '1 repo(s) read, 1 with no Dependency Dashboard. nothing waiting');
});

test('banner: says when queued updates cleared the gate since the last review, from the cache alone', () => {
  const dir = path.join(STATE, 'review');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 2 * 864e5).toISOString();
  fs.writeFileSync(path.join(dir, 'last-review.json'), JSON.stringify({ at }));   // a review 2 days ago: not due
  const banner = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'review.js'), '--banner'], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: ROOT, NO_COLOR: '1' } });
  fs.writeFileSync(path.join(dir, 'gate-queue.json'), JSON.stringify({ at, rows: [
    { repo: 'acme/tools-config', title: 'a', section: 'pending-checks', clearsAt: new Date(Date.now() - 864e5).toISOString(), next: 'Renovate opens the PR' },
    { repo: 'acme/tools-config', title: 'b', section: 'pending-checks', clearsAt: new Date(Date.now() + 864e5).toISOString(), next: 'wait' },
  ] }));
  const r = banner();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 queued update\(s\) cleared the gate since the last review: steward review/);
  assert.doesNotMatch(r.stdout, /review due/);
  // nothing cleared yet: no line
  fs.writeFileSync(path.join(dir, 'gate-queue.json'), JSON.stringify({ at, rows: [{ clearsAt: new Date(Date.now() + 864e5).toISOString() }] }));
  assert.equal(banner().stdout, '');
});
