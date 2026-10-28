#!/usr/bin/env node
// Offboard a project whose registry entry has no AI tools (lib/offboard.js, D31): show the plan (each launcher or
// settings file's removals, each path moved to the backup and why, what's left and why, the project-scope plugin
// installs Claude Code's own CLI removes), and with --apply ask, then make it so with a backup folder and a receipt.
// Usage: offboard.js <path> [--also <path>…] [--json]          plan only
//        offboard.js <path> --apply [--also <path>…]           plan, ask [y/N], apply (DRY_RUN=1 stops)
//        offboard.js --rollback <receipt.json>                 move everything back (refuses if anything changed since)
const fs = require('fs');
const readline = require('readline');
const P = require('../../lib/projects.js');
const B = require('../../lib/offboard.js');
const R = require('../../lib/reconcile.js');

const args = process.argv.slice(2);
const json = args.includes('--json');
const opts = { also: [] };
const ai = args.indexOf('--also');
if (ai >= 0) for (const a of args.slice(ai + 1)) { if (a.startsWith('--')) break; opts.also.push(a); }
const target = args.find((a, i) => !a.startsWith('--') && !(ai >= 0 && i > ai && !args.slice(ai + 1, i).some(x => x.startsWith('--'))));

const H = s => `\x1b[1;34m==>\x1b[0m ${s}`;
const strip = p => p.split(P.HOME).join('~');

async function ask(q) {
  if (process.env.DRY_RUN === '1') return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

function show(p) {
  console.log(H(`offboard plan: ${p.project}`));
  if (p.stop) { console.log(`  nothing to do: ${p.stop}`); return; }
  for (const c of p.configs) {
    console.log(`  ${c.action === 'archive' ? 'move  ' : 'edit  '} ${c.path}${c.action === 'archive' ? ' (nothing else in it: the whole file moves to the backup)' : ''}`);
    for (const l of c.changes.slice(0, 14)) console.log(`           ${strip(l)}`);
    if (c.changes.length > 14) console.log(`           … ${c.changes.length - 14} more`);
  }
  const groups = {};
  for (const m of p.moves) (groups[m.why] = groups[m.why] || []).push(m.path);
  for (const [why, ps] of Object.entries(groups)) {
    console.log(`  move   ${ps.length} path(s): ${why}`);
    for (const x of ps.slice(0, 10)) console.log(`           ${x}`);
    if (ps.length > 10) console.log(`           … ${ps.length - 10} more`);
  }
  if (p.rmdirs.length) console.log(`  rmdir  ${p.rmdirs.join(', ')} (empty once the moves are done)`);
  if (p.left.length) { console.log(H('left in place')); for (const l of p.left) console.log(`  ${l}`); }
  if (p.notes.length) { console.log(H('notes')); for (const n of p.notes) console.log(`  ${strip(n)}`); }
  if (p.plugins.length) {
    console.log(H('project-scope plugin installs: run these BEFORE --apply (they edit .claude/settings.json; listed, never run)'));
    for (const n of p.plugins) console.log(`  cd ${p.project} && claude plugin uninstall ${n} --scope project`);
  }
  console.log(H(`${p.configs.filter(c => c.action === 'edit').length} edit, ${p.moves.length + p.configs.filter(c => c.action === 'archive').length} move, ${p.rmdirs.length} rmdir, ${p.left.length} left`));
}

// No process.exit after output: a pipe is written asynchronously and would be cut off.
(async function main() {
  if (args.includes('--rollback')) {
    const receipt = args[args.indexOf('--rollback') + 1];
    if (!receipt || receipt.startsWith('--')) { console.error('usage: steward projects offboard --rollback <receipt.json>'); process.exitCode = 2; return; }
    const rc = JSON.parse(fs.readFileSync(P.userPath(receipt), 'utf8'));
    const changed = B.changedSince(rc);
    if (changed.length) { console.error(`refusing: changed since the apply: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` … ${changed.length - 5} more` : ''}`); process.exitCode = 1; return; }
    for (const e of rc.entries) console.log(`  ${e.action === 'move' ? 'move back' : e.action === 'edit' ? 'restore' : 'recreate'} ${e.path}`);
    if (!(await ask(`Undo the offboard of ${rc.project} (${rc.at})?`))) { console.log('nothing changed'); return; }
    B.undo(rc);
    R.markRolledBack(P.untilde(receipt)); // the onboard receipts before it count as reconcile baselines again
    console.log(`undone; the receipt and any edit backups stay in ${rc.backup}`);
    return;
  }
  if (!target) { console.error('usage: steward projects offboard <path> [--also <path>…] [--apply] [--json] | --rollback <receipt>'); process.exitCode = 2; return; }
  const p = B.plan(P.userPath(target), opts);
  if (json) { console.log(JSON.stringify(p, (k, v) => (k === 'next' || k === 'text' ? undefined : v), 1)); return; }
  show(p);
  const n = p.configs.length + p.moves.length + p.rmdirs.length;
  if (!args.includes('--apply')) { if (!p.stop && n) console.log('  plan only; `steward projects offboard <path> --apply` applies it (asks first)'); return; }
  const why = B.refusals(p);
  if (why.length) { for (const w of why) console.error(`refusing: ${w}`); process.exitCode = 1; return; }
  if (!n) { console.log('nothing to apply'); return; }
  if (p.plugins.length) console.log(`  note: Claude Code still records ${p.plugins.length} project-scope plugin install(s) here; the uninstall commands above come first`);
  if (!(await ask(`Offboard ${p.project}: ${n} change(s), moved paths kept in the backup?`))) { console.log('nothing changed'); return; }
  const rp = B.apply(p);
  console.log(H(`applied; receipt ${P.tilde(rp)}`));
  console.log(`  rollback: steward projects offboard --rollback ${P.tilde(rp)}`);
  const again = B.plan(p.dir, opts);
  const left = again.stop ? [] : [...again.configs.map(c => c.path), ...again.moves.map(m => m.path)];
  console.log(left.length ? `  CHECK: the plan still lists ${left.join(', ')}` : '  check: the plan now has nothing left to apply');
})().catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
