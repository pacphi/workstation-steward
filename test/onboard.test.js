// Unit tests for onboarding's merge rules and writers (lib/onboard.js, lib/write.js). Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/projects.js');
const O = require('../lib/onboard.js');
const W = require('../lib/write.js');
const F = require('../lib/profiles.js');

const tomlParse = text => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-toml-')), 'c.toml');
  fs.writeFileSync(f, text);
  return P.toml(f);
};
const hook = (event, matcher, command) => ({ tool: 't', event, matcher, command, timeout: 5 });
const H = (command, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });

test('addOnly adds missing keys and keeps every existing value', () => {
  const r = O.addOnly({ a: 1, b: { c: 'mine' } }, { a: 2, b: { c: 'theirs', d: true }, e: { f: [1] } });
  assert.deepEqual(r.next, { a: 1, b: { c: 'mine', d: true }, e: { f: [1] } });
  assert.deepEqual(r.added, ['b.d', 'e.f']);
});

test('addOnly skips an empty table under an existing key, keeps it inside a new one', () => {
  assert.deepEqual(O.addOnly({ s: { command: 'x' } }, { s: { env: {} } }).added, []);
  assert.deepEqual(O.addOnly({}, { s: { command: 'x', env: {} } }).next, { s: { command: 'x', env: {} } });
});

test('hookKey names the work, whatever the form', () => {
  assert.equal(F.hookKey(`sh -c 'exec node "$D/.claude/helpers/hook-handler.cjs" pre-bash'`), 'hook-handler.cjs pre-bash');
  assert.equal(F.hookKey('node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" guard --file x'), 'aqe-hook.cjs guard');
  assert.equal(F.hookKey('npx agentic-qe hooks post-edit --file x'), 'aqe-hook.cjs post-edit');
  assert.equal(F.hookKey('echo hi'), null);
  assert.equal(F.hookKey(`env AQE_HOOK_BUNDLE='/old/v1.cjs' node "$D/.claude/hooks/aqe-hook.cjs" route --json`), 'aqe-hook.cjs route');
});

test('mergeHooks adds a missing hook into its event and matcher group', () => {
  const want = [hook('PreToolUse', 'Bash', 'node .claude/helpers/hook-handler.cjs pre-bash')];
  const r = O.mergeHooks({}, want);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.next.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: want[0].command, timeout: 5 }] }]);
});

test('mergeHooks leaves an exact match alone', () => {
  const c = 'node .claude/helpers/hook-handler.cjs route';
  const r = O.mergeHooks({ UserPromptSubmit: [H(c)] }, [hook('UserPromptSubmit', '', c)]);
  assert.equal(r.added.length + r.kept.length, 0);
});

test('mergeHooks keeps an older form of the same work instead of doubling it', () => {
  const have = {
    PreToolUse: [H('npx agentic-qe hooks pre-task --description x', '^Task$')],
    UserPromptSubmit: [H(`env AQE_HOOK_BUNDLE='/v1' node "$D/.claude/hooks/aqe-hook.cjs" route --json`)],
  };
  const r = O.mergeHooks(have, [
    hook('PreToolUse', '^(Task|Agent)$', 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" pre-task --json'),
    hook('UserPromptSubmit', '', 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" route --json'),
  ]);
  assert.equal(r.added.length, 0);
  assert.equal(r.kept.length, 2);
  assert.deepEqual(r.next, have);
});

test('mergeHooks with replaceOlder swaps transport v1 inline, npx and ^Task$ forms for the profile\'s', () => {
  const v1 = `env AQE_HOOK_BUNDLE='/x/transports/v1/aqe-shared-cli.cjs' node "$D/.claude/hooks/aqe-hook.cjs" route --json`;
  const have = {
    UserPromptSubmit: [H(v1)],
    PreToolUse: [H('npx agentic-qe hooks pre-command --json', '^Bash$'), H('node "$D/.claude/hooks/aqe-hook.cjs" pre-task --json', '^Task$')],
    Stop: [H('node "$D/.claude/helpers/brain-checkpoint.cjs" export --json')],
  };
  const want = [
    hook('UserPromptSubmit', '', 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" route --json'),
    hook('PreToolUse', '^Bash$', 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" pre-command --json'),
    hook('PreToolUse', '^(Task|Agent)$', 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/aqe-hook.cjs" pre-task --json'),
    hook('Stop', '', `sh -c 'exec node "\${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/brain-checkpoint.cjs" export --json'`),
  ];
  const r = O.mergeHooks(have, want, { replaceOlder: true });
  assert.deepEqual(r.replaced.map(x => x.key), ['aqe-hook.cjs route', 'aqe-hook.cjs pre-command', 'aqe-hook.cjs pre-task']);
  assert.deepEqual(r.kept.map(x => x.key), ['brain-checkpoint.cjs export'], 'a different but not replaceable form is kept');
  const cmds = JSON.stringify(r.next);
  assert.doesNotMatch(cmds, /transports\/v1|npx agentic-qe|\^Task\$/);
  assert.deepEqual(r.next.PreToolUse.map(g => g.matcher), ['^Bash$', '^(Task|Agent)$'], 'the emptied ^Task$ group is dropped');
  assert.equal(r.next.UserPromptSubmit[0].hooks.length, 1);
  const without = O.mergeHooks(have, want);
  assert.equal(without.replaced.length, 0);
  assert.equal(without.kept.length, 4);
  assert.ok(without.kept.filter(k => k.replaceable).length === 3);
});

test('mergeHooks counts the matcher when the profile splits one key by it (PreCompact manual and auto)', () => {
  const c = 'node .claude/helpers/hook-handler.cjs session-end';
  const r = O.mergeHooks({ PreCompact: [H(c, 'manual')] }, [hook('PreCompact', 'manual', c + ' --m'), hook('PreCompact', 'auto', c + ' --a')]);
  assert.deepEqual(r.added.map(a => a.matcher), ['auto']);
  assert.equal(r.kept.length, 1);
});

test('mergeHooks never treats a hook it just added as an older form', () => {
  const r = O.mergeHooks({}, [hook('PreCompact', 'manual', 'x/hook-handler.cjs session-end'), hook('PreCompact', 'auto', 'x/hook-handler.cjs session-end')]);
  assert.equal(r.added.length, 2);
});

test('jsonText keeps indent, final newline and key order, adding new keys last', () => {
  const orig = '{\n    "b": 1,\n    "hooks": {},\n    "a": {"x": 1}\n}';
  const have = JSON.parse(orig);
  const next = { a: { x: 1, y: 2 }, b: 1, c: 3, hooks: { E: [] } };
  const out = W.jsonText(orig, have, next);
  assert.equal(out, '{\n    "b": 1,\n    "hooks": {\n        "E": []\n    },\n    "a": {\n        "x": 1,\n        "y": 2\n    },\n    "c": 3\n}');
  assert.equal(W.jsonText(null, {}, { a: 1 }), '{\n  "a": 1\n}\n');
});

test('headerPath reads bare, quoted and dotted table headers', () => {
  assert.deepEqual(W.headerPath('[mcp_servers.agentic-qe.env]'), ['mcp_servers', 'agentic-qe', 'env']);
  assert.deepEqual(W.headerPath('[plugins."ruvnet-brain@ruvnet-brain"]  # c'), ['plugins', 'ruvnet-brain@ruvnet-brain']);
  assert.equal(W.headerPath('[[array]]'), null);
  assert.equal(W.headerPath('key = "[x]"'), null);
});

test('tomlAdd inserts under existing headers and appends new tables, keeping comments', () => {
  const text = [
    '# my config',
    'model = "x"',
    '',
    '[mcp_servers.agentic-qe]',
    'command = "aqe-mcp"',
    '',
    '[mcp_servers.agentic-qe.env]',
    'AQE_PROJECT_ROOT = "/p"  # mine',
    '',
    '# trailing comment',
    '[plugins."a@b"]',
    'enabled = true',
    '',
  ].join('\n');
  const have = tomlParse(text);
  const next = O.addOnly(have, {
    mcp_servers: {
      'agentic-qe': { env: { AQE_SESSION_CACHE: 'off' }, tools: { memory_store: { approval_mode: 'approve' } } },
      ruflo: { command: '/n/node', args: ['/c/mcp-launch.cjs'], env: { RUFLO_MCP_SKIP_NPX: '1' } },
    },
    plugins: { 'ruflo-core@ruflo': { enabled: true } },
  }).next;
  const out = W.tomlAdd(text, have, next);
  assert.equal(W.canon(tomlParse(out)), W.canon(next));
  assert.ok(out.startsWith('# my config\nmodel = "x"\n'));
  assert.match(out, /AQE_PROJECT_ROOT = "\/p" {2}# mine\nAQE_SESSION_CACHE = "off"\n\n# trailing comment/);
  assert.match(out, /\n\[mcp_servers\.ruflo\]\ncommand = "\/n\/node"\nargs = \["\/c\/mcp-launch\.cjs"\]\n\n\[mcp_servers\.ruflo\.env\]\nRUFLO_MCP_SKIP_NPX = "1"\n/);
  assert.match(out, /\n\[plugins\."ruflo-core@ruflo"\]\nenabled = true\n$/);
});

test('tomlRemoveTables drops a table and its sub-tables, keeping everything else', () => {
  const text = [
    'model = "x"',
    '',
    '# the remote one',
    '[mcp_servers.flow-nexus]',
    'command = "npx"',
    'args = ["-y", "flow-nexus@latest", "mcp", "start"]',
    '',
    '[mcp_servers.flow-nexus.tools.sandbox_create]',
    'approval_mode = "approve"',
    '',
    '[mcp_servers.agentic-qe]',
    'command = "aqe-mcp"',
    '',
  ].join('\n');
  const out = W.tomlRemoveTables(text, ['mcp_servers', 'flow-nexus']);
  assert.deepEqual(tomlParse(out), { model: 'x', mcp_servers: { 'agentic-qe': { command: 'aqe-mcp' } } });
  assert.doesNotMatch(out, /flow-nexus|the remote one/);
  assert.throws(() => W.tomlRemoveTables('a = 1\n', ['mcp_servers', 'x']), /no header line/);
});

test('tomlAdd writes a new file from nothing and refuses a table it cannot extend', () => {
  const next = { mcp_servers: { x: { command: 'c', env: {} } } };
  assert.equal(W.canon(tomlParse(W.tomlAdd('', {}, next))), W.canon(next));
  const inline = 'env = { A = "1" }\n';
  assert.throws(() => W.tomlAdd(inline, tomlParse(inline), { env: { A: '1', B: '2' } }), /no header line/);
});
