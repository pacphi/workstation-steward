// lib/ui.js: steps with a spinner and live timer after 1 s, aligned rows and tables, symbols with an ASCII fallback,
// and nothing at all off a terminal. A fake stream and clock; no real terminal or waiting.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, fmt, cut } = require('../lib/ui.js');

// term(env) — a fake 80-column terminal, a clock the test moves, and what was written
function term(env = { LANG: 'en_US.UTF-8' }, tty = true) {
  let t = 0, text = '';
  const out = { isTTY: tty, columns: 80, write: s => { text += s; } };
  const u = ui({ out, env, now: () => t, nameWidth: 12 });
  return { u, at: ms => { t = ms; }, text: () => text, plain: () => text.replace(/\x1b\[[0-9;]*m/g, ''), reset: () => { text = ''; } };
}

test('fmt and cut: seconds with a tenth, minutes and seconds; … when too long', () => {
  assert.equal(fmt(400), '0.4s');
  assert.equal(fmt(12400), '12.4s');
  assert.equal(fmt(130000), '2m10s');
  assert.equal(cut('abcdef', 4), 'abc…');
  assert.equal(cut('abc', 4), 'abc');
});

test('a step under 1 s prints only its finished row: no spinner, no redraw', () => {
  const T = term();
  const s = T.u.step('Docker');
  T.at(900);
  T.u.tick();
  assert.equal(T.text(), '', 'nothing drawn before 1 s');
  s.done('ok', '24 containers', ['      ✔ detail line']);
  const lines = T.plain().split('\n');
  assert.match(lines[0], /^ {2}✔ {2}Docker {6} {2}24 containers +0\.9s$/);
  assert.equal(lines[0].length, 80, 'the row fills the terminal width, time flush right');
  assert.equal(lines[1], '      ✔ detail line');
  assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(T.text()));
});

test('from 1 s a step shows a spinner, its detail and a live timer; done clears it and prints the row', () => {
  const T = term();
  const s = T.u.step('Homebrew');
  s.detail('release dates 7/12');
  T.at(1500);
  T.u.tick();
  assert.match(T.plain(), /\r\x1b\[2K {2}⠙ {2}Homebrew {6}release dates 7\/12 +1\.5s$/);
  T.u.print('a line above');
  assert.match(T.plain(), /\r\x1b\[2Ka line above\n {2}⠙ {2}Homebrew/, 'a printed line goes above the live one, which comes back');
  T.reset();
  T.at(12400);
  s.done('warn', '2 actions');
  assert.match(T.plain(), /^\r\x1b\[2K {2}⚠ {2}Homebrew {6}2 actions +12\.4s\n$/);
});

test('table: columns padded to the widest cell, the last one cut to the width', () => {
  const T = term();
  T.u.table([[{ text: '⚠', color: '33' }, 'app', 'Google Chrome 155.0 -> 156.0 (always_current: update now)'], ['⚠', 'docker', `container ollama ${'x'.repeat(80)}`]]);
  const [a, b] = T.plain().split('\n');
  assert.equal(a, '  ⚠  app     Google Chrome 155.0 -> 156.0 (always_current: update now)');
  assert.equal(b.length, 80);
  assert.ok(b.startsWith('  ⚠  docker  container ollama') && b.endsWith('…'));
});

test('off a terminal nothing is drawn; ASCII symbols without a UTF-8 locale; NO_COLOR has no escapes', () => {
  const off = term({ LANG: 'en_US.UTF-8' }, false);
  off.u.header('x', 'y');
  off.u.step('a').done('ok', 'fine');
  off.u.table([['a', 'b']]);
  assert.equal(off.text(), '');
  const ascii = term({ LANG: 'C', NO_COLOR: '' });
  ascii.u.step('Docker').done('warn', '1 action');
  assert.match(ascii.text(), /^ {2}!! {2}Docker/);
  assert.ok(!ascii.text().includes('\x1b['), 'NO_COLOR: no colour escapes');
});

test('rows: returned, not written; a right-aligned cell; a short row says the rest in its last cell, cut to fit', () => {
  const T = term();
  const r = T.u.rows([['iTerm', '3.6.4', { text: '1d', right: true }, 'held'], ['Chrome', '149.0.0', { text: '12d', right: true }, ''], ['other', 'x'.repeat(100)]], { indent: 4 });
  assert.equal(T.text(), '');
  assert.deepEqual(r.slice(0, 2), ['    iTerm   3.6.4     1d  held', '    Chrome  149.0.0  12d']);
  assert.equal(r[2].length, 80);
  assert.ok(r[2].startsWith('    other   xxx') && r[2].endsWith('…'));
});
