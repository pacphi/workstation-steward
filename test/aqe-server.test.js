// lib/projects.js sharedAqeCommand: does a project's AQE MCP server command run the shared runtime (D33)?
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const { sharedAqeCommand } = require('../lib/projects.js');

const bin = '/Users/x/.local/share/ai-tooling/aqe/current/bin';
const root = '/Users/x/.local/share/ai-tooling/aqe';
const roots = [bin, '~/.local/share/ai-tooling/aqe/current/bin', root, '~/.local/share/ai-tooling/aqe'];
const shared = (cmd, bare) => sharedAqeCommand(cmd, { roots, bare: new Set(bare || []) });

test('aqe server: explicit paths into the runtime count; stock paths, siblings and fetches don\'t', () => {
  assert.equal(shared(`${bin}/aqe-mcp`), true);
  assert.equal(shared('~/.local/share/ai-tooling/aqe/current/bin/aqe-mcp --stdio'), true);
  assert.equal(shared(`${root}/releases/3.15.12-local.1/bin/aqe-mcp`), true);
  assert.equal(shared('/Users/x/.local/share/mise/installs/npm-agentic-qe/3.15.12/bin/aqe-mcp'), false);
  assert.equal(shared('/Users/x/.local/share/ai-tooling/aqe-old/current/bin/aqe-mcp'), false); // a sibling folder
  assert.equal(shared('npx agentic-qe mcp'), false);
  assert.equal(shared('npx -y agentic-qe@latest mcp'), false);
  assert.equal(shared(`node ${bin}/aqe-mcp`), false); // the rule reads the command, not its arguments
  assert.equal(shared(''), false);
  assert.equal(shared(undefined), false);
});

test('aqe server: a bare name counts only while a fresh shell resolves it to the runtime', () => {
  const all = ['aqe', 'aqe-mcp', 'agentic-qe'];
  assert.equal(shared('aqe-mcp', all), true);
  assert.equal(shared('agentic-qe mcp', all), true);
  assert.equal(shared('aqe-mcp', []), false);      // a stock install first on PATH, or nothing on PATH
  assert.equal(shared('aqe-mcp', ['aqe']), false); // only the names that resolved count
  assert.equal(shared('node', all), false);
});
