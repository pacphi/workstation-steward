// What the engine says on every platform (parity 0.7): "this machine", not "this Mac", where it means the machine the
// steward runs on; lists that name only what applies here; the RuVector add-on named for this OS, CPU and C library.
// A guard fails when "this Mac" comes back outside a line marked `mac-ok: <why>` (one that only runs, or only speaks, on
// macOS). No network.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { nextLine } = require('../supply-chain/bin/audit.js');
const { elsewhere } = require('../lib/vulns.js');
const { COMMANDS, AREAS } = require('../lib/commands.js');

const REPO = path.join(__dirname, '..');

// addon(args) — ruvectorAddon from addon-check.js, loaded in a child process: loading it must not run its checks (it
// used to, then exit 0, which ended a test file early and made it look passed)
const addon = (...a) => {
  const js = `const m = require(${JSON.stringify(path.join(REPO, 'supply-chain', 'bin', 'addon-check.js'))}); process.stdout.write(JSON.stringify(m.ruvectorAddon(...${JSON.stringify(a)})))`;
  const r = spawnSync(process.execPath, ['-e', js], { encoding: 'utf8' });
  assert.ok(r.stdout, `no answer: loading addon-check.js ran its checks instead (${r.stdout}${r.stderr})`.slice(0, 300));
  return JSON.parse(r.stdout);
};

test('ruvectorAddon: the prebuilt add-on @ruvector/core ships for this OS and CPU; none where it ships none', () => {
  assert.equal(addon('darwin', 'arm64', null), 'ruvector-core-darwin-arm64');
  assert.equal(addon('darwin', 'x64', null), 'ruvector-core-darwin-x64');
  assert.equal(addon('linux', 'x64', '2.41'), 'ruvector-core-linux-x64-gnu');
  assert.equal(addon('linux', 'arm64', '2.41'), 'ruvector-core-linux-arm64-gnu');
  assert.equal(addon('win32', 'x64', null), 'ruvector-core-win32-x64-msvc');
  assert.equal(addon('linux', 'arm64', null), null, 'musl (Alpine): no build');
  assert.equal(addon('linux', 's390x', '2.41'), null, 'a CPU without a build');
  assert.equal(addon('win32', 'arm64', null), null);
});

test('the audit\'s Next line names only what applies here; macOS\'s is unchanged', () => {
  assert.equal(nextLine('macos'), '  Next: steward sc plan (Homebrew, mise and declared updaters); apps, App Store, macOS and trust are manual.');
  const linux = nextLine('linux');
  assert.ok(!/App Store|macOS/.test(linux), linux);
  assert.equal(linux, '  Next: steward sc plan (Homebrew, mise and declared updaters); apps and trust are manual.');
});

test('vulns: what it leaves to the audit names only what exists here', () => {
  assert.equal(elsewhere('macos'), 'apps, App Store, macOS updates, Docker images: not covered here (see steward sc audit)');
  assert.equal(elsewhere('linux'), 'apps, OS updates, Docker images: not covered here (see steward sc audit)');
});

test('steward help: the supply-chain descriptions are not macOS-only', () => {
  const audit = COMMANDS.find(c => c.area === 'sc' && c.name === 'audit');
  for (const t of [AREAS.sc, audit.desc]) assert.ok(!/App Store|macOS/.test(t), t);
});

test('package.json describes a machine, not a Mac (npm shows it on every platform)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(!/\bMac\b/.test(pkg.description), pkg.description);
});

test('no engine message says "this Mac" (or "the Mac") for the machine it runs on, outside a line marked mac-ok', () => {
  const files = spawnSync('git', ['ls-files', 'lib', 'bin', 'supply-chain/bin', 'supply-chain/checks', 'ai-tooling/bin', 'projects/bin', 'fleet/bin'], { cwd: REPO, encoding: 'utf8' })
    .stdout.split('\n').filter(f => f && /\.(js|sh)$|\/[a-z-]+$/.test(f));
  const found = [];
  for (const f of files) {
    fs.readFileSync(path.join(REPO, f), 'utf8').split('\n').forEach((l, i) => {
      if (/^\s*(\/\/|#)/.test(l) || /(\/\/|#) mac-ok: \S/.test(l)) return;
      if (/\b(this|the) Mac\b|\ba Mac's\b/.test(l)) found.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});
