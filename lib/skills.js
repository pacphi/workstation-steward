#!/usr/bin/env node
// The steward's Claude Code skills as a plugin (D48). The marketplace (.claude-plugin/marketplace.json, shipped with
// the engine) lists one plugin, `steward`, whose source is a command: `steward skills path`. Claude Code runs it once per session
// and copies the folder it prints, so the skills always match the installed (age-gated) engine, and hold only what
// this config turns on: supply-chain and fix always, ai-tooling and projects with their add-ons, pr-consolidation with
// [skills] pr_consolidation. Its manifest is generated: it carries one read-only SessionStart hook,
// `steward brief --hook` (docs/briefing.md), unless [brief] session = false leaves it out.
// Usage: skills.js path                                  build the plugin folder; print its absolute path (one line)
//        skills.js install [--project <path>] [--yes]    plan, ask, then `claude plugin install` (user or local scope)
//        skills.js uninstall [--project <path>] [--yes]  plan, ask, then `claude plugin uninstall`
// Install and uninstall back up the Claude Code settings they touch and write a receipt; each is the other's undo.
// Install registers the INSTALLED engine's own marketplace file (copied to a fixed folder under the state folder), never
// one fetched from GitHub: the command it accepts on the user's yes is exactly the one this age-gated release ships.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const C = require('./config.js');

const PLUGIN = 'steward';
const MARKETPLACE = 'workstation-steward';   // the name in .claude-plugin/marketplace.json
const ID = `${PLUGIN}@${MARKETPLACE}`;
const SHIPPED = path.join(C.REPO_ROOT, '.claude-plugin', 'marketplace.json');
// marketplaceDir(values) — where install puts its copy of the shipped marketplace: a path that stays put across upgrades
const marketplaceDir = values => path.join(values.paths.state, 'skills', 'marketplace');
// `claude plugin install <name> --marketplace <source>` arrived in 2.1.292; command sources need 2.1.229
const MIN_CLAUDE = '2.1.292';
// The session-start hook: a new session (startup), /clear and a compaction; never resume or fork. timeout is in
// seconds; the briefing's own watchdog stops at 1.5 s. Without a steward on PATH it does nothing, quietly.
const HOOK_MATCHER = 'startup|clear|compact';
const HOOK_TIMEOUT = 5;
const hookCommand = (steward, extra = '') => `command -v ${steward} >/dev/null 2>&1 && ${steward} brief --hook${extra} || true`;
const HOOK_COMMAND = hookCommand('steward');
const SKILLS = [
  { name: 'supply-chain', on: () => true },
  { name: 'fix', on: () => true },
  { name: 'ai-tooling', on: v => v.profiles.ai_tooling },
  { name: 'projects', on: v => v.profiles.projects },
  { name: 'pr-consolidation', on: v => v.skills.pr_consolidation },
];

const die = (msg, code = 2) => { console.error(`steward skills: ${msg}`); process.exit(code); };
const chosen = values => SKILLS.filter(s => s.on(values)).map(s => s.name);

// files(dir, rel) — every file under dir, relative, sorted
function files(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => {
    const r = path.join(rel, e.name);
    return e.isDirectory() ? files(dir, r) : [r];
  }).sort();
}

// manifest(values, channel) — the plugin's plugin.json: the shipped one's metadata, and the session-start hook unless
// [brief] session = false. A dev clone's build (`steward-dev skills path`) calls steward-dev instead, so the maintainer
// can try the hook before a release has it: with --real unless the clone's own examples are the instance
function manifest(values, channel = require('./brief.js').channelOf()) {
  const m = JSON.parse(fs.readFileSync(path.join(C.REPO_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  delete m.hooks;
  if (values.brief.session) {
    const command = channel === 'dev' ? hookCommand('steward-dev', C.INSTANCE_ROOT === path.join(C.REPO_ROOT, 'examples') ? '' : ' --real') : HOOK_COMMAND;
    m.hooks = { SessionStart: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }] }] };
  }
  return `${JSON.stringify(m, null, 2)}\n`;
}

// build(values) — the plugin folder for these values: <state>/skills/<hash of its content>. The same content gives
// the same folder, so a session that is still copying one is never disturbed; older folders beyond the last few go.
function build(values) {
  /** @type {[string, Buffer, number][]} */
  const parts = [['.claude-plugin/plugin.json', Buffer.from(manifest(values)), 0o644]];
  for (const n of chosen(values)) {
    const dir = path.join(C.REPO_ROOT, 'skills', n);
    for (const f of files(dir)) parts.push([path.join('skills', n, f), fs.readFileSync(path.join(dir, f)), fs.statSync(path.join(dir, f)).mode & 0o777]);
  }
  const h = crypto.createHash('sha256');
  for (const [rel, data, mode] of parts) h.update(`${rel}\0${mode & 0o111 ? 'x' : '-'}\0`).update(data).update('\0');
  const root = path.join(values.paths.state, 'skills');
  const out = path.join(root, h.digest('hex').slice(0, 16));
  if (!fs.existsSync(out)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(root, '.tmp-'));
    for (const [rel, data, mode] of parts) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), data);
      fs.chmodSync(path.join(tmp, rel), mode);
    }
    try { fs.renameSync(tmp, out); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); if (!fs.existsSync(out)) throw e; }
  }
  const now = Date.now();
  fs.utimesSync(out, now / 1000, now / 1000);
  const old = fs.readdirSync(root).filter(d => /^[0-9a-f]{16}$/.test(d) && path.join(root, d) !== out)
    .map(d => ({ d, t: fs.statSync(path.join(root, d)).mtimeMs })).sort((a, b) => b.t - a.t).slice(2);
  for (const { d } of old) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  return out;
}

// claudeVersion() — the installed Claude Code's version as [major, minor, patch], or null when there is none
function claudeVersion() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  const m = r.status === 0 && r.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}
const atLeast = (v, min) => { const w = min.split('.').map(Number); for (let i = 0; i < 3; i++) if (v[i] !== w[i]) return v[i] > w[i]; return true; };

// projectProblem(dir) — why the steward may not write this project's local Claude settings (D6), or null
function projectProblem(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `${C.tilde(dir)} is not a folder`;
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  if (git('rev-parse', '--git-dir').status !== 0) return null;
  if (git('ls-files', '--error-unmatch', '.claude/settings.local.json').status === 0) return `${C.tilde(dir)}/.claude/settings.local.json is tracked by Git; change it through a PR instead (D6)`;
  const merge = git('rev-parse', '--git-path', 'MERGE_HEAD').stdout.trim();
  if (merge && fs.existsSync(path.resolve(dir, merge))) return `${C.tilde(dir)} is in the middle of a merge`;
  return null;
}

// pathProblem() — why Claude Code couldn't run `steward skills path` the way it will (sh, from home), or null
function pathProblem() {
  const r = spawnSync('sh', ['-c', 'steward skills path'], { cwd: C.HOME, encoding: 'utf8' });
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  if (r.status === 0 && lines.length === 1 && fs.existsSync(lines[0]) && fs.statSync(lines[0]).isDirectory()) return null;
  return `\`steward skills path\` didn't print the plugin's folder when run the way Claude Code runs it (sh, from your home folder): ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}, ${lines.length} line(s)`}. The \`steward\` on PATH must be this release or newer (docs/lifecycle.md, Install and set up)`;
}

// installed(cwd) — whether Claude Code lists the plugin (as seen from cwd, so a project's local scope counts)
function installed(cwd) {
  const r = spawnSync('claude', ['plugin', 'list', '--json'], { cwd, encoding: 'utf8' });
  let list = [];
  try { list = JSON.parse(r.stdout); } catch { return false; }
  return Array.isArray(list) && list.some(p => p && p.id === ID && p.enabled !== false);
}

async function ask(q) {
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(q, res));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

// change('install' | 'uninstall', args) — the plan, the user's yes, a backup and a receipt, then Claude Code's command
async function change(what, args) {
  const values = C.load().values;
  const i = args.indexOf('--project');
  const project = i >= 0 ? C.userPath(args[i + 1] || die('--project needs a folder')) : null;
  const yes = args.includes('--yes');
  const scope = project ? 'local' : 'user';
  const mdir = marketplaceDir(values);
  const accepted = JSON.parse(fs.readFileSync(SHIPPED, 'utf8')).plugins.find(p => p.name === PLUGIN).source.command;
  const cmd = what === 'install'
    ? ['plugin', 'install', PLUGIN, '--marketplace', mdir, '--scope', scope, '--yes']
    : ['plugin', 'uninstall', ID, '--scope', scope];
  const settings = [path.join(values.paths.claude_dir, 'settings.json'), ...(project ? [path.join(project, '.claude', 'settings.local.json')] : [])];

  console.log(`steward skills ${what}: the steward's Claude Code skills, ${project ? `only in sessions started in ${C.tilde(project)} (Claude's local scope)` : "in every Claude Code session you start, in any folder (Claude's user scope)"}`);
  if (what === 'install') {
    console.log(`  skills:   ${chosen(values).join(', ')} (from your add-ons)`);
    console.log(`  accepts:  the plugin's command \`${accepted}\`, which Claude Code runs each session (from this release's own`);
    console.log(`            marketplace file, copied to ${C.tilde(mdir)}; nothing is fetched)`);
    console.log(`  hook:     ${values.brief.session ? 'a read-only session-start briefing (`steward brief --hook`): what needs you, once, then quiet;\n            `[brief] session = false` in steward.toml turns it off' : 'none (`[brief] session = false` in steward.toml)'}`);
  }
  console.log(`  runs:     claude ${cmd.join(' ')}${project ? `   (in ${C.tilde(project)})` : ''}`);
  console.log(`  changes:  ${settings.map(C.tilde).join(', ')}, ${C.tilde(path.join(values.paths.claude_dir, 'plugins'))}/`);
  console.log(`  undo:     steward skills ${what === 'install' ? 'uninstall' : 'install'}${project ? ` --project ${C.tilde(project)}` : ''}`);

  const v = claudeVersion();
  if (!v) die('Claude Code (`claude`) is not on PATH; install it, then run this again', 1);
  if (!atLeast(v, MIN_CLAUDE)) die(`Claude Code ${v.join('.')} is older than ${MIN_CLAUDE}; update it, then run this again`, 1);
  if (project) { const p = projectProblem(project); if (p) die(p, 1); }
  if (what === 'install') {
    const p = pathProblem();
    if (p) die(p, 1);
    // Claude Code takes a plugin's command only from a person: inside a session it ignores --yes (it asks for review)
    if (process.env.CLAUDECODE) die(`Claude Code accepts a plugin's command only from your own terminal. Run there: steward skills install${project ? ` --project ${C.tilde(project)}` : ''}`, 3);
  }
  if (process.env.DRY_RUN === '1') { console.log('DRY_RUN=1: nothing changed.'); return; }
  if (!yes && !(await ask(`${what === 'install' ? 'Install' : 'Uninstall'}? [y/N] `))) { console.log('Nothing changed.'); return; }

  if (what === 'install') {
    fs.mkdirSync(path.join(mdir, '.claude-plugin'), { recursive: true, mode: 0o700 });
    fs.copyFileSync(SHIPPED, path.join(mdir, '.claude-plugin', 'marketplace.json'));
  }
  const dir = C.newBackupDir(`skills-${what}`);
  const saved = settings.filter(f => fs.existsSync(f)).map((f, n) => {
    const to = path.join(dir, `${n}-${path.basename(f)}`);
    fs.copyFileSync(f, to);
    return { file: f, backup: to };
  });
  const r = spawnSync('claude', cmd, { cwd: project || C.HOME, stdio: 'inherit' });
  const receipt = { kind: `skills-${what}`, at: new Date().toISOString(), engine: C.ENGINE_VERSION, scope, project, command: ['claude', ...cmd], status: r.status, saved };
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 1) + '\n');
  console.log(`Receipt: ${C.tilde(path.join(dir, 'receipt.json'))}`);
  if (r.status !== 0) die(`claude exited ${r.status}; the settings files as they were are in ${C.tilde(dir)}`, 1);
  // claude can exit 0 without installing (a command it didn't accept): believe the list, not the exit code
  if (installed(project || C.HOME) !== (what === 'install')) die(`claude plugin list ${what === 'install' ? "doesn't show" : 'still shows'} ${ID}; see claude's output above. The settings files as they were are in ${C.tilde(dir)}`, 1);
  console.log(what === 'install' ? `Installed: ${ID}. A new Claude Code session loads /steward:${chosen(values)[0]} and the rest.` : `Uninstalled: ${ID}.`);
}

if (require.main === module) {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === 'path') {
    try { console.log(build(C.load().values)); } catch (e) { die(e.message, 1); }
  } else if (verb === 'install' || verb === 'uninstall') {
    change(verb, args).catch(e => die(e.message, 1));
  } else die('usage: skills.js path | install [--project <path>] [--yes] | uninstall [--project <path>] [--yes]');
}

module.exports = { build, manifest, chosen, projectProblem, atLeast, marketplaceDir, PLUGIN, MARKETPLACE, ID, HOOK_COMMAND, HOOK_MATCHER, HOOK_TIMEOUT };
