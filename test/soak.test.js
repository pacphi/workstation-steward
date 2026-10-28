// lib/soak.js: which receipts start a soak. Receipts go to a temporary XDG_STATE_HOME.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-soak-')));
process.env.XDG_STATE_HOME = ROOT;
const S = require('../lib/soak.js');
const STATE = path.join(ROOT, 'workstation-steward');
const receipt = (dir, r) => { fs.mkdirSync(path.join(STATE, 'backups', dir), { recursive: true }); fs.writeFileSync(path.join(STATE, 'backups', dir, 'receipt.json'), JSON.stringify(r)); };

test('soak: repins and onboarding start one; offboarding and the guards don\'t', () => {
  receipt('repin-20261020T000000', { kind: 'repin', at: '2026-10-20T00:00:00Z', files: [] });
  receipt('onboard-x-20261021T000000', { kind: 'onboard', at: '2026-10-21T00:00:00Z' });
  receipt('offboard-x-20261022T000000', { kind: 'offboard', at: '2026-10-22T00:00:00Z' });
  receipt('guard-20261023T000000', { kind: 'guard', at: '2026-10-23T00:00:00Z', files: [] });
  receipt('guard-npx-ask-20261024T000000', { at: '2026-10-24T00:00:00Z', file: 'x' });
  assert.deepEqual(S.events().map(e => e.kind), ['onboard', 'repin']);
});

test('soak: what each receipt changed, counted from files or from entries', () => {
  receipt('reconcile-y-20261025T000000', { kind: 'reconcile', at: '2026-10-25T00:00:00Z', project: '~/y', entries: [{ path: 'a' }, { path: 'b' }] });
  receipt('onboard-y-20261026T000000', { kind: 'onboard', at: '2026-10-26T00:00:00Z', project: '~/y', entries: [{ path: '.claude/skills', names: [{}, {}, {}] }, { path: '.mcp.json' }] });
  const w = Object.fromEntries(S.events().map(e => [path.basename(path.dirname(e.file)), e.what]));
  assert.equal(w['reconcile-y-20261025T000000'], '2 unit(s) in ~/y');
  assert.equal(w['onboard-y-20261026T000000'], '4 unit(s) in ~/y');
  assert.equal(w['repin-20261020T000000'], '0 file(s)');
  assert.equal(w['onboard-x-20261021T000000'], 'a change');
});
