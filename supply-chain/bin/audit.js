#!/usr/bin/env node
// The host audit in Node (R5c, D43): `steward sc audit`. Runs supply-chain/checks/ for this platform. Read-only.
// Off a terminal (a pipe, CI, `steward review`) it prints what the Bash audit printed, line for line: on 2026-10-27 the
// two gave identical output on the owner's Mac, audit switched, and R5c PR 3 retired the Bash one. On a terminal it
// shows a step per check (lib/ui.js): a spinner and a live timer once a check takes 3 s, its result row, the check's
// lines under it, and a table of what to act on.
// Exit 0 = no alerts; 2 = an indicator of compromise matched.
// Usage: audit.js [--only <check,…>] [--plain]
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const C = require('../../lib/config.js');
const H = require('../../lib/host.js');
const PL = require('../../lib/platform.js');
const { ui: makeUi } = require('../../lib/ui.js');
const { CHECKS } = require('../checks/index.js');

const T0 = Date.now();
const elapsed = () => { const s = Math.floor((Date.now() - T0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
let onLabel = null; // where a command's label goes while it runs: the live step's detail on a terminal, else stderr

// run(cmd, args, {label, stderr}) — Promise {status, stdout}: a command's result, never thrown; stderr: true folds
// the command's stderr into stdout (softwareupdate writes there)
function run(cmd, args = [], o = {}) {
  const t = Date.now();
  if (o.label) { if (onLabel) onLabel(o.label); else process.stderr.write(`   … ${o.label}\n`); }
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    let p;
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { resolve({ status: 127, stdout: '' }); return; }
    p.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    p.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    p.on('error', () => resolve({ status: 127, stdout: '' }));
    p.on('close', status => {
      if (o.label && !onLabel) process.stderr.write(status === 0 ? `   \x1b[1;32m✓\x1b[0m ${o.label} (${Math.round((Date.now() - t) / 1000)}s)\n` : `   \x1b[1;31m✗\x1b[0m ${o.label}: exit ${status}\n`);
      resolve({ status, stdout: stdout + (o.stderr ? stderr : '') });
    });
  });
}

// localDay(d) — YYYY-MM-DD in local time, as the Bash audit's `date +%Y-%m-%d` (cache file names, exception expiry)
const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// context(o) — what every check reads; tests pass their own run, policy and paths
function context(o = {}) {
  const cfg = C.load().values;
  const now = o.now || new Date();
  return {
    run, cfg, now, platform: PL.current(), policy: H.load().policy, instance: C.INSTANCE_ROOT, engine: path.join(__dirname, '..', '..'),
    cache: cfg.paths.cache, home: os.homedir(), today: localDay(now), ...o,
  };
}

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// audit(ctx, {only, write, ui}) — run the checks for ctx.platform; {actions, alerts, skipped}. With a drawing ui
// (lib/ui.js, tty) the result is laid out as steps and a table; otherwise each line goes to write as the Bash audit's.
async function audit(ctx, o = {}) {
  const u = o.ui && o.ui.tty ? o.ui : null;
  const write = o.write || (s => process.stdout.write(`${s}\n`));
  const actions = [], alerts = [], skipped = [];
  const todo = CHECKS.filter(c => !o.only || o.only.includes(c.id));
  if (u) u.header('steward sc audit', `${ctx.platform} · ${todo.filter(c => c.platforms.includes(ctx.platform)).length} checks`);
  for (const c of todo) {
    if (!c.platforms.includes(ctx.platform)) { skipped.push(c.id); continue; }
    // this check's lines: printed as they come (plain), or kept and printed under its row (ui)
    const mine = { actions: 0, alerts: 0, held: 0, lines: [] };
    const PLAIN = { line: '  ', ok: '  ok     ', held: '  held   ', info: '  info   ', clean: '  clean  ', action: '  \x1b[1;33mACTION\x1b[0m ', alert: '  \x1b[1;31mALERT\x1b[0m ' };
    const SHOWN = { ok: ['ok', '32'], clean: ['ok', '32'], held: ['held', '2'], info: ['info', '2'], line: [null, '2'], action: ['warn', '33'], alert: ['fail', '31'] };
    const emit = (kind, t) => {
      if (!u) { write(`${PLAIN[kind]}${t}`); return; }
      const [sym, col] = SHOWN[kind];
      const body = kind === 'line' || kind === 'info' || kind === 'held' ? u.paint('2', u.cut(strip(t), u.cols() - 8)) : u.cut(strip(t), u.cols() - 8);
      mine.lines.push(`      ${sym ? `${u.paint(col, u.sym[sym])} ` : '  '}${body}`);
    };
    const out = {
      line: t => emit('line', t), ok: t => emit('ok', t), held: t => { mine.held++; emit('held', t); }, info: t => emit('info', t), clean: t => emit('clean', t),
      action: t => { actions.push(t); mine.actions++; emit('action', t); },
      alert: t => { alerts.push(t); mine.alerts++; emit('alert', t); },
      warn: t => process.stderr.write(`\x1b[1;33mWARN\x1b[0m ${t}\n`),
    };
    const step = u ? u.step(c.name) : null;
    onLabel = step ? l => step.detail(l) : null;
    if (!u && c.title) write(`\x1b[1;34m==>\x1b[0m ${c.title(ctx)} \x1b[2m[${elapsed()}]\x1b[0m`);
    let failed = null;
    if (c.provider && !(await c.provider.available(ctx))) out.line(`${c.provider.id} not found: skipped`);
    else { try { await c.run(ctx, out); } catch (e) { failed = e.message; out.warn(`${c.id}: ${e.message}`); } }
    onLabel = null;
    if (step) {
      const n = (k, w) => (k ? `${k} ${w}${k === 1 ? '' : 's'}` : '');
      const summary = failed ? `failed: ${failed}` : [n(mine.alerts, 'alert'), n(mine.actions, 'action'), mine.held ? `${mine.held} held` : ''].filter(Boolean).join(' · ') || 'ok';
      step.done(failed || mine.alerts ? 'fail' : mine.actions ? 'warn' : 'ok', summary, mine.lines);
    }
  }
  if (u) {
    u.print('');
    u.header('Summary', `${actions.length} action(s) · ${alerts.length} alert(s) · ${u.fmt(Date.now() - T0)}`);
    // one row per finding: its symbol, its kind (the word before the first colon: app, brew, docker…) and the rest
    const row = (kind, t) => { const i = t.indexOf(': '); const short = i > 0 && i <= 12; return [{ text: u.sym[kind], color: kind === 'fail' ? '31' : '33' }, short ? t.slice(0, i) : '', short ? t.slice(i + 2) : t]; };
    u.table([...alerts.map(t => row('fail', t)), ...actions.map(t => row('warn', t))]);
    if (!actions.length && !alerts.length) u.print(`  ${u.paint('32', u.sym.ok)}  nothing to act on`);
    if (actions.length) u.print(u.paint('2', '  Next: steward sc plan (Homebrew + mise); apps, App Store, macOS and trust are manual.'));
    return { actions, alerts, skipped };
  }
  write(`\x1b[1;34m==>\x1b[0m Summary: ${actions.length} action(s), ${alerts.length} alert(s) \x1b[2m[${elapsed()}]\x1b[0m`);
  for (const a of alerts) write(`  ALERT  ${a}`);
  for (const a of actions) write(`  ACTION ${a}`);
  if (actions.length) write('  Next: steward sc plan (Homebrew + mise); apps, App Store, macOS and trust are manual.');
  return { actions, alerts, skipped };
}

module.exports = { audit, context, run, localDay };

if (require.main === module) {
  const i = process.argv.indexOf('--only');
  const only = i > 0 ? process.argv[i + 1].split(',') : null;
  const u = process.argv.includes('--plain') ? null : makeUi();
  audit(context(), { only, ui: u }).then(r => { if (r.alerts.length) process.exitCode = 2; })
    .catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
