// steward ai guard (ai-tooling/bin/guard.js) on a Mac with no Claude Code settings file yet: the plan says it creates
// one, --apply writes it with only the ask rules (no backup: the receipt records it didn't exist), and --rollback
// removes it. A throwaway instance (copied from the examples) and HOME; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-guard-')));
const INST = path.join(ROOT, 'instance');
fs.cpSync(path.join(REPO, 'examples'), INST, { recursive: true, dereference: true });
const toml = path.join(INST, 'steward.toml');
fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace(/^ai_tooling = false/m, 'ai_tooling = true'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME);
/** @type {NodeJS.ProcessEnv} */
const ENV = { ...process.env, NO_COLOR: '1', NO_PROGRESS: '1', STEWARD_NO_REFRESH: '1', STEWARD_INSTANCE: INST, HOME, XDG_CONFIG_HOME: path.join(HOME, '.config'), XDG_STATE_HOME: path.join(ROOT, 'state') };
delete ENV.STEWARD_CONFIG;
const steward = (args, input = '') => spawnSync(process.execPath, [path.join(REPO, 'bin', 'steward.js'), ...args], { encoding: 'utf8', input, env: ENV });

test('ai guard: no ~/.claude/settings.json yet: plans to create it, creates it with the ask rules, --rollback removes it', () => {
  const settings = path.join(HOME, '.claude', 'settings.json');
  const plan = steward(['ai', 'guard']);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /npx ask guard: ~\/\.claude\/settings\.json \(a new file\)/);
  assert.equal(fs.existsSync(settings), false, 'the plan writes nothing');
  const r = steward(['ai', 'guard', '--apply'], 'y\n');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(j.permissions.ask.length > 0, 'the ask rules');
  assert.deepEqual(Object.keys(j), ['permissions'], 'nothing else');
  const rp = r.stdout.match(/rollback: steward ai guard --rollback (\S+)/)[1].replace(/^~/, HOME);
  const entry = JSON.parse(fs.readFileSync(rp, 'utf8')).files.find(f => f.guard === 'npx ask guard');
  assert.equal(entry.sha_before, null);
  assert.equal(entry.backup, undefined);
  const back = steward(['ai', 'guard', '--rollback', rp], 'y\n');
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stdout, /remove ~\/\.claude\/settings\.json \(it didn't exist before\)/);
  assert.equal(fs.existsSync(settings), false);
});
