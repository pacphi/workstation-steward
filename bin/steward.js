#!/usr/bin/env node
// steward: the workstation-steward client (D39, D40). It runs every user command from one list (lib/commands.js),
// each from its area's folder, so a command behaves the same however the engine was installed (npm, mise, a clone).
// Built in: version, init, check, help. With no arguments: the one-line notices (new projects, soak, review due),
// then help. The engine finds your config: $STEWARD_INSTANCE, else its own folder when it holds a steward.toml,
// else ~/.config/workstation-steward (`steward config` says which). docs/lifecycle.md is the contract.
// Two channels (D41): `steward` runs a pinned release, `steward-dev` a working clone. The launcher says which
// ($STEWARD_CHANNEL); without one, an install with no .git is a release and a Git checkout is dev. A dev build uses
// examples/ and its own state unless given --real or a $STEWARD_INSTANCE; with your real config, a command that can
// change things first names the dev build, and nothing may leave your config in a format the release can't read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = path.resolve(__dirname, '..');
const CHANNEL = process.env.STEWARD_CHANNEL || (fs.existsSync(path.join(ENGINE, '.git')) ? 'dev' : 'release');
const REAL = process.argv.includes('--real');
const argv = process.argv.slice(2).filter(a => a !== '--real');
// A dev build's own sandbox: the examples and a separate state folder, so feature work never touches your config or
// receipts. Set before the config module loads (it finds the instance once). `init` makes a config, so it is exempt.
const SANDBOX = CHANNEL === 'dev' && !REAL && !process.env.STEWARD_INSTANCE && argv[0] !== 'init';
if (SANDBOX) {
  process.env.STEWARD_INSTANCE = path.join(ENGINE, 'examples');
  process.env.XDG_STATE_HOME = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'workstation-steward-dev');
}
const C = require('../lib/config.js');
const K = require('../lib/commands.js');
const { AREAS, COMMANDS, find } = K;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = s => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = s => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const die = (msg, code = 2) => { console.error(`steward: ${msg}`); process.exit(code); };
// load() — the effective config, or a clear stop (a $STEWARD_INSTANCE without a steward.toml, an unreadable file)
const load = () => { try { return C.load(); } catch (e) { return die(e.message); } };
// report() — the same for the commands that report on the config: no steward.toml yet is something to say, not a stop
const report = () => { try { return C.load({ allowMissing: true }); } catch (e) { return die(e.message); } };

// help(words, o) — the everyday commands, then "N more"; o.all: every command under its group's heading (everyday
// first, then advanced, dimmed), each marked read-only or writes, and the old names at the end (o.internal adds the
// internal ones); an area (`steward help sc`, `steward sc`): that group the same way; a command: the one entry
function help(words = [], o = {}) {
  const cfg = (() => { try { return C.load(); } catch { return null; } })();
  const off = p => (p && cfg && !cfg.values.profiles[p] ? dim(`  (off: steward.toml [profiles] ${p} = false)`) : '');
  const name = c => `steward${c.area ? ` ${c.area}` : ''}${c.name ? ` ${c.name}` : ''}`;
  const mark = c => (c.writes ? 'writes' : 'read-only');
  const line = c => `  ${name(c)}${c.usage ? ` ${c.usage}` : ''}  ${mark(c)}`;
  const head = () => console.log(`${bold('steward')} ${C.ENGINE_VERSION}: keeps this machine's software supply chain current within policy.`);
  if (words.length && !(words.length === 1 && words[0] in AREAS)) {
    const hit = find(words);
    if (!hit || hit.args.length) die(`no command "${words.join(' ')}"; steward help --all lists them`);
    const c = hit.cmd;
    const back = c.undo || (c.usage && c.usage.includes('--rollback') ? `${name(c)} --rollback <receipt> (the receipt its run printed)` : '');
    console.log(`${bold(name(c))}${c.usage ? ` ${c.usage}` : ''}
  ${c.desc}`);
    console.log(`  ${c.writes ? `writes: shows its plan and asks first${c.class ? ` (class ${c.class})` : ' (a person runs it)'}` : 'read-only: changes nothing'}${off(c.profile)}`);
    if (back) console.log(`  way back: ${back}`);
    if (c.parent) console.log(`  part of: steward ${c.parent} (runs it with the others, one yes for all)`);
    const kids = COMMANDS.filter(x => x.parent === K.key(c)).map(name);
    if (kids.length) console.log(`  runs: ${kids.join(', ')}`);
    const olds = COMMANDS.filter(x => x.aliasOf && find(x.aliasOf.split(' ')).cmd === c);
    for (const x of olds) console.log(`  old name: ${name(x)} (still works)`);
    return;
  }
  head();
  const area = words[0];
  if (!area && !o.all) {
    console.log(`Usage: steward <command> [args]   ${dim('(writes: shows its plan and asks first)')}\n`);
    const ev = K.everyday();
    const w = Math.max(...ev.map(c => name(c).length));
    // a command whose add-on is off says so in place of when to use it
    const gated = c => c.profile && cfg && !cfg.values.profiles[c.profile];
    for (const c of ev) console.log(`  ${name(c).padEnd(w)}  ${gated(c) ? dim(`off: set [profiles] ${c.profile} = true in steward.toml to use it`) : c.when}`);
    console.log(`\n${K.listed(o).filter(c => c.tier !== 'everyday').length} more for specific jobs: steward help --all   ${dim('(steward help <command> for one)')}`);
    return;
  }
  console.log(`Usage: steward <area> <command> [args]   ${dim('(writes: shows its plan and asks first)')}`);
  const group = area && (K.AREA_GROUP[area] || area);
  for (const [g, title] of Object.entries(K.GROUPS)) {
    if (group && g !== group) continue;
    const cs = K.listed(o).filter(c => c.group === g);
    const gate = (cs.find(c => c.area && c.profile) || {}).profile;
    console.log(`\n${bold(title)}${off(gate)}`);
    for (const c of [...cs.filter(x => x.tier === 'everyday'), ...cs.filter(x => x.tier !== 'everyday')]) {
      const adv = c.tier !== 'everyday';
      console.log(adv ? dim(line(c)) : line(c));
      console.log(`      ${dim(c.desc)}`);
    }
  }
  const olds = COMMANDS.filter(c => c.aliasOf && (!group || c.group === group));
  if (olds.length) {
    console.log(`\n${bold('Old names that still work')} ${dim('(each prints its new name)')}`);
    for (const c of olds) console.log(`  ${name(c)} → steward ${c.aliasOf}`);
  }
  if (!o.internal && K.listed({ internal: true }).length > K.listed(o).length) console.log(dim('\nInternal commands, for Claude Code and the engine: steward help --all --internal'));
  if (!area && CHANNEL === 'dev') console.log(dim('steward-dev only: add --real to use your real config instead of the examples (D41)'));
}

// build() — what is running, in words: "release 0.1.0 (npm)" or "dev main@1ffa0ee (+2 uncommitted)"
function build() {
  const git = (...a) => { const r = spawnSync('git', ['-C', ENGINE, ...a], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
  if (!fs.existsSync(path.join(ENGINE, '.git'))) return `${CHANNEL} ${C.ENGINE_VERSION} (npm)`;
  const at = git('describe', '--tags', '--exact-match') || `${git('rev-parse', '--abbrev-ref', 'HEAD')}@${git('rev-parse', '--short', 'HEAD')}`;
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean).length;
  return `${CHANNEL} ${C.ENGINE_VERSION} (${at}${dirty ? `, +${dirty} uncommitted` : ''})`;
}

// releaseReads() — { where, version, reads } for the pinned release a dev build answers to, or null when there is none:
// $STEWARD_RELEASE (the dev launcher sets it), else the default release checkout. The hook `steward migrate` uses (D41).
function releaseReads() {
  const where = process.env.STEWARD_RELEASE || path.join(os.homedir(), '.local', 'share', 'workstation-steward', 'release');
  const mod = path.join(where, 'lib', 'config.js');
  if (CHANNEL !== 'dev' || !fs.existsSync(mod)) return null;
  const r = spawnSync(process.execPath, ['-e', 'const c = require(process.argv[1]); console.log(JSON.stringify({ v: c.ENGINE_VERSION || "?", s: c.SCHEMA || { READS: [1] } }))', mod], { encoding: 'utf8' });
  try { const j = JSON.parse(r.stdout); return { where, version: j.v, reads: j.s.READS }; } catch { return null; }
}

function version() {
  const cfg = report();
  console.log(`workstation-steward ${build()} on node ${process.versions.node}`);
  if (SANDBOX) console.log(dim('dev build: using examples/ and its own state; add --real to use your config'));
  console.log(`engine:   ${C.tilde(ENGINE)}`);
  console.log(`instance: ${C.tilde(C.INSTANCE_ROOT)}   [${C.INSTANCE.source}]${fs.existsSync(cfg.file) ? '' : '  (no steward.toml yet: steward init)'}`);
  const fmt = !fs.existsSync(cfg.file) ? 'none yet' : `schema ${cfg.schema}${cfg.schemaGiven ? '' : ' (no schema line: format 1)'}`;
  console.log(`format:   ${fmt}; this release writes ${C.SCHEMA.CURRENT} and reads ${C.SCHEMA.READS.join(', ')}`);
}

// basics(cfg) — {ok, wants}: the lines check and doctor share, about the config's format and the add-ons
function basics(cfg) {
  const ok = [];
  const wants = [];
  if (!fs.existsSync(cfg.file)) wants.push(`no steward.toml at ${C.tilde(C.INSTANCE_ROOT)}: steward init`);
  for (const e of cfg.errors) wants.push(`steward.toml: ${e} (steward config --check)`);
  if (cfg.schema > C.SCHEMA.CURRENT) wants.push(`your config is format ${cfg.schema}, written by a newer steward; this one reads ${C.SCHEMA.READS.join(', ')}: upgrade the engine`);
  else if (!C.SCHEMA.READS.includes(cfg.schema)) wants.push(`your config is format ${cfg.schema}; this release reads ${C.SCHEMA.READS.join(', ')}: steward migrate`);
  else ok.push(`config format ${cfg.schema}: current${cfg.schemaGiven ? '' : ' (add `schema = 1` at the top of steward.toml to say so)'}`);
  // A dev build answers to the pinned release: your config must stay in a format it reads (D41)
  const rel = !SANDBOX && releaseReads();
  if (rel && !rel.reads.includes(cfg.schema)) wants.push(`the pinned release (${rel.version}, ${C.tilde(rel.where)}) reads formats ${rel.reads.join(', ')}, and your config is ${cfg.schema}: move the release forward before using this config with it`);
  else if (rel) ok.push(`the pinned release (${rel.version}) reads format ${cfg.schema}`);
  ok.push(`add-ons: ${Object.entries(cfg.values.profiles).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ')}`);
  return { ok, wants };
}

// check() — exit 0 when nothing is wanted from you, 1 when something is (each with its command), 2 on an error
function check() {
  const cfg = report();
  console.log(`engine ${C.ENGINE_VERSION}; instance ${C.tilde(C.INSTANCE_ROOT)} [${C.INSTANCE.source}]`);
  const { ok, wants } = basics(cfg);
  for (const l of ok) console.log(`ok     ${l}`);
  // projects a promotion of Ruflo or AQE left behind (D42): needs both add-ons
  if (!wants.length && cfg.values.profiles.projects && cfg.values.profiles.ai_tooling) {
    try {
      const R = require('../lib/reconcile.js');
      const st = require('../lib/progress.js').progress(1).stage('plan every onboarded project against the qualified AI tools');
      const plans = R.all({ each: (i, n, dir) => st.detail(`${i + 1}/${n} ${C.tilde(dir)}`) });
      const late = R.behind(plans);
      st.done(`${plans.length} planned, ${late.length} behind`);
      if (!late.length) console.log(`ok     ${plans.length} onboarded project(s) in step with the qualified AI tools`);
      if (late.length > 3) wants.push(`${late.length} onboarded projects have ${late.reduce((s, b) => s + b.update, 0)} copied unit(s) behind the qualified AI tools: steward projects reconcile --all`);
      else for (const b of late) wants.push(`${b.project}: ${b.update} copied unit(s) behind the qualified AI tools${b.edited ? ` (and ${b.edited} you edited have a newer version)` : ''}: steward projects reconcile ${b.project}`);
    } catch (e) { wants.push(`couldn't check the onboarded projects (${e.message}): steward projects reconcile --all`); }
  }
  for (const w of wants) console.log(`WANTS  ${w}`);
  process.exit(wants.length ? 1 : 0);
}

// files(dir) — every file under dir, relative, sorted
function files(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => {
    const r = path.join(rel, e.name);
    return e.isDirectory() ? files(dir, r) : [r];
  }).sort();
}

async function init(args) {
  if (CHANNEL === 'dev') devBanner('init');
  const yes = args.includes('--yes');
  const given = args.find(a => !a.startsWith('-'));
  const env = process.env.STEWARD_INSTANCE;
  const target = path.resolve(C.untilde(given || env || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'workstation-steward')));
  const src = path.join(ENGINE, 'examples');
  const list = files(src);
  if (fs.existsSync(path.join(target, 'steward.toml'))) die(`a config is already at ${C.tilde(target)}; nothing changed (steward check says what it needs)`, 1);
  const clash = list.filter(f => fs.existsSync(path.join(target, f)));
  if (clash.length) die(`${clash.length} file(s) already exist in ${C.tilde(target)} and init never overwrites: ${clash.slice(0, 5).join(', ')}${clash.length > 5 ? ' …' : ''}`, 1);
  console.log(`steward init: create your config in ${C.tilde(target)} from the examples (${list.length} files):`);
  for (const f of list) console.log(`  create ${f}`);
  if (!yes) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const a = await new Promise(res => rl.question('Create these? [y/N] ', res));
    rl.close();
    if (!/^y(es)?$/i.test(a.trim())) { console.log('Nothing changed.'); return; }
  }
  for (const f of list) {
    fs.mkdirSync(path.dirname(path.join(target, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(target, f), fs.constants.COPYFILE_EXCL);
  }
  // A receipt like every change's; creating a config installs nothing, so it starts no soak (lib/soak.js)
  const state = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'workstation-steward');
  const dir = path.join(state, 'backups', `init-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ kind: 'init', at: new Date().toISOString(), engine: C.ENGINE_VERSION, target, files: list }, null, 1) + '\n');
  const receipt = path.join(dir, 'receipt.json');
  console.log(`Created ${list.length} files. Receipt: ${C.tilde(receipt)}`);
  // Where the steward will look from now on (with this new steward.toml in place); say so if it isn't here
  if (C.resolveInstance().root !== target) console.log(`The steward doesn't look here by default: export STEWARD_INSTANCE=${C.tilde(target)}`);
  // The rest of setup, asked of a person in their own terminal (only a person can accept the skills plugin's command,
  // D48); without one, the same choices are lines in steward.toml
  const interactive = !yes && process.stdin.isTTY && !process.env.CLAUDECODE;
  const set = interactive ? await walkSetup(target) : [];
  if (set.length) fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt, 'utf8')), set }, null, 1) + '\n');
  const toml = C.tilde(path.join(target, 'steward.toml'));
  console.log(`Next:\n  steward doctor             what this machine still needs\n  DRY_RUN=1 steward sc link  then steward sc link: point ~/.config/mise at this config's mise/`);
  if (!interactive) console.log(`  edit ${toml}: your roots, [profiles] to turn on AI tooling or projects, [skills] for PR consolidation\n  steward skills install     the Claude Code skills, for you or --project <path> (from your own terminal)`);
}

// walkSetup(target) — the rest of setup, asked in this terminal (lib/setup.js), then `steward skills install` when
// chosen, which shows its plan and asks again. Returns what it set in steward.toml, for the receipt.
async function walkSetup(target) {
  const file = path.join(target, 'steward.toml');
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const ask = s => new Promise(res => rl.question(s, res));
  const { set, install } = await require('../lib/setup.js').walkSetup(file, ask).finally(() => rl.close());
  if (set.length) console.log(`Set in ${C.tilde(file)}: ${set.join('; ')}`);
  if (install) {
    spawnSync(process.execPath, [path.join(ENGINE, 'lib', 'skills.js'), 'install', ...(install.project ? ['--project', install.project] : [])],
      { cwd: ENGINE, stdio: 'inherit', env: { ...process.env, STEWARD_INSTANCE: target, STEWARD_CWD: process.cwd() } });
  } else console.log('Later: steward skills install [--project <path>]; [skills] pr_consolidation in steward.toml adds PR consolidation');
  return set;
}

// unattendedEnv(cmd, args, yesTo) — the environment for a run with --unattended (D58), or a stop. A read-only command
// needs nothing. A writing command must take the flag (commands.js unattended) and its class, or rollback's, must be
// one [autonomy] allows or one the user said yes to for this run (--yes-to <class>, D59); then the command answers its
// own questions, each checked again by its own class (lib/autonomy.js answer). A refusal exits 4, so the runner can
// tell "waiting on you" from "failed"
function unattendedEnv(cmd, args, yesTo = []) {
  const A = require('../lib/autonomy.js');
  const name = `steward ${cmd.area ? `${cmd.area} ` : ''}${cmd.name}`;
  const refuse = why => { console.error(`steward: not running "${name}" unattended: ${why}. Nothing changed; run it yourself to answer its questions.`); process.exit(A.REFUSED); };
  // doctor reads, and installs only with --install (an install: it asks at every level)
  if (!cmd.writes && !(cmd.area === '' && cmd.name === 'doctor' && args.includes('--install'))) return {};
  if (!cmd.writes) refuse("it doesn't run unattended yet");
  if (!cmd.class) refuse('a person runs this one');
  if (!cmd.unattended) refuse("it doesn't run unattended yet");
  const r = A.check(args.includes('--rollback') ? 'rollback' : cmd.class, load().values.autonomy, yesTo);
  if (!r.ok) refuse(r.why);
  return { STEWARD_UNATTENDED: '1', ...(yesTo.length ? { STEWARD_YES_TO: yesTo.join(',') } : {}) };
}

function run(cmd, args) {
  const unattended = args.includes('--unattended');
  args = args.filter(a => a !== '--unattended');
  // --yes-to <class>, any number of times: the user's yes for this run, only with --unattended (D59). A runner
  // (steward fix) reads its own: it passes each to the one step it was given for
  const yesTo = [];
  for (let i = cmd.runner ? -1 : args.indexOf('--yes-to'); i >= 0; i = args.indexOf('--yes-to')) {
    const c = args[i + 1];
    if (!c || !(c in require('../lib/autonomy.js').CLASSES)) die(`--yes-to takes a class (steward config lists them), got ${c === undefined ? 'nothing' : `"${c}"`}`);
    yesTo.push(c);
    args.splice(i, 2);
  }
  if (yesTo.length && !unattended) die('--yes-to goes with --unattended');
  const words = args.filter(a => !a.startsWith('-'));
  if (words.length < (cmd.min || 0)) die(`usage: steward ${cmd.area ? `${cmd.area} ` : ''}${cmd.name} ${cmd.usage}`);
  // A config in a format this engine doesn't read is refused, not half-read: an older engine on a newer config could
  // silently skip checks (R3b found an older release reading a trimmed host.toml with no IOCs at all). config and doctor
  // are top-level and stay available to help fix it.
  const fmt = cmd.area ? load() : null;
  if (fmt && fs.existsSync(fmt.file) && !C.SCHEMA.READS.includes(fmt.schema)) {
    die(`your config is format ${fmt.schema}; this engine (${C.ENGINE_VERSION}) reads ${C.SCHEMA.READS.join(', ')}. ${fmt.schema > C.SCHEMA.CURRENT ? 'Upgrade the engine' : 'Run steward migrate'} first (steward check says more)`, 1);
  }
  if (cmd.profile && !load().values.profiles[cmd.profile]) {
    console.error(`The ${cmd.profile.replace('_', ' ')} add-on is off (${C.tilde(load().file)} [profiles] ${cmd.profile} = false). Turn it on there to use these commands.`);
    process.exit(3);
  }
  // never inherited: only this check sets it, for this run
  const env = { ...process.env };
  delete env.STEWARD_UNATTENDED;
  delete env.STEWARD_YES_TO;
  const extra = unattended ? unattendedEnv(cmd, args, yesTo) : {};
  // doctor: the engine and your config first (what version and check say), then the prerequisites; not for --json.
  // It runs on a bare machine to say what is missing, so a config it can't read (no yq yet) is a line, not a stop
  let wanted = 0;
  if (cmd.area === '' && cmd.name === 'doctor' && !args.some(a => a === '--json' || a === '--markdown')) {
    console.log(`workstation-steward ${build()} on node ${process.versions.node}`);
    console.log(`instance: ${C.tilde(C.INSTANCE_ROOT)}   [${C.INSTANCE.source}]`);
    let cfg = null;
    let why = '';
    try { cfg = C.load({ allowMissing: true }); } catch (e) { why = e.message; }
    const { ok, wants } = cfg ? basics(cfg) : { ok: [], wants: [`couldn't read your config (${why}); the prerequisites below may be why`] };
    for (const l of ok) console.log(`ok     ${l}`);
    for (const l of wants) console.log(`WANTS  ${l}`);
    wanted = wants.length;
    console.log('');
  }
  if (CHANNEL === 'dev' && !SANDBOX && cmd.writes) devBanner(`${cmd.area ? `${cmd.area} ` : ''}${cmd.name}`);
  const cwd = path.join(ENGINE, cmd.cwd);
  const [exe, ...rest] = cmd.run;
  const bin = exe === 'node' ? process.execPath : path.join(cwd, exe);
  const r = spawnSync(bin, [...rest, ...args], { cwd, stdio: 'inherit', env: { ...env, ...(cmd.env || {}), ...extra, STEWARD_CWD: process.cwd() } });
  if (r.error) die(`${cmd.run.join(' ')}: ${r.error.message}`);
  process.exit(r.status === null ? 1 : r.status || (wanted ? 1 : 0));
}

// devBanner(what) — before a dev build runs a command that can change things against a real config
function devBanner(what) {
  const line = `DEV BUILD ${build()} is about to run "${what}" against ${C.tilde(C.INSTANCE_ROOT)}. Its plan and question come next.`;
  console.error(tty ? `\x1b[1;35m${line}\x1b[0m` : line);
}

// banners() — what bare `steward` says before the help: the briefing (lib/brief.js), one process and no network. It
// replaced five banners (new projects, projects behind, soak, review due, config repo), one of which walked every
// project root on each run; the briefing covers each of them and names the one next step
function banners() {
  spawnSync(process.execPath, ['lib/brief.js', '--banner'], { cwd: ENGINE, stdio: 'inherit' });
}

(async () => {
  const [first, ...rest] = argv;
  if (!first) { banners(); return help(); }
  if (first === 'help' || first === '--help' || first === '-h') {
    return help(rest.filter(a => !a.startsWith('-')), { all: rest.includes('--all'), internal: rest.includes('--internal') });
  }
  if (first === 'version' || first === '--version' || first === '-v') return version();
  if (first === 'check') return check();
  if (first === 'init') return init(rest);
  const hit = find(argv);
  // an old name: one line on stderr (stdout may be --json), then its new form
  if (hit && hit.alias) console.error(`steward: "steward ${K.key(hit.alias)}" is now "steward ${hit.alias.aliasOf}"; the old name keeps working.`);
  if (hit) return run(hit.cmd, hit.args);
  if (first in AREAS) { if (rest[0]) console.error(`steward: no command "${first} ${rest[0]}"\n`); help([first]); process.exit(rest[0] ? 2 : 0); }
  die(`no command "${argv.join(' ')}"; steward help lists them`);
})();
