#!/usr/bin/env node
// Turn hook timeouts written in milliseconds into seconds (Claude Code reads them as seconds; lib/hooktimeouts.js). Ruflo
// writes 5000 where it means 5. Edits only files Git doesn't track (D6): tracked files are listed for a PR, and repos
// mid-merge or mid-rebase are refused. Every edit has a backup, a parse check and a receipt. Only the timeout numbers change.
// Usage: timeouts.js                      plan only: every file, how many timeouts change, and whether it can be applied
//        timeouts.js --apply              plan, ask [y/N], then apply (DRY_RUN=1 stops after the plan)
//        timeouts.js --rollback <receipt.json>   restore the files a receipt changed (if they're unchanged since)
const fs = require('fs');
const path = require('path');
const C = require('../../lib/config.js');
const P = require('../../lib/projects.js');
const H = require('../../lib/hooktimeouts.js');
const { sha, gitState, stateProblems, ask, apply, runRollback } = require('../../lib/localedit.js');

// Every settings file that sets a millisecond timeout: each project (not ignored, not an agent worktree: D19) and the user's.
function candidates() {
  const reg = new Map(P.loadRegistry().map(r => [r.abs, r]));
  const files = [];
  for (const f of P.discover()) {
    const r = P.effective(f, reg);
    if (r && r.decision === 'ignored') continue;
    if (f.path.split(path.sep).join('/').includes('/.claude/worktrees/')) continue;
    for (const rel of H.FILES) files.push(path.join(f.path, rel));
  }
  files.push(path.join(C.untilde(C.load().values.paths.claude_dir), 'settings.json'));
  return [...new Set(files)].filter(f => fs.existsSync(f));
}

function plan() {
  const rows = [];
  for (const file of candidates().sort()) {
    let text, data;
    try { text = fs.readFileSync(file, 'utf8'); data = JSON.parse(text); } catch { continue; }
    const hits = H.find(data);
    if (!hits.length) continue;
    const row = { file, hits, before: sha(text), state: gitState(file), problems: [] };
    const next = H.fixed(data);
    const out = H.serialize(text, next, data);
    if (out === null) row.problems.push('the file would be reformatted by a rewrite: fix it by hand');
    else if (H.find(JSON.parse(out)).length) row.problems.push('parse check failed');
    else row.next = out;
    const sp = stateProblems(row.state);
    if (sp) row.problems.push(sp);
    row.count = hits.length;
    row.ok = !row.problems.length;
    rows.push(row);
  }
  return rows;
}

function show(rows) {
  console.log('\x1b[1;34m==>\x1b[0m hook timeouts in milliseconds (Claude Code reads the field as seconds, default 600)');
  for (const r of rows) {
    const vals = [...new Set(r.hits.map(h => h.value))].sort((a, b) => a - b);
    console.log(`  ${r.ok ? 'apply' : 'SKIP '} ${C.tilde(r.file)}  ${r.hits.length} timeout(s): ${vals.map(v => `${v}→${Math.ceil(v / 1000)}`).join(' ')}  (${r.state})${r.ok ? '' : '  — ' + r.problems.join('; ')}`);
  }
  const ok = rows.filter(r => r.ok);
  const n = ok.reduce((a, r) => a + r.hits.length, 0);
  console.log(`\x1b[1;34m==>\x1b[0m ${ok.length} file(s) to change (${n} timeout(s)); ${rows.length - ok.length} skipped`);
  return ok;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--rollback')) { await runRollback(args); return; }
  const rows = plan();
  if (!rows.length) { console.log('no hook timeouts in milliseconds.'); return; }
  const ok = show(rows);
  if (!args.includes('--apply') || !ok.length) { if (!args.includes('--apply')) console.log('  plan only; run `steward ai timeouts --apply` to apply (asks first)'); return; }
  if (!(await ask(`Change ${ok.length} file(s) as above?`))) { console.log('nothing changed'); return; }
  apply('timeouts', ok, { recipe: 'timeouts', note: 'Running Claude Code sessions keep their hooks until restarted; new sessions use the new timeouts.' });
})().catch(e => { console.error(`ERROR ${e.message}`); process.exit(1); });
