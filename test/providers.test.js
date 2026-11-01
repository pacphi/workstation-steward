// The package sources (parity 0.2, lib/providers/index.js): every provider and kind (Homebrew formulae, Homebrew
// casks, later apt, dnf and zypper) is one object with one contract, so the audit and the plan judge a package the same
// way, in one place. No network, no real package manager: commands are canned.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/providers/index.js');

const NOW = new Date('2026-10-27T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
const ctx = (extra = {}) => ({
  now: NOW, today: '2026-10-27', platform: 'macos', family: null,
  cfg: { policy: { min_release_age_days: 3 } },
  policy: { security_exception: [{ kind: 'formula', name: 'openssl@3', version: '3.6.1', advisory: 'GHSA-x', expires: '2026-11-01' }] },
  ...extra,
});
const FIELDS = ['id', 'check', 'provider', 'title', 'noun', 'tag', 'platforms', 'families', 'gateMode', 'exceptionKind', 'needsRoot', 'heldEta', 'back'];
const HOOKS = ['available', 'refresh', 'outdated', 'releaseDate', 'manual', 'upgradeCmd'];

test('the Homebrew sources keep the contract, with today\'s titles, ids and way back', () => {
  const [formula, cask] = P.ALL;
  for (const s of P.ALL) {
    for (const f of FIELDS) assert.ok(f in s, `${s.id}: ${f}`);
    for (const h of HOOKS) assert.equal(typeof s[h], 'function', `${s.id}: ${h}`);
    assert.equal(s.gateMode, 'per-package');
    assert.equal(s.needsRoot, false);
  }
  assert.deepEqual([formula.id, formula.check, formula.provider, formula.title, formula.noun, formula.tag, formula.exceptionKind, formula.heldEta],
    ['brew-formula', 'brew-formulae', 'brew', 'Homebrew formulae', 'formula(e)', 'brew', 'formula', true]);
  assert.deepEqual([cask.id, cask.check, cask.title, cask.noun, cask.tag, cask.exceptionKind, cask.heldEta],
    ['brew-cask', 'brew-casks', 'Homebrew casks (self-updating casks are left to their own updaters)', 'cask(s)', 'cask', null, false]);
  assert.deepEqual(formula.platforms, ['macos', 'linux']);
  assert.deepEqual(cask.platforms, ['macos']);
  assert.equal(formula.back, 'brew reinstall the previous bottle (Homebrew keeps no old keg; brew named what failed above)');
  assert.deepEqual(formula.upgradeCmd(['git', 'jq']), { cmd: 'brew', args: ['upgrade', '--formula', 'git', 'jq'] });
  assert.deepEqual(cask.upgradeCmd(['iterm2']), { cmd: 'brew', args: ['upgrade', '--cask', 'iterm2'] });
  assert.deepEqual(formula.refresh(), { cmd: 'brew', args: ['update', '--quiet'] });
  assert.equal(cask.refresh(), null, 'Homebrew refreshes once, with the formulae');
});

test('sources: macOS gets formulae and casks; Linux formulae only; families narrow a source; ctx.sources stands in', () => {
  assert.deepEqual(P.sources(ctx()).map(s => s.id), ['brew-formula', 'brew-cask']);
  assert.deepEqual(P.sources(ctx({ platform: 'linux', family: 'debian' })).map(s => s.id), ['brew-formula']);
  const apt = { id: 'fake-apt', platforms: ['linux'], families: ['debian'] };
  const all = [...P.ALL, apt];
  assert.deepEqual(P.sources(ctx({ platform: 'linux', family: 'debian', sources: all })).map(s => s.id), ['brew-formula', 'fake-apt']);
  assert.deepEqual(P.sources(ctx({ platform: 'linux', family: 'rhel', sources: all })).map(s => s.id), ['brew-formula']);
  assert.equal(P.byId('brew-cask').title.startsWith('Homebrew casks'), true);
  assert.equal(P.byId('nope'), null);
});

test('judge: an exception wins; old enough is taken; younger, or an unknown date, is held', async () => {
  const src = (date, extra = {}) => ({ id: 'x', exceptionKind: 'formula', exceptionVersion: v => v.replace(/_[^_]*$/, ''), releaseDate: async () => date, ...extra });
  assert.deepEqual(await P.judge(ctx(), src(daysAgo(1)), { name: 'openssl@3', have: '3.6.0', want: '3.6.1_1' }), { verdict: 'take', age: 1, exception: 'GHSA-x' });
  assert.deepEqual(await P.judge(ctx(), src(daysAgo(3)), { name: 'git', have: '2.51.0', want: '2.52.0' }), { verdict: 'take', age: 3, exception: '' }, 'the boundary is taken');
  assert.deepEqual(await P.judge(ctx(), src(daysAgo(2)), { name: 'git', have: '2.51.0', want: '2.52.0' }), { verdict: 'hold', age: 2, exception: '' });
  assert.deepEqual(await P.judge(ctx(), src(''), { name: 'git', have: '2.51.0', want: '2.52.0' }), { verdict: 'hold', age: -1, exception: '' });
  const noExc = src(daysAgo(1), { exceptionKind: null });
  assert.deepEqual(await P.judge(ctx(), noExc, { name: 'openssl@3', have: '3.6.0', want: '3.6.1_1' }), { verdict: 'hold', age: 1, exception: '' }, 'a source without an exception kind never takes one');
  const expired = ctx({ policy: { security_exception: [{ kind: 'formula', name: 'openssl@3', version: '3.6.1', advisory: 'GHSA-x', expires: '2026-10-26' }] } });
  assert.equal((await P.judge(expired, src(daysAgo(1)), { name: 'openssl@3', have: '3.6.0', want: '3.6.1_1' })).verdict, 'hold', 'an expired exception is ignored');
});
