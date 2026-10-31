// The explainer site (docs/explainer.html, published by .github/workflows/pages.yml on demand): every steward command
// it names exists in lib/commands.js, the release it names is never newer than this engine, its publish time is
// filled in, and the workflow runs only when a maintainer starts it. No network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const K = require('../lib/commands.js');

const REPO = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(REPO, 'docs', 'explainer.html'), 'utf8');
// commands the page shows as planned (lifecycle.md), never as shipping
const PLANNED = ['sc add'];

// commands(page) — each `steward …` in a <code>, a copy button, or a quoted string of the page's script
function commands(page) {
  const found = new Set();
  const take = t => { for (const m of String(t).replace(/<[^>]+>/g, '').matchAll(/(?:^|[\s(])steward((?: [a-z][a-z-]*){0,2})/g)) found.add(m[1].trim()); };
  for (const m of page.matchAll(/<code>([\s\S]*?)<\/code>/g)) take(m[1]);
  for (const m of page.matchAll(/data-copy="([^"]*)"/g)) take(m[1]);
  for (const m of page.matchAll(/'(steward [^']*)'/g)) take(m[1]);
  return [...found];
}

test('explainer: every steward command it names exists (or is marked planned)', () => {
  const named = commands(PAGE);
  assert.ok(named.length > 20, `found ${named.length}`);
  for (const c of named) {
    if (!c || PLANNED.some(p => c.startsWith(p))) continue;
    const w = c.split(' ');
    const ok = K.find(w) || K.find(w.slice(0, 1)) || (w.length === 1 && w[0] in K.AREAS) || K.BUILTINS.some(b => b.name === w[0]);
    assert.ok(ok, `steward ${c}: not in lib/commands.js`);
  }
  for (const p of PLANNED) assert.match(PAGE, new RegExp(`steward ${p}[^<]*</code>:</b>[^<]*<span class="tagp">planned`), `${p} is shown as planned`);
});

test('explainer: the release it names is not newer than this engine, and its publish time is filled in', () => {
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const engine = require('../package.json').version;
  const named = [...PAGE.matchAll(/release (\d+\.\d+\.\d+)/g)].map(m => m[1]);
  assert.ok(named.length, 'the page names its release');
  for (const v of named) assert.ok(cmp(v, engine) <= 0, `the page names ${v}, newer than the engine (${engine})`);
  assert.doesNotMatch(PAGE, /__RELEASE_PUBLISHED_(ISO|DATE)__/, 'fill in the release\'s npm publish time (docs/maintainers.md, The explainer site)');
});

test('pages workflow: on demand only, and every action pinned by commit', () => {
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'pages.yml'), 'utf8');
  const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /push:|pull_request|schedule|release:/, 'nothing but a maintainer starts it');
  for (const m of wf.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${m[1]}: pin by commit SHA`);
  assert.match(wf, /docs\/explainer\.html _site\/index\.html/);
});
