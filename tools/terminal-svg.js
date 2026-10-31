#!/usr/bin/env node
// Build the README's animated terminals: docs/assets/terminal/<name>.json → docs/assets/<name>.svg. Each script is a
// list of scenes; a scene is a list of lines that appear in turn (a command types out; a prompt's answer follows a
// beat later) and clear before the next scene. CSS animation only, so GitHub shows it as an image; a <title> and <desc>
// describe it, and with reduced motion one scene shows still, written out. Timings are computed, never hand-set.
// The lines are real steward output (trimmed where a script says so); keep them in step when the output changes.
// Usage: terminal-svg.js            write every SVG
//        terminal-svg.js --check    exit 1 when an SVG differs from what its script builds (test/terminal-svg.test.js)
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'docs', 'assets');
const SCRIPTS = path.join(DIR, 'terminal');
const W = 940, LH = 20, X0 = 24, Y0 = 66, FONT = 13;
const COLORS = { fg: '#c9d1d9', dim: '#8b949e', ok: '#3fb950', prompt: '#3fb950', cmd: '#f0f6fc', blue: '#58a6ff',
  hold: '#d29922', skip: '#db6d28', ans: '#79c0ff', claude: '#d97757', bad: '#f85149' };
const HOLD = 3.4, GAP = 0.4;   // seconds a finished scene stays, and between scenes

/** @typedef {{ cmd?: string, prompt?: string, ask?: string, answer?: string, out?: string, color?: string, bold?: boolean, segs?: [string, string, boolean?][], quick?: boolean }} Line */
/** @typedef {{ name: string, title: string, desc: string, window: string, still: number, scenes: Line[][] }} Script */

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// segments(line) — [text, color, bold] parts and the kind of reveal: a command types out, an ask shows its answer late
function segments(line) {
  if (line.cmd !== undefined) return { kind: 'cmd', segs: [[`${line.prompt || '$'} `, line.prompt ? 'claude' : 'prompt', true], [line.cmd, 'cmd', true]] };
  if (line.ask !== undefined) return { kind: 'ask', segs: [[line.ask, 'fg', false], [line.answer || '', 'ans', true]] };
  return { kind: 'out', segs: line.segs || [[line.out || '', line.color || 'fg', Boolean(line.bold)]] };
}

/** @param {Script} script */
function build(script) {
  const rows = Math.max(...script.scenes.map(s => s.length));
  const H = Y0 + LH * rows + 22;
  // lay the scenes out in time: each line's reveal frames, then the scene's end
  let t = 0.4;
  const laid = script.scenes.map(scene => {
    const lines = scene.map(line => {
      const { kind, segs } = segments(line);
      const text = segs.map(s => s[0]).join('');
      /** @type {[number, number, string | null][]} */
      const frames = [];   // [time, inset-right %, timing]
      if (kind === 'cmd') {
        const pre = segs[0][0].length;
        const typing = Math.min(2.4, 0.045 * (text.length - pre));
        frames.push([t, 100 - (pre / text.length) * 100, `steps(${text.length - pre}, end)`], [t + typing, 0, null]);
        t += typing + 0.55;
      } else if (kind === 'ask') {
        frames.push([t, ((segs[1][0].length) / text.length) * 100, null], [t + 0.75, 0, null]);
        t += 1.05;
      } else {
        frames.push([t, 0, null]);
        t += line.quick ? 0.12 : 0.42;
      }
      return { segs, frames };
    });
    const end = t + HOLD;
    t = end + GAP;
    return { lines, end };
  });
  const T = Math.round((t + 0.4) * 10) / 10;
  const pct = /** @param {number} x */ x => `${Math.max(0, Math.min(100, (x / T) * 100)).toFixed(3)}%`;

  const css = [], body = [];
  let n = 0;
  laid.forEach(({ lines, end }, si) => { lines.forEach(({ segs, frames }, li) => {
    n++;
    // every keyframe HOLDS its state until the next (step-end), except typing (steps) and the scene's fade (linear)
    const kf = ['0%{clip-path:inset(0 100% 0 0);opacity:1;animation-timing-function:step-end}'];
    for (const [ft, inset, tf] of frames) kf.push(`${pct(ft)}{clip-path:inset(0 ${inset.toFixed(2)}% 0 0);opacity:1;animation-timing-function:${tf || 'step-end'}}`);
    kf.push(`${pct(end)}{clip-path:inset(0 0 0 0);opacity:1;animation-timing-function:linear}`);
    kf.push(`${pct(end + 0.35)}{clip-path:inset(0 0 0 0);opacity:0;animation-timing-function:step-end}`);
    kf.push('100%{clip-path:inset(0 0 0 0);opacity:0}');
    css.push(`@keyframes k${n}{${kf.join('')}}`);
    css.push(`.l${n}{opacity:${si === script.still ? 1 : 0};animation:k${n} ${T}s linear infinite}`);
    const spans = segs.map(([s, c, b]) => `<tspan fill="${COLORS[c] || c}"${b ? ' font-weight="600"' : ''}>${esc(s)}</tspan>`).join('');
    body.push(`<text class="l${n}" x="${X0}" y="${Y0 + li * LH}" xml:space="preserve">${spans}</text>`);
  }); });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(script.title)}</title>
<desc id="d">${esc(script.desc)}</desc>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px}
${css.join('\n')}
@media (prefers-reduced-motion:reduce){text{animation:none!important}}
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
<path d="M0.5 10.5a10 10 0 0 1 10-10h${W - 21}a10 10 0 0 1 10 10V36H0.5Z" fill="#161b22"/>
<line x1="0.5" y1="36" x2="${W - 0.5}" y2="36" stroke="#30363d"/>
<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
<text x="${W / 2}" y="22" text-anchor="middle" fill="${COLORS.dim}" style="font-size:12px">${esc(script.window)}</text>
${body.join('\n')}
</svg>
`;
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const f of fs.readdirSync(SCRIPTS).filter(x => x.endsWith('.json')).sort()) {
    /** @type {Script} */
    const script = JSON.parse(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'));
    const out = path.join(DIR, `${script.name}.svg`);
    const svg = build(script);
    if (check) {
      const same = fs.existsSync(out) && fs.readFileSync(out, 'utf8') === svg;
      if (!same) { stale++; console.log(`stale: ${path.relative(process.cwd(), out)} (run: node tools/terminal-svg.js)`); }
    } else {
      fs.writeFileSync(out, svg);
      console.log(`${path.relative(process.cwd(), out)}: ${svg.length} bytes`);
    }
  }
  process.exit(stale ? 1 : 0);
}

if (require.main === module) main();
module.exports = { build };
