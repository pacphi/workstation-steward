#!/usr/bin/env node
// steward sc vulns-fix (D66): take the fixes `steward sc vulns` names, in one plan. Writes only after a plan and a yes.
//   - a mise tool whose own version has a serious advisory and a fixed release: steward sc upgrade-tool <tool> <fixed>,
//     an exact pin that skips the release-age gate; each is recorded as a host.toml security_exception with the
//     advisory and an expiry ([vulns] fix_skip_gate = "serious", exception_days). With fix_skip_gate = "never" it waits
//     for steward sc upgrade instead;
//   - old installs no config uses any more that carry serious advisories: mise uninstall <tool>@<version>, before the
//     soak ends for those copies only ([vulns] cleanup, cleanup_skip_soak), never one a launcher still points into;
//   - Node: named, with steward sc node-patch <version> to run next (it reinstalls the hybrids, and asks its own yes);
//   - handed over, not done here: a hybrid's fix (hybrids.toml, then steward sc install-hybrids), a tool AI tooling
//     owns (the ai-tooling skill), and packages inside a tool (its next release).
// A backup of mise/config.toml, mise/mise.lock and supply-chain/host.toml first; a receipt; --rollback puts those files
// back (when nothing changed them since) and reinstalls what the cleanup removed.
// Usage: vulns-fix.js                 the plan (read-only)
//        vulns-fix.js --apply         the plan, then asks (class vulns-fix; --unattended takes it where [autonomy] allows)
//        vulns-fix.js --rollback <receipt>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');
const C = require('../../lib/config.js');
const V = require('../../lib/vulns.js');

const ENGINE = path.join(__dirname, '..', '..');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ownedBy = (owned, tool) => owned.includes(tool) || owned.includes(tool.replace(/^npm -g /, ''));
const adv = f => ({ id: f.id, url: f.url, severity: f.severity, kev: f.kev });
// few(ids) — up to two advisory ids, then how many more: a plan line fits a terminal
const few = ids => { const u = [...new Set(ids)]; return u.length > 2 ? `${u.slice(0, 2).join(', ')} and ${u.length - 2} more` : u.join(', '); };

// plan(ctx, {soakRunning}) — {upgrades, node, cleanup, exceptions, held, handed, failed}: what --apply would do and why
// the rest waits. ctx: as the audit's (run, policy, today, say?, aiOwned?, pinned?(dirs) → Promise of the Set of those
// install folders a launcher config points into)
async function plan(ctx, o = {}) {
  const s = ctx.policy.vulns || V.SETTINGS;
  const feeds = ctx.policy.advisory_feed || [];
  if (!feeds.length) throw new Error('every advisory_feed is turned off in host.toml, so there is nothing to judge by');
  const owned = ctx.aiOwned || [];
  const say = ctx.say || (() => {});
  const live = list => list.filter(f => V.serious(f, s) && !V.ignored(f, ctx.policy.advisory_ignore, ctx.today));
  const p = { upgrades: [], node: null, cleanup: [], exceptions: [], held: [], handed: [], failed: [] };

  const look = await V.lookup(ctx, feeds, await V.inventory(ctx, s, { say }), say, s);
  p.failed.push(...look.failed);
  const byTool = new Map(), brew = new Map();
  for (const f of live(look.findings)) {
    const tool = f.pkg.tool;
    if (!f.pkg.top) continue;   // inside a tool: that tool's next release (steward sc vulns lists them)
    if (f.pkg.ecosystem === 'node') {
      if (f.fixed && (!p.node || V.cmpVer(f.fixed, p.node.version) > 0)) p.node = { have: f.pkg.version, version: f.fixed, advisories: [adv(f)] };
      continue;
    }
    // a Homebrew formula: one line per formula, after the loop
    if (f.pkg.ecosystem === 'Homebrew') { const b = brew.get(tool) || { tool, version: f.pkg.version, list: [] }; b.list.push(f); brew.set(tool, b); continue; }
    if (f.pkg.ecosystem === 'eol') { p.handed.push(`${tool} ${f.pkg.version}: past its end of life (${f.id}): move to a supported release${f.supported && f.supported.length ? ` (${f.supported.join(', ')})` : ''}; a major is deliberate`); continue; }
    if (f.pkg.via === 'go build info' && !V.fixCommand(f)) { p.held.push(`${tool} ${f.pkg.version}: ${f.id}${f.fixed ? `, fixed in ${f.fixed}` : ''}: its next release carries the fix (steward sc plan)`); continue; }
    if (V.nodeOwn(tool)) { p.handed.push(`${tool} ${f.pkg.version}: ${f.id}: it ships with Node; a Node release carries the fix`); continue; }
    if (ownedBy(owned, tool)) { p.handed.push(`${tool} ${f.pkg.version}: ${f.id}: AI tooling owns it (the ai-tooling skill)`); continue; }
    if (tool.startsWith('npm -g ')) {
      p.handed.push(`${tool} ${f.pkg.version}: ${f.id}${f.fixed ? `, fixed in ${f.fixed}: set its version in hybrids.toml, then steward sc install-hybrids` : ': no fixed release yet'}`);
      continue;
    }
    if (!f.fixed) {
      const iso = s.isolate_suggest && V.urgent(f) && !V.isolatable(tool, s, owned) ? `; steward sc isolate ${tool} switches it off meanwhile` : '';
      p.held.push(`${tool} ${f.pkg.version}: ${f.id} (${f.severity}): no fixed release yet${iso}`);
      continue;
    }
    if (s.fix_skip_gate === 'never') { p.held.push(`${tool} ${f.pkg.version}: ${f.id}, fixed in ${f.fixed}: [vulns] fix_skip_gate = "never", so steward sc upgrade takes it once it clears the release-age gate`); continue; }
    const u = byTool.get(tool) || { tool, have: f.pkg.version, version: f.fixed, advisories: [] };
    if (V.cmpVer(f.fixed, u.version) > 0) u.version = f.fixed;
    u.advisories.push(adv(f));
    byTool.set(tool, u);
  }
  for (const b of brew.values()) {
    const fixed = b.list.map(x => x.fixed).filter(Boolean).sort(V.cmpVer).pop();
    const what = `${b.tool} ${b.version}: ${few(b.list.map(x => x.id))}`;
    if (fixed) p.handed.push(`${what}, fixed in ${fixed}: a security_exception of kind formula, then steward sc upgrade`);
    else p.held.push(`${what}: ${b.list.some(x => x.upstream) ? 'fixed upstream, unreleased' : 'no fixed release yet'}`);
  }
  // a fix across a major (or a 0.x minor) is deliberate: handed over with its command unless [vulns] fix_majors = "take"
  for (const u of byTool.values()) {
    if (s.fix_majors === 'take' || !V.isMajor(u.have, u.version)) p.upgrades.push(u);
    else p.handed.push(`${u.tool} ${u.have} -> ${u.version} is a major (${u.advisories.map(a => a.id).join(', ')}): read its release notes, then steward sc upgrade-tool ${u.tool} ${u.version}`);
  }
  p.exceptions = p.upgrades.map(u => ({ kind: 'mise', name: u.tool, version: u.version, advisory: u.advisories[0].url, expires: addDays(ctx.today, s.exception_days) }));

  if (s.cleanup) {
    say('unused installs: reading what each holds');
    const old = await V.inventory(ctx, s, { inactive: true, say });
    if (old.packages.length) {
      const ol = await V.lookup(ctx, feeds.filter(f => f.kind !== 'nodejs'), old, say, s);
      p.failed.push(...ol.failed.filter(x => !p.failed.some(y => y.feed === x.feed)));
      const byInstall = new Map();
      for (const f of live(ol.findings)) {
        if (!f.pkg.install || f.pkg.tool.startsWith('npm -g ')) continue;
        const k = `${f.pkg.tool}@${f.pkg.install.version}`;
        const c = byInstall.get(k) || { tool: f.pkg.tool, version: f.pkg.install.version, dir: f.pkg.install.dir, advisories: [] };
        if (!c.advisories.some(a => a.id === f.id)) c.advisories.push(adv(f));
        byInstall.set(k, c);
      }
      say(`launcher configs: do any point into the ${byInstall.size} unused install(s)?`);
      const pinned = ctx.pinned && byInstall.size ? await ctx.pinned([...byInstall.values()].map(c => c.dir)) : new Set();
      for (const c of byInstall.values()) {
        const ids = c.advisories.map(a => a.id).join(', ');
        if (ownedBy(owned, c.tool)) p.handed.push(`${c.tool}@${c.version} (unused): ${ids}: AI tooling owns it (steward sc prune after the soak)`);
        else if (o.soakRunning && s.cleanup_skip_soak === 'never') p.held.push(`${c.tool}@${c.version} (unused): ${ids}: the soak is running and [vulns] cleanup_skip_soak = "never"`);
        else if (pinned.has(c.dir)) p.held.push(`${c.tool}@${c.version} (unused): ${ids}: a launcher config still points into it (steward ai drift; repin first)`);
        else p.cleanup.push(c);
      }
    }
  }
  return p;
}

// show(p, write) — the plan as lines
function show(p, write = s => console.log(s)) {
  const ids = a => few(a.map(x => `${x.id}${x.kev ? ' (exploited)' : ''}`));
  write('==> steward sc vulns-fix: the plan');
  for (const f of p.failed) write(`  not checked: ${f.feed} (${f.error}); what it would have found isn't in this plan`);
  for (const u of p.upgrades) write(`  upgrade  ${u.tool} ${u.have} -> ${u.version}${V.isMajor(u.have, u.version) ? ' (MAJOR)' : ''}  (${ids(u.advisories)}; skips the release-age gate)`);
  for (const e of p.exceptions) write(`  record   host.toml security_exception ${e.name} ${e.version}, ${e.advisory}, expires ${e.expires}`);
  for (const c of p.cleanup) write(`  remove   ${c.tool}@${c.version} (unused: ${ids(c.advisories)})`);
  if (p.node) write(`  next     steward sc node-patch ${p.node.version}  (Node ${p.node.have}; ${ids(p.node.advisories)}; it reinstalls the hybrids and asks its own yes)`);
  for (const h of p.held) write(`  waits    ${h}`);
  for (const h of p.handed) write(`  yours    ${h}`);
  if (!p.upgrades.length && !p.cleanup.length) write('  nothing for vulns-fix to do here');
}

// exceptionText(entries) — host.toml [[security_exception]] tables for the entries, appended as text (comments kept)
const exceptionText = entries => entries.map(e => `\n# steward sc vulns-fix ${e.expires}: ${e.advisory}\n[[security_exception]]\nkind = "${e.kind}"\nname = ${JSON.stringify(e.name)}\nversion = ${JSON.stringify(e.version)}\nadvisory = ${JSON.stringify(e.advisory)}\nexpires = "${e.expires}"\n`).join('');

// apply(p, {dir, exec, files, write}) — the receipt. exec(cmd, args, env) → exit status (inherits the terminal);
// files: {host, miseConfig, miseLock}
function apply(p, o) {
  const write = o.write || (s => console.log(s));
  const rp = path.join(o.dir, 'receipt.json');
  const r = { kind: 'vulns-fix', at: new Date().toISOString(), engine: C.ENGINE_VERSION, outcome: 'started', rollback: `steward sc vulns-fix --rollback ${C.tilde(rp)}`,
    plan: { upgrades: p.upgrades, cleanup: p.cleanup, exceptions: p.exceptions, node: p.node }, backups: [], steps: [] };
  const save = () => fs.writeFileSync(rp, `${JSON.stringify(r, null, 1)}\n`);
  // back up the three files this can change (one that doesn't exist yet is recorded as absent)
  for (const [name, f] of Object.entries(o.files)) {
    const text = read(f);
    if (text !== null) fs.copyFileSync(f, path.join(o.dir, name));
    r.backups.push({ name, file: f, existed: text !== null, sha: text === null ? null : sha(text) });
  }
  save();
  write(`==> backed up to ${C.tilde(o.dir)}`);
  let ok = true;
  if (p.exceptions.length) {
    const before = read(o.files.host) || '';
    const after = before + (before.endsWith('\n') || !before ? '' : '\n') + exceptionText(p.exceptions);
    fs.writeFileSync(o.files.host, after);
    const parsed = spawnSync('yq', ['-p', 'toml', '-o', 'json', '.', o.files.host], { encoding: 'utf8' });
    if (parsed.status !== 0) { fs.writeFileSync(o.files.host, before); r.steps.push({ step: 'exceptions', outcome: 'failed: host.toml did not parse; put back' }); r.outcome = 'failed: host.toml'; save(); return r; }
    r.steps.push({ step: 'exceptions', outcome: 'done', count: p.exceptions.length });
    write(`==> recorded ${p.exceptions.length} security_exception(s) in ${C.tilde(o.files.host)}`);
  }
  for (const u of p.upgrades) {
    write(`==> upgrade ${u.tool} ${u.have} -> ${u.version}`);
    const status = o.exec(path.join(ENGINE, 'supply-chain', 'bin', 'upgrade-tool'), [u.tool, u.version], { STEWARD_DEFER_VERIFY: '1' });
    r.steps.push({ step: `upgrade ${u.tool}@${u.version}`, outcome: status === 0 ? 'done' : `failed: exit ${status}` });
    ok = ok && status === 0; save();
  }
  for (const c of p.cleanup) {
    write(`==> remove ${c.tool}@${c.version}`);
    const status = o.exec('mise', ['uninstall', `${c.tool}@${c.version}`], {});
    r.steps.push({ step: `remove ${c.tool}@${c.version}`, outcome: status === 0 ? 'done' : `failed: exit ${status}`, reinstall: `mise install ${c.tool}@${c.version}` });
    ok = ok && status === 0; save();
  }
  if (p.upgrades.length || p.cleanup.length) {
    const status = o.exec(path.join(ENGINE, 'supply-chain', 'bin', 'verify'), [], {});
    r.steps.push({ step: 'verify', outcome: status === 0 ? 'done' : `failed: exit ${status}` });
    ok = ok && status === 0;
  }
  for (const [name, f] of Object.entries(o.files)) { const t = read(f); const b = r.backups.find(x => x.name === name); b.after_sha = t === null ? null : sha(t); }
  r.outcome = ok ? 'done' : `failed: ${r.steps.filter(s => s.outcome !== 'done').map(s => s.step).join(', ')}`;
  save();
  write(ok ? `==> done. receipt ${C.tilde(rp)}; way back: ${r.rollback}` : `ERROR ${r.outcome}; receipt ${C.tilde(rp)}; way back: ${r.rollback}`);
  if (p.node) write(`  next: steward sc node-patch ${p.node.version}`);
  return r;
}

// rollback(file, {exec, write}) — put the backed-up files back where nothing changed them since, and reinstall what the
// cleanup removed; returns an exit status
function rollback(file, o) {
  const write = o.write || (s => console.log(s));
  const f = fs.statSync(file).isDirectory() ? path.join(file, 'receipt.json') : file;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (r.kind !== 'vulns-fix') { write(`ERROR ${C.tilde(f)} is not a vulns-fix receipt (kind ${r.kind})`); return 1; }
  if (r.undone) { write('already rolled back'); return 0; }
  const dir = path.dirname(f);
  let status = 0;
  for (const b of r.backups) {
    const now = read(b.file);
    const nowSha = now === null ? null : sha(now);
    if (b.after_sha !== undefined && nowSha !== b.after_sha) { write(`  kept ${C.tilde(b.file)}: it changed after vulns-fix (put it back by hand from ${C.tilde(path.join(dir, b.name))})`); status = 1; continue; }
    if (b.existed) fs.copyFileSync(path.join(dir, b.name), b.file);
    else if (now !== null) fs.rmSync(b.file);
    write(`  restored ${C.tilde(b.file)}`);
  }
  for (const s of r.steps.filter(x => x.reinstall && x.outcome === 'done')) {
    const [cmd, ...args] = s.reinstall.split(' ');
    const st = o.exec(cmd, args, {});
    write(`  ${st === 0 ? 'reinstalled' : 'FAILED to reinstall'}: ${s.reinstall}`);
    if (st !== 0) status = 1;
  }
  if (r.steps.some(x => x.step.startsWith('upgrade ') && x.outcome === 'done')) o.exec('mise', ['reshim'], {});
  r.undone = new Date().toISOString();
  fs.writeFileSync(f, `${JSON.stringify(r, null, 1)}\n`);
  return status;
}

// ask(q, cls) — [y/N] on the terminal; under --unattended, [autonomy] answers by the question's class (lib/autonomy.js)
async function ask(q, cls) {
  if (process.env.DRY_RUN === '1') return false;
  if (require('../../lib/autonomy.js').answer(cls, q)) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

const execInherit = (cmd, args, env) => spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

module.exports = { plan, show, apply, rollback, exceptionText };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const files = { host: C.instance('supply-chain/host.toml'), miseConfig: C.instance('mise/config.toml'), miseLock: C.instance('mise/mise.lock') };
    if (argv[0] === '--rollback') {
      if (!argv[1]) { console.error('usage: vulns-fix.js --rollback <receipt>'); process.exit(2); }
      const file = C.userPath(argv[1]);
      console.log(`==> roll back ${C.tilde(file)}: put back mise/config.toml, mise/mise.lock and host.toml as they were, and reinstall what was removed`);
      if (!(await ask('Roll back?', 'rollback'))) { console.log('not rolled back'); process.exit(process.env.DRY_RUN === '1' ? 0 : 1); }
      process.exit(rollback(file, { exec: execInherit }));
    }
    const { context } = require('./audit.js');
    const { values } = C.load();
    // a live line (lib/progress.js): the feeds and the unused installs can take a while, and nothing should look hung
    const st = require('../../lib/progress.js').progress(1).stage('known vulnerabilities: installed and unused');
    const ctx = context({
      say: t => st.detail(t),
      aiOwned: values.profiles.ai_tooling ? V.aiOwned(C.policy('ai-tooling/ai-tooling.toml')) : [],
      // one pins.js run for every folder, off the event loop so the live line keeps moving; its lines name the install
      pinned: dirs => new Promise(resolve => {
        let out = '';
        const ch = require('child_process').spawn('node', [path.join(ENGINE, 'lib', 'pins.js'), ...dirs], { stdio: ['ignore', 'pipe', 'ignore'] });
        ch.stdout.on('data', d => { out += d; });
        ch.on('close', () => resolve(new Set(dirs.filter(d => out.split('\n').some(l => C.untilde(l.split('\t')[1] || '') === d)))));
        ch.on('error', () => resolve(new Set(dirs)));   // couldn't check: hold them all
      }),
    });
    let soakRunning = false;
    try { soakRunning = require('../../lib/soak.js').state(new Date()).running; } catch { /* no soak state */ }
    const p = await plan(ctx, { soakRunning });
    st.done(`${p.upgrades.length} upgrade(s), ${p.cleanup.length} removal(s)`);
    show(p);
    if (!argv.includes('--apply')) { console.log('\nplan only. Add --apply to do it (asks first).'); return; }
    if (!p.upgrades.length && !p.cleanup.length) return;
    if (!(await ask(`Take ${p.upgrades.length} upgrade(s) and remove ${p.cleanup.length} old install(s)?`, 'vulns-fix'))) { console.log('nothing changed'); process.exitCode = process.env.DRY_RUN === '1' ? 0 : 1; return; }
    const r = apply(p, { dir: C.newBackupDir('vulns-fix'), exec: execInherit, files });
    if (r.outcome !== 'done') process.exitCode = 1;
  })().catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
