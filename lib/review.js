#!/usr/bin/env node
// The weekly review: one read-only pass over every area that turns their checks into one list of what needs the
// owner's decision, each with the command that acts on it. Nothing here changes anything except the review's own
// record (the report and last-review.json under [paths] state/review/).
//   - soak and prune (lib/soak.js)
//   - supply chain: `steward sc audit`'s ACTION and ALERT lines
//   - AI tooling: `steward ai drift`'s DRIFT and WARN lines
//   - projects: new or vanished projects (`steward projects scan`), and onboarded ones a promotion of Ruflo or AQE
//     left behind (`steward projects reconcile --all`, which notes what it found for the banner)
//   - GitHub: this repo's open PRs and its open issues labelled owner-decision (the decisions that wait)
//   - the fleet: open bot PRs and open Dependabot alerts in every GitHub repo the registry names, read with the
//     owner's own `gh` login (no token is stored anywhere; the weekly GitHub issue leaves the fleet to this)
// Usage: review.js            run it, print the report and save it (the banner's clock restarts)
//        review.js --quick    skip the audit and the fleet (the slow, networked parts)
//        review.js --banner   one line when a review is due ([policy] review_days since the last); nothing otherwise
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { progress } = require('./progress.js');
const C = require('./config.js');

const { values } = C.load();
const DIR = path.join(values.paths.state, 'review');
const LAST = path.join(DIR, 'last-review.json');
const DAYS = values.policy.review_days;
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const tilde = s => s.split(C.HOME).join('~');

function banner() {
  if (!DAYS) return;
  let last = null;
  try { last = new Date(JSON.parse(fs.readFileSync(LAST, 'utf8')).at); } catch { /* never reviewed */ }
  const age = last ? Math.floor((Date.now() - last) / 864e5) : null;
  if (age === null || age >= DAYS) console.log(`\x1b[1;33mreview due\x1b[0m ${age === null ? '(never run)' : `(last ${age} days ago)`}: steward review`);
}

// runAsync(cmd, args, onLine) — {status, stdout}: the command's output, with each line handed to onLine as it comes
/** @param {string} cmd @param {string[]} args @param {(line: string) => void} [onLine] @param {number} [timeout] */
function runAsync(cmd, args, onLine = () => {}, timeout = 900e3) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd: C.REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', buf = '';
    const t = setTimeout(() => p.kill(), timeout);
    const feed = d => { out += d; buf += d; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) onLine(strip(l)); };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('close', status => { clearTimeout(t); resolve({ status, stdout: out }); });
  });
}
const ghAsync = args => new Promise(resolve => execFile('gh', args, { cwd: C.REPO_ROOT, timeout: 60e3, maxBuffer: 16 << 20 }, (e, out) => { try { resolve(e ? null : JSON.parse(out)); } catch { resolve(null); } }));

async function review(quick) {
  const sections = [];
  const add = (title, items, note) => sections.push({ title, items, note });
  const pg = progress(7);

  // soak and prune
  let st = pg.stage('soak and prune');
  const S = require('./soak.js').state();
  const fmt = d => d.toLocaleString('sv-SE').slice(0, 16); // local time, as the soak banner shows it
  if (S.running) add('Soak and prune', [], `soak running until ${fmt(S.until)}: the prune waits (\`steward sc soak\`)`);
  else if (S.awaitingPrune) add('Soak and prune', [{ text: 'the soak has ended: old installs can be pruned', cmd: 'DRY_RUN=1 steward sc prune, then steward sc prune' }]);
  else add('Soak and prune', [], 'nothing waiting');
  st.done(S.running ? 'soak running' : S.awaitingPrune ? 'prune due' : 'nothing waiting');

  // supply chain
  st = pg.stage('supply-chain audit');
  if (quick) { add('Supply chain', [], 'skipped (--quick): run `steward sc audit`'); st.done('skipped (--quick)'); }
  else {
    let n = 0;
    const r = await runAsync('node', [path.join(C.REPO_ROOT, 'supply-chain', 'bin', 'audit.js')], l => {
      if (/^==> /.test(l) && !/^==> Summary/.test(l)) st.detail(l.slice(4).replace(/ \(.*$/, ''));
      if (/^\s+(ACTION|ALERT) /.test(l)) n++;
    });
    const items = strip(r.stdout).split('\n').filter(l => /^\s+(ACTION|ALERT) /.test(l)).map(l => {
      const [, kind, text] = l.match(/^\s+(ACTION|ALERT) (.*)$/);
      return { text: `${kind === 'ALERT' ? 'ALERT: ' : ''}${text}`, cmd: kind === 'ALERT' ? 'docs/supply-chain/runbook.md (advisories and IOCs)' : 'steward sc plan, then steward sc upgrade' };
    });
    add('Supply chain', items, r.status === null ? 'the audit timed out' : items.length ? null : 'no actions');
    st.done(`${n} action(s) or alert(s)`);
  }

  // AI tooling
  st = pg.stage('AI tooling drift');
  if (!values.profiles.ai_tooling) { add('AI tooling', [], 'off ([profiles] ai_tooling = false)'); st.done('off'); }
  else {
    const r = await runAsync('node', [path.join(C.REPO_ROOT, 'ai-tooling', 'bin', 'drift.js'), '--json'].concat(quick ? ['--offline'] : []));
    let findings = [];
    try { findings = JSON.parse(r.stdout); } catch { add('AI tooling', [], 'drift failed: run `steward ai drift`'); }
    const items = findings.filter(f => f.level === 'DRIFT' || f.level === 'WARN')
      .map(f => ({ text: `${f.level}: ${f.area}: ${tilde(f.msg)}`, cmd: 'steward ai drift; docs/ai-tooling/runbook.md' }));
    if (findings.length) add('AI tooling', items, items.length ? null : 'no drift');
    st.done(`${items.length} drift or warning(s)`);
  }

  // projects
  st = pg.stage('projects scan');
  if (!values.profiles.projects) { add('Projects', [], 'off ([profiles] projects = false)'); st.done('off'); }
  else {
    const r = await runAsync('node', [path.join(C.REPO_ROOT, 'projects', 'bin', 'projects.js'), 'scan', '--json']);
    let s = { fresh: [], gone: [] };
    try { s = JSON.parse(r.stdout); } catch { /* reported below */ }
    const items = [
      ...(s.fresh || []).map(p => ({ text: `new project: ${tilde(p.path || p)}`, cmd: 'steward projects scan, then steward projects decide <path>' })),
      ...(s.gone || []).map(p => ({ text: `registered but gone: ${tilde(p.path || p)}`, cmd: 'docs/projects/runbook.md (a project disappears)' })),
    ];
    add('Projects', items, items.length ? null : 'nothing new or gone');
    st.done(`${items.length} new or gone`);
  }

  // projects behind the qualified AI tools (D42)
  st = pg.stage('projects behind the AI tools');
  if (!values.profiles.projects || !values.profiles.ai_tooling) { add('Projects behind the AI tools', [], 'off (needs the projects and ai_tooling add-ons)'); st.done('off'); }
  else {
    const r = await runAsync('node', [path.join(C.REPO_ROOT, 'projects', 'bin', 'reconcile.js'), '--all', '--json']);
    let plans = null;
    try { plans = JSON.parse(r.stdout); } catch { /* reported below */ }
    if (!plans) { add('Projects behind the AI tools', [], 'the plan failed: run `steward projects reconcile --all`'); st.done('failed'); }
    else {
      const late = require('./reconcile.js').behind(plans);
      add('Projects behind the AI tools', late.map(b => ({ text: `${tilde(b.project)}: ${b.update} copied unit(s) to update${b.edited ? `, ${b.edited} you edited have a newer version` : ''}${b.pr ? `, ${b.pr} tracked (PR)` : ''}`, cmd: `steward projects reconcile ${b.project}` })),
        late.length ? null : `${plans.length} onboarded project(s), all in step`);
      st.done(`${late.length} of ${plans.length} behind`);
    }
  }

  // GitHub: this repo's open PRs and the decisions that wait
  st = pg.stage('this repo on GitHub');
  {
    const [prs, issues] = await Promise.all([ghAsync(['pr', 'list', '--json', 'number,title,author,createdAt', '--limit', '50']),
      ghAsync(['issue', 'list', '--label', 'owner-decision', '--json', 'number,title,createdAt', '--limit', '50'])]);
    if (!prs && !issues) add('GitHub', [], '`gh` unavailable: skipped');
    else {
      add('Pull requests (this repo)', (prs || []).map(p => ({ text: `#${p.number} ${p.title} (${p.author.login}, ${p.createdAt.slice(0, 10)})`, cmd: `gh pr view ${p.number}` })), prs && prs.length ? null : 'none open');
      add('Decisions waiting (issues labelled owner-decision)', (issues || []).map(i => ({ text: `#${i.number} ${i.title} (since ${i.createdAt.slice(0, 10)})`, cmd: `gh issue view ${i.number}` })), issues && issues.length ? null : 'none open');
    }
    st.done(`${(prs || []).length} PR(s), ${(issues || []).length} decision(s)`);
  }

  // the fleet: one line per repo with bot PRs or open alerts, 6 repos at a time
  st = pg.stage('fleet on GitHub');
  if (quick) { add('Fleet', [], 'skipped (--quick)'); st.done('skipped (--quick)'); }
  else {
    const P = require('./projects.js');
    const repos = [...new Set(P.loadRegistry().filter(r => r.decision !== 'ignored').map(r => ((r.remote || '').match(/github\.com\/([^/]+\/[^/.]+)/) || [])[1]).filter(Boolean))].sort();
    const rows = {}, unreadable = [];
    let done = 0;
    const one = async r => {
      const [prs, alerts] = await Promise.all([ghAsync(['pr', 'list', '-R', r, '--json', 'number,author', '--limit', '100']), ghAsync(['api', `repos/${r}/dependabot/alerts?state=open&per_page=100`])]);
      done++; st.detail(`${done}/${repos.length} repos · ${r}`);
      if (prs === null && alerts === null) { unreadable.push(r); return; }
      const bots = (prs || []).filter(p => /dependabot|renovate/.test(p.author.login)).length;
      const sev = {};
      for (const a of Array.isArray(alerts) ? alerts : []) { const s = (a.security_advisory || {}).severity || 'unknown'; sev[s] = (sev[s] || 0) + 1; }
      const sevText = ['critical', 'high', 'medium', 'low', 'unknown'].filter(s => sev[s]).map(s => `${sev[s]} ${s}`).join(', ');
      if (bots || sevText) rows[r] = { text: `${r}: ${[bots ? `${bots} bot PR(s)` : '', sevText ? `alerts: ${sevText}` : ''].filter(Boolean).join('; ')}`, cmd: sevText ? `gh api repos/${r}/dependabot/alerts; the pr-consolidation skill` : `gh pr list -R ${r}; the pr-consolidation skill` };
    };
    const queue = [...repos];
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
    const items = repos.filter(r => rows[r]).map(r => rows[r]);
    add('Fleet (bot PRs and Dependabot alerts)', items, `${repos.length} repos checked${unreadable.length ? `; unreadable with this gh login: ${unreadable.join(', ')}` : ''}${items.length ? '' : '; nothing open'}`);
    st.done(`${items.length} of ${repos.length} repos with something open`);
  }
  pg.finish();

  const at = new Date();
  const n = sections.reduce((s, x) => s + x.items.length, 0);
  const md = [`# Steward review, ${at.toISOString().slice(0, 10)}`, '', `${n} item(s) to decide${quick ? ' (quick: no audit)' : ''}. Each names the command that acts on it; nothing here was changed.`, ''];
  for (const s of sections) {
    md.push(`## ${s.title}`, '');
    if (s.note) md.push(s.note, '');
    for (const i of s.items) md.push(`- ${i.text}  \n  → \`${i.cmd}\``);
    if (s.items.length) md.push('');
  }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, `review-${at.toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, md.join('\n'));
  fs.writeFileSync(LAST, JSON.stringify({ at: at.toISOString(), items: n, quick, report: file }) + '\n');
  console.log(md.join('\n'));
  console.log(`saved ${tilde(file)}`);
}

module.exports = { banner };
if (require.main === module) {
  if (process.argv.includes('--banner')) banner();
  else review(process.argv.includes('--quick')).catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
