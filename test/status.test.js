// supply-chain/bin/status (the audit's "mise toolchain" step) on a fresh machine (parity 0.8): an app that isn't there,
// or an app folder that doesn't exist, is skipped, never a failed step. A run of the audit in a Linux container found
// the whole step failing because ~/.local/share/cursor-agent/versions didn't exist (find exits 1 under pipefail); any
// machine without that folder would, a fresh Mac included. Its own HOME and instance; stand-ins for mise, curl and gh.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

test('status: listed apps and app folders that are not on this machine are skipped, and the step succeeds', () => {
  const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-status-')));
  const home = path.join(box, 'home'), inst = path.join(box, 'inst'), bin = path.join(box, 'bin');
  for (const d of [home, path.join(inst, 'supply-chain'), bin]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(inst, 'steward.toml'), `schema = 1\n[paths]\nstate = "${box}/state"\ncache = "${box}/cache"\n`);
  fs.writeFileSync(path.join(inst, 'supply-chain', 'host.toml'), 'vendored_node = ["~/no-such-app/node"]\nvendored_node_dirs = ["~/.local/share/no-such-agent/versions"]\n');
  fs.writeFileSync(path.join(inst, 'supply-chain', 'hybrids.toml'), '');
  const stub = (n, body) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('mise', 'case "$1" in --version) echo "2026.10.21 linux-arm64 (2026-10-27)";; *) exit 0;; esac');
  stub('curl', 'echo \'[{"version":"v26.13.0","date":"2026-10-21","security":false}]\'');
  stub('gh', 'echo "[]"');
  const yq = path.dirname(fs.realpathSync(spawnSync('/bin/sh', ['-c', 'command -v yq'], { encoding: 'utf8' }).stdout.trim()));
  const npm = path.dirname(fs.realpathSync(spawnSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim()));
  const env = { PATH: [bin, path.dirname(process.execPath), yq, npm, '/usr/bin', '/bin'].join(':'), HOME: home, STEWARD_INSTANCE: inst, NO_PROGRESS: '1' };
  const r = spawnSync('bash', [path.join(REPO, 'supply-chain', 'bin', 'status')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-1500));
  assert.match(r.stdout, /Vendored Node runtimes/);
});
