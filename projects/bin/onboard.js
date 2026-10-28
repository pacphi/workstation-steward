#!/usr/bin/env node
// Onboard a project (lib/onboard.js): show the plan (per file its Git state and action: edit in place, PR, create,
// refresh, manual; the .git/info/exclude entries, the hooks' Node, existing keep-off breaks and the owner's manual
// steps), and with --apply ask, then make the edit and create changes with a backup and a receipt.
// Usage: onboard.js <path> [--refresh <file>…] [--replace-older] [--fix-keep-off] [--remove-unpinned] [--no-approvals] [--json]   plan only
//        onboard.js <path> --apply [--refresh <file>…] [--no-approvals]    plan, ask [y/N], apply (DRY_RUN=1 stops)
//        onboard.js --all [--json]     one line per onboarded project with AI tools (counts only)
//        onboard.js --rollback <receipt.json>   undo an apply (refuses if anything it wrote has changed since)
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const P = require('../../lib/projects.js');
const O = require('../../lib/onboard.js');
const R = require('../../lib/reconcile.js');
const { progress } = require('../../lib/progress.js');

const args = process.argv.slice(2);
const json = args.includes('--json');
const opts = { approvals: !args.includes('--no-approvals'), replaceOlder: args.includes('--replace-older'), fixKeepOff: args.includes('--fix-keep-off'), removeUnpinned: args.includes('--remove-unpinned'), refresh: [] };
const ri = args.indexOf('--refresh');
if (ri >= 0) for (const a of args.slice(ri + 1)) { if (a.startsWith('--')) break; opts.refresh.push(a); }
const target = args.find((a, i) => !a.startsWith('--') && !(ri >= 0 && i > ri && !args.slice(ri + 1, i).some(x => x.startsWith('--'))));

const H = s => `\x1b[1;34m==>\x1b[0m ${s}`;
const LABEL = { edit: 'edit  ', pr: 'PR    ', create: 'create', manual: 'MANUAL', none: 'ok    ' };
const strip = p => p.split(P.HOME).join('~');

async function ask(q) {
  if (process.env.DRY_RUN === '1') return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

function show(p) {
  console.log(H(`onboard plan: ${p.project}${p.tools.length ? ` (${p.tools.join(', ')})` : ''}${p.inherits ? `, inherits ${p.inherits}` : ''}`));
  if (p.stop) { console.log(`  nothing to do: ${p.stop}`); return; }
  for (const f of p.files) {
    if (f.action === 'none') continue;
    const why = f.action === 'manual' ? " (exists but doesn't parse: fix it by hand)" : f.action === 'pr' ? ' (tracked: changes go through a PR)' : '';
    console.log(`  ${LABEL[f.action]} ${(f.tool ? `${f.path} (${f.tool})` : f.path).padEnd(38)} ${f.state}${why}`);
    for (const c of f.changes.slice(0, 12)) console.log(`           ${strip(c)}`);
    if (f.changes.length > 12) console.log(`           … ${f.changes.length - 12} more`);
    for (const k of f.kept || []) console.log(`           = ${k}`);
  }
  const acted = new Set(p.files.filter(f => f.action !== 'none').map(f => f.path));
  const ok = [...new Set(p.files.filter(f => f.action === 'none' && !acted.has(f.path)).map(f => f.path))];
  if (ok.length) console.log(`  ok      ${ok.join(', ')}`);
  if (p.exclude.length) { console.log(H('.git/info/exclude (files onboarding creates, so `git status` stays clean)')); for (const e of p.exclude) console.log(`  + ${e}`); }
  console.log(H('hooks run a bare `node`'));
  console.log(`  mise resolves Node ${p.node.version} here; ${p.node.engines.map(e => `${e.tool} needs ${e.range || 'no stated minimum'}`).join(', ')}`);
  if (p.keepoff.length) { console.log(H('keep-off breaks already in the project (reported; --fix-keep-off sets the ones in the settings files)')); for (const k of p.keepoff) console.log(`  ${k.file} ${k.key} = ${JSON.stringify(k.found)} (should be ${JSON.stringify(k.want)}): ${k.why}`); }
  if (p.notes.length) { console.log(H('notes')); for (const n of p.notes) console.log(`  ${strip(n)}`); }
  if (p.manual.length) { console.log(H('manual steps (listed, never run)')); for (const m of p.manual) console.log(`  ${m.tool}: ${m.text}`); }
  const n = a => p.files.filter(f => f.action === a).length;
  const kept = p.files.flatMap(f => f.kept || []);
  if (kept.length && !opts.replaceOlder && kept.some(k => k.includes('--replace-older'))) console.log('  some kept hooks are older forms --replace-older swaps for the profile\'s (transport v1 inline, npx agentic-qe hooks, ^Task$)');
  if (p.files.some(f => f.path === '.claude/settings.json' && f.action !== 'none')) console.log(`  settings.json changes take effect when Claude Code next starts here, and it asks to trust changed hooks.`);
  console.log(H(`${n('edit')} edit, ${n('create')} create, ${n('pr')} PR (not applied: rollout), ${n('manual')} manual`));
}

// No process.exit after output: a pipe is written asynchronously and would be cut off.
(async function main() {
  if (args.includes('--rollback')) {
    const receipt = args[args.indexOf('--rollback') + 1];
    if (!receipt || receipt.startsWith('--')) { console.error('usage: steward projects onboard --rollback <receipt.json>'); process.exitCode = 2; return; }
    const rc = JSON.parse(fs.readFileSync(P.untilde(receipt), 'utf8'));
    const changed = O.changedSince(rc);
    if (changed.length) { console.error(`refusing: changed since the apply: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` … ${changed.length - 5} more` : ''}`); process.exitCode = 1; return; }
    for (const e of rc.entries) console.log(`  ${e.names ? `remove ${e.names.length} name(s) from` : e.backup ? 'restore' : 'remove'} ${e.path}`);
    if (rc.exclude) console.log(`  remove the onboard block from ${rc.exclude.file}`);
    if (!(await ask(`Undo the onboard of ${rc.project} (${rc.at})?`))) { console.log('nothing changed'); return; }
    O.undo(rc);
    R.markRolledBack(P.untilde(receipt)); // its hashes stop counting as reconcile baselines
    console.log(`undone; the backups stay in ${rc.backup}`);
    return;
  }
  if (args.includes('--all')) {
    const todo = P.loadRegistry().filter(r => r.decision === 'onboarded' && (r.ai || []).length && P.exists(r.abs));
    const st = progress(1).stage(`plan ${todo.length} projects`);
    const rows = todo.map((r, i) => { st.detail(`${i + 1}/${todo.length} ${P.tilde(r.abs)}`); return O.plan(r.abs, opts); });
    st.done(`${rows.length} planned`);
    if (json) { console.log(JSON.stringify(rows, (k, v) => (k === 'next' || k === 'text' ? undefined : v), 1)); return; }
    const A = ['edit', 'create', 'pr', 'manual'];
    console.log(`${'project'.padEnd(46)} ${A.map(a => a.padStart(6)).join(' ')}  changes  exclude  keepoff  node`);
    const short = P.shortener(rows.map(p => p.project));
    for (const p of rows) {
      const c = a => p.files.filter(f => f.action === a).length;
      const ch = p.files.reduce((s, f) => s + f.changes.length, 0);
      console.log(`${short(p.project).padEnd(46)} ${A.map(a => String(c(a) || '·').padStart(6)).join(' ')}  ${String(ch).padStart(7)}  ${String(p.exclude.length).padStart(7)}  ${String(p.keepoff.length).padStart(7)}  ${p.node ? p.node.version : '-'}${p.stop ? `  (${p.stop})` : ''}`);
    }
    return;
  }
  if (!target) { console.error('usage: steward projects onboard <path> [--refresh <file>…] [--no-approvals] [--json] | --all'); process.exitCode = 2; return; }
  const p = O.plan(path.resolve(P.untilde(target)), opts);
  if (json) { console.log(JSON.stringify(p, (k, v) => (k === 'next' || k === 'text' ? undefined : v), 1)); return; }
  show(p);
  if (!args.includes('--apply')) { if (!p.stop && p.files.some(f => f.action === 'edit' || f.action === 'create')) console.log('  plan only; `steward projects onboard <path> --apply` applies it (asks first)'); return; }
  const why = O.refusals(p);
  if (why.length) { for (const w of why) console.error(`refusing: ${w}`); process.exitCode = 1; return; }
  const n = p.files.filter(f => f.action === 'edit' || f.action === 'create').length;
  if (!n) { console.log('nothing to apply'); return; }
  if (!(await ask(`Apply ${n} change(s) to ${p.project}?`))) { console.log('nothing changed'); return; }
  const rp = O.apply(p);
  console.log(H(`applied; receipt ${P.tilde(rp)}`));
  console.log(`  rollback: steward projects onboard --rollback ${P.tilde(rp)}`);
  const again = O.plan(p.dir, opts);
  const left = again.files.filter(f => f.action === 'edit' || f.action === 'create');
  console.log(left.length ? `  CHECK: the plan still lists ${left.map(f => f.path).join(', ')}` : '  check: the plan now has nothing left to apply');
})().catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
