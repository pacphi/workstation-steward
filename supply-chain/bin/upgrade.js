#!/usr/bin/env node
// Upgrade what can be upgraded from the CLI, within host.toml's policy (R5c, D43): `steward sc upgrade`, and with
// DRY_RUN=1 `steward sc plan`. The plan comes from the providers (lib/providers/):
//   - each package source that applies here and is installed (lib/providers/index.js, parity 0.2: Homebrew formulae
//     and non-self-updating casks today), for versions at least the release-age gate (steward.toml [policy]) old, or
//     that match an unexpired host.toml security_exception; a source that needs root is listed for the user (D-b);
//   - mise tools (mise holds them to minimum_release_age; majors are skipped and listed; Node goes through node-patch;
//     AI tooling's own tools follow its qualification);
//   - declared updaters ([[updater]], D52) that are behind and whose class may skip the gate (lib/updaters.js);
//   - mise itself, when it is the standalone build (bin/mise-self.js chooses; bin/mise-self-update applies, last).
// Applying asks first, then runs each source's upgrade (brew upgrade) and the Bash steps that back up and record: bin/upgrade-tool per mise tool,
// lib/updaters.js --apply per declared updater, bin/mise-self-update; then bin/verify once, for all of them
// (STEWARD_DEFER_VERIFY=1 tells upgrade-tool and mise-self-update to leave it to this run). Every step's exit status is
// kept: a failed step is reported as it happens and the run carries on with the others (each is independent); the end
// lists each failure with its way back and exits 1, never "done". Never touches app updaters, the App Store, macOS, trust stores or Docker;
// `steward sc audit` lists those. Off a terminal it prints what the Bash upgrade printed, line for line (compared on
// the owner's Mac before the switch, R5c PR 3); on a terminal the planning shows as steps (lib/ui.js).
// Usage: upgrade.js [--plain]     (DRY_RUN=1: the plan and its commands only; nothing changes)
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const C = require('../../lib/config.js');
const P = require('../../lib/providers/index.js');
const mise = require('../../lib/providers/mise.js');
const { ui: makeUi } = require('../../lib/ui.js');
const { context } = require('./audit.js');
const U = require('../../lib/updaters.js');

const SC = path.join(__dirname, '..');
const DRY = process.env.DRY_RUN === '1';
// the scripts this starts share its start time, as lib/lib.sh does, so their [m:ss] stamps continue
process.env.STEWARD_T0 = process.env.STEWARD_T0 || String(Math.floor(Date.now() / 1000));
const T0 = Number(process.env.STEWARD_T0) * 1000;
const elapsed = () => { const s = Math.floor((Date.now() - T0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const log = s => console.log(`\x1b[1;34m==>\x1b[0m ${s} \x1b[2m[${elapsed()}]\x1b[0m`);

// step(cmd, args) — a command shown as `   $ …` (lib.sh run); skipped under DRY_RUN; output passes through; its status
function step(cmd, args) {
  console.log(`   $ ${[cmd, ...args].join(' ')}`);
  if (DRY) return Promise.resolve(0);
  return script(cmd, args);
}
// script(cmd, args, env) — run with this terminal (a script that honours DRY_RUN itself, or asks); its exit status
// (127 when it can't start, 1 when a signal ended it)
const script = (cmd, args, env = process.env) => new Promise(resolve => {
  const p = spawn(cmd, args, { stdio: 'inherit', env });
  p.on('error', () => resolve(127));
  p.on('close', code => resolve(code === null ? 1 : code));
});

// snap(dir, match) — the names in dir that match; fresh(dir, match, before) — the newest one not in that snapshot: the
// backup a step just made (each backup gets its own name), or ''
function snap(dir, match) {
  try { return new Set(fs.readdirSync(dir).filter(n => match.test(n))); } catch { return new Set(); }
}
const fresh = (dir, match, before) => [...snap(dir, match)].filter(n => !before.has(n)).sort().map(n => path.join(dir, n)).pop() || '';

// crossesMajor(current, target) — whether target crosses a major (a 0.x minor counts as one), as the Bash plan judged it
function crossesMajor(current, target) {
  let c = current.split('.')[0], t = target.split('.')[0];
  if (c === '0') { c = current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : current; t = target.includes('.') ? target.slice(0, target.lastIndexOf('.')) : target; }
  return c !== t && /^[0-9]/.test(current);
}

// ROOT — why a source that needs root is listed, never run (D-b: the hand-off comes with the apt provider)
const ROOT = "needs root; the steward doesn't run sudo yet (D-b, comes with the apt provider)";

// refreshSteps(ctx) — the metadata refresh of each source that applies, is installed and needs no root (brew update)
async function refreshSteps(ctx) {
  const steps = [];
  for (const s of P.sources(ctx)) if (!s.needsRoot && s.refresh() && (await s.available(ctx))) steps.push(s.refresh());
  return steps;
}

// plan(ctx, out) — {packages: [{source, names}], tools, updaters, miseSelf}: what applying would take. out.section(name, title) starts a
// part; out.line(text) is one of its lines (take, hold, skip, manual, ai)
async function plan(ctx, out) {
  const p = { packages: [], tools: [], updaters: [], miseSelf: '' };
  for (const s of P.sources(ctx)) {
    out.section(s.name, s.title);
    if (!(await s.available(ctx))) { out.line(`${s.provider} not found: skipped`); continue; }
    const names = [];
    for (const it of await s.outdated(ctx)) {
      if (it.auto) continue;
      const j = await P.judge(ctx, s, it);
      const what = `${it.name} ${it.have} -> ${it.want}`;
      if (j.verdict === 'hold') { out.line(`hold   ${what} (${j.age}d old)`); continue; }
      if (s.needsRoot) { const c = s.upgradeCmd([it.name]); out.line(`manual ${s.provider}: ${ROOT}: sudo ${[c.cmd, ...c.args].join(' ')}`); continue; }
      names.push(it.name);
      out.line(`take   ${what} (${j.exception ? `security exception: ${j.exception}` : `${j.age}d old`})`);
    }
    for (const l of await s.manual(ctx)) out.line(s.manualText('plan', l));
    if (names.length) p.packages.push({ source: s.id, names });
  }

  out.section('mise tools', 'mise tools (mise already applies minimum_release_age)');
  // AI tooling owns some mise tools (ai-tooling/ai-tooling.toml owned_mise): they follow its qualification, not this plan
  const aiOwned = new Set(ctx.cfg.profiles.ai_tooling ? ((C.policy('ai-tooling/ai-tooling.toml') || {}).owned_mise || []) : []);
  for (const { name, have, want } of await mise.outdated(ctx)) {
    if (name === 'node') { out.line(`manual node ${have} -> ${want}: steward sc node-patch <version> (hybrids reinstall)`); continue; }
    if (aiOwned.has(name)) { out.line(`ai     ${name} ${have} -> ${want} (AI tooling owns it: steward ai drift)`); continue; }
    if (crossesMajor(have, want)) out.line(`skip   ${name} ${have} -> ${want} (major: upgrade deliberately with steward sc upgrade-tool ${name} <version>)`);
    else { p.tools.push(name); out.line(`take   ${name} ${have} -> ${want}`); }
  }

  out.section('Declared updaters', 'Declared updaters ([[updater]]: signed_data, always_current and an unexpired exception skip the gate)');
  for (const u of U.active(ctx.policy)) {
    const cls = U.classOf(u, ctx.today);
    if (!U.pinState(u).ok) { out.line(`skip   ${u.name} (its signing key changed: steward sc audit)`); continue; }
    const c = await U.check(u, ctx.run);
    if (c.state === 'current') continue;
    if (c.state === 'unknown') out.line(`skip   ${u.name} (its check couldn't tell: exit ${c.status})`);
    else if (cls === 'gated') out.line(`hold   ${u.name} (gated: a declared source has no release date; apply it yourself after review)`);
    else { p.updaters.push(u.name); out.line(`take   ${u.name} (${cls}: ${U.SKIPS[cls]})`); }
  }

  out.section('mise itself', "mise itself (D38: the gate and advisories decide; Homebrew's mise is judged with the formulae)");
  const [action, current, target, reason, auto] = (await ctx.run('node', [path.join(SC, 'bin', 'mise-self.js'), '--plan'])).stdout.trim().split('\t');
  if (action === 'take') { p.miseSelf = target; out.line(`take   mise ${current} -> ${target} (${reason})`); }
  else out.line(`${String(action).padEnd(6)} mise ${current} (${reason})`);
  if (auto === 'true') out.warn("mise's own automatic update is on (self_update.auto): it skips this plan's backup; turn it off");
  return p;
}

// ask(q) — [y/N] on the terminal; under --unattended, [autonomy] answers for the class upgrade (lib/autonomy.js)
async function ask(q) {
  if (DRY) return true;
  if (require('../../lib/autonomy.js').answer('upgrade', q)) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^[Yy]$/.test(a.trim());
}

async function main() {
  const u = process.argv.includes('--plain') ? null : makeUi();
  const tty = Boolean(u && u.tty);
  const ctx = context();
  // Refresh each source's own metadata (brew update), so its upgrade sees the versions the plan judged
  for (const r of await refreshSteps(ctx)) await step(r.cmd, r.args);

  let st = null, lines = [], counts = { take: 0, hold: 0, other: 0 };
  const finish = () => {
    if (!st) return;
    const parts = [counts.take ? `${counts.take} to take` : '', counts.hold ? `${counts.hold} held` : '', counts.other ? `${counts.other} other` : ''].filter(Boolean);
    st.done(counts.take ? 'warn' : 'ok', parts.join(' · ') || 'nothing to do', lines);
    st = null;
  };
  const out = {
    section(name, title) {
      if (!tty) { log(title); return; }
      finish();
      lines = []; counts = { take: 0, hold: 0, other: 0 };
      st = u.step(name);
    },
    line(t) {
      if (!tty) { console.log(`  ${t}`); return; }
      const kind = t.slice(0, 6).trim();
      if (kind === 'take') counts.take++; else if (kind === 'hold') counts.hold++; else counts.other++;
      const sym = kind === 'take' ? u.paint('33', u.sym.warn) : kind === 'hold' ? u.paint('2', u.sym.held) : u.paint('2', u.sym.info);
      lines.push(`      ${sym} ${u.cut(t, u.cols() - 8)}`);
    },
    warn: t => process.stderr.write(`\x1b[1;33mWARN\x1b[0m ${t}\n`),
  };
  if (tty) u.header(DRY ? 'steward sc plan' : 'steward sc upgrade', `${require('../../lib/platform.js').label({ platform: ctx.platform, distro: ctx.distro || null, version: ctx.version || null })} · release-age gate ${ctx.cfg.policy.min_release_age_days}d`);
  const p = await plan(ctx, out);
  finish();

  if (!p.packages.length && !p.tools.length && !p.updaters.length && !p.miseSelf) { log('nothing eligible; see steward sc audit for held and manual items'); return 0; }
  const sourceCounts = P.sources(ctx).map(s => `${((p.packages.find(x => x.source === s.id) || { names: [] }).names).length} ${s.noun}, `).join('');
  log(`plan: ${sourceCounts}${p.tools.length} mise tool(s)${p.updaters.length ? `, ${p.updaters.length} declared updater(s)` : ''}${p.miseSelf ? `, mise ${p.miseSelf}` : ''}`);
  if (!(await ask('Apply this plan?'))) { console.error('\x1b[1;31mERROR\x1b[0m aborted'); return 1; }

  const paths = ctx.cfg.paths;
  return apply(p, { backups: path.join(paths.mise_config_dir, 'backups'), stateBackups: path.join(paths.state, 'backups') });
}

const err = s => console.error(`\x1b[1;31mERROR\x1b[0m ${s}`);

// apply(p, o) — run the plan's steps in order, verify once, and report; the exit code. Every step's status is kept and a
// failed step doesn't stop the others: each tool, formula batch, updater and mise itself is its own change, with its
// own backup. o.backups: where upgrade-tool's config backups land, o.stateBackups: the state folder's backups (for the
// rollback hints); o.script and o.step: the runners (tests pass stand-ins); o.sources: the package sources (tests);
// o.dry: DRY_RUN
async function apply(p, o = {}) {
  const run = o.script || script, show = o.step || step, dry = o.dry === undefined ? DRY : o.dry;
  // the scripts leave verification to the single run at the end (they still verify when run on their own)
  const deferred = { ...process.env, STEWARD_DEFER_VERIFY: '1' };
  /** @type {{what: string, code: number, back: string}[]} */
  const failed = [];
  const fail = (what, code, back) => { failed.push({ what, code, back }); err(`${what} failed (exit ${code}); the other steps still run, and the end lists it`); };

  // each source's upgrade, with its own way back; a source this engine doesn't know, or one that needs root, is refused
  const list = o.sources || P.ALL;
  for (const { source, names } of p.packages || []) {
    const s = P.byId(source, list);
    if (!s) { fail(`${source}: no such package source`, 1, 'none needed: nothing ran for it'); continue; }
    if (s.needsRoot) { fail(`${s.provider}: ${ROOT}`, 1, 'none needed: nothing ran for it'); continue; }
    const u = s.upgradeCmd(names);
    const c = await show(u.cmd, u.args);
    if (c) fail([u.cmd, ...u.args].join(' '), c, s.back);
  }
  // bin/upgrade-tool backs up config + lock, upgrades with --no-prune, records and locks each tool, and honours DRY_RUN
  for (const [i, t] of p.tools.entries()) {
    log(`mise tool ${i + 1}/${p.tools.length}: ${t}`);
    const before = o.backups ? snap(o.backups, /^config\.toml\./) : new Set();
    const c = await run(path.join(SC, 'bin', 'upgrade-tool'), [t], deferred);
    if (!c) continue;
    const b = o.backups ? fresh(o.backups, /^config\.toml\./, before) : '';
    fail(`mise tool ${t}`, c, b ? `if it changed the config, steward sc rollback ${C.tilde(b)} (puts back the config from before it, and undoes the tools after it)` : 'none needed: it stopped before its config backup, so it changed nothing');
  }
  // lib/updaters.js checks the pin again, backs up, applies, checks the output and the pin, writes a receipt; honours DRY_RUN
  for (const n of p.updaters) {
    const c = await run('node', [path.join(SC, '..', 'lib', 'updaters.js'), '--apply', n]);
    if (c) fail(`declared updater ${n}`, c, 'steward sc rollback <receipt> (it printed its receipt above)');
  }
  // Last, so the tools above upgrade under the mise that planned them; it backs up the binary and records
  if (p.miseSelf) {
    const before = o.stateBackups ? snap(o.stateBackups, /^mise-self-update-/) : new Set();
    const c = await run(path.join(SC, 'bin', 'mise-self-update'), [p.miseSelf], deferred);
    if (c) fail(`mise self-update to ${p.miseSelf}`, c, !o.stateBackups || fresh(o.stateBackups, /^mise-self-update-/, before) ? 'if mise changed, steward sc rollback mise (puts the previous binary back)' : 'none needed: it stopped before its binary backup, so mise is as it was');
  }

  let verified = true;
  if (dry) log('dry run: nothing changed');
  else {
    log('verify: once, for every change above');
    if ((await run(path.join(SC, 'bin', 'verify'), [])) !== 0) { verified = false; err('verification failed; mise: steward sc rollback; Homebrew: brew reinstall the previous bottle'); }
  }
  if (failed.length) {
    err(`${failed.length} step(s) of this upgrade failed${dry ? ' in the dry run' : ''}; the others ran:`);
    for (const f of failed) console.error(`  ✗ ${f.what} (exit ${f.code})\n      way back: ${f.back}`);
    log('not done: fix each failed step (its error is above), then run steward sc upgrade again. Manual items: steward sc audit');
    return 1;
  }
  if (!verified) return 1;
  if (!dry) log('done. Remaining manual items: steward sc audit');
  return 0;
}

module.exports = { plan, apply, crossesMajor, refreshSteps };

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(e => { console.error(`\x1b[1;31mERROR\x1b[0m ${e.message}`); process.exitCode = 1; });
