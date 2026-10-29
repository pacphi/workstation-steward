// lib/projects.js unpinnedLauncher and inertSettingsServers: which MCP launchers fetch an unpinned version (D30), and
// which mcpServers blocks sit where Claude Code never reads them.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const { unpinnedLauncher, inertSettingsServers } = require('../lib/projects.js');

const forbid = ['@latest'];

test('unpinned launcher: a forbidden tag, or a package run through npx, bunx or pnpm dlx with no version', () => {
  assert.equal(unpinnedLauncher('npx -y ruflo@latest mcp start', forbid), true);
  assert.equal(unpinnedLauncher('npx -y ruv-swarm mcp start', forbid), true); // no version: newest on every start
  assert.equal(unpinnedLauncher('npx ruv-swarm', forbid), true);
  assert.equal(unpinnedLauncher('npx --yes @scope/tool serve', forbid), true); // a scope's @ isn't a version
  assert.equal(unpinnedLauncher('bunx flow-nexus mcp', forbid), true);
  assert.equal(unpinnedLauncher('pnpm dlx ruv-swarm mcp start', forbid), true);
  assert.equal(unpinnedLauncher('/opt/homebrew/bin/npx -y ruv-swarm', forbid), true); // npx by path
  assert.equal(unpinnedLauncher('npx -p ruv-swarm ruv-swarm-mcp', forbid), true);
  assert.equal(unpinnedLauncher('npx --package=ruv-swarm ruv-swarm-mcp', forbid), true);
});

test('pinned launcher: an exact version, a non-npx command, or a local path', () => {
  assert.equal(unpinnedLauncher('npx -y ruflo@3.59.8 mcp start', forbid), false);
  assert.equal(unpinnedLauncher('npx --yes @scope/tool@1.2.3 serve', forbid), false);
  assert.equal(unpinnedLauncher('npx -p ruv-swarm@1.0.20 ruv-swarm-mcp', forbid), false);
  assert.equal(unpinnedLauncher('npx --package=ruv-swarm@1.0.20 ruv-swarm-mcp', forbid), false);
  assert.equal(unpinnedLauncher('/Users/x/.local/share/ai-tooling/aqe/current/bin/aqe-mcp', forbid), false);
  assert.equal(unpinnedLauncher('node /Users/x/.local/share/mise/installs/npm-ruvector/0.3/cli.js mcp start', forbid), false);
  assert.equal(unpinnedLauncher('npx ./bin/local-server.js', forbid), false); // a file, not a registry package
  assert.equal(unpinnedLauncher('', forbid), false);
  assert.equal(unpinnedLauncher(undefined, forbid), false);
});

test('unpinned launcher: the policy list still applies to commands that are not npx', () => {
  assert.equal(unpinnedLauncher('uvx some-tool@latest', forbid), true);
  assert.equal(unpinnedLauncher('uvx some-tool@latest', []), false); // nothing forbidden, and uvx isn't an npm runner
});

test('inert settings servers: mcpServers in .claude/settings*.json launches nothing; other keys are ignored', () => {
  const settings = {
    '.claude/settings.json': { permissions: {}, mcpServers: { ruflo: { command: 'npx', args: ['ruflo@3.5.18', 'mcp'] } } },
    '.claude/settings.local.json': { env: {} },
  };
  assert.deepEqual(inertSettingsServers(settings), [{ file: '.claude/settings.json', names: ['ruflo'] }]);
  assert.deepEqual(inertSettingsServers({ '.claude/settings.json': { mcpServers: {} } }), []);
  assert.deepEqual(inertSettingsServers({ '.claude/settings.json': null }), []);
  assert.deepEqual(inertSettingsServers({}), []);
});
