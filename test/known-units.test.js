// Tests for tools/known-units.js (D42, F3): units from a jsDelivr listing hash the way reconcile hashes them on disk,
// the narrowing finds every change between sampled versions, and the committed index is well formed. No network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const K = require('../tools/known-units.js');
const O = require('../lib/onboard.js');

const b64 = t => crypto.createHash('sha256').update(t).digest('base64');

test('units: a skill folder from a listing hashes like reconcile hashes it on disk; files are units of their own', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'known-units-'));
  try {
    const files = { 'SKILL.md': '# demo\n', 'refs/a.md': 'a\n', 'refs/b/c.md': 'c\n' };
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
    const listing = [
      ...Object.entries(files).reverse().map(([rel, text]) => ({ name: `/.claude/skills/demo/${rel}`, hash: b64(text) })),
      { name: '/.claude/helpers/router.cjs', hash: b64('r\n') },
      { name: '/.claude/commands/sparc/coder.md', hash: b64('c\n') },
      { name: '/dist/templates/.claude/commands/sparc/coder.md', hash: b64('older\n') },
      { name: '/.claude/settings.json', hash: b64('{}') },
      { name: '/README.md', hash: b64('x') },
    ];
    const m = K.units(listing);
    assert.deepEqual(m.get('.claude/skills/demo'), [O.unitHash(d)]);
    assert.deepEqual(m.get('.claude/helpers/router.cjs'), [crypto.createHash('sha256').update('r\n').digest('hex')]);
    assert.equal(m.get('.claude/commands/sparc/coder.md').length, 2, 'every .claude folder in the package counts');
    assert.equal(m.has('.claude/settings.json'), false, 'settings are not copied units');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('unitOf: helpers and skills by entry, commands and agents by file, AQE\'s hook', () => {
  assert.deepEqual(K.unitOf('skills/x/SKILL.md'), { unit: '.claude/skills/x', inner: 'SKILL.md' });
  assert.deepEqual(K.unitOf('helpers/a.cjs'), { unit: '.claude/helpers/a.cjs', inner: '' });
  assert.deepEqual(K.unitOf('agents/core/coder.md'), { unit: '.claude/agents/core/coder.md', inner: '' });
  assert.deepEqual(K.unitOf('hooks/aqe-hook.cjs'), { unit: '.claude/hooks/aqe-hook.cjs', inner: '' });
  assert.equal(K.unitOf('hooks/other.cjs'), null);
  assert.equal(K.unitOf('settings.json'), null);
});

test('narrow: fetches until each change sits between two adjacent versions, and skips stretches that are equal', async () => {
  const sig = i => (i < 37 ? 'a' : i < 81 ? 'b' : 'c'); // changes at 37 and 81
  const asked = [];
  const idx = await K.narrow(100, async i => { asked.push(i); return sig(i); }, { per: 5 });
  for (const c of [37, 81]) assert.ok(idx.includes(c - 1) && idx.includes(c), `brackets the change at ${c}`);
  assert.equal(new Set(asked).size, asked.length, 'each version read once');
  assert.ok(idx.length < 25, `far fewer than 100 reads (${idx.length})`);
  const missing = await K.narrow(10, async i => (i === 5 ? null : 'same'), { per: 3 });
  assert.ok(missing.includes(4) && missing.includes(6), 'an unreadable version counts as different');
});

test('the committed index is well formed', () => {
  const k = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'projects', 'profiles', 'known-units.json'), 'utf8'));
  assert.deepEqual(k.packages, ['@claude-flow/cli', 'claude-flow', 'agentic-qe']);
  const units = Object.entries(k.units);
  assert.ok(units.length > 100);
  for (const [u, hs] of units) {
    assert.match(u, /^\.claude\/(helpers|skills|commands|agents|hooks)\/./);
    for (const [h, origin] of Object.entries(hs)) { assert.match(h, /^[0-9a-f]{64}$/); assert.ok(origin.length); }
  }
});
