#!/usr/bin/env node
// Codex MCP settings in project .codex/config.toml that the policy sets (ai-tooling.toml, D37): a tool whose approval_mode
// must be "prompt" ([[codex_prompt]]: today Brain's ruvnet_cli_run, declared destructive, carried from the migration as
// "approve" with no vetting), and a server that must launch with the stable Node link instead of a bare `node`
// ([[codex_stable_node]]). Edits only files Git doesn't track (D6): tracked files are listed for a PR, and repos
// mid-merge or mid-rebase are refused. Only existing tables change; a missing one is onboarding's job. Every edit has a
// backup, a parse check and a receipt (lib/localedit.js). The TOML is edited as text, so comments and order stay.
// Usage: approvals.js                      plan only: every file, what changes, and whether it can be applied
//        approvals.js --apply              plan, ask [y/N], then apply (DRY_RUN=1 stops after the plan)
//        approvals.js --rollback <receipt.json>   restore the files a receipt changed (if they're unchanged since)
const fs = require('fs');
const path = require('path');
const C = require('../../lib/config.js');
const P = require('../../lib/projects.js');
const { sha, gitState, stateProblems, ask, apply, runRollback } = require('../../lib/localedit.js');

const policy = C.policy('ai-tooling/ai-tooling.toml');
const prompts = policy.codex_prompt || [];
const stableNode = (policy.codex_stable_node || []).map(s => s.server);
const NODE = C.untilde(policy.launch.node);

// section(lines, header) — [start, end) of the table `[header]`: from its line to the next table header
function section(lines, header) {
  const i = lines.findIndex(l => l.trim() === `[${header}]`);
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
  return [i, j];
}

// edit(text) — {next, changes: ['ruvnet-brain ruvnet_cli_run: approve → prompt', …]}; next === text when nothing changes
function edit(text) {
  const lines = text.split('\n');
  const changes = [];
  for (const p of prompts) {
    const sec = section(lines, `mcp_servers.${p.server}.tools.${p.tool}`);
    if (!sec) continue;
    const k = lines.findIndex((l, i) => i > sec[0] && i < sec[1] && /^\s*approval_mode\s*=/.test(l));
    const cur = k < 0 ? '(unset)' : (lines[k].match(/=\s*"([^"]*)"/) || [])[1];
    if (cur === 'prompt') continue;
    if (k < 0) lines.splice(sec[0] + 1, 0, 'approval_mode = "prompt"'); else lines[k] = lines[k].replace(/=\s*"[^"]*"/, '= "prompt"');
    changes.push(`${p.server} ${p.tool}: ${cur} → prompt`);
  }
  for (const server of stableNode) {
    const sec = section(lines, `mcp_servers.${server}`);
    if (!sec) continue;
    const k = lines.findIndex((l, i) => i > sec[0] && i < sec[1] && /^\s*command\s*=\s*"node"\s*$/.test(l));
    if (k < 0) continue;
    lines[k] = `command = ${JSON.stringify(NODE)}`;
    changes.push(`${server}: command node → ${C.tilde(NODE)}`);
  }
  return { next: lines.join('\n'), changes };
}

function candidates() {
  const reg = new Map(P.loadRegistry().map(r => [r.abs, r]));
  const files = [];
  for (const f of P.discover()) {
    const r = P.effective(f, reg);
    if (r && r.decision === 'ignored') continue;
    if (f.path.split(path.sep).join('/').includes('/.claude/worktrees/')) continue; // agent worktrees: D19
    files.push(path.join(f.path, '.codex', 'config.toml'));
  }
  return files.filter(f => fs.existsSync(f));
}

function plan() {
  const rows = [];
  for (const file of candidates().sort()) {
    const text = fs.readFileSync(file, 'utf8');
    const { next, changes } = edit(text);
    if (!changes.length) continue;
    const row = { file, changes, count: changes.length, before: sha(text), state: gitState(file), problems: [], next };
    try {
      const a = P.toml(file);
      const tmp = `${file}.approvals-check-${process.pid}`;
      fs.writeFileSync(tmp, next);
      let b; try { b = P.toml(tmp); } finally { fs.rmSync(tmp, { force: true }); }
      // only the intended keys moved: re-apply the edits to the parsed original and compare
      const want = JSON.parse(JSON.stringify(a));
      for (const p of prompts) { const t = ((want.mcp_servers || {})[p.server] || {}).tools; if (t && t[p.tool]) t[p.tool].approval_mode = 'prompt'; }
      for (const s of stableNode) { const m = (want.mcp_servers || {})[s]; if (m && m.command === 'node') m.command = NODE; }
      if (JSON.stringify(want) !== JSON.stringify(b)) row.problems.push('parse check failed: more than the intended keys moved');
    } catch (e) { row.problems.push(`unparseable: ${String(e.message).split('\n')[0]}`); }
    const sp = stateProblems(row.state);
    if (sp) row.problems.push(sp);
    row.ok = !row.problems.length;
    rows.push(row);
  }
  return rows;
}

function show(rows) {
  console.log('\x1b[1;34m==>\x1b[0m Codex MCP settings the policy sets (ai-tooling.toml [[codex_prompt]], [[codex_stable_node]])');
  for (const p of prompts) console.log(`  ${p.server} ${p.tool} must be "prompt": ${p.why}`);
  for (const s of stableNode) console.log(`  ${s} must launch ${C.tilde(NODE)}, not a bare node`);
  for (const r of rows) console.log(`  ${r.ok ? 'apply' : 'SKIP '} ${C.tilde(r.file)}  ${r.changes.join('; ')}  (${r.state})${r.ok ? '' : '  — ' + r.problems.join('; ')}`);
  const ok = rows.filter(r => r.ok);
  console.log(`\x1b[1;34m==>\x1b[0m ${ok.length} file(s) to change (${ok.reduce((a, r) => a + r.count, 0)} setting(s)); ${rows.length - ok.length} skipped`);
  return ok;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--rollback')) { await runRollback(args); return; }
  const rows = plan();
  if (!rows.length) { console.log('every project already matches the policy.'); return; }
  const ok = show(rows);
  if (!args.includes('--apply') || !ok.length) { if (!args.includes('--apply')) console.log('  plan only; run `steward ai approvals --apply` to apply (asks first)'); return; }
  if (!(await ask(`Change ${ok.length} file(s) as above?`, 'ai-fix'))) { console.log('nothing changed'); return; }
  apply('approvals', ok, { recipe: 'approvals', note: 'Running Codex sessions keep their MCP servers until restarted; new sessions use the new settings.' });
})().catch(e => { console.error(`ERROR ${e.message}`); process.exit(1); });
