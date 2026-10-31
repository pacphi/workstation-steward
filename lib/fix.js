#!/usr/bin/env node
// steward fix (D59): the runner that turns the work list into done work. It reads the list (`steward brief --plan`, or
// a file `steward review --json` wrote), and works it top down. It runs only `steward` commands, through this engine's
// own bin/steward.js, never a shell command it was handed:
//   run       read-only, or a class [autonomy] allows: it runs, a writing command with --apply --unattended
//   ask       an engine command that writes and takes --unattended, but its class needs a yes: in a terminal it asks;
//             from Claude, it waits until the fix skill has asked the user and passes --only <id> --yes-to <class>
//   terminal  a writing command that doesn't take --unattended: in a terminal it asks, then runs it with its own
//             questions; from Claude, the user runs it in their terminal
//   yours     human-only (a merge, sudo, a trust store, by hand), or not a steward command: handed over, never run
//   skill     a maintainer flow (/steward-maintain), a sandbox qualification or a fleet repo: the fix skill takes it
//   wait      nothing to do yet (an update the gate still holds)
// A step whose after names one that didn't get done waits on it. A step that exits 4 (a question its policy may not
// answer, D58) waits on the user, with whatever it finished before; any other failure stops the run, with the rollback
// its receipt names. Each step's output streams to stderr and to a log beside the run's record,
// <state>/backups/fix-<time>/receipt.json, which names every receipt the steps wrote.
// Usage: fix.js                         the plan: each step and what --apply would do with it; nothing runs
//        fix.js --apply                 work the list
//        fix.js --apply --only <id> [--yes-to <class>]…
//                                       one step; --yes-to is the user's yes to that class, for that step only
//        fix.js … --from <file>         the work list in a file ({items: […]}: steward review --json, brief --plan --json)
//        fix.js … --json                the plan or the summary as data, on stdout (step output stays on stderr)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./config.js');
const A = require('./autonomy.js');

// a step's command, one part at a time ("x, then y"), as lib/autonomy.js reads it
const parts = cmd => String(cmd).split(/,\s*then\s+|;\s+/).map(s => s.trim()).filter(Boolean);

// stewardPart(s) — {words, env, cmd, writes} for a part this runner may run: a `steward …` command in lib/commands.js,
// with at most a DRY_RUN=1 in front. null for anything else: another program, a <placeholder>, shell syntax
function stewardPart(s) {
  let t = s;
  const env = {};
  if (/^DRY_RUN=1 /.test(t)) { env.DRY_RUN = '1'; t = t.slice('DRY_RUN=1 '.length); }
  if (!/^steward(-dev)? /.test(t) || /<[^>]*>|[|;&$`<>(){}"'\\]/.test(t)) return null;
  const words = t.split(/\s+/).slice(1);
  const hit = require('./commands.js').find(words);
  if (!hit) return null;
  const doctorInstall = hit.cmd.area === '' && hit.cmd.name === 'doctor' && words.includes('--install');
  return { text: s, words, env, cmd: hit.cmd, writes: Boolean((hit.cmd.writes || doctorInstall) && !env.DRY_RUN) };
}

const SKILL_PART = /^\/steward-maintain\b|\/qualify\/aqe\/run\.sh( |$)/;

// disposition(item, policy, yesTo) — {how, why, parts, classes}: what --apply does with a step (the list above)
function disposition(item, policy, yesTo = []) {
  if (item.wait || item.severity === 'wait') return { how: 'wait', why: item.how || 'nothing to do yet' };
  if (!item.cmd) return item.skill ? { how: 'skill', why: `the ${item.skill} skill` } : { how: 'yours', why: item.how || 'by hand' };
  if (item.actor === 'human') return { how: 'yours', why: 'a step only you take' };
  const ps = parts(item.cmd);
  const parsed = ps.map(stewardPart);
  if (parsed.some(p => !p)) {
    return ps.some(p => SKILL_PART.test(p)) ? { how: 'skill', why: 'a maintainer flow or a qualification: the fix skill takes it' } : { how: 'yours', why: 'not a steward command this runner may run' };
  }
  // a steward command only a person runs (skills install) is theirs, whatever the list says
  if (parsed.some(p => p.writes && A.classify(p.text, policy).actor === 'human')) return { how: 'yours', why: 'a step only you take' };
  const ok = A.allowed(policy);
  for (const p of parsed) p.cls = p.writes ? A.classify(p.text, policy).class : null;
  const held = parsed.filter(p => p.writes && !ok.has(p.cls) && !yesTo.includes(p.cls));
  const byYes = parsed.some(p => p.writes && !ok.has(p.cls));
  if (!held.length) return { how: 'run', why: byYes ? 'your yes for this run (--yes-to)' : parsed.some(p => p.writes) ? 'your [autonomy] allows it' : 'read-only', parts: parsed };
  const classes = [...new Set(held.map(p => p.cls).filter(Boolean))];
  if (held.every(p => p.cmd.unattended && p.cls)) return { how: 'ask', why: `needs your yes (${classes.join(', ')})`, parts: parsed, classes };
  return { how: 'terminal', why: `it asks its own questions (${classes.join(', ') || 'no class'})`, parts: parsed, classes };
}

// argv(p, {yesTo, attended}) — the arguments for one part: a writing command gets --apply when it takes one, and,
// unattended, --unattended and the user's --yes-to
function argv(p, { yesTo = [], attended = false } = {}) {
  const out = [...p.words];
  if (!p.writes) return out;
  if ((p.cmd.usage || '').includes('--apply') && !out.includes('--apply') && !out.includes('--rollback')) out.push('--apply');
  if (!attended) { out.push('--unattended'); for (const c of yesTo) out.push('--yes-to', c); }
  return out;
}

const NOT_DONE = new Set(['skipped', 'waiting', 'declined', 'failed', 'not-run', 'yours', 'skill', 'wait']);

// work(items, opts) — {results, failed}: the list worked top down. opts: policy ([autonomy]), only (one step's id),
// yesTo (with only), tty and ask(question) → Promise<boolean> (a person at a terminal), and exec({argv, env, attended,
// item, n}) → Promise<{code, receipts, log, tail}> (bin/steward.js; tests pass a stand-in). Nothing else runs anything
/** @param {any[]} items @param {{policy: any, only?: string | null, yesTo?: string[], tty?: boolean, ask?: ((q: string) => Promise<boolean>) | null, exec: (x: any) => Promise<any>, onStep?: (n: number, total: number, item: any) => void}} opts */
async function work(items, { policy, only = null, yesTo = [], tty = false, ask = null, exec, onStep = () => {} }) {
  const results = [];
  const outcome = {};
  let failed = null;
  const list = only ? items.filter(x => x.id === only) : items;
  for (const [n, item] of list.entries()) {
    const base = { id: item.id, text: item.text, cmd: item.cmd || null, actor: item.actor || null, class: item.class || null };
    const done = r => { outcome[item.id] = r.outcome; results.push({ ...base, ...r }); };
    if (failed) { done({ outcome: 'not-run', why: `the run stopped at ${failed.id}` }); continue; }
    const blocked = only ? [] : (item.after || []).filter(a => items.some(x => x.id === a) && NOT_DONE.has(outcome[a]));
    if (blocked.length) { done({ outcome: 'skipped', why: `waits on ${blocked.join(', ')}` }); continue; }
    const d = disposition(item, policy, yesTo);
    if (['wait', 'yours', 'skill'].includes(d.how)) { done({ outcome: d.how, why: d.why }); continue; }
    let attended = false, grant = yesTo;
    if (d.how === 'ask' || d.how === 'terminal') {
      if (!(tty && ask)) {
        done({ outcome: 'waiting', why: d.how === 'ask' ? `${d.why}: steward fix --apply --only ${item.id}${d.classes.map(c => ` --yes-to ${c}`).join('')}` : `${d.why}: run it in your terminal: ${item.cmd}` });
        continue;
      }
      if (!(await ask(`${item.text}\n  run ${item.cmd}?`))) { done({ outcome: 'declined', why: 'you said no' }); continue; }
      if (d.how === 'ask') grant = [...yesTo, ...d.classes];
      else attended = true;
    }
    onStep(n, list.length, item);
    const receipts = [], logs = [];
    let r = { outcome: 'done', why: d.why };
    for (const p of d.parts) {
      const x = await exec({ argv: argv(p, { yesTo: grant, attended }), env: p.env, attended, item, n });
      receipts.push(...(x.receipts || []));
      if (x.log) logs.push(x.log);
      if (x.code === 0) continue;
      if (x.code === A.REFUSED) r = { outcome: 'waiting', why: `stopped at a question it may not answer${x.tail ? `: ${x.tail}` : ''}` };
      else r = { outcome: 'failed', why: `${p.text} exited ${x.code}${x.tail ? `: ${x.tail}` : ''}`, exit: x.code };
      break;
    }
    const rollback = item.rollback || receipts.map(f => (readJSON(f) || {}).rollback).find(Boolean) || null;
    done({ ...r, receipts, logs, ...(rollback && r.outcome !== 'done' ? { rollback } : {}) });
    if (r.outcome === 'failed') failed = item;
  }
  return { results, failed: failed ? failed.id : null };
}

const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// summary(results) — the run in four lists: done (with receipts), waiting on you, for the skill, failed (with rollbacks)
const GROUPS = { done: ['done'], 'waiting on you': ['waiting', 'declined', 'yours'], 'for the fix skill': ['skill'], failed: ['failed'], 'not run': ['skipped', 'not-run', 'wait'] };
function summary(results) {
  const out = [];
  for (const [g, kinds] of Object.entries(GROUPS)) {
    const rs = results.filter(r => kinds.includes(r.outcome));
    if (!rs.length) continue;
    out.push(`${g} (${rs.length}):`);
    for (const r of rs) {
      out.push(`  ${r.text}`);
      if (r.cmd) out.push(`    ${r.cmd}`);
      if (r.outcome !== 'done' || !(r.receipts || []).length) out.push(`    ${r.outcome}: ${r.why}`);
      for (const f of r.receipts || []) out.push(`    receipt ${C.tilde(f)}`);
      if (r.rollback) out.push(`    rollback: ${r.rollback}`);
    }
  }
  return out.length ? out : ['nothing to do'];
}

// planLines(items, policy) — the plan for a person: each step, its command and what --apply would do
function planLines(items, policy) {
  if (!items.length) return ['steward fix: nothing needs doing'];
  return items.flatMap((x, i) => { const d = disposition(x, policy); return [`${i + 1}. ${x.text}`, `   → ${x.cmd || x.how || '(nothing to run)'}`, `     ${d.how}: ${d.why}`]; });
}

// readItems(file) — a work list from a file, each step with an id (review items have none: review-<n>)
function readItems(file) {
  const j = JSON.parse(fs.readFileSync(C.userPath(file), 'utf8'));
  return (Array.isArray(j) ? j : j.items || []).map((x, i) => ({ ...x, id: x.id || `${x.section ? 'review' : 'item'}-${i + 1}` }));
}

// listing(dir) — the receipts under <state>/backups now, to tell which ones a step wrote
const listing = dir => { try { return new Set(fs.readdirSync(dir)); } catch { return new Set(); } };

// realExec(record) — exec for work(): this engine's bin/steward.js (never the steward on PATH, which may be an older
// release), with the instance named so a dev build doesn't fall back to its examples; output to stderr and a log
function realExec(record) {
  const backups = path.join(C.load().values.paths.state, 'backups');
  return ({ argv: args, env, attended, item, n }) => new Promise(resolve => {
    const before = listing(backups);
    const log = path.join(record.dir, `${String(n + 1).padStart(2, '0')}-${String(item.id).replace(/[^\w.-]+/g, '_')}.log`);
    const out = fs.openSync(log, 'a', 0o600);
    fs.writeSync(out, `$ steward ${args.join(' ')}\n`);
    const p = spawn(process.execPath, [path.join(C.REPO_ROOT, 'bin', 'steward.js'), ...args], {
      cwd: C.REPO_ROOT, stdio: attended ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, STEWARD_INSTANCE: C.INSTANCE_ROOT, STEWARD_CWD: process.env.STEWARD_CWD || process.cwd() },
    });
    let tail = '';
    const take = d => { fs.writeSync(out, d); process.stderr.write(d); tail = (tail + d).slice(-2000); };
    if (!attended) { p.stdout.on('data', take); p.stderr.on('data', take); }
    p.on('close', code => {
      fs.closeSync(out);
      const receipts = [...listing(backups)].filter(d => !before.has(d)).map(d => path.join(backups, d, 'receipt.json')).filter(f => fs.existsSync(f) && f !== record.file);
      const last = tail.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').filter(l => /\S/.test(l)).pop() || '';
      resolve({ code: code === null ? 1 : code, receipts, log, tail: last.slice(0, 300) });
    });
  });
}

module.exports = { parts, stewardPart, disposition, argv, work, summary, planLines, readItems, realExec, GROUPS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const die = m => { console.error(`steward fix: ${m}`); process.exit(2); };
  const yesTo = args.flatMap((a, i) => (a === '--yes-to' ? [args[i + 1]] : []));
  for (const c of yesTo) if (!(c in A.CLASSES)) die(`--yes-to takes a class (steward config lists them), got "${c}"`);
  const only = opt('--only');
  if (yesTo.length && !only) die('--yes-to needs --only <id>: a yes is for one step');
  const json = args.includes('--json');
  const { values } = C.load();
  const policy = values.autonomy;
  let items;
  try {
    if (opt('--from')) items = readItems(opt('--from'));
    else { const B = require('./brief.js'); items = B.workList(B.brief()).items; }
  } catch (e) { die(`couldn't read the work list: ${e.message}`); }
  if (only && !items.some(x => x.id === only)) die(`no step "${only}" in the work list (steward fix lists them)`);
  const at = new Date().toISOString();
  if (!args.includes('--apply') || process.env.DRY_RUN === '1') {
    if (json) console.log(JSON.stringify({ v: 1, at, subagents: policy.subagents, items: items.map(x => ({ ...x, plan: disposition(x, policy, only === x.id ? yesTo : []) })) }, null, 1));
    else { console.log(planLines(only ? items.filter(x => x.id === only) : items, policy).join('\n')); console.log('\nplan only. steward fix --apply works it (each write still plans, backs up and writes a receipt).'); }
    process.exit(0);
  }
  (async () => {
    const dir = C.newBackupDir('fix');
    const record = { dir, file: path.join(dir, 'receipt.json') };
    const rc = { kind: 'fix', at, engine: C.ENGINE_VERSION, pid: process.pid, from: opt('--from') ? C.tilde(C.userPath(opt('--from'))) : 'steward brief --plan', only, yes_to: yesTo, steps: [], complete: false };
    const save = () => fs.writeFileSync(record.file, `${JSON.stringify(rc, null, 1)}\n`, { mode: 0o600 });
    save();
    const tty = Boolean(process.stdin.isTTY && process.stderr.isTTY && !json);
    // one reader per question, closed before the step runs: a step that asks its own questions reads the terminal next
    const ask = tty ? q => new Promise(res => {
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stderr });
      rl.question(`\n${q} [y/N] `, a => { rl.close(); res(/^y(es)?$/i.test(a.trim())); });
    }) : null;
    const started = Date.now();
    const res = await work(items, { policy, only, yesTo, tty, ask, exec: realExec(record),
      onStep: (n, total, item) => { process.stderr.write(`\n\x1b[1;34m==>\x1b[0m [${n + 1}/${total}] ${item.text} \x1b[2m[${Math.round((Date.now() - started) / 1000)}s]\x1b[0m\n`); } });
    rc.steps = res.results.map(r => ({ ...r, receipts: (r.receipts || []).map(C.tilde), logs: (r.logs || []).map(C.tilde) }));
    rc.complete = true;
    rc.outcome = res.failed ? `failed at ${res.failed}` : 'done';
    save();
    if (json) console.log(JSON.stringify({ v: 1, at, receipt: C.tilde(record.file), subagents: policy.subagents, failed: res.failed, results: rc.steps }, null, 1));
    else { console.log(`\n${summary(res.results).join('\n')}`); console.log(`\nrecord ${C.tilde(record.file)}. What's next now: steward brief`); }
    process.exit(res.failed ? 1 : 0);
  })().catch(e => { console.error(`steward fix: ${e.message}`); process.exit(1); });
}
