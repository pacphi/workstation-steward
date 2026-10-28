#!/usr/bin/env node
// Repin project launcher configs from version-specific install paths to stable ones, per the [[repin]] rules in
// ai-tooling/ai-tooling.toml (D11, D12). Edits only files Git doesn't track (D6): tracked files are listed for a
// PR, and repos mid-merge or mid-rebase are refused. Every edit has a backup, a parse check and a receipt.
// Usage: repin.js                    plan only: every file, what changes, and whether it can be applied
//        repin.js --apply            plan, ask [y/N], then apply (DRY_RUN=1 stops after the plan)
//        repin.js --apply --tracked-local <file>...   also repin these tracked files, which is allowed only when
//                                    the pinned paths come solely from uncommitted local edits (D13)
//        repin.js --rollback <receipt.json>   restore the files a receipt changed (if they're unchanged since)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');
const C = require('../../lib/config.js');
const { scan } = require('../../lib/pins.js');

const policy = C.policy('ai-tooling/ai-tooling.toml');
const rules = (policy.repin || []).map(r => ({ ...r, from: C.untilde(r.from), to: C.untilde(r.to) }));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const git = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// A shell script (the AQE hook shim, the AQE runtime's bin/aqe and bin/aqe-mcp): no structure to compare, so
// applyRules is the whole change; parse() returns the text once `sh -n` accepts it.
const isScript = text => text.startsWith('#!/bin/sh') || text.startsWith('#!/usr/bin/env sh') || text.startsWith('#!/bin/bash');
function parse(file, text) {
  if (isScript(text)) {
    execFileSync(text.startsWith('#!/bin/bash') ? 'bash' : 'sh', ['-n'], { input: text, stdio: ['pipe', 'ignore', 'pipe'] });
    return text;
  }
  if (file.endsWith('.json')) return JSON.parse(text);
  return JSON.parse(execFileSync('yq', ['-p', 'toml', '-o', 'json', '.', '-'], { input: text, encoding: 'utf8' }));
}
// Every string value with the rules applied: the parsed new file must equal this, so only the intended paths moved.
function mapStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map(x => mapStrings(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}
const applyRules = s => rules.reduce((acc, r) => acc.split(r.from).join(r.to), s);

// gitState FILE — 'untracked' | 'tracked' | 'mid-merge' | 'not-git'
function gitState(file) {
  const dir = path.dirname(file);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return 'not-git';
  for (const p of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
    const gp = git(dir, ['rev-parse', '--git-path', p]);
    if (gp && fs.existsSync(path.resolve(dir, gp))) return 'mid-merge';
  }
  return git(top, ['ls-files', '--error-unmatch', path.relative(top, file)]) === null ? 'untracked' : 'tracked';
}

// Tracked files the owner named with --tracked-local (D13).
const trackedLocal = (() => {
  const a = process.argv.slice(2), i = a.indexOf('--tracked-local');
  if (i < 0) return new Set();
  const out = [];
  for (const x of a.slice(i + 1)) { if (x.startsWith('--')) break; out.push(C.userPath(x)); }
  return new Set(out);
})();

// committedHasPins FILE — true when HEAD's version of a tracked file already contains a from-path.
function committedHasPins(file) {
  const top = git(path.dirname(file), ['rev-parse', '--show-toplevel']);
  const committed = top && git(top, ['show', `HEAD:${path.relative(top, file)}`]);
  return committed === null || committed === undefined ? true : rules.some(r => committed.includes(r.from));
}

function plan() {
  const files = [...new Set(scan().filter(h => rules.some(r => r.from.startsWith(h.install + '/'))).map(h => h.file))].sort();
  return files.map(file => {
    const text = fs.readFileSync(file, 'utf8');
    const counts = rules.map(r => text.split(r.from).length - 1);
    const next = applyRules(text);
    const row = { file, counts, before: sha(text), state: gitState(file), problems: [] };
    // Anything still pointing into a from-install after the rules: an unmapped subpath.
    for (const r of rules) {
      const install = r.from.replace(/\/(bin|lib)\/.*$/, '');
      if (next.includes(install + '/')) row.problems.push(`unmapped path into ${C.tilde(install)}`);
    }
    for (const [i, r] of rules.entries()) if (counts[i] && !fs.existsSync(r.to.replace(/\/$/, ''))) row.problems.push(`target missing: ${C.tilde(r.to)}`);
    try {
      const a = mapStrings(parse(file, text), applyRules), b = parse(file, next);
      if (JSON.stringify(a) !== JSON.stringify(b)) row.problems.push('parse check failed');
    } catch (e) { row.problems.push(`unparseable: ${String(e.message).split('\n')[0]}`); }
    if (row.state === 'tracked') {
      if (committedHasPins(file)) row.problems.push('tracked by Git, and the committed version has these paths: change it through a PR');
      else {
        row.state = 'tracked; pins only in local edits';
        if (!trackedLocal.has(file)) row.problems.push('pins come only from uncommitted local edits: name it with --tracked-local to repin (D13)');
      }
    }
    if (row.state === 'mid-merge') row.problems.push('repo is mid-merge or mid-rebase');
    row.next = next;
    row.ok = !row.problems.length;
    return row;
  });
}

function show(rows) {
  console.log(`\x1b[1;34m==>\x1b[0m repin rules (ai-tooling/ai-tooling.toml)`);
  rules.forEach((r, i) => { console.log(`  [${i + 1}] ${C.tilde(r.from)}\n      → ${C.tilde(r.to)}  (${r.why})`); });
  console.log(`\x1b[1;34m==>\x1b[0m plan: ${rows.length} file(s)`);
  for (const r of rows) {
    const what = r.counts.map((c, i) => (c ? `[${i + 1}]×${c}` : '')).filter(Boolean).join(' ');
    console.log(`  ${r.ok ? 'apply' : 'SKIP '} ${C.tilde(r.file)}  ${what}  (${r.state})${r.ok ? '' : '  — ' + r.problems.join('; ')}`);
  }
  const ok = rows.filter(r => r.ok);
  const refs = ok.reduce((a, r) => a + r.counts.reduce((x, y) => x + y, 0), 0);
  console.log(`\x1b[1;34m==>\x1b[0m ${ok.length} file(s) to change (${refs} reference(s)); ${rows.length - ok.length} skipped`);
  return ok;
}

async function ask(q) {
  if (process.env.DRY_RUN === '1') return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

function apply(rows) {
  const dir = C.newBackupDir('repin');
  fs.mkdirSync(path.join(dir, 'home'), { mode: 0o700 });
  const receipt = { kind: 'repin', at: new Date().toISOString(), engine: C.ENGINE_VERSION, rules: policy.repin, backup: dir, files: [] };
  for (const r of rows) {
    // under home/ when the file is in the home folder, else under abs/: a backup path must never leave the backup folder
    const bak = r.file.startsWith(C.HOME + path.sep) ? path.join(dir, 'home', path.relative(C.HOME, r.file)) : path.join(dir, 'abs', r.file);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(r.file, bak, fs.constants.COPYFILE_EXCL);
    const mode = fs.statSync(r.file).mode;
    const tmp = `${r.file}.repin-${process.pid}`;
    fs.writeFileSync(tmp, r.next, { mode });
    fs.renameSync(tmp, r.file);
    const after = fs.readFileSync(r.file, 'utf8');
    if (sha(after) !== sha(r.next)) throw new Error(`write check failed: ${r.file}`);
    receipt.files.push({ path: C.tilde(r.file), sha_before: r.before, sha_after: sha(after), backup: C.tilde(bak), counts: r.counts });
  }
  const rp = path.join(dir, 'receipt.json');
  fs.writeFileSync(rp, JSON.stringify(receipt, null, 1) + '\n');
  console.log(`\x1b[1;34m==>\x1b[0m changed ${rows.length} file(s); receipt ${C.tilde(rp)}`);
  console.log(`  rollback: steward ai repin --rollback ${C.tilde(rp)}`);
  console.log('  Running Codex/Claude sessions keep their servers until restarted; new sessions use the new paths.');
}

function rollback(receiptPath) {
  const rc = JSON.parse(fs.readFileSync(C.userPath(receiptPath), 'utf8'));
  const changed = rc.files.filter(f => fs.existsSync(C.untilde(f.path)) && sha(fs.readFileSync(C.untilde(f.path), 'utf8')) !== f.sha_after);
  if (changed.length) { console.error(`refusing: ${changed.length} file(s) changed since the repin, e.g. ${changed[0].path}`); process.exit(1); }
  return rc;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--rollback')) {
    const receipt = args[args.indexOf('--rollback') + 1];
    if (!receipt || receipt.startsWith('--')) { console.error('usage: --rollback <receipt.json>'); process.exit(2); }
    const rc = rollback(receipt);
    for (const f of rc.files) console.log(`  restore ${f.path}`);
    if (!(await ask(`Restore ${rc.files.length} file(s) from ${C.tilde(rc.backup)}?`))) { console.log('nothing changed'); return; }
    for (const f of rc.files) fs.copyFileSync(C.untilde(f.backup), C.untilde(f.path));
    console.log(`restored ${rc.files.length} file(s)`);
    return;
  }
  if (!rules.length) { console.log('no [[repin]] rules in ai-tooling.toml'); return; }
  const ok = show(plan());
  if (!args.includes('--apply') || !ok.length) { if (!args.includes('--apply')) console.log('  plan only; run `steward ai repin --apply` to apply (asks first)'); return; }
  if (!(await ask(`Change ${ok.length} file(s) as above?`))) { console.log('nothing changed'); return; }
  apply(ok);
})().catch(e => { console.error(`ERROR ${e.message}`); process.exit(1); });
