// A tool switched on per project only must stay off at user level (D55): each profile's [user_off] names the user-level
// Claude plugin, Codex plugin and Codex MCP server, and `steward ai drift` reports any that is on. Throwaway HOME and
// instance; no network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('../lib/profiles.js');

const REPO = path.join(__dirname, '..');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-user-off-')));
let n = 0;
// home(files) — a fresh fake home folder holding the given files ({rel: text})
const home = (files = {}) => {
  const h = path.join(ROOT, `home-${n++}`);
  fs.mkdirSync(h, { recursive: true });
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true }); fs.writeFileSync(path.join(h, rel), text); }
  return h;
};
const dirs = h => ({ claudeDir: path.join(h, '.claude'), codexHome: path.join(h, '.codex') });
/** @type {Record<string, any>} */
const PROFILES = {
  pp: { tool: 'pp', user_off: { claude_plugins: ['pp@market'], codex_plugins: ['pp@market'], codex_mcp_servers: ['pp-server'] } },
  plain: { tool: 'plain', settings: { enabledPlugins: { 'plain@market': true } } },
};
const check = (h, tools = ['pp']) => F.userOff(tools, { ...dirs(h), profile: t => PROFILES[t] });
const drift = r => r.filter(x => x.level === 'DRIFT').map(x => x.msg);

// What Brain's installer writes into ~/.codex/config.toml on every run (any mode), with the names changed.
const INSTALLER_BLOCK = '# --- pp (managed block, installer-rewritten) ---\n[mcp_servers.pp-server]\ncommand = "node"\nargs = ["/opt/pp/mcp/server.mjs"]\nstartup_timeout_sec = 30\nenv = { PP_HOOK_HOST = "codex" }\n# --- end pp ---\n';

test('user-level off: a Codex MCP block for a per-project-only tool is DRIFT, naming the file, the key and the fix', () => {
  const d = drift(check(home({ '.codex/config.toml': 'model = "m"\n\n' + INSTALLER_BLOCK })));
  assert.equal(d.length, 1);
  assert.match(d[0], /config\.toml \[mcp_servers\.pp-server\] is present.*remove the block/);
});

test('user-level off: a Codex plugin with enabled = true is DRIFT', () => {
  const d = drift(check(home({ '.codex/config.toml': '[plugins."pp@market"]\nenabled = true\n' })));
  assert.equal(d.length, 1);
  assert.match(d[0], /config\.toml \[plugins\."pp@market"\] enabled = true: set it to false/);
});

test('user-level off: a Claude plugin enabled in the user settings is DRIFT', () => {
  const d = drift(check(home({ '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'pp@market': true } }) })));
  assert.equal(d.length, 1);
  assert.match(d[0], /settings\.json enabledPlugins\."pp@market" = true: set it to false/);
});

test('user-level off: switched off, or absent, is ok', () => {
  for (const h of [
    home(),                                                                     // neither file exists
    home({ '.claude/settings.json': '{}', '.codex/config.toml': 'model = "m"\n' }), // present, no keys
    home({
      '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'pp@market': false, 'other@market': true } }),
      '.codex/config.toml': '[plugins."pp@market"]\nenabled = false\n\n[mcp_servers.pp-server]\ncommand = "node"\nenabled = false\n',
    }),
  ]) {
    const r = check(h);
    assert.deepEqual(drift(r), []);
    assert.equal(r.length, 1);
    assert.equal(r[0].level, 'ok');
    assert.match(r[0].msg, /^pp: off at user level \(enabledPlugins\."pp@market", \[plugins\."pp@market"\], \[mcp_servers\.pp-server\]\)$/);
  }
});

test('user-level off: a profile without [user_off] is not checked, and a file that does not parse is a warning', () => {
  const on = { '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'plain@market': true } }), '.codex/config.toml': '[mcp_servers.plain]\ncommand = "x"\n' };
  assert.deepEqual(check(home(on), ['plain']), []);
  const bad = check(home({ '.claude/settings.json': '{ not json', '.codex/config.toml': INSTALLER_BLOCK }));
  assert.ok(bad.some(x => x.level === 'WARN' && /settings\.json doesn't parse/.test(x.msg)), JSON.stringify(bad));
  assert.equal(drift(bad).length, 1); // the Codex side is still checked
});

test('the shipped profiles: Brain keeps its Claude plugin, Codex plugin and Codex server off at user level; every [user_off] is well formed', () => {
  assert.deepEqual(F.load('brain').user_off, { claude_plugins: ['ruvnet-brain@ruvnet-brain'], codex_plugins: ['ruvnet-brain@ruvnet-brain'], codex_mcp_servers: ['ruvnet-brain'] });
  for (const t of F.TOOLS) assert.deepEqual(F.userOffProblems(t), [], t);
  // onboarding never writes the table: the rendered profile has no trace of it
  assert.equal(JSON.stringify(F.render(F.TOOLS, '/tmp/p', {})).includes('user_off'), false);
});

test('steward ai drift: Brain\'s installer block in the user Codex config shows as DRIFT under "user-level off" (temp HOME)', () => {
  const inst = path.join(ROOT, 'inst'), dev = path.join(ROOT, 'dev');
  fs.cpSync(path.join(REPO, 'examples'), inst, { recursive: true });
  fs.mkdirSync(dev);
  fs.writeFileSync(path.join(inst, 'steward.toml'), `[projects]\nroots = [${JSON.stringify(dev)}]\n\n[profiles]\nai_tooling = true\nprojects = true\n`);
  const h = home({ '.codex/config.toml': INSTALLER_BLOCK.replace(/pp-server/g, 'ruvnet-brain') });
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: h, STEWARD_INSTANCE: inst, NO_PROGRESS: '1' };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'STEWARD_CONFIG']) delete env[k];
  const r = spawnSync('node', ['ai-tooling/bin/drift.js', '--offline', '--json'], { cwd: REPO, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const lines = JSON.parse(r.stdout).filter((/** @type {any} */ x) => x.area === 'user-level off');
  assert.deepEqual(lines.map((/** @type {any} */ x) => x.level).sort(), ['DRIFT', 'ok', 'ok']);
  assert.match(lines.find((/** @type {any} */ x) => x.level === 'DRIFT').msg, /^brain is switched on per project only, but ~\/\.codex\/config\.toml \[mcp_servers\.ruvnet-brain\] is present/);
});
