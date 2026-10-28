// tools/terminal-svg.js: the README's animated terminals (docs/assets/*.svg) are exactly what their scripts
// (docs/assets/terminal/*.json) build, and every line fits the window. No network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SCRIPTS = path.join(REPO, 'docs', 'assets', 'terminal');

test('terminal SVGs: each one is what its script builds (rebuild: node tools/terminal-svg.js)', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'terminal-svg.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('terminal SVGs: every line fits the window, and each script names a still scene for reduced motion', () => {
  const most = Math.floor((940 - 2 * 24) / (0.62 * 13));   // monospace at 13px is about 0.6em a character; a little slack
  for (const f of fs.readdirSync(SCRIPTS).filter(x => x.endsWith('.json'))) {
    const s = JSON.parse(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'));
    assert.ok(Number.isInteger(s.still) && s.still >= 0 && s.still < s.scenes.length, `${f}: still names a scene`);
    for (const line of s.scenes.flat()) {
      const text = line.cmd !== undefined ? `$ ${line.cmd}` : line.ask !== undefined ? line.ask + (line.answer || '') : line.segs ? line.segs.map(x => x[0]).join('') : line.out;
      assert.ok(text.length <= most, `${f}: "${text.slice(0, 40)}…" has ${text.length} characters; the window fits ${most}`);
    }
  }
});
