// The Claude Code skills (D48): skills/<name>/ as the `steward` plugin. Each skill is self-contained, so it still works
// once Claude Code copies the plugin into its cache: SKILL.md names its folder, reads its own files through
// ${CLAUDE_SKILL_DIR}, and points nowhere outside it. Its pre-approved tools change nothing. No network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { COMMANDS } = require('../lib/commands.js');

const REPO = path.join(__dirname, '..');
const SKILLS = path.join(REPO, 'skills');
const names = fs.readdirSync(SKILLS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
const front = text => (text.match(/^---\n([\s\S]*?)\n---\n/) || [undefined, ''])[1];
const field = (fm, key) => (fm.match(new RegExp(`^${key}: (.*)$`, 'm')) || [undefined, ''])[1].trim();

test('skills: the plugin holds the five skills, each named for its folder', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'steward');
  assert.deepEqual(names, ['ai-tooling', 'fix', 'pr-consolidation', 'projects', 'supply-chain']);
  for (const n of names) assert.equal(field(front(fs.readFileSync(path.join(SKILLS, n, 'SKILL.md'), 'utf8')), 'name'), n);
  assert.ok(require('../package.json').files.includes('skills/'), 'the skills ship in the npm package');
});

test('skills: each SKILL.md reads only files inside its own folder', () => {
  for (const n of names) {
    const text = fs.readFileSync(path.join(SKILLS, n, 'SKILL.md'), 'utf8');
    for (const [, rel] of text.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+?)[`)\s]/g)) {
      assert.ok(fs.existsSync(path.join(SKILLS, n, rel)), `${n}: \${CLAUDE_SKILL_DIR}/${rel} is missing`);
    }
    for (const [, target] of text.matchAll(/\]\(([^)#]+)/g)) {
      if (/^https?:/.test(target)) continue;   // a web page, not a file
      assert.ok(!/^(\.\.\/|\/)/.test(target), `${n}: links outside its folder (${target})`);
      assert.ok(fs.existsSync(path.join(SKILLS, n, target)), `${n}: ${target} is missing`);
    }
    for (const bad of [/\bdocs\/\w/, /\bAGENTS\.md\b/, /\.claude\/skills/, /~\/Development/, /\barchive\//]) {
      assert.ok(!bad.test(text), `${n}: SKILL.md names ${bad}, which isn't part of the skill`);
    }
  }
});

test('skills: pre-approved tools are read-only steward commands', () => {
  for (const n of names) {
    const tools = field(front(fs.readFileSync(path.join(SKILLS, n, 'SKILL.md'), 'utf8')), 'allowed-tools');
    for (const [, cmd] of tools.matchAll(/Bash\(steward ([^)*]+?)(?: \*)?\)/g)) {
      const [area, name] = cmd.trim().split(' ');
      const c = COMMANDS.find(x => (name ? x.area === area && x.name === name : x.area === '' && x.name === area));
      assert.ok(c, `${n}: allowed-tools names an unknown command: steward ${cmd}`);
      assert.ok(!c.writes, `${n}: allowed-tools pre-approves steward ${cmd}, which can change things`);
    }
  }
});

test('skills: no symlinks; .claude/skills holds only the maintainer\'s own skills (D53), never a plugin skill (D48)', () => {
  const links = execFileSync('git', ['ls-files', '-s'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(l => l.startsWith('120000'));
  assert.deepEqual(links, []);
  const project = path.join(REPO, '.claude', 'skills');
  const maintainer = fs.existsSync(project) ? fs.readdirSync(project).filter(d => !d.startsWith('.')) : [];
  assert.deepEqual(maintainer, ['steward-maintain'], 'a new project skill is a deliberate change to this list');
  const plugin = fs.readdirSync(path.join(REPO, 'skills')).filter(d => fs.existsSync(path.join(REPO, 'skills', d, 'SKILL.md')));
  assert.deepEqual(maintainer.filter(d => plugin.includes(d)), [], 'no plugin skill is copied into .claude/skills');
});
