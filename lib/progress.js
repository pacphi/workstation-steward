// Progress for long commands, on stderr so stdout stays the command's own output.
//   const pg = progress(total)            total stages (0 when unknown)
//   const s = pg.stage('supply-chain audit')
//   s.detail('Homebrew casks')            what it's on now (a milestone inside the stage)
//   s.done('23 actions')                  close the stage with a summary and its time
//   s.fail('FAILED (exit 1)')             close it as failed: the same line with ✗ instead of ✓
// On a terminal, the current stage's line redraws every second with the elapsed time and detail, so a slow step
// never looks stuck. Elsewhere (a pipe, a log, CI) each stage prints one start line and one done line, and a detail
// change prints at most every 10 s. NO_PROGRESS=1 turns it off.
const TTY = process.stderr.isTTY && process.env.NO_PROGRESS !== '1';
const OFF = process.env.NO_PROGRESS === '1';
const secs = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
const cols = () => (process.stderr.columns || 120) - 1;

function progress(total = 0) {
  const t0 = Date.now();
  let n = 0;
  return {
    stage(label) {
      n++;
      const tag = total ? `[${n}/${total}]` : `[${n}]`;
      const start = Date.now();
      let detail = '', lastPlain = 0, timer = null;
      // close(summary, colour, mark) — the stage's last line: its summary and time, marked ✓ or ✗
      const close = (summary, colour, mark) => {
        if (timer) clearInterval(timer);
        if (OFF) return;
        const msg = `${tag} ${label}: ${summary} (${secs(Date.now() - start)})`;
        process.stderr.write(TTY ? `\r\x1b[2K\x1b[1;${colour}m${mark}\x1b[0m ${msg}\n` : `${mark} ${msg}\n`);
      };
      const line = () => `\x1b[1;34m${tag}\x1b[0m ${label} … ${secs(Date.now() - start)}${detail ? ` · ${detail}` : ''}`;
      const draw = () => { if (TTY) process.stderr.write(`\r\x1b[2K${line().slice(0, cols() + 11)}`); };
      if (OFF) { /* silent */ } else if (TTY) { draw(); timer = setInterval(draw, 1000); timer.unref(); }
      else process.stderr.write(`${tag} ${label} …\n`);
      return {
        detail(d) {
          detail = d;
          if (TTY) draw();
          else if (!OFF && Date.now() - lastPlain >= 10e3) { lastPlain = Date.now(); process.stderr.write(`    ${label}: ${d} (${secs(Date.now() - start)})\n`); }
        },
        done(summary = '') { close(summary || 'done', '32', '✓'); },
        fail(summary = '') { close(summary || 'failed', '31', '✗'); },
      };
    },
    finish(summary = '') { if (!OFF) process.stderr.write(`${summary ? `${summary} ` : ''}(total ${secs(Date.now() - t0)})\n`); },
  };
}

module.exports = { progress, secs };
