// supply-chain/bin/link (`steward sc link`): on a fresh machine with no ~/.config/mise yet, it makes the folder and
// links config.toml and mise.lock to the instance's mise/; a dry run says so and changes nothing. The install check
// (.github/workflows/install-check.yml) found the missing folder. Throwaway folders; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-link-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('link: makes a missing mise config folder, then links both files; a dry run only says so', () => {
  const inst = path.join(ROOT, 'inst');
  const target = path.join(ROOT, 'home', '.config', 'mise');
  fs.mkdirSync(path.join(inst, 'mise'), { recursive: true });
  for (const f of ['config.toml', 'mise.lock']) fs.writeFileSync(path.join(inst, 'mise', f), `# ${f}\n`);
  fs.writeFileSync(path.join(inst, 'steward.toml'), `schema = 1\n[paths]\nmise_config_dir = "${target}"\nstate = "${path.join(ROOT, 'state')}"\n`);
  const run = env => spawnSync('bash', [path.join(REPO, 'supply-chain', 'bin', 'link')], { encoding: 'utf8', env: { ...process.env, STEWARD_INSTANCE: inst, NO_PROGRESS: '1', NO_COLOR: '1', ...env } });

  const dry = run({ DRY_RUN: '1' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`mkdir -p ${target}`));
  assert.ok(!fs.existsSync(target), 'a dry run makes nothing');

  const r = run({});
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['config.toml', 'mise.lock']) assert.equal(fs.readlinkSync(path.join(target, f)), path.join(inst, 'mise', f));
  assert.equal(run({}).status, 0, 'idempotent');
});
