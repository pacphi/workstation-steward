#!/usr/bin/env node
// The bundled commands (D61): one plan, one yes, one record, for jobs that take several steward commands.
//   steward ai fix             ai repin, guard, timeouts, approvals and transport
//   steward fleet tidy <repo>  fleet sync, then prune-merged
//   steward projects apply     each project to its registry decision: onboard, offboard, then reconcile --all
//   steward upgrade            a Node security release (sc node-patch) or hybrids out of step (sc install-hybrids),
//                              then sc upgrade
// Each part is a steward command, shown with its own plan first (DRY_RUN=1, no --apply). At a terminal it asks once;
// then each part runs through this engine's bin/steward.js with --unattended and the user's yes to that part's class
// (--yes-to, D59), so every question a part asks is still checked by its own class (D58). Run with --unattended
// (steward fix, the skills), [autonomy] answers instead and nothing is widened. Without a terminal or --unattended, it
// plans only. The runner is steward fix's (lib/fix.js work): a part that stops at a question it may not answer waits on
// the user (exit 4), a failure stops the rest (exit 1). Its record is <state>/backups/coarse-<name>-<time>/receipt.json
// (kind coarse), naming every receipt the parts wrote; the briefing names one left unfinished.
// Usage: coarse.js <name> [args] [--json]       (bin/steward.js runs it: steward ai fix, steward upgrade, …)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./config.js');
const A = require('./autonomy.js');
const F = require('./fix.js');

const key = c => `${c.area ? `${c.area} ` : ''}${c.name}`;
const descOf = words => { const h = require('./commands.js').find(words); return h ? h.cmd.desc : ''; };
const part = (id, cmd, text, after) => ({ id, cmd, text, ...(after ? { after } : {}) });

// newerSecurity(node, index) — {security, target} when a release newer than node on its major is a security release:
// the newest on the line is the target (steward sc status chose it the same way), else null
function newerSecurity(node, index) {
  const major = `v${node.split('.')[0]}.`;
  const line = index.filter(r => String(r.version).startsWith(major));
  const at = line.findIndex(r => r.version === `v${node}`);
  const sec = line.slice(0, at < 0 ? line.length : at).filter(r => r.security);
  return sec.length ? { security: sec[sec.length - 1].version.slice(1), target: line[0].version.slice(1) } : null;
}

// nodeIndex() — nodejs.org's release index (the one network call a plan makes here; steward sc plan makes the others)
async function nodeIndex() {
  const st = require('./progress.js').progress(1).stage('Node releases (nodejs.org/dist/index.json)');
  const r = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(15e3) });
  if (!r.ok) { st.done(`answered ${r.status}`); throw new Error(`nodejs.org answered ${r.status}`); }
  const j = await r.json();
  st.done(`${j.length} releases`);
  return j;
}

// hybridsOff() — the briefing's hybrid-vs-policy finding, or null: the hybrids against hybrids.toml and their receipts
function hybridsOff() {
  const B = require('./brief.js');
  const d = B.DETECTORS.find(x => x.id === 'hybrid-vs-policy');
  const x = d && d.check(B.facts());
  return x && x.cmd === 'steward sc install-hybrids' ? x : null;
}

// PARTS — for each bundled command, (args, ctx) → {items, notes}: its parts as work-list items (lib/fix.js), and lines
// for the user (what it found but won't run). ctx holds the stand-ins tests pass; the real ones are the defaults
const PARTS = {
  'ai fix': async () => ({
    items: ['repin', 'guard', 'timeouts', 'approvals', 'transport'].map(n => part(n, `steward ai ${n}`, `ai ${n}: ${descOf(['ai', n])}`)),
    notes: [],
  }),
  'fleet tidy': async ([repo]) => ({
    items: [part('sync', `steward fleet sync ${repo}`, `fleet sync: ${descOf(['fleet', 'sync'])}`),
      part('prune-merged', `steward fleet prune-merged ${repo}`, `fleet prune-merged: ${descOf(['fleet', 'prune-merged'])}`, ['sync'])],
    notes: [],
  }),
  'projects apply': async (_args, ctx) => {
    const P = require('./projects.js');
    const registry = ctx.registry || (() => P.loadRegistry());
    const exists = ctx.exists || P.exists;
    const home = ctx.home || P.HOME;
    const tilde = d => (d.startsWith(home) ? `~${d.slice(home.length)}` : d);
    const onboard = ctx.onboard || (d => { const O = require('./onboard.js'); const p = O.plan(d); return { ...p, refusals: p.stop ? [p.stop] : O.refusals(p) }; });
    const offboard = ctx.offboard || (d => { const X = require('./offboard.js'); const p = X.plan(d); return { ...p, n: p.configs.length + p.moves.length + p.rmdirs.length, refusals: p.stop ? [p.stop] : X.refusals(p) }; });
    const behind = ctx.behind || (() => {
      const R = require('./reconcile.js');
      const rs = require('./progress.js').progress(1).stage('plan every onboarded project against the qualified AI tools');
      const plans = R.all({ each: (i, n, dir) => rs.detail(`${i + 1}/${n} ${tilde(dir)}`) });
      rs.done(`${plans.length} planned`);
      return R.behind(plans);
    });
    const items = [], notes = [];
    const list = registry().filter(r => exists(r.abs));
    const st = ctx.registry ? null : require('./progress.js').progress(1).stage(`plan ${list.length} registered project(s) against their decisions`);
    for (const [i, r] of list.entries()) {
      if (st) st.detail(`${i + 1}/${list.length} ${tilde(r.abs)}`);
      const where = tilde(r.abs);
      // a path the runner can't pass as one word (a space, a quote) is yours to run
      const safe = !/[\s|;&$`<>(){}"'\\]/.test(where);
      if (r.decision === 'onboarded' && (r.ai || []).length) {
        const p = onboard(r.abs);
        const n = p.files.filter(x => x.action === 'edit' || x.action === 'create').length;
        if (!n) continue;
        if (p.refusals.length) notes.push(`${where}: onboard refuses: ${p.refusals.join('; ')}`);
        else if (!safe) notes.push(`${where}: run it yourself: steward projects onboard "${where}" --apply`);
        else items.push(part(`onboard:${where}`, `steward projects onboard ${where}`, `onboard ${where}: ${n} change(s) for ${r.ai.join(', ')}`));
      } else if (!(r.ai || []).length && r.decision !== 'deferred') {
        if (st) st.detail(`${i + 1}/${list.length} ${where}: what offboarding would take`);
        const p = offboard(r.abs);
        if (!p.n) continue;
        if (p.refusals.length) notes.push(`${where}: offboard refuses: ${p.refusals.join('; ')}`);
        else if (!safe) notes.push(`${where}: run it yourself: steward projects offboard "${where}" --apply`);
        else items.push(part(`offboard:${where}`, `steward projects offboard ${where}`, `offboard ${where}: ${p.n} change(s); its decision has no AI tools`));
      }
    }
    if (st) st.done(`${items.length} to change`);
    const late = behind();
    if (late.length) items.push(part('reconcile', 'steward projects reconcile --all', `reconcile ${late.length} project(s) whose copied tool files are behind the qualified installs`));
    return { items, notes };
  },
  upgrade: async (_args, ctx) => {
    const items = [], notes = [];
    const node = ctx.node || process.versions.node;
    let n = null;
    try { n = newerSecurity(node, await (ctx.nodeIndex || nodeIndex)()); } catch (e) { notes.push(`couldn't check for a Node security release (${e.message}); steward sc plan shows it`); }
    if (n) {
      items.push(part('node-patch', `steward sc node-patch ${n.target}`,
        `Node security release ${n.security} (this Node is ${node}): to ${n.target}. It verifies the tarball, reinstalls the hybrids into it and backs up every Ruflo policy folder first; the release-age gate doesn't hold a security release`));
    } else {
      const h = (ctx.hybrids || hybridsOff)();
      if (h) items.push(part('install-hybrids', 'steward sc install-hybrids', `${h.text}: each with its reviewed install scripts and a receipt; a Ruflo version change backs up its policy folders first (its first run migrates them)`));
    }
    items.push(part('upgrade', 'steward sc upgrade', `sc upgrade: ${descOf(['sc', 'upgrade'])}`));
    return { items, notes };
  },
};

// parts(name, args, ctx) — {items, notes} for a bundled command
const parts = (name, args = [], ctx = {}) => PARTS[name](args, ctx);

// run(items, {policy, yesTo, exec}) — {code, results}: the parts worked by steward fix's runner, none of them asking a
// terminal (the one yes was asked already, and reaches each part as yesTo). code: 0 done, 4 waiting on you, 1 failed
/** @param {any[]} items @param {{policy: any, yesTo?: string[], exec: (x: any) => Promise<any>, onStep?: (n: number, total: number, item: any) => void}} opts */
async function run(items, { policy, yesTo = [], exec, onStep = () => {} }) {
  const res = await F.work(items, { policy, yesTo, tty: false, ask: null, exec, onStep });
  const code = res.failed ? 1 : res.results.some(r => r.outcome !== 'done') ? A.REFUSED : 0;
  return { code, results: res.results };
}

module.exports = { PARTS, parts, run, newerSecurity, key };

if (require.main === module) {
  const [name, ...rest] = process.argv.slice(2);
  const die = (m, code = 2) => { console.error(`steward ${name}: ${m}`); process.exit(code); };
  if (!(name in PARTS)) die(`no bundled command "${name}"`);
  const json = rest.includes('--json');
  const args = rest.filter(a => !a.startsWith('--'));
  const H = s => `\x1b[1;34m==>\x1b[0m ${s}`;
  const out = json ? s => console.error(s) : s => console.log(s);
  (async () => {
    const { values } = C.load();
    const policy = values.autonomy;
    const { items, notes } = await parts(name, args);
    if (!items.length) { out(`steward ${name}: nothing to do`); for (const l of notes) out(`  yours: ${l}`); process.exit(0); }
    // each part's own plan, as it would run now: DRY_RUN=1 and no --apply, through this engine's bin/steward.js
    for (const [i, x] of items.entries()) {
      out(`\n${H(`[${i + 1}/${items.length}] ${x.text}`)}\n   $ ${x.cmd}`);
      const words = x.cmd.split(/\s+/).slice(1);
      const r = spawnSync(process.execPath, [path.join(C.REPO_ROOT, 'bin', 'steward.js'), ...words], {
        cwd: C.REPO_ROOT, stdio: ['ignore', json ? process.stderr : 'inherit', 'inherit'],
        env: { ...process.env, DRY_RUN: '1', STEWARD_UNATTENDED: '', STEWARD_INSTANCE: C.INSTANCE_ROOT, STEWARD_CWD: process.env.STEWARD_CWD || process.cwd() },
      });
      if (r.status !== 0) out(`   (its plan exited ${r.status}: it would stop there)`);
    }
    for (const l of notes) out(`\n  yours: ${l}`);
    const classes = [...new Set(items.map(x => A.classify(x.cmd, policy).class).filter(Boolean))];
    const unattended = A.unattended();
    const planOnly = () => { out(`\nplan only: steward ${name} asks once, then runs the ${items.length} part(s) above, each with its own backup and receipt; --unattended lets [autonomy] answer instead.`); process.exit(0); };
    if (process.env.DRY_RUN === '1' || json && !unattended) planOnly();
    let yesTo = A.yesTo();
    if (!unattended) {
      // the one question, on the terminal or piped stdin; no answer at all (stdin closed, nothing typed) is a plan only
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      const a = await new Promise(res => { rl.on('close', () => res('')); rl.question(`\nRun the ${items.length} part(s) above (${classes.join(', ')})? [y/N] `, x => { answered = true; res(x); }); });
      rl.close();
      if (!answered) { out(''); planOnly(); }
      if (!/^y(es)?$/i.test(a.trim())) { out('nothing changed'); process.exit(0); }
      yesTo = [...new Set([...yesTo, ...classes])];
    }
    const dir = C.newBackupDir(`coarse-${name.replace(/\s+/g, '-')}`);
    const record = { dir, file: path.join(dir, 'receipt.json') };
    const rc = Object.assign({ kind: 'coarse', command: name, name, args, at: new Date().toISOString(), engine: C.ENGINE_VERSION, pid: process.pid,
      parts: items.length, yes_to: yesTo, steps: [], complete: false, outcome: 'started' }, A.mark(), name === 'fleet tidy' ? { repo: path.resolve(process.env.STEWARD_CWD || process.cwd(), C.untilde(args[0])) } : {});
    const save = () => fs.writeFileSync(record.file, `${JSON.stringify(rc, null, 1)}\n`, { mode: 0o600 });
    save();
    const started = Date.now();
    const res = await run(items, { policy, yesTo, exec: F.realExec(record),
      onStep: (i, total, x) => process.stderr.write(`\n${H(`[${i + 1}/${total}] ${x.text}`)} \x1b[2m[${Math.round((Date.now() - started) / 1000)}s]\x1b[0m\n`) });
    rc.steps = res.results.map(r => ({ ...r, receipts: (r.receipts || []).map(C.tilde), logs: (r.logs || []).map(C.tilde) }));
    rc.complete = true;
    rc.outcome = res.code === 1 ? 'failed' : res.code === A.REFUSED ? 'waiting' : 'done';
    save();
    if (json) console.log(JSON.stringify({ v: 1, receipt: C.tilde(record.file), outcome: rc.outcome, results: rc.steps }, null, 1));
    else { console.log(`\n${F.summary(res.results).join('\n')}`); console.log(`\nrecord ${C.tilde(record.file)}. What's next now: steward brief`); }
    process.exit(res.code);
  })().catch(e => die(e.message, 1));
}
