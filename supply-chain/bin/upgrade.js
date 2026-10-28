#!/usr/bin/env node
// Upgrade what can be upgraded from the CLI, within host.toml's policy (R5c, D43): `steward sc upgrade`, and with
// DRY_RUN=1 `steward sc plan`. The plan comes from the providers (lib/providers/):
//   - Homebrew formulae and non-self-updating casks whose new version has been in Homebrew for at least the release-age
//     gate (steward.toml [policy]), or that match an unexpired host.toml security_exception;
//   - mise tools (mise holds them to minimum_release_age; majors are skipped and listed; Node goes through node-patch;
//     AI tooling's own tools follow its qualification);
//   - mise itself, when it is the standalone build (bin/mise-self.js chooses; bin/mise-self-update applies, last).
// Applying asks first, then runs the Bash steps that back up, record and verify: brew upgrade, bin/upgrade-tool per
// mise tool, bin/mise-self-update, bin/verify. Never touches app updaters, the App Store, macOS, trust stores or Docker;
// `steward sc audit` lists those. Off a terminal it prints what the Bash upgrade printed, line for line (compared on
// the owner's Mac before the switch, R5c PR 3); on a terminal the planning shows as steps (lib/ui.js).
// Usage: upgrade.js [--plain]     (DRY_RUN=1: the plan and its commands only; nothing changes)
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const C = require('../../lib/config.js');
const brew = require('../../lib/providers/brew.js');
const mise = require('../../lib/providers/mise.js');
const { ui: makeUi } = require('../../lib/ui.js');
const { ageDays, securityException } = require('../checks/index.js');
const { context } = require('./audit.js');

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
// script(cmd, args) — run with this terminal (a script that honours DRY_RUN itself, or asks); its exit status
const script = (cmd, args) => new Promise(resolve => {
  const p = spawn(cmd, args, { stdio: 'inherit' });
  p.on('error', () => resolve(127));
  p.on('close', code => resolve(code));
});

// crossesMajor(current, target) — whether target crosses a major (a 0.x minor counts as one), as the Bash plan judged it
function crossesMajor(current, target) {
  let c = current.split('.')[0], t = target.split('.')[0];
  if (c === '0') { c = current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : current; t = target.includes('.') ? target.slice(0, target.lastIndexOf('.')) : target; }
  return c !== t && /^[0-9]/.test(current);
}

// plan(ctx, out) — {formulae, casks, tools, miseSelf}: what applying would take. out.section(name, title) starts a
// part; out.line(text) is one of its lines (take, hold, skip, manual, ai)
async function plan(ctx, out) {
  const min = ctx.cfg.policy.min_release_age_days;
  const p = { formulae: [], casks: [], tools: [], miseSelf: '' };

  out.section('Homebrew formulae', 'Homebrew formulae');
  for (const { name, have, want } of await brew.outdated(ctx, 'formula')) {
    const age = ageDays(await brew.releaseDate(ctx, 'formula', name, want), ctx.now);
    const exc = securityException(ctx, 'formula', name, want.replace(/_[^_]*$/, ''));
    if (exc) { p.formulae.push(name); out.line(`take   ${name} ${have} -> ${want} (security exception: ${exc})`); }
    else if (age >= min) { p.formulae.push(name); out.line(`take   ${name} ${have} -> ${want} (${age}d old)`); }
    else out.line(`hold   ${name} ${have} -> ${want} (${age}d old)`);
  }
  for (const l of (await ctx.run('brew', ['outdated', '--formula', '--verbose'])).stdout.split('\n').filter(l => l.includes('/'))) out.line(`manual tap formula (review its release, then brew upgrade): ${l}`);

  out.section('Homebrew casks', 'Homebrew casks (self-updating casks are left to their own updaters)');
  for (const { name, have, want, auto } of await brew.outdated(ctx, 'cask')) {
    if (auto) continue;
    const age = ageDays(await brew.releaseDate(ctx, 'cask', name, want), ctx.now);
    if (age >= min) { p.casks.push(name); out.line(`take   ${name} ${have} -> ${want} (${age}d old)`); }
    else out.line(`hold   ${name} ${have} -> ${want} (${age}d old)`);
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

  out.section('mise itself', "mise itself (D38: the gate and advisories decide; Homebrew's mise is judged with the formulae)");
  const [action, current, target, reason, auto] = (await ctx.run('node', [path.join(SC, 'bin', 'mise-self.js'), '--plan'])).stdout.trim().split('\t');
  if (action === 'take') { p.miseSelf = target; out.line(`take   mise ${current} -> ${target} (${reason})`); }
  else out.line(`${String(action).padEnd(6)} mise ${current} (${reason})`);
  if (auto === 'true') out.warn("mise's own automatic update is on (self_update.auto): it skips this plan's backup; turn it off");
  return p;
}

async function ask(q) {
  if (DRY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^[Yy]$/.test(a.trim());
}

async function main() {
  const u = process.argv.includes('--plain') ? null : makeUi();
  const tty = Boolean(u && u.tty);
  const ctx = context();
  // Refresh Homebrew's own metadata so `brew upgrade` sees the versions the live API reports
  await step('brew', ['update', '--quiet']);

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
  if (tty) u.header(DRY ? 'steward sc plan' : 'steward sc upgrade', `${ctx.platform} · release-age gate ${ctx.cfg.policy.min_release_age_days}d`);
  const p = await plan(ctx, out);
  finish();

  if (!p.formulae.length && !p.casks.length && !p.tools.length && !p.miseSelf) { log('nothing eligible; see steward sc audit for held and manual items'); return 0; }
  log(`plan: ${p.formulae.length} formula(e), ${p.casks.length} cask(s), ${p.tools.length} mise tool(s)${p.miseSelf ? `, mise ${p.miseSelf}` : ''}`);
  if (!(await ask('Apply this plan?'))) { console.error('\x1b[1;31mERROR\x1b[0m aborted'); return 1; }

  if (p.formulae.length) await step('brew', ['upgrade', '--formula', ...p.formulae]);
  if (p.casks.length) await step('brew', ['upgrade', '--cask', ...p.casks]);
  // bin/upgrade-tool backs up config + lock, upgrades with --no-prune, verifies and locks each tool, and honours DRY_RUN
  for (const t of p.tools) await script(path.join(SC, 'bin', 'upgrade-tool'), [t]);
  // Last, so the tools above upgrade under the mise that planned them; it backs up the binary, verifies and records
  if (p.miseSelf) await script(path.join(SC, 'bin', 'mise-self-update'), [p.miseSelf]);

  if (DRY) { log('dry run: nothing changed'); return 0; }
  if ((await script(path.join(SC, 'bin', 'verify'), [])) !== 0) { console.error('\x1b[1;31mERROR\x1b[0m verification failed; mise: steward sc rollback; Homebrew: brew reinstall the previous bottle'); return 1; }
  log('done. Remaining manual items: steward sc audit');
  return 0;
}

module.exports = { plan, crossesMajor };

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(e => { console.error(`\x1b[1;31mERROR\x1b[0m ${e.message}`); process.exitCode = 1; });
