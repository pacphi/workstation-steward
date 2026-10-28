// supply-chain/bin/tool-age.js (argument and config checks) and fleet/skill/scripts/lock-age.sh --files with aube
// lockfiles and a fake curl (no network). Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-toolage-')));
const REPO = path.join(__dirname, '..');
const lock = pkgs => `lockfileVersion: '9.0'\n\npackages:\n\n${pkgs.map(p => `  '${p}':\n    resolution: {integrity: sha512-x}\n`).join('\n')}\nsnapshots:\n\n${pkgs.map(p => `  '${p}': {}\n`).join('')}`;
const old = path.join(ROOT, 'old', 'aube-lock.yaml'), neu = path.join(ROOT, 'new', 'aube-lock.yaml');
fs.mkdirSync(path.dirname(old)); fs.mkdirSync(path.dirname(neu));
fs.writeFileSync(old, lock(['kept@1.0.0', 'bumped@1.0.0', '@scope/pkg@1.0.0']));
fs.writeFileSync(neu, lock(['kept@1.0.0', 'bumped@2.0.0', '@scope/pkg@1.0.0', 'fresh@3.0.0', "weird@4.0.0(peer@1.0.0)"]));
// fake curl: every registry document lists 2.0.0 and 3.0.0 as old, fresh@3.0.0 as recent, weird has no time entry
const bin = path.join(ROOT, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
for a in "$@"; do u="$a"; done
case "$u" in
  *fresh) echo '{"time":{"3.0.0":"2026-10-25T00:00:00.000Z"}}' ;;
  *weird) echo '{"time":{}}' ;;
  *) echo '{"time":{"2.0.0":"2026-01-01T00:00:00.000Z","4.0.0":"2026-01-01T00:00:00.000Z"}}' ;;
esac
`, { mode: 0o755 });
const ENV = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
const lockAge = (...a) => spawnSync(path.join(REPO, 'fleet/skill/scripts/lock-age.sh'), a, { encoding: 'utf8', env: ENV });

test('lock-age --files: lists only new aube-lock entries, flags the young one, exits 1', () => {
  const r = lockAge('-c', '2026-10-23T00:00:00Z', '--files', old, neu);
  assert.equal(r.status, 1, r.stderr);
  const rows = r.stdout.trim().split('\n').map(l => l.split('\t'));
  assert.deepEqual(rows.map(x => [x[1], x[4]]).sort(), [['bumped@2.0.0', 'OK'], ['fresh@3.0.0', 'UNDER'], ['weird@4.0.0', 'UNKNOWN']].sort());
  assert.match(r.stderr, /3 new entries, 1 UNDER/);
});

test('lock-age --files: with no old lockfile every entry is new; UNKNOWN alone does not fail the run', () => {
  const solo = path.join(ROOT, 'solo', 'aube-lock.yaml'); fs.mkdirSync(path.dirname(solo));
  fs.writeFileSync(solo, lock(['kept@1.0.0', 'bumped@2.0.0']));
  const r = lockAge('-c', '2026-10-23T00:00:00Z', '--files', '/dev/null', solo);
  assert.equal(r.status, 0, r.stderr); // kept@1.0.0 has no time entry in the fake: UNKNOWN, not UNDER
  assert.match(r.stderr, /2 new entries, 0 UNDER .*, 1 UNKNOWN/);
});

test('tool-age: refuses what it can\'t check, before touching mise', () => {
  const cfg = path.join(ROOT, 'config.toml');
  fs.writeFileSync(cfg, '[settings]\nlockfile = true\n\n[tools]\nnode = "26.12.1"\n"npm:thing" = { version = "1.0.0" }\n"npm:fuzzy" = "latest"\n');
  const run = (...a) => spawnSync('node', [path.join(REPO, 'supply-chain/bin/tool-age.js'), ...a, '--config', cfg], { encoding: 'utf8', env: { ...process.env, NO_PROGRESS: '1' } });
  assert.match(run('thing', '2.0.0').stderr, /usage/);              // not an npm: tool
  assert.match(run('npm:thing', 'latest').stderr, /usage/);         // not an exact version
  assert.match(run('npm:missing', '2.0.0').stderr, /not in/);
  assert.match(run('npm:thing', '1.0.0').stderr, /already pinned/);
  assert.match(run('npm:fuzzy', '2.0.0').stderr, /not an exact version/);
  for (const a of [['thing', '2.0.0'], ['npm:thing', '1.0.0']]) assert.equal(run(...a).status, 2);
});
