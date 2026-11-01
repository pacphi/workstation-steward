#!/usr/bin/env node
// The host audit in Node (R5c, D43): `steward sc audit`. Runs supply-chain/checks/ for this platform. Read-only.
// Off a terminal (a pipe, CI, `steward review`) it prints what the Bash audit printed, line for line: on 2026-10-27 the
// two gave identical output on the owner's Mac, audit switched, and R5c PR 3 retired the Bash one. On a terminal it
// shows a step per check (lib/ui.js): a spinner and a live timer once a check takes 3 s, its result row, and under it
// the check's findings in columns (what to act on, then what the release-age gate holds); its other lines stay folded
// unless --verbose or the check failed. The Summary lists what to act on under what to do about it.
// Exit 0 = no alerts; 2 = an indicator of compromise matched.
// Usage: audit.js [--only <check,…>] [--plain] [--verbose]
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
    run, cfg, now, platform: PL.current(), family: PL.describe().family, distro: PL.describe().distro, version: PL.describe().version, policy: H.load().policy, instance: C.INSTANCE_ROOT, engine: path.join(__dirname, '..', '..'),
    detail: t => { if (onLabel) onLabel(t); }, // the live step's detail on a terminal; nothing elsewhere
    cache: cfg.paths.cache, home: os.homedir(), today: localDay(now), ...o,
  };
}

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const OTHER = 'other: each line says what to do';
const ALERTS = 'ALERT: an indicator of compromise matched; stop and investigate (the supply-chain runbook)';

// cells(u, f, {note}) — a finding's row in columns: name, have → want, age (and its note), or its text when the check
// gave no facts
function cells(u, f, o = {}) {
  const x = f.facts || {};
  if (!x.name) return [f.text];
  return [x.name, x.have || '', x.have && x.want ? (u.unicode ? '→' : '->') : '', x.want || '', { text: x.age >= 0 ? `${x.age}d` : '', right: true }, o.note ? x.note || '' : ''];
}

// summaryLines(u, found) — the Summary's lines: alerts first, then what to act on under what to do about it (the order
// the checks found them in), all in one set of columns
function summaryLines(u, found) {
  const groups = new Map();
  for (const f of found) {
    const k = f.kind === 'alert' ? ALERTS : (f.facts && f.facts.fix) || OTHER;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const rank = k => (k === ALERTS ? 0 : k === OTHER ? 2 : 1);
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
  const rows = u.rows(order.flatMap(k => groups.get(k).map(f => cells(u, f))), { indent: 6 });
  const lines = [];
  let i = 0;
  for (const k of order) {
    lines.push(`  ${u.paint(k === ALERTS ? '1;31' : '1', k)}`, ...rows.slice(i, i + groups.get(k).length));
    i += groups.get(k).length;
  }
  return lines;
}

// audit(ctx, {only, write, ui}) — run the checks for ctx.platform; {actions, alerts, skipped}. With a drawing ui
// (lib/ui.js, tty) the result is laid out as steps and a table; otherwise each line goes to write as the Bash audit's.
async function audit(ctx, o = {}) {
  const u = o.ui && o.ui.tty ? o.ui : null;
  const write = o.write || (s => process.stdout.write(`${s}\n`));
  const actions = [], alerts = [], skipped = [];
  const found = []; // every action and alert with its facts, for the Summary
  let folded = 0;
  const todo = CHECKS.filter(c => !o.only || o.only.includes(c.id));
  if (u) u.header('steward sc audit', `${PL.label({ platform: ctx.platform, distro: ctx.distro || null, version: ctx.version || null })} · ${todo.filter(c => c.platforms.includes(ctx.platform)).length} checks`);
  for (const c of todo) {
    if (!c.platforms.includes(ctx.platform)) { skipped.push(c.id); continue; }
    // this check's lines: printed as they come (plain), or kept and printed under its row (ui): its other lines, then
    // its findings in columns
    const mine = { actions: 0, alerts: 0, held: 0, lines: [], findings: [] };
    const PLAIN = { line: '  ', ok: '  ok     ', held: '  held   ', info: '  info   ', clean: '  clean  ', action: '  \x1b[1;33mACTION\x1b[0m ', alert: '  \x1b[1;31mALERT\x1b[0m ' };
    const SHOWN = { ok: ['ok', '32'], clean: ['ok', '32'], held: ['held', '2'], info: ['info', '2'], line: [null, '2'], action: ['warn', '33'], alert: ['fail', '31'] };
    const emit = (kind, t, facts) => {
      if (!u) { write(`${PLAIN[kind]}${t}`); return; }
      if (kind === 'action' || kind === 'alert' || kind === 'held') { mine.findings.push({ kind, text: strip(t), facts }); return; }
      const [sym, col] = SHOWN[kind];
      const body = kind === 'line' || kind === 'info' || kind === 'held' ? u.paint('2', u.cut(strip(t), u.cols() - 8)) : u.cut(strip(t), u.cols() - 8);
      mine.lines.push(`      ${sym ? `${u.paint(col, u.sym[sym])} ` : '  '}${body}`);
    };
    const out = {
      line: t => emit('line', t), ok: t => emit('ok', t), held: (t, f) => { mine.held++; emit('held', t, f); }, info: t => emit('info', t), clean: t => emit('clean', t),
      action: (t, f) => { actions.push(t); found.push({ kind: 'action', text: t, facts: f }); mine.actions++; emit('action', t, f); },
      alert: t => { alerts.push(t); found.push({ kind: 'alert', text: t }); mine.alerts++; emit('alert', t); },
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
      const status = failed || mine.alerts ? 'fail' : mine.actions ? 'warn' : 'ok';
      // what it found in columns: alerts, then what to act on (by what to do), then what's held; its other lines fold
      // away unless --verbose, or the check failed and they may say why
      const quiet = !failed && !o.verbose;
      if (quiet && mine.lines.length) folded++;
      const SYMS = { alert: ['fail', '31'], action: ['warn', '33'], held: ['held', '2'] };
      const fix = f => (f.facts && f.facts.fix) || '';
      const list = ['alert', 'action', 'held'].flatMap(k => mine.findings.filter(f => f.kind === k).sort((a, b) => (k === 'action' ? fix(a).localeCompare(fix(b)) : 0)));
      const rows = u.rows(list.map(f => [{ text: u.sym[SYMS[f.kind][0]], color: SYMS[f.kind][1] }, ...cells(u, f, { note: true })]), { indent: 6 });
      step.done(status, summary, [...(quiet ? [] : mine.lines), ...rows]);
    }
  }
  if (u) {
    u.print('');
    u.header('Summary', `${actions.length} action(s) · ${alerts.length} alert(s) · ${u.fmt(Date.now() - T0)}`);
    for (const l of summaryLines(u, found)) u.print(l);
    if (!actions.length && !alerts.length) u.print(`  ${u.paint('32', u.sym.ok)}  nothing to act on`);
    if (folded) u.print(u.paint('2', `  ${folded} check(s) have more lines: steward sc audit --verbose`));
    return { actions, alerts, skipped };
  }
  write(`\x1b[1;34m==>\x1b[0m Summary: ${actions.length} action(s), ${alerts.length} alert(s) \x1b[2m[${elapsed()}]\x1b[0m`);
  for (const a of alerts) write(`  ALERT  ${a}`);
  for (const a of actions) write(`  ACTION ${a}`);
  if (actions.length) write('  Next: steward sc plan (Homebrew, mise and declared updaters); apps, App Store, macOS and trust are manual.');
  return { actions, alerts, skipped };
}

module.exports = { audit, context, run, localDay };

if (require.main === module) {
  const i = process.argv.indexOf('--only');
  const only = i > 0 ? process.argv[i + 1].split(',') : null;
  const u = process.argv.includes('--plain') ? null : makeUi();
  audit(context(), { only, ui: u, verbose: process.argv.includes('--verbose') }).then(r => { if (r.alerts.length) process.exitCode = 2; })
    .catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
