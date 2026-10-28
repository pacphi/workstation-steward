#!/usr/bin/env node
// Reconcile onboarded projects with the qualified AI tool installs (lib/reconcile.js, D42): show the plan (per unit the
// steward copied: updated, kept because you edited it, yours, missing, no longer shipped, tracked), and with --apply
// ask once, then update each project with a backup and a receipt (the soak starts).
// Usage: reconcile.js <path> [--take <unit>…] [--json]          plan only
//        reconcile.js <path> --diff <unit>                      your copy against the qualified source
//        reconcile.js <path> --apply [--take <unit>…]           plan, ask [y/N], apply (DRY_RUN=1 stops)
//        reconcile.js --all [--apply] [--json]                  every onboarded project with AI tools: one table, one ask
//        reconcile.js --rollback <receipt.json>                 undo a reconcile (refuses if anything it wrote has changed since)
//        reconcile.js --banner     one line when the AI tools changed since the last full plan, or it found projects behind
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const P = require('../../lib/projects.js');
const R = require('../../lib/reconcile.js');
const { progress } = require('../../lib/progress.js');

const args = process.argv.slice(2);
const json = args.includes('--json');
const after = flag => { const i = args.indexOf(flag), out = []; if (i >= 0) for (const a of args.slice(i + 1)) { if (a.startsWith('--')) break; out.push(a); } return out; };
const take = after('--take');
const diffUnit = after('--diff')[0];
const target = args.find((a, i) => !a.startsWith('--') && !take.includes(a) && a !== diffUnit && args[i - 1] !== '--rollback');

const H = s => `\x1b[1;34m==>\x1b[0m ${s}`;
// What a reconcile does, in plain words: shown above a plan that would change something, before the question
// (docs/ai-tooling/upstream-and-reconcile.md#what-reconcile-does-to-your-project-in-plain-words)
const ABOUT = [
  'These are the agent, command, skill and helper files Claude Code reads in the project, copied from an older Ruflo',
  'or AQE. Updating them matches the versions installed now. Files you edited, your settings and anything Git tracks',
  'are not touched; every replaced file is backed up (undo: --rollback <receipt>). To see a change first: --diff <unit>.',
];
const STATE = { behind: 'unchanged since the steward wrote it', edited: 'you edited it; the source has a new version', yours: 'no baseline (from before the steward onboarded it)', missing: 'missing', dropped: 'the qualified installs no longer ship it' };

async function ask(q) {
  if (process.env.DRY_RUN === '1') return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

function show(p) {
  console.log(H(`reconcile plan: ${p.project}${p.tools.length ? ` (${p.tools.join(', ')})` : ''}`));
  if (p.stop) { console.log(`  nothing to do: ${p.stop}`); return; }
  if (R.todo(p).length) for (const l of ABOUT) console.log(`  ${l}`);
  const group = (title, units, line) => {
    if (!units.length) return;
    console.log(`  ${title} (${units.length})`);
    for (const u of units.slice(0, 15)) console.log(`    ${line(u)}`);
    if (units.length > 15) console.log(`    … ${units.length - 15} more (--json lists them all)`);
  };
  const of = (fn) => p.units.filter(fn);
  const lock = u => (u.locked ? ' [locked folder: Ruflo\'s own refresh stays off]' : '');
  const rel = u => (u.released ? ` [no receipt; an unedited copy of ${u.released.split('; ')[0]}]` : '');
  group('update: unchanged since the steward wrote it, or an unedited copy of a release', of(u => u.action === 'update'), u => `${u.unit} (${u.tool})${rel(u)}${lock(u)}`);
  group('take: the new version, as you asked (--take)', of(u => u.action === 'take'), u => `${u.unit} (${u.tool}; ${STATE[u.state]})${lock(u)}`);
  group('PR: tracked, so a change goes through a PR (not applied)', of(u => u.action === 'pr'), u => `${u.unit} (${STATE[u.state]})`);
  group('kept: you edited it, and the source has a new version', of(u => u.action === 'none' && u.state === 'edited'), u => `${u.unit}: --diff ${u.unit} to see it, --take ${u.unit} to take it`);
  group('yours: no baseline, so never touched', of(u => u.action === 'none' && u.state === 'yours'), u => `${u.unit}: --take ${u.unit} adopts the qualified version`);
  group('missing: `steward projects onboard` restores missing names', of(u => u.state === 'missing'), u => u.unit);
  group('no longer shipped: reported only (`steward projects offboard` is the way to remove)', of(u => u.state === 'dropped'), u => u.unit);
  for (const n of p.notes) console.log(`  note: ${n}`);
  const c = R.counts(p);
  console.log(H(`${c.update} update, ${c.take} take, ${c.pr} PR (not applied), ${c.edited} kept, ${c.yours} yours, ${c.missing} missing, ${c.dropped} no longer shipped, ${c.current} current`));
}

// No process.exit after output: a pipe is written asynchronously and would be cut off.
(async function main() {
  if (args.includes('--banner')) {
    // silent unless both add-ons are on (D39): reconcile needs the registry and the AI tool installs
    const on = require('../../lib/config.js').load().values.profiles;
    const line = on.projects && on.ai_tooling && R.bannerLine();
    if (line) console.log(`\x1b[1;33m!!\x1b[0m ${line}\n`);
    return;
  }
  if (args.includes('--rollback')) {
    const receipt = args[args.indexOf('--rollback') + 1];
    if (!receipt || receipt.startsWith('--')) { console.error('usage: steward projects reconcile --rollback <receipt.json>'); process.exitCode = 2; return; }
    const file = P.untilde(receipt);
    const rc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rc.kind !== 'reconcile') { console.error(`refusing: ${receipt} is a ${rc.kind || 'unknown'} receipt, not a reconcile one`); process.exitCode = 2; return; }
    if (rc.rolled_back) { console.error(`refusing: already rolled back (${rc.rolled_back})`); process.exitCode = 1; return; }
    const changed = R.changedSince(rc);
    if (changed.length) { console.error(`refusing: changed since the reconcile: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` … ${changed.length - 5} more` : ''}`); process.exitCode = 1; return; }
    for (const e of rc.entries) console.log(`  restore ${e.path}`);
    if (!(await ask(`Undo the reconcile of ${rc.project} (${rc.at})?`))) { console.log('nothing changed'); return; }
    R.undo(rc);
    R.markRolledBack(file);
    console.log(`undone; the backups stay in ${rc.backup}`);
    return;
  }
  if (args.includes('--all')) {
    if (take.length || diffUnit) { console.error('--take and --diff name one project: steward projects reconcile <path> --take <unit>'); process.exitCode = 2; return; }
    const st = progress(1).stage('plan every onboarded project');
    const plans = R.all({ each: (i, n, dir) => st.detail(`${i + 1}/${n} ${P.tilde(dir)}`) });
    st.done(`${plans.length} planned`);
    if (json) { console.log(JSON.stringify(plans, null, 1)); return; }
    const K = R.COUNT;
    console.log(`${'project'.padEnd(46)} ${K.map(k => k.padStart(8)).join('')}`);
    const short = P.shortener(plans.map(p => p.project));
    for (const p of plans) {
      const c = R.counts(p);
      console.log(`${short(p.project).padEnd(46)} ${K.map(k => String(c[k] || '·').padStart(8)).join('')}${p.stop ? `  (${p.stop})` : ''}`);
    }
    const go = plans.filter(p => !p.stop && R.todo(p).length);
    const n = go.reduce((s, p) => s + R.todo(p).length, 0);
    if (!go.length) { console.log('nothing to update'); return; }
    for (const l of ABOUT) console.log(`  ${l}`);
    if (!args.includes('--apply')) { console.log(`  plan only; ${n} unit(s) in ${go.length} project(s) would update. \`steward projects reconcile <path>\` shows one project; --all --apply applies (asks first)`); return; }
    if (!(await ask(`Update ${n} unit(s) in ${go.length} project(s), each with its own backup and receipt?`))) { console.log('nothing changed'); return; }
    let failed = 0;
    for (const p of go) {
      try { console.log(`  ${p.project}: receipt ${P.tilde(R.apply(p))}`); }
      catch (e) { failed++; console.error(`  ${p.project}: FAILED, undone: ${e.message}`); }
    }
    R.noteSeen(go.map(p => R.plan(p.dir)));
    console.log(H(`${go.length - failed} reconciled${failed ? `, ${failed} failed (each undone)` : ''}; rollback per project: steward projects reconcile --rollback <receipt>`));
    if (failed) process.exitCode = 1;
    return;
  }
  if (!target) { console.error('usage: steward projects reconcile <path> [--take <unit>…] [--diff <unit>] [--apply] [--json] | --all [--apply] | --rollback <receipt>'); process.exitCode = 2; return; }
  const dir = path.resolve(P.untilde(target));
  const p = R.plan(dir, { take });
  if (!p.stop) R.noteSeen([p]);
  if (diffUnit) {
    const u = p.units.find(x => x.unit === diffUnit.replace(/^\.\//, '').replace(/\/+$/, ''));
    if (!u || !u.from) { console.error(`${diffUnit}: not a unit the qualified installs ship into ${p.project}`); process.exitCode = 2; return; }
    if (u.state === 'missing') { console.log(`${u.unit} is missing here`); return; }
    process.stdout.write(R.diff(dir, u.unit, u.from) || `${u.unit} is current\n`);
    return;
  }
  if (json) { console.log(JSON.stringify(p, null, 1)); return; }
  show(p);
  if (p.stop) return;
  const n = R.todo(p).length;
  if (!args.includes('--apply')) { if (n) console.log(`  plan only; \`steward projects reconcile ${p.project} --apply\` applies it (asks first)`); return; }
  if (!n) { console.log('nothing to apply'); return; }
  if (!(await ask(`Update ${n} unit(s) in ${p.project}?`))) { console.log('nothing changed'); return; }
  const rp = R.apply(p);
  console.log(H(`applied; receipt ${P.tilde(rp)}`));
  console.log(`  rollback: steward projects reconcile --rollback ${P.tilde(rp)}`);
  const again = R.plan(dir, { take });
  R.noteSeen([again]);
  const left = R.todo(again);
  console.log(left.length ? `  CHECK: the plan still lists ${left.map(u => u.unit).join(', ')}` : '  check: the plan now has nothing left to apply');
})().catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
