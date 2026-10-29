// Steps, spinner, timer and tables for the steward's terminal output (in-house, no dependencies; the owner's choice,
// 2026-10-27). A step that takes 3 s or more gets a spinner and a live timer on its line; a shorter one prints only its
// finished row, so nothing flickers. Rows line up in columns; symbols carry the meaning and colour only adds to it.
// Off a terminal (a pipe, CI, a log) nothing is drawn: callers print their plain lines instead (tty === false).
//   const u = ui()                         u.tty: whether to draw at all
//   u.header(title, meta)                  the title, with meta right-aligned
//   const s = u.step(name)                 s.detail(text) while it runs; s.done(status, summary, lines) when it ends
//   u.print(text)                          a line above the live one
//   u.table(rows, {indent})                rows of cells, columns padded to the widest cell (the last one truncated)
//   u.rows(rows, {indent})                 the same lines, returned rather than written (to print under a step)
// Options (tests): out (a stream with isTTY and columns), env, tty, unicode, now (a clock), nameWidth.
// status: ok | warn | fail | skip | held | info. NO_COLOR turns colour off; TERM=dumb or a non-UTF-8 locale uses ASCII.
const THRESHOLD = 3000;

// fmt(ms) — 0.4s, 12.4s, 2m10s
const fmt = ms => (ms < 60e3 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60e3)}m${String(Math.floor((ms % 60e3) / 1000)).padStart(2, '0')}s`);

// width(s) — how many columns s takes: escapes take none; the symbols used here take one
const width = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
// cut(s, n) — s shortened to n columns with … (plain text only)
const cut = (s, n) => (n <= 0 ? '' : s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

function ui(o = {}) {
  const out = o.out || process.stdout;
  const env = o.env || process.env;
  const tty = o.tty ?? Boolean(out.isTTY && env.NO_PROGRESS !== '1');
  const color = tty && !('NO_COLOR' in env);
  const unicode = !(env.TERM === 'dumb') && /utf-?8/i.test(`${env.LC_ALL || ''}${env.LC_CTYPE || ''}${env.LANG || ''}`) || (o.unicode ?? false);
  const now = o.now || (() => Date.now());
  const cols = () => Math.max(60, Math.min(out.columns || 100, 140));
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const SYM = unicode
    ? { ok: '✔', warn: '⚠', fail: '✖', skip: '·', held: '⏸', info: '·', pending: '·', frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] }
    : { ok: 'ok', warn: '!!', fail: 'xx', skip: '--', held: '..', info: '- ', pending: '..', frames: ['|', '/', '-', '\\'] };
  const COLOR = { ok: '32', warn: '33', fail: '31', skip: '2', held: '2', info: '2', pending: '2' };
  const icon = st => paint(COLOR[st] || '0', SYM[st] || st);
  const write = s => out.write(s);
  let live = null; // the running step: {name, start, detail, frame, shown}
  let timer = null;

  const liveText = () => {
    const t = fmt(now() - live.start);
    const left = `  ${paint('36', SYM.frames[live.frame % SYM.frames.length])}  ${live.name.padEnd(o.nameWidth || 24)}  `;
    const room = cols() - width(left) - t.length - 2;
    return `${left}${paint('2', cut(live.detail, room).padEnd(Math.max(0, room)))}  ${paint('2', t)}`;
  };
  const clear = () => { if (live && live.shown) write('\r\x1b[2K'); };
  const draw = () => {
    if (!live) return;
    if (!live.shown && now() - live.start < THRESHOLD) return;
    live.shown = true;
    live.frame++;
    write(`\r\x1b[2K${liveText()}`);
  };

  return {
    tty, color, unicode, sym: SYM, paint, fmt, cut, cols,
    tick: draw, // one frame now (the timer draws every 100 ms; tests call it with their own clock)
    header(title, meta = '') {
      if (!tty) return;
      const gap = Math.max(2, cols() - title.length - meta.length);
      write(`${paint('1', title)}${' '.repeat(gap)}${paint('2', meta)}\n`);
    },
    print(text) {
      if (!tty) return;
      clear();
      write(`${text}\n`);
      if (live && live.shown) write(liveText());
    },
    step(name) {
      live = { name, start: now(), detail: '', frame: 0, shown: false };
      if (tty && !timer) { timer = setInterval(draw, 100); timer.unref(); }
      const me = live;
      return {
        detail(text) { me.detail = text; },
        elapsed: () => now() - me.start,
        done(status, summary = '', lines = []) {
          if (live === me) { clear(); live = null; }
          if (timer) { clearInterval(timer); timer = null; }
          if (!tty) return;
          const t = fmt(now() - me.start);
          const left = `  ${icon(status)}  ${me.name.padEnd(o.nameWidth || 24)}  `;
          const room = cols() - width(left) - t.length - 2;
          write(`${left}${cut(summary, room).padEnd(Math.max(0, room))}  ${paint('2', t)}\n`);
          for (const l of lines) write(`${l}\n`);
        },
      };
    },
    // rows(rows, {indent}) — aligned lines: each row an array of cells (a cell may be {text, color, right}); a row's
    // last cell takes the rest of the line, cut to fit the terminal, so a short row can say in one cell what others
    // say in columns
    rows(rows, t = {}) {
      const text = c => (c && typeof c === 'object' ? c.text : String(c ?? ''));
      const n = Math.max(0, ...rows.map(r => r.length));
      const w = Array.from({ length: n }, (_, i) => Math.max(0, ...rows.map(r => (i < r.length - 1 ? width(text(r[i])) : 0))));
      const indent = ' '.repeat(t.indent ?? 2);
      return rows.map(r => {
        let line = indent;
        r.forEach((c, i) => {
          const s = text(c);
          if (i === r.length - 1) { line += cut(s, cols() - width(line)); return; }
          const pad = ' '.repeat(w[i] - width(s));
          const shown = c && typeof c === 'object' && c.color ? paint(c.color, s) : s;
          line += `${c && typeof c === 'object' && c.right ? pad + shown : shown + pad}  `;
        });
        return line.replace(/\s+$/, '');
      });
    },
    // table(rows, {indent}) — rows(), written
    table(rows, t = {}) {
      if (!tty || !rows.length) return;
      for (const l of this.rows(rows, t)) write(`${l}\n`);
    },
  };
}

module.exports = { ui, fmt, cut, width, THRESHOLD };
