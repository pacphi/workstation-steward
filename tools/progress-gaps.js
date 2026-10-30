#!/usr/bin/env node
// The maintainer's progress check (`just progress-gaps`, run by hand): run steward commands in a pseudo-terminal, so
// their progress shows as it does on a real terminal, timestamp every chunk of output, and report each silent stretch
// longer than --gap seconds, with the last line printed before it. The rule it checks is AGENTS.md's "Long commands
// show progress": no silent stretch over about 3 s on a terminal. The default, 2 s, allows for lib/ui.js (D44), which
// draws a step's live line only once the step has run 1 s, so a fast step never flickers.
// The pseudo-terminal is script(1) in its macOS form (`script -q /dev/null cmd…`): a maintainer tool for the Mac.
// Read-only by default: a command that can change something (`writes` in lib/commands.js) runs only under DRY_RUN=1,
// --apply is refused, and only `steward …` commands run. --allow-writes lifts all three; never use it on a machine
// you care about. `steward` is this checkout's bin/steward.js, a dev build, so it uses examples/ unless given --real
// (your config: the measure that counts) or $STEWARD_INSTANCE; --installed runs the `steward` on PATH instead.
// Usage: progress-gaps.js [--gap <s>] [--out <file.json>] [--file <commands.txt>] [--real | --installed]
//                         [--allow-writes] [-- <one command, its words>]
//   commands: the words after --, as one command (just splits a quoted argument, so they are joined again), else the
//   lines of --file (# comments), else DEFAULTS below
// Exit: 0 = no gap; 1 = at least one gap; 2 = usage, or a command refused.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { find } = require('../lib/commands.js');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = [
  'steward ai drift --offline',
  'steward ai drift',
  'steward sc verify',
  'steward sc status',
  'steward sc audit',
  'steward sc plan',
  'DRY_RUN=1 steward sc install-hybrids',
];

// args(argv) — the options and the commands
function args(argv) {
  const o = { gap: 2, out: null, file: null, real: false, installed: false, writes: false, cmds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gap') o.gap = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--real') o.real = true;
    else if (a === '--installed') o.installed = true;
    else if (a === '--allow-writes') o.writes = true;
    else if (a === '--') { if (argv.length > i + 1) o.cmds.push(argv.slice(i + 1).join(' ')); break; }
    else throw new Error(`unknown argument ${a} (one command goes after --; more go in a --file)`);
  }
  if (!(o.gap > 0)) throw new Error('--gap takes a number of seconds');
  if (!o.cmds.length && o.file) o.cmds = fs.readFileSync(o.file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!o.cmds.length) o.cmds = DEFAULTS;
  return o;
}

// refusal(cmd, writes) — why cmd may not run read-only, or '' when it may: `VAR=value … steward <area> <name> …`
function refusal(cmd, writes) {
  if (writes) return '';
  const words = cmd.trim().split(/\s+/);
  const env = {};
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { const [k, ...v] = words.shift().split('='); env[k] = v.join('='); }
  if (words[0] !== 'steward') return 'only steward commands run (--allow-writes for others)';
  if (words.includes('--apply')) return '--apply changes things (--allow-writes to measure it anyway)';
  const hit = find(words.slice(1));
  if (!hit) return `not a steward command: ${words.slice(1, 3).join(' ')}`;
  if (hit.cmd.writes && env.DRY_RUN !== '1') return `${[hit.cmd.area, hit.cmd.name].filter(Boolean).join(' ')} can change things: run it as DRY_RUN=1 ${words.join(' ')}`;
  return '';
}

const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
const round = n => Math.round(n * 10) / 10;

// measure(cmd, o) — Promise {cmd, code, total, gaps: [{at, silent, after}]}: cmd run under `script` (a pseudo-terminal)
function measure(cmd, o) {
  const launcher = o.installed ? '' : `steward() { node ${JSON.stringify(path.join(ROOT, 'bin', 'steward.js'))}${o.real ? ' --real' : ''} "$@"; }; `;
  return new Promise(resolve => {
    const t0 = Date.now();
    let last = t0, after = '(start)';
    const gaps = [];
    const gap = (now, note = '') => { if ((now - last) / 1000 > o.gap) gaps.push({ at: round((last - t0) / 1000), silent: round((now - last) / 1000), after: after + note }); };
    const p = spawn('script', ['-q', '/dev/null', 'bash', '-c', launcher + cmd], { cwd: process.env.HOME, stdio: ['ignore', 'pipe', 'pipe'] });
    const on = d => {
      const now = Date.now();
      gap(now);
      last = now;
      const lines = strip(d.toString()).split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length) after = lines[lines.length - 1].slice(0, 140);
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    const kill = setTimeout(() => p.kill('SIGTERM'), 15 * 60e3);
    p.on('close', code => {
      clearTimeout(kill);
      const end = Date.now();
      gap(end, ' (then exit)');
      resolve({ cmd, code, total: round((end - t0) / 1000), gaps });
    });
  });
}

async function main(argv) {
  let o;
  try { o = args(argv); } catch (e) { console.error(`progress-gaps: ${e.message}`); return 2; }
  const refused = o.cmds.map(c => [c, refusal(c, o.writes)]).filter(([, why]) => why);
  for (const [c, why] of refused) console.error(`refused: ${c}: ${why}`);
  if (refused.length) return 2;
  const out = [];
  for (const c of o.cmds) {
    process.stdout.write(`… ${c}\n`);
    const r = await measure(c, o);
    out.push(r);
    if (o.out) fs.writeFileSync(o.out, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`${r.gaps.length ? '✗' : '✓'} ${c}: ${r.total}s, exit ${r.code}, ${r.gaps.length} silent stretch(es) over ${o.gap}s`);
    for (const g of r.gaps) console.log(`    ${g.silent}s silent from ${g.at}s, after: ${g.after}`);
  }
  return out.some(r => r.gaps.length) ? 1 : 0;
}

module.exports = { args, refusal, DEFAULTS };

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
