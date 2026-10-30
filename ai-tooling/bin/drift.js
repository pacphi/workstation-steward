#!/usr/bin/env node
// Read-only: compare this machine's AI tooling with ai-tooling/ai-tooling.toml and each project's declared tools.
// Never writes or installs anything. Usage: drift.js [--offline] [--json]
// Progress goes to stderr in three stages (machine, upstream, projects; lib/progress.js), so stdout, and --json, stay the
// report alone. Every check here is synchronous, so a stage's line moves on each detail, not on a timer.
//   DRIFT  something differs from policy        WARN  likely drift, or policy not yet decided
//   info   context (ages, upstream state)        ok    matches policy
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../../lib/projects.js');
const HT = require('../../lib/hooktimeouts.js');
const C = require('../../lib/config.js');
const { progress } = require('../../lib/progress.js');

const offline = process.argv.includes('--offline');
const asJSON = process.argv.includes('--json');
if (!C.load().values.profiles.ai_tooling) {
  console.log('AI tooling profile is off (steward.toml [profiles] ai_tooling = false): nothing to check.');
  process.exit(0);
}
const policy = C.policy('ai-tooling/ai-tooling.toml');
const results = [];
const say = (level, area, msg) => { results.push({ level, area, msg }); };
const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const realOr = p => { try { return fs.realpathSync(p); } catch { return null; } };
const MIN_AGE_DAYS = C.load().values.policy.min_release_age_days;
const pg = progress(3);
const found = n => `${n} finding(s)`;

// ---- machine ----------------------------------------------------------------------------------------------
let st = pg.stage('machine');
st.detail('the AQE runtime');
const aqeRoot = P.untilde(policy.aqe.runtime);
const aqeCur = realOr(path.join(aqeRoot, 'current'));
const aqeWant = path.join(aqeRoot, 'releases', policy.aqe.current);
if (!aqeCur) say('DRIFT', 'aqe runtime', `${P.tilde(aqeRoot)}/current is missing`);
else if (aqeCur !== realOr(aqeWant)) say('DRIFT', 'aqe runtime', `current → ${path.basename(aqeCur)}, policy says ${policy.aqe.current}`);
else say('ok', 'aqe runtime', `current → ${policy.aqe.current} (based on ${policy.aqe.based_on}; patches: ${policy.aqe.patches.join(', ')})`);

const aqeBin = P.untilde(policy.aqe.bin);
// What a bare name runs in a fresh shell: mise's environment for the home folder (its global config, whose [env]
// puts the shared runtime first), not this process's PATH, which a long-lived shell can leave stale.
st.detail('what a fresh shell runs');
const freshPath = sh('bash', ['-c', 'cd ~ && mise env -s bash | sed -n "s/^export PATH=//p"']).replace(/^['"]|['"]$/g, '');
const bareShared = new Set(); // the bare names that reach the shared runtime; project servers running one count as on it
const bareWhere = new Map();  // …and where the others land, for the project messages
for (const b of ['aqe', 'aqe-mcp', 'agentic-qe']) {
  const where = sh('bash', ['-c', `${freshPath ? `PATH=${JSON.stringify(freshPath)} ` : ''}command -v ${b}`]);
  if (!where) { say('info', 'aqe on PATH', `${b}: not on PATH`); bareWhere.set(b, 'nothing (not on PATH)'); continue; }
  const real = realOr(where) || where;
  if (real.startsWith(realOr(aqeBin) || aqeBin) || real.startsWith(realOr(aqeRoot) || aqeRoot)) { bareShared.add(b); say('ok', 'aqe on PATH', `${b} → shared runtime`); }
  else { bareWhere.set(b, `${P.tilde(where)} (stock)`); say('DRIFT', 'aqe on PATH', `${b} → ${P.tilde(where)} (stock install ahead of the shared runtime; bare callers skip its guards: mise/config.toml [env] _.path)`); }
}
const aqeRoots = [aqeBin, P.tilde(aqeBin), aqeRoot, P.tilde(aqeRoot)]; // explicit paths a project server may use
// The stock npm:agentic-qe stays managed (mise, Renovate) at the runtime's base version, so it can take over when
// the patches retire ([[retire]]): each qualification moves both.
{
  const pin = ((fs.readFileSync(C.instance('mise/config.toml'), 'utf8').match(/^"npm:agentic-qe"\s*=\s*(?:"([^"]+)"|\{[^}]*?version\s*=\s*"([^"]+)")/m)) || []).slice(1).find(Boolean);
  if (!pin) say('WARN', 'aqe stock', 'npm:agentic-qe is not pinned in mise/config.toml: keep it managed so it can take over when the patches retire');
  else if (pin !== policy.aqe.based_on) say('WARN', 'aqe stock', `npm:agentic-qe is pinned at ${pin}; the runtime is based on ${policy.aqe.based_on}: move the pin with the qualification`);
  else say('ok', 'aqe stock', `npm:agentic-qe ${pin} = the runtime's base (managed by mise and Renovate)`);
}

const rcRoot = P.untilde(policy.ruflo_core.runtime);
const rcCur = realOr(path.join(rcRoot, 'current'));
if (!rcCur) say('DRIFT', 'ruflo-core', `${P.tilde(rcRoot)}/current is missing`);
else if (path.basename(rcCur) !== policy.ruflo_core.current) say('DRIFT', 'ruflo-core', `current → ${path.basename(rcCur)}, policy says ${policy.ruflo_core.current}`);
else say('ok', 'ruflo-core', `current → ${policy.ruflo_core.current}`);

// Hybrid receipts: the install on disk must be the reviewed one (lib/lib.sh hybrid_receipt_ok).
for (const h of policy.owned_hybrids) {
  st.detail(`hybrid receipt: ${h}`);
  const ok = sh('bash', ['-c', `source "${P.REPO_ROOT}/lib/lib.sh" && hybrid_receipt_ok ${h} && echo yes`]) === 'yes';
  say(ok ? 'ok' : 'DRIFT', 'hybrids', ok ? `${h}: receipt matches supply-chain/hybrids.toml and the active Node` : `${h}: no matching receipt (steward sc install-hybrids)`);
}

st.detail('guards');
const envName = policy.guards.auto_update_env;
for (const f of policy.guards.auto_update_files) {
  const abs = P.untilde(f);
  const txt = P.exists(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const set = abs.endsWith('.json')
    ? ((P.readJSON(abs) || {}).env || {})[envName] === 'false'
    : new RegExp(`^\\s*export\\s+${envName}=["']?false["']?\\s*$`, 'm').test(txt);
  say(set ? 'ok' : 'DRIFT', 'guards', `${envName}=false in ${f}: ${set ? 'yes' : 'NO (Ruflo will auto-install patch releases)'}`);
}
{
  const f = policy.guards.npx_ask_file, want = policy.guards.npx_ask || [];
  const have = (((P.readJSON(P.untilde(f)) || {}).permissions || {}).ask) || [];
  const gone = want.filter(r => !have.includes(r));
  say(gone.length ? 'DRIFT' : 'ok', 'guards', `npx ask rules in ${f}: ${gone.length ? `${gone.length} of ${want.length} missing (agents may run unpinned npx unprompted; steward ai guard)` : `${want.length} present`}`);
}
{
  // the git ignore guard (D28): checked through git itself, so a different core.excludesFile is caught too
  const want = (policy.guards.git_ignore || []).filter(l => !l.startsWith('#'));
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'steward-gi-'));
  sh('git', ['-C', tmp, 'init', '-q']);
  const probe = r => r.replace(/\*\*\//g, '').replace(/\*/g, 'x').replace(/\/$/, '/f');
  const ignored = f => { try { execFileSync('git', ['-C', tmp, 'check-ignore', '-q', '--no-index', f], { stdio: 'ignore' }); return true; } catch { return false; } }; // exit 1: not ignored
  const gone = want.filter(r => !ignored(probe(r)));
  fs.rmSync(tmp, { recursive: true, force: true });
  say(gone.length ? 'DRIFT' : 'ok', 'guards', `git ignore rules: ${gone.length ? `${gone.length} of ${want.length} not in effect (AI tool output shows in git status; steward ai guard): ${gone.slice(0, 4).join(' ')}` : `${want.length} in effect`}`);
}
{
  // the plugin store guard (D29): keys a plugin's store file must hold, e.g. ruflo-console's own updater off
  for (const e of policy.guards.plugin_store || []) {
    const g = P.untilde(e.file_glob), dir = path.dirname(g), [pre, post] = path.basename(g).split('*');
    let files = []; try { files = fs.readdirSync(dir).filter(f => f.startsWith(pre) && f.endsWith(post)); } catch { /* no store yet */ }
    if (!files.length) { say('info', 'guards', `${e.name}: no store file yet (${e.file_glob}); run steward ai guard after the plugin first loads`); continue; }
    for (const f of files) {
      const j = P.readJSON(path.join(dir, f)) || {};
      const off = Object.entries(e.set).filter(([k, v]) => JSON.stringify(j[k]) !== JSON.stringify(v)).map(([k, v]) => `${k} is ${JSON.stringify(j[k])}, not ${JSON.stringify(v)}`);
      say(off.length ? 'DRIFT' : 'ok', 'guards', `${e.name}: ${off.length ? `${off.join('; ')} (steward ai guard)` : Object.entries(e.set).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}`);
    }
  }
  // installed Ruflo plugins against the pinned marketplace ([ruflo] marketplace): versions change only by qualification
  const market = P.untilde(policy.ruflo.marketplace);
  const installed = (P.readJSON(path.join(C.load().values.paths.claude_dir, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  for (const [id, entries] of Object.entries(installed).filter(([k]) => k.endsWith('@ruflo'))) {
    const pinned = (P.readJSON(path.join(market, 'plugins', id.split('@')[0], '.claude-plugin', 'plugin.json')) || {}).version;
    const other = [...new Set((Array.isArray(entries) ? entries : [entries]).map(x => x.version).filter(v => v !== pinned))];
    say(other.length ? 'DRIFT' : 'ok', 'ruflo plugins', `${id}: ${other.length ? `installed ${other.join(', ')} somewhere, but the pinned marketplace has ${pinned} (an update outside qualification)` : `${pinned} everywhere it is installed (pinned marketplace)`}`);
  }
}

{
  const src = path.join(P.REPO_ROOT, 'ai-tooling', 'transports', 'aqe-hook-bundle.cjs'), dest = P.untilde(policy.aqe.hook_transport);
  const h = f => { try { return require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
  const st = !P.exists(dest) ? 'missing' : h(dest) === h(src) ? 'installed' : 'differs from ai-tooling/transports/aqe-hook-bundle.cjs';
  say(st === 'installed' ? 'ok' : 'DRIFT', 'aqe', `hook transport v2 ${P.tilde(dest)}: ${st}${st === 'installed' ? '' : ' (steward ai transport)'}`);
}

// A tool switched on per project only, switched on at user level instead (D55): each profile's [user_off].
{
  const F = require('../../lib/profiles.js'), paths = C.load().values.paths;
  for (const r of F.userOff(F.TOOLS, { claudeDir: paths.claude_dir, codexHome: paths.codex_home })) say(r.level, 'user-level off', r.msg);
}

const kb = P.untilde(policy.brain.kb_source);
if (P.exists(kb)) say('info', 'brain', `knowledge base last updated ${fs.statSync(kb).mtime.toISOString().slice(0, 10)} (update deferred by owner; owner-run script)`);

st.done(found(results.length));

// Upstream: releases newer than the AQE runtime's base, and watched threads.
st = pg.stage('upstream');
const before = results.length;
if (!offline) {
  try {
    st.detail(`npm registry: ${policy.aqe.package}`);
    const t = JSON.parse(sh('curl', ['-fsSL', `https://registry.npmjs.org/${policy.aqe.package}`]) || '{}').time || {};
    const base = t[policy.aqe.based_on];
    if (!base) throw new Error('no publish time for the base version');
    const newer = Object.entries(t).filter(([v, d]) => /^\d+\.\d+\.\d+$/.test(v) && base && d > base).sort((a, b) => a[1].localeCompare(b[1]));
    for (const [v, d] of newer) {
      const age = Math.floor((Date.now() - Date.parse(d)) / 864e5);
      st.detail(`release notes: ${policy.aqe.package} ${v}`);
      const notes = sh('gh', ['api', `repos/${policy.aqe.repo}/releases/tags/v${v}`, '--jq', '.body']);
      const sec = /security/i.test(notes) ? ', release notes mention security' : '';
      say(sec ? 'WARN' : 'info', 'aqe upstream', `${v} published ${d.slice(0, 10)} (${age}d${age >= MIN_AGE_DAYS ? ', past the gate' : `, gate clears in ${MIN_AGE_DAYS - age}d`}${sec}); runtime is based on ${policy.aqe.based_on}`);
    }
    if (!newer.length) say('ok', 'aqe upstream', `no release newer than ${policy.aqe.based_on}`);
  } catch { say('info', 'aqe upstream', 'could not read the npm registry'); }
  for (const w of policy.watch || []) {
    const [repo, n] = w.issue.split('#');
    st.detail(`watched: ${w.issue}`);
    const s = sh('gh', ['api', `repos/${repo}/issues/${n}`, '--jq', '"\\(.state) \\(.state_reason // "") \\(.closed_at // "" | .[:10])"']);
    say(s.startsWith('closed') ? 'WARN' : 'info', 'watch', `${w.issue}: ${s || 'unreadable'} — ${w.why}`);
    // a closed thread that a [[retire]] entry waits on: say what to do, so the workaround doesn't outlive its cause
    if (s.startsWith('closed')) for (const r of (policy.retire || []).filter(r => (r.watch || []).includes(w.issue))) {
      say('WARN', 'retire', `${w.issue} is closed: ${r.what} may retire. Check the ${r.when.length} conditions, then: ${(r.steps || []).join('; ') || `see ${C.tilde(path.join(C.REPO_ROOT, 'skills', 'ai-tooling', 'runbook.md'))}`}`);
    }
  }
}

st.done(offline ? 'skipped (--offline)' : found(results.length - before));

// What retires a steward workaround: checked by hand at each AQE qualification (the watched threads above help).
for (const r of policy.retire || []) say('info', 'retire', `${r.what}: retire when all ${r.when.length} hold: ${r.when.map((w, i) => `(${i + 1}) ${w}`).join('; ')}`);

// ---- projects ---------------------------------------------------------------------------------------------
// Checks apply per tool a project declared (ai) or, until confirmed, the migration seed (ai_seed). A tool a
// project shows but didn't choose is reported, never removed.
st = pg.stage('projects');
const reg = P.loadRegistry();
const regByPath = new Map(reg.map(r => [r.abs, r]));
st.detail('finding projects under [projects] roots');
const all = P.discover();
let nth = 0;
const forbid = policy.launchers.forbid;
const counts = {};
const codexApprovals = { files: 0, settings: 0 }; // Codex MCP settings off the policy ([[codex_prompt]], [[codex_stable_node]], D37)
const msTimeouts = { files: 0, hooks: 0, tracked: 0 }; // hook timeouts written in milliseconds (lib/hooktimeouts.js)
for (const f of all) {
  st.detail(`${++nth}/${all.length} ${P.tilde(f.path)}`);
  const r = P.effective(f, regByPath);
  if (r && r.decision === 'ignored') continue; // the owner chose not to manage it
  const { ev, servers, settings } = P.evidence(f.path);
  const declared = r && r.decision === 'onboarded' ? r.ai || [] : null;
  const expected = declared || (r ? r.ai_seed || [] : []);
  const basis = declared ? 'declared' : r ? 'seed, unconfirmed' : 'not registered';
  const where = P.tilde(f.path);
  const out = (level, msg) => { say(level, 'project', `${where}: ${msg}`); counts[level] = (counts[level] || 0) + 1; };

  const extra = ['ruflo', 'aqe', 'brain'].filter(t => ev[t].length && !expected.includes(t));
  if (extra.length && !r) out('info', `not registered yet; shows ${extra.join(', ')}`);
  else if (extra.length) out('WARN', `shows ${extra.map(t => `${t} (${ev[t][0]})`).join(', ')}, beyond its ${basis} tools [${expected.join(', ')}]`);
  // mcpServers in .claude/settings*.json: an older `ruflo init` wrote them, but Claude Code never reads that key.
  for (const i of P.inertSettingsServers(settings)) out('info', `${i.file} has an mcpServers block (${i.names.join(', ')}) that Claude Code doesn't read; it launches nothing and can be deleted`);
  for (const s of servers) {
    if (P.unpinnedLauncher(s.cmd, forbid)) out('DRIFT', `${s.file} server "${s.name}" fetches an unpinned version: ${s.cmd.slice(0, 60)}${['ruflo', 'ruv-swarm', 'flow-nexus'].includes(s.name) && declared && declared.length ? ` (steward projects onboard ${where} --remove-unpinned)` : ''}`);
    if (/agentic-qe|aqe-mcp/.test(s.name + ' ' + s.cmd)) {
      // An explicit path into the runtime, or a bare name a fresh shell resolves to it ("aqe on PATH" above, D33).
      if (!P.sharedAqeCommand(s.cmd, { roots: aqeRoots, bare: bareShared })) {
        const cmd0 = s.cmd.split(' ')[0];
        const runs = !cmd0 ? 'runs (none)' : bareWhere.has(cmd0) ? `runs a bare ${cmd0}, which a fresh shell resolves to ${bareWhere.get(cmd0)}` : `runs ${cmd0}`;
        out('DRIFT', `${s.file} AQE server "${s.name}" ${runs}, not the shared runtime`);
      }
    }
  }
  // Chosen tools with none of their files: decided, never onboarded (or removed by hand).
  // Claude Code agent worktrees aren't onboarding targets (D19): their files come from the agent session.
  const agentWt = f.path.split(path.sep).join('/').includes('/.claude/worktrees/');
  for (const t of agentWt ? [] : declared || []) if (!ev[t].length) out('DRIFT', `chose ${t} but has none of its files: steward projects onboard ${where}`);
  // AQE hooks reach the shared runtime through AQE_HOOK_BUNDLE = transport v2 in settings.local.json (D24). An
  // inline env in a hook command overrides it (transport v1), and `npx agentic-qe hooks` fetches an unpinned AQE.
  if (!f.path.split(path.sep).join('/').includes('/.claude/worktrees/')) {
    const cfg = P.toml(path.join(f.path, '.codex', 'config.toml')) || {};
    let n = 0;
    for (const p of policy.codex_prompt || []) { const t = (((cfg.mcp_servers || {})[p.server] || {}).tools || {})[p.tool]; if (t && t.approval_mode !== 'prompt') n++; }
    for (const s of policy.codex_stable_node || []) { const m = (cfg.mcp_servers || {})[s.server]; if (m && m.command === 'node') n++; }
    if (n) { codexApprovals.files++; codexApprovals.settings += n; }
  }
  const hooks = JSON.stringify((settings['.claude/settings.json'] || {}).hooks || {});
  if (!f.path.split(path.sep).join('/').includes('/.claude/worktrees/')) {
    for (const rel of HT.FILES) {
      const n = HT.find(settings[rel]).length;
      if (n) { msTimeouts.files++; msTimeouts.hooks += n; }
    }
  }
  if (P.exists(path.join(f.path, '.claude', 'hooks', 'aqe-hook.cjs')) && /aqe-hook\.cjs/.test(hooks)) {
    const bundle = ((settings['.claude/settings.local.json'] || {}).env || {}).AQE_HOOK_BUNDLE;
    if (bundle !== P.untilde(policy.aqe.hook_transport)) out(expected.includes('aqe') ? 'DRIFT' : 'WARN', `AQE hooks present but .claude/settings.local.json AQE_HOOK_BUNDLE is ${bundle ? P.tilde(bundle) : 'unset'}, not transport v2 (D24; a hook must not depend on PATH): steward projects onboard ${where}`);
    if (/AQE_HOOK_BUNDLE=[^ ]*transports\/v1/.test(hooks)) out('WARN', `AQE hooks set transport v1 inline, which overrides settings.local.json: steward projects onboard ${where} --replace-older`);
  }
  if (/npx agentic-qe hooks/.test(hooks)) out('DRIFT', `AQE hooks run \`npx agentic-qe hooks …\`, an unpinned fetch on every hook: steward projects onboard ${where} --replace-older`);
  // What the project already breaks on the keep-off list (ai-tooling.toml [[keep_off]] entries with a value).
  if (ev.ruflo.length || ev.aqe.length || ev.brain.length) {
    const files = { settings: settings['.claude/settings.json'], settings_local: settings['.claude/settings.local.json'], mcp: P.readJSON(path.join(f.path, '.mcp.json')), codex: P.toml(path.join(f.path, '.codex', 'config.toml')) };
    for (const k of policy.keep_off || []) {
      if (!('value' in k) || k.key === 'claudeFlow.daemon.autoStart') continue; // autoStart has its own check below
      const v = String(k.key).split('.').reduce((o, x) => (o && typeof o === 'object' ? o[x] : undefined), files[k.file]);
      if (v !== undefined && JSON.stringify(v) !== JSON.stringify(k.value)) out('DRIFT', `keep-off: ${k.file} ${k.key} = ${JSON.stringify(v)} (${k.why})${declared && declared.length ? `: steward projects onboard ${where} --fix-keep-off` : ''}`);
    }
  }
  if (ev.ruflo.length) {
    const s = settings['.claude/settings.json'];
    const auto = s && s.claudeFlow && s.claudeFlow.daemon && s.claudeFlow.daemon.autoStart;
    if (auto !== false) out(expected.includes('ruflo') ? 'DRIFT' : 'WARN', `Ruflo present but .claude/settings.json claudeFlow.daemon.autoStart is ${auto === undefined ? 'unset' : auto}`);
  }
}

// Launchers pinned to a version-specific install folder: they keep running that version after upgrades (a pinned
// pre-patch Node misses its security fixes) and break when it's pruned. Stable alternatives: node/<major>/…,
// npm-<tool>/<major.minor>/….
{
  st.detail('launchers pinned to a version');
  const pins = require('../../lib/pins.js').scan({ detail: d => st.detail(`launchers pinned to a version: ${d}`) });
  const active = sh('bash', ['-lc', 'node -p process.versions.node']);
  const byInstall = {};
  for (const h of pins.filter(h => h.permissionOnly)) say('info', 'pinned launchers', `${P.tilde(h.file)}: ${h.file.endsWith('.claude.json') ? 'a history entry' : 'a permission rule'} names ${P.tilde(h.install)}${h.exists ? '' : ' (no longer installed)'}; it launches nothing`);
  for (const h of pins.filter(h => !h.permissionOnly)) (byInstall[h.install] = byInstall[h.install] || []).push(h);
  for (const [install, hs] of Object.entries(byInstall)) {
    const v = path.basename(install), tool = path.basename(path.dirname(install));
    const stale = tool === 'node' && v !== active;
    const refs = hs.reduce((a, h) => a + h.count, 0);
    say(hs.some(h => !h.exists) ? 'DRIFT' : stale ? 'DRIFT' : 'WARN', 'pinned launchers',
      `${hs.length} file(s), ${refs} reference(s) → ${P.tilde(install)}${hs[0].alias ? ` (a link to ${path.basename(hs[0].target)}, which prune would remove)` : ''}${hs.some(h => !h.exists) ? ' (MISSING: broken)' : stale ? ` (not the active Node ${active})` : ''}; e.g. ${P.tilde(hs[0].file)}`);
  }
  if (!pins.some(h => !h.permissionOnly)) say('ok', 'pinned launchers', 'no launcher config, AQE hook shim or AQE runtime script points into a version-specific install');
}

// Launcher targets that don't exist. Stable paths (node/26/…, npm-ruvector/0.3/…) survive prunes but not a
// layout change inside a new version, and a missing memory-package.json distPath makes the Ruflo memory hook
// fall back without saying so. Check after every upgrade, Node patch, hybrid install or repin.
{
  st.detail('launcher targets');
  const missing = require('../../lib/pins.js').targets({ detail: d => st.detail(`launcher targets: ${d}`) });
  const byTarget = {};
  for (const m of missing) (byTarget[m.target] = byTarget[m.target] || []).push(m.file);
  for (const [target, files] of Object.entries(byTarget)) {
    const hook = files.every(f => f.endsWith('memory-package.json')) ? ' (the Ruflo memory hook falls back silently)' : '';
    say('DRIFT', 'launcher targets', `${files.length} config file(s) → ${P.tilde(target)}, which doesn't exist${hook}; e.g. ${P.tilde(files[0])}`);
  }
  if (!missing.length) say('ok', 'launcher targets', 'every install path a launcher config names exists');
}

// A Codex tool the policy says must ask is auto-approved, or a server launches a bare node (D37).
if (codexApprovals.files) say('DRIFT', 'codex approvals', `${codexApprovals.files} project .codex/config.toml file(s) set ${codexApprovals.settings} Codex MCP setting(s) off the policy (Brain's ruvnet_cli_run auto-approved, or a bare node launcher): steward ai approvals`);
else say('ok', 'codex approvals', 'every Codex MCP setting the policy names is as it says');

// Claude Code reads a hook's timeout in seconds; Ruflo writes milliseconds (5000 is 83 minutes).
if (msTimeouts.files) say('DRIFT', 'hook timeouts', `${msTimeouts.files} project settings file(s) set ${msTimeouts.hooks} hook timeout(s) in milliseconds (the field is seconds; 5000 means 83 minutes): steward ai timeouts`);
else say('ok', 'hook timeouts', 'every hook timeout is in seconds');

st.done(`${all.length} project(s)`);

// ---- report -----------------------------------------------------------------------------------------------
// No process.exit after output: a pipe is written asynchronously and would be cut off.
if (asJSON) console.log(JSON.stringify(results, null, 1));
else report();

// report() — the results by area, then the summary
function report() {
  const color = { DRIFT: '\x1b[1;31mDRIFT\x1b[0m', WARN: '\x1b[1;33mWARN \x1b[0m', info: '\x1b[2minfo \x1b[0m', ok: '\x1b[32mok   \x1b[0m' };
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\x1b[1;34m==>\x1b[0m ${area}`); }
    console.log(`  ${color[r.level]} ${r.msg}`);
  }
  const tally = l => results.filter(r => r.level === l).length;
  const dec = reg.reduce((m, r) => (m[r.decision] = (m[r.decision] || 0) + 1, m), {});
  console.log(`\x1b[1;34m==>\x1b[0m Summary: ${tally('DRIFT')} drift, ${tally('WARN')} warning(s) across ${all.length} project(s) (${Object.entries(dec).map(([k, v]) => `${v} ${k}`).join(', ')}; worktrees: ${P.WORKTREES}). Nothing was changed.`);
}
