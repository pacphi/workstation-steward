#!/usr/bin/env node
// The weekly review: one read-only pass over every area that turns their checks into one list of what needs the
// owner's decision, each with the command that acts on it. Nothing here changes anything except the review's own
// record (the report and last-review.json under [paths] state/review/).
//   - soak and prune (lib/soak.js)
//   - supply chain: `steward sc audit`'s ACTION and ALERT lines
//   - AI tooling: `steward ai drift`'s DRIFT and WARN lines
//   - projects: new or vanished projects (`steward projects scan`), and onboarded ones a promotion of Ruflo or AQE
//     left behind (`steward projects reconcile --all`, which notes what it found for the banner)
//   - your config repo (lib/configrepo.js, D50): fetched, then what's changed here, not pushed, or newer on GitHub;
//     its open PRs (Renovate's among them) and its issues labelled owner-decision (the decisions that wait)
//   - the fleet: open bot PRs and open Dependabot alerts in every GitHub repo the registry names, read with the
//     owner's own `gh` login (no token is stored anywhere; the weekly GitHub issue leaves the fleet to this)
//   - the release-age gate's queue (lib/gatequeue.js, D56): what Renovate's Dependency Dashboard holds in the config repo
//     and the fleet's repos, when each clears the gate, and the next step; cached for the banner
// Usage: review.js            run it, print the report and save it (the banner's clock restarts)
//        review.js --quick    skip the audit, the gate's queue and the fleet (the slow, networked parts)
//        review.js --banner   one line when a review is due ([policy] review_days since the last), and one when queued
//                             updates cleared the gate since it (from the review's cache, no network); else nothing
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
// a skill's runbook where this engine is installed (D48: runbooks live beside their skills, and ship with them)
const CR = require('./configrepo.js');
const { githubRepo } = CR;
const runbook = area => tilde(path.join(C.REPO_ROOT, 'skills', area, 'runbook.md'));
const GQ = require('./gatequeue.js');

// lift(text) — {text, cmd}: a finding that ends with the steward command that fixes it gives that command up, so the
// report shows it once over every finding it fixes
function lift(text) {
  const m = text.match(/^(.*): (steward [^:]+)$/);
  return m ? { text: m[1], cmd: m[2] } : { text };
}

// what fixes each kind of audit finding (the word before its first colon). `steward sc upgrade` takes Homebrew and
// mise; apps, the App Store, macOS, trust stores and Docker are by hand (supply-chain/bin/upgrade.js)
const BY_HAND = {
  app: 'by hand: update each app (its own updater), or ask its vendor',
  appstore: 'by hand: the App Store',
  macOS: 'by hand: System Settings, Software Update',
  trust: 'by hand: the command on each line',
  docker: 'by hand: pin each image by tag@digest',
};

// auditItems(stdout) — the audit's ACTION and ALERT lines as items. Off a terminal the audit prints each finding twice,
// as its check finds it and again under its Summary, so only the Summary is read (all of it, if a timeout cut it off)
function auditItems(stdout) {
  const lines = strip(stdout).split('\n');
  const at = lines.findLastIndex(l => /^==> Summary/.test(l));
  return lines.slice(at + 1).filter(l => /^\s+(ACTION|ALERT) /.test(l)).map(l => {
    const [, kind, line] = l.match(/^\s+(ACTION|ALERT) +(.*)$/);
    if (kind === 'ALERT') return { text: `ALERT: ${line}`, cmd: `${runbook('supply-chain')} (advisories and IOCs)` };
    const { text, cmd } = lift(line);
    const how = BY_HAND[text.slice(0, text.indexOf(':'))];
    if (cmd) return { text, cmd };
    if (how) return { text: text.replace(/; update it, or ask the vendor$/, ''), how };
    return { text, cmd: 'steward sc plan, then steward sc upgrade' };
  });
}

// driftItems(findings) — `steward ai drift --json`'s DRIFT and WARN findings as items. A project's fix names the
// project, so a finding filed under it doesn't repeat the path. Onboarding's flags only add to what it does, so a
// project's `steward projects onboard <path>` folds into the same command with flags when drift asks for both
function driftItems(findings) {
  const items = findings.filter(f => f.level === 'DRIFT' || f.level === 'WARN').map(f => {
    const { text, cmd } = lift(tilde(f.msg));
    const where = f.area === 'project' ? text.slice(0, text.indexOf(': ')) : '';
    if (cmd && where && cmd.includes(where)) return { text: `${f.level}: ${text.slice(where.length + 2)}`, cmd };
    return { text: `${f.level}: ${f.area}: ${text}`, cmd: cmd || `steward ai drift; ${runbook('ai-tooling')}` };
  });
  const onboard = items.map(i => i.cmd).filter(c => c.startsWith('steward projects onboard '));
  for (const i of items) i.cmd = onboard.find(c => c.startsWith(`${i.cmd} --`)) || i.cmd;
  return items;
}

// fleetTable(rows) — the fleet's repos with something open, worst first: critical, then high, medium and low alerts,
// then bot PRs. rows: [{repo, bots, sev: {critical, high, …}}]
const SEV = ['critical', 'high', 'medium', 'low', 'unknown'];
function fleetTable(rows) {
  const key = r => [...SEV.map(s => r.sev[s] || 0), r.bots];
  const sorted = [...rows].sort((a, b) => { const ka = key(a), kb = key(b); const i = ka.findIndex((v, j) => v !== kb[j]); return i < 0 ? a.repo.localeCompare(b.repo) : kb[i] - ka[i]; });
  const cols = SEV.filter(s => s !== 'unknown' || rows.some(r => r.sev.unknown));
  return { head: ['repo', ...cols, 'bot PRs'], rows: sorted.map(r => [r.repo, ...cols.map(s => String(r.sev[s] || '')), String(r.bots || '')]) };
}

// render(sections, at, quick) — the report as Markdown. A section whose items share a command lists them under it, so
// each command shows once; one whose items each have their own keeps a command under each item
function render(sections, at, quick) {
  const count = s => s.items.length + (s.table ? s.table.rows.length : 0);
  // a section can count fewer toward the headline than it lists (decide): the gate's queue lists what waits, but only
  // what has cleared it needs a decision now
  const n = sections.reduce((t, s) => t + (s.decide ?? count(s)), 0);
  const md = [`# Steward review, ${at.toISOString().slice(0, 10)}`, '', `${n} item(s) to decide${quick ? ' (quick: no audit)' : ''}. Each names the command that acts on it; nothing here was changed.`, ''];
  const say = i => (i.cmd ? `\`${i.cmd}\`` : i.how);
  for (const s of sections) {
    md.push(`## ${s.title}${count(s) ? ` · ${count(s)}` : ''}`, '');
    if (s.note) md.push(s.note, '');
    const groups = new Map();
    for (const i of s.items) { const k = say(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
    if ([...groups.values()].some(g => g.length > 1)) {
      for (const [k, g] of groups) md.push(`### → ${k}`, '', ...g.map(i => `- ${i.text}`), '');
    } else {
      for (const i of s.items) md.push(`- ${i.text}  \n  → ${say(i)}`);
      if (s.items.length) md.push('');
    }
    if (s.table) md.push(`| ${s.table.head.join(' | ')} |`, `| ${s.table.head.map((_, j) => (j ? '---:' : '---')).join(' | ')} |`, ...s.table.rows.map(r => `| ${r.join(' | ')} |`), '');
  }
  return { md: md.join('\n'), n };
}

function banner() {
  const gate = GQ.bannerLine(GQ.readCache(path.join(DIR, 'gate-queue.json')));
  if (gate) console.log(`\x1b[1;33mgate\x1b[0m ${gate}`);
  if (!DAYS) return;
  let last = null;
  try { last = new Date(JSON.parse(fs.readFileSync(LAST, 'utf8')).at); } catch { /* never reviewed */ }
  const age = last ? Math.floor((Date.now() - last) / 864e5) : null;
  if (age === null || age >= DAYS) console.log(`\x1b[1;33mreview due\x1b[0m ${age === null ? '(never run)' : `(last ${age} days ago)`}: steward review`);
}

// gateItems(rows, now) — the gate's queue (lib/gatequeue.js) as items: each update with where it waits and when it
// clears, under its next step (prose, so render groups the ones that share it)
const WAITS = { 'pending-checks': 'held by the gate', 'pending-approval': 'waits for a tick', 'awaiting-schedule': 'waits for its schedule' };
function gateItems(rows, now = new Date()) {
  return rows.map(r => {
    const at = r.clearsAt ? new Date(r.clearsAt) : null;
    const when = r.section === 'awaiting-schedule' ? '' : at ? `, ${at <= now ? 'cleared' : 'clears'} ${GQ.utc(at)}` : ', Renovate times it';
    return { text: `${r.repo}: ${r.title.replace(/^[\w-]+(\([^)]*\))?!?:\s*/, '')} (${WAITS[r.section]}${when})`, how: r.next };
  });
}

// gateSection(repos, opts) — {title, items, note}: the queue for those repos (opts go to gatequeue.queue: now, run,
// days, aiOwned, cache). Read-only on GitHub; it writes only the banner's cache
async function gateSection(repos, opts = {}) {
  const now = opts.now || new Date();
  repos = [...new Set(repos.filter(Boolean))];
  const q = await GQ.queue({ ...opts, repos, now });
  const read = repos.length - q.unreadable.length;
  const ready = q.rows.filter(r => r.clearsAt && new Date(r.clearsAt) <= now && r.section !== 'awaiting-schedule').length;
  const note = [`${read} repo(s) read${q.none.length ? `, ${q.none.length} with no Dependency Dashboard` : ''}${q.unreadable.length ? `; unreadable with this gh login: ${q.unreadable.join(', ')}` : ''}`,
    q.rows.length ? `${ready} past the gate. Read-only: never tick "Pending Status Checks" (that opens the PR before the gate clears); ${runbook('supply-chain')} (Check the queue)` : 'nothing waiting'].join('. ');
  return { title: 'Waiting on the release-age gate', items: gateItems(q.rows, now), note, decide: ready };
}

// runAsync(cmd, args, onLine) — {status, stdout}: the command's standard output, and each line of either stream
// handed to onLine as it comes. Only stdout is kept: a command's progress goes to stderr, and mixed into its --json
// it made the output unreadable (reconcile's, so the review said "the plan failed" every time)
/** @param {string} cmd @param {string[]} args @param {(line: string) => void} [onLine] @param {number} [timeout] */
function runAsync(cmd, args, onLine = () => {}, timeout = 900e3) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd: C.REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => p.kill(), timeout);
    const lines = () => { let buf = ''; return d => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) onLine(strip(l)); }; };
    const fromOut = lines(), fromErr = lines();
    p.stdout.on('data', d => { out += d; fromOut(d); }); p.stderr.on('data', fromErr);
    p.on('close', status => { clearTimeout(t); resolve({ status, stdout: out }); });
  });
}
const ghAsync = args => new Promise(resolve => execFile('gh', args, { cwd: C.REPO_ROOT, timeout: 60e3, maxBuffer: 16 << 20 }, (e, out) => { try { resolve(e ? null : JSON.parse(out)); } catch { resolve(null); } }));

async function review(quick) {
  const sections = [];
  const add = (title, items, note, table) => sections.push({ title, items, note, table });
  const pg = progress(8);

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
    const r = await runAsync('node', [path.join(C.REPO_ROOT, 'supply-chain', 'bin', 'audit.js')], l => {
      if (/^==> /.test(l) && !/^==> Summary/.test(l)) st.detail(l.slice(4).replace(/ \(.*$/, ''));
    });
    const items = auditItems(r.stdout);
    add('Supply chain', items, r.status === null ? 'the audit timed out' : items.length ? null : 'no actions');
    st.done(`${items.length} action(s) or alert(s)`);
  }

  // AI tooling
  st = pg.stage('AI tooling drift');
  if (!values.profiles.ai_tooling) { add('AI tooling', [], 'off ([profiles] ai_tooling = false)'); st.done('off'); }
  else {
    const r = await runAsync('node', [path.join(C.REPO_ROOT, 'ai-tooling', 'bin', 'drift.js'), '--json'].concat(quick ? ['--offline'] : []));
    let findings = [];
    try { findings = JSON.parse(r.stdout); } catch { add('AI tooling', [], 'drift failed: run `steward ai drift`'); }
    const items = driftItems(findings);
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
      ...(s.gone || []).map(p => ({ text: `registered but gone: ${tilde(p.path || p)}`, cmd: `${runbook('projects')} (a project disappears)` })),
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

  // your config repo: fetched, then its state here and its PRs and waiting decisions on GitHub (D50). Before the
  // engine and the config were split (D39) this read "this repo", which now would be the engine's.
  st = pg.stage('your config repo');
  let configSlug = null;
  {
    const s = CR.state(C.INSTANCE_ROOT, { fetch: true });
    if (!s.repo) { add('Your config repo', [], 'not a Git repository of its own (docs/config-repo.md)'); st.done('not a repo'); }
    else {
      configSlug = s.slug;
      add('Your config repo', CR.needs(s), `${s.slug || C.tilde(s.dir)}${s.fetchError ? `; fetch failed: ${s.fetchError}` : ''}${CR.needs(s).length ? '' : '; in step'}`);
      const [prs, issues] = s.slug ? await Promise.all([ghAsync(['pr', 'list', '-R', s.slug, '--json', 'number,title,author,createdAt', '--limit', '50']),
        ghAsync(['issue', 'list', '-R', s.slug, '--label', 'owner-decision', '--json', 'number,title,createdAt', '--limit', '50'])]) : [null, null];
      if (!s.slug) add('Config repo on GitHub', [], 'no GitHub remote: skipped');
      else if (!prs && !issues) add('Config repo on GitHub', [], '`gh` unavailable: skipped');
      else {
        add(`Pull requests (${s.slug})`, (prs || []).map(p => ({ text: `#${p.number} ${p.title} (${p.author.login}, ${p.createdAt.slice(0, 10)})`, cmd: `gh pr view ${p.number} -R ${s.slug}` })), prs && prs.length ? null : 'none open');
        add('Decisions waiting (issues labelled owner-decision)', (issues || []).map(i => ({ text: `#${i.number} ${i.title} (since ${i.createdAt.slice(0, 10)})`, cmd: `gh issue view ${i.number} -R ${s.slug}` })), issues && issues.length ? null : 'none open');
      }
      st.done(`${CR.needs(s).length} to do here, ${(prs || []).length} PR(s), ${(issues || []).length} decision(s)`);
    }
  }

  // the fleet's GitHub repos: every one the registry names, but your config repo (listed above)
  const fleetRepos = () => [...new Set(require('./projects.js').loadRegistry().filter(r => r.decision !== 'ignored').map(r => githubRepo(r.remote)).filter(Boolean))].filter(r => r !== configSlug).sort();

  // the release-age gate's queue (D56): Renovate's Dependency Dashboard in the config repo and the fleet's repos
  st = pg.stage('the release-age gate');
  if (quick) { add('Waiting on the release-age gate', [], 'skipped (--quick): run `steward review` without it'); st.done('skipped (--quick)'); }
  else {
    const s = await gateSection([configSlug, ...fleetRepos()].filter(Boolean));
    sections.push(s);
    st.done(`${s.items.length} update(s) waiting`);
  }

  // the fleet: one row per repo with bot PRs or open alerts, 6 repos at a time. Your config repo's PRs are listed above
  st = pg.stage('fleet on GitHub');
  if (quick) { add('Fleet', [], 'skipped (--quick)'); st.done('skipped (--quick)'); }
  else {
    const repos = fleetRepos();
    const rows = {}, unreadable = [];
    let done = 0;
    const one = async r => {
      const [prs, alerts] = await Promise.all([ghAsync(['pr', 'list', '-R', r, '--json', 'number,author', '--limit', '100']), ghAsync(['api', `repos/${r}/dependabot/alerts?state=open&per_page=100`])]);
      done++; st.detail(`${done}/${repos.length} repos · ${r}`);
      if (prs === null && alerts === null) { unreadable.push(r); return; }
      const bots = (prs || []).filter(p => /dependabot|renovate/.test(p.author.login)).length;
      const sev = {};
      for (const a of Array.isArray(alerts) ? alerts : []) { const s = (a.security_advisory || {}).severity || 'unknown'; sev[s] = (sev[s] || 0) + 1; }
      if (bots || Object.keys(sev).length) rows[r] = { repo: r, bots, sev };
    };
    const queue = [...repos];
    await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
    const open = repos.filter(r => rows[r]).map(r => rows[r]);
    add('Fleet (bot PRs and Dependabot alerts)', [], `${repos.length} repos checked${unreadable.length ? `; unreadable with this gh login: ${unreadable.join(', ')}` : ''}${open.length
      ? '. For a repo: `gh api repos/<repo>/dependabot/alerts` or `gh pr list -R <repo>`, then the pr-consolidation skill' : '; nothing open'}`, open.length ? fleetTable(open) : null);
    st.done(`${open.length} of ${repos.length} repos with something open`);
  }
  pg.finish();

  const at = new Date();
  const { md, n } = render(sections, at, quick);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, `review-${at.toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, md);
  fs.writeFileSync(LAST, JSON.stringify({ at: at.toISOString(), items: n, quick, report: file }) + '\n');
  console.log(md);
  console.log(`saved ${tilde(file)}`);
}

module.exports = { banner, githubRepo, runAsync, auditItems, driftItems, fleetTable, render, gateItems, gateSection };
if (require.main === module) {
  if (process.argv.includes('--banner')) banner();
  else review(process.argv.includes('--quick')).catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
