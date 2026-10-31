#!/usr/bin/env node
// Keep this machine's user-level guards (ai-tooling.toml [guards]):
// - the npx ask guard (D27): `permissions.ask` rules in the user's Claude Code settings. Ruflo's and AQE's skill text
//   tells agents to run unpinned `npx` (`@claude-flow/cli@latest`, `@alpha`), and projects' allow rules auto-approve
//   it; a user-level ask rule is evaluated before every project's allow rule, so each such run prompts.
// - the git ignore guard (D28): AI tool output that is never project source (runtime state, learned stores, the
//   launchers onboarding points at this machine's installs), ignored in every repo through the user's git ignore
//   file. The steward owns one marked block there; the owner's own lines are kept and never repeated.
// - the plugin store guard (D29): keys a plugin keeps in its Claude Code store file that must hold one value, such as
//   ruflo-console's own updater (`updates`), which would otherwise offer, or with "Always auto-update" install, every
//   new version from the tip of github.com/ruvnet/ruflo, bypassing qualification and the release-age gate.
// Adds only, except the plugin store keys it names: existing rules, keys and lines are kept. Backup, parse check,
// receipt.
// Usage: guard.js                    plan only: which rules are missing
//        guard.js --apply            plan, ask [y/N], then add them (DRY_RUN=1 stops after the plan)
//        guard.js --rollback <receipt.json>   restore the files it changed (if they're unchanged since)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');
const C = require('../../lib/config.js');

const policy = C.policy('ai-tooling/ai-tooling.toml');
const G = policy.guards;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const BEGIN = '# BEGIN workstation-steward (ai-tooling.toml [guards] git_ignore; `steward ai guard` keeps this block)';
const END = '# END workstation-steward';

// ask(q, cls) — [y/N] on the terminal; under --unattended, [autonomy] answers by the question's class (lib/autonomy.js)
async function ask(q, cls) {
  if (process.env.DRY_RUN === '1') return false;
  if (require('../../lib/autonomy.js').answer(cls, q)) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

// gitIgnoreFile() — the file git reads for user-level ignores: core.excludesFile, else $XDG_CONFIG_HOME/git/ignore
function gitIgnoreFile() {
  let set = '';
  try { set = execFileSync('git', ['config', '--global', '--get', 'core.excludesFile'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* unset */ }
  if (set) return C.untilde(set);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(C.HOME, '.config'), 'git', 'ignore');
}

// Each guard: {name, what, file, text (null when absent), rules, add: [missing rules], next (the new text)}
// A Mac with no Claude Code settings file yet (a fresh one) gets one holding only the rules, as the git ignore guard
// creates its file: the receipt records it didn't exist, so --rollback removes it
function npxAsk() {
  const file = C.untilde(G.npx_ask_file), rules = G.npx_ask || [];
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const j = text === null ? {} : JSON.parse(text);
  const add = rules.filter(r => !(((j.permissions || {}).ask) || []).includes(r));
  let next = text;
  if (add.length) {
    j.permissions = j.permissions || {};
    j.permissions.ask = [...(j.permissions.ask || []), ...add];
    const indent = (text === null ? '' : (text.split('\n')[1] || '').match(/^\s*/)[0]) || '  ';
    next = JSON.stringify(j, null, indent) + (text === null || text.endsWith('\n') ? '\n' : '');
    if (rules.some(r => !JSON.parse(next).permissions.ask.includes(r))) throw new Error('parse check failed: npx ask rules not present after the change');
  }
  return { name: 'npx ask guard', what: `${C.tilde(file)}${text === null ? ' (a new file)' : ''} permissions.ask (ai-tooling.toml [guards] npx_ask)`, file, text, rules, add, next };
}

function gitIgnore() {
  const file = gitIgnoreFile(), want = G.git_ignore || [];
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const lines = (text || '').split('\n');
  const b = lines.indexOf(BEGIN), e = lines.indexOf(END);
  const has = b >= 0 && e > b;
  const outside = has ? [...lines.slice(0, b), ...lines.slice(e + 1)] : lines;
  const inBlock = has ? lines.slice(b + 1, e) : [];
  const rules = want.filter(l => !l.startsWith('#'));
  const mine = new Set(outside.map(l => l.trim()));
  const add = rules.filter(r => !mine.has(r) && !inBlock.includes(r));
  // the block holds every rule the owner's own lines don't already have, with its group comments
  const block = [BEGIN, ...want.filter(l => l.startsWith('#') || !mine.has(l)), END];
  let next = text;
  if (add.length) {
    next = has ? [...lines.slice(0, b), ...block, ...lines.slice(e + 1)].join('\n') : (text ? text.replace(/\n*$/, '\n\n') : '') + block.join('\n') + '\n';
    const n = new Set(next.split('\n').map(l => l.trim()));
    if (rules.some(r => !n.has(r))) throw new Error('check failed: git ignore rules not present after the change');
  }
  return { name: 'git ignore guard', what: `${C.tilde(file)} (ai-tooling.toml [guards] git_ignore)`, file, text, rules, add, next };
}

// storeFiles(glob) — the files matching a `<dir>/<prefix>*.json` pattern (a plugin's store file ends in an install id)
function storeFiles(glob) {
  const g = C.untilde(glob), dir = path.dirname(g), base = path.basename(g);
  const [pre, post] = base.split('*');
  try { return fs.readdirSync(dir).filter(f => f.startsWith(pre) && f.endsWith(post)).map(f => path.join(dir, f)); } catch { return []; }
}

// pluginStore() — one guard per store file a [[guards.plugin_store]] entry matches: its `set` keys, set to their values
function pluginStore() {
  const out = [];
  for (const e of G.plugin_store || []) {
    const files = storeFiles(e.file_glob);
    if (!files.length) { console.log(`  note: ${e.name}: no store file yet (${e.file_glob}); run the guard again after the plugin first loads`); continue; }
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const j = JSON.parse(text);
      const rules = Object.entries(e.set).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
      const add = Object.entries(e.set).filter(([k, v]) => JSON.stringify(j[k]) !== JSON.stringify(v)).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
      let next = text;
      if (add.length) {
        Object.assign(j, e.set);
        const indent = /\n\s+"/.test(text) ? ((text.split('\n')[1] || '').match(/^\s*/)[0] || '  ') : 0;
        next = JSON.stringify(j, null, indent) + (text.endsWith('\n') ? '\n' : '');
        const k = JSON.parse(next);
        if (Object.entries(e.set).some(([key, v]) => JSON.stringify(k[key]) !== JSON.stringify(v))) throw new Error(`parse check failed: ${C.tilde(file)}`);
      }
      out.push({ name: `plugin store guard: ${e.name}`, what: `${C.tilde(file)} (ai-tooling.toml [[guards.plugin_store]])`, file, text, rules, add, next });
    }
  }
  return out;
}

function apply(guards) {
  const dir = C.newBackupDir('guard');
  const receipt = { kind: 'guard', at: new Date().toISOString(), engine: C.ENGINE_VERSION, backup: C.tilde(dir), files: [] };
  Object.assign(receipt, require('../../lib/autonomy.js').mark());   // --unattended (D58), and --yes-to (D59)
  const rp = path.join(dir, 'receipt.json');
  for (const g of guards) {
    const e = { guard: g.name, file: C.tilde(g.file), added: g.add, sha_before: g.text === null ? null : sha(g.text) };
    if (g.text !== null) {
      const bak = path.join(dir, `${receipt.files.length + 1}-${path.basename(g.file)}`);
      fs.copyFileSync(g.file, bak, fs.constants.COPYFILE_EXCL);
      e.backup = C.tilde(bak);
    }
    fs.mkdirSync(path.dirname(g.file), { recursive: true });
    const tmp = `${g.file}.guard-${process.pid}`;
    fs.writeFileSync(tmp, g.next, { mode: g.text === null ? 0o644 : fs.statSync(g.file).mode });
    fs.renameSync(tmp, g.file);
    const after = fs.readFileSync(g.file, 'utf8');
    if (sha(after) !== sha(g.next)) throw new Error(`write check failed: ${g.file}`);
    e.sha_after = sha(after);
    receipt.files.push(e);
    fs.writeFileSync(rp, JSON.stringify(receipt, null, 1) + '\n');
    console.log(`\x1b[1;34m==>\x1b[0m added ${g.add.length} rule(s) to ${C.tilde(g.file)}`);
  }
  console.log(`  receipt ${C.tilde(rp)}; rollback: steward ai guard --rollback ${C.tilde(rp)}`);
  console.log('  Claude Code sessions pick up settings changes; git reads its ignore file on every command.');
}

// A receipt from before the git ignore guard holds one file at its top level.
const receiptFiles = rc => rc.files || [{ file: rc.file, sha_after: rc.sha_after, backup: rc.backup }];

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--rollback')) {
    const receipt = args[args.indexOf('--rollback') + 1];
    if (!receipt || receipt.startsWith('--')) { console.error('usage: --rollback <receipt.json>'); process.exit(2); }
    const files = receiptFiles(JSON.parse(fs.readFileSync(C.userPath(receipt), 'utf8')));
    const changed = files.filter(f => !fs.existsSync(C.untilde(f.file)) || sha(fs.readFileSync(C.untilde(f.file), 'utf8')) !== f.sha_after);
    if (changed.length) { console.error(`refusing: changed since the guard was added: ${changed.map(f => f.file).join(', ')}`); process.exit(1); }
    for (const f of files) console.log(`  ${f.backup ? `restore ${f.file} from ${f.backup}` : `remove ${f.file} (it didn't exist before)`}`);
    if (!(await ask(`Undo ${files.length} file(s)?`, 'rollback'))) { console.log('nothing changed'); return; }
    for (const f of files) { if (f.backup) fs.copyFileSync(C.untilde(f.backup), C.untilde(f.file)); else fs.unlinkSync(C.untilde(f.file)); }
    console.log(`restored ${files.length} file(s)`);
    return;
  }
  const guards = [G.npx_ask && npxAsk(), G.git_ignore && gitIgnore(), ...pluginStore()].filter(Boolean);
  for (const g of guards) {
    console.log(`\x1b[1;34m==>\x1b[0m ${g.name}: ${g.what}`);
    for (const r of g.rules) console.log(`  ${g.add.includes(r) ? 'add ' : 'ok  '} ${r}`);
  }
  const todo = guards.filter(g => g.add.length);
  if (!todo.length) { console.log('  nothing to add'); return; }
  if (!args.includes('--apply')) { console.log('  plan only; run `steward ai guard --apply` to apply (asks first)'); return; }
  if (!(await ask(`Add ${todo.reduce((s, g) => s + g.add.length, 0)} rule(s) to ${todo.map(g => C.tilde(g.file)).join(' and ')}?`, 'ai-fix'))) { console.log('nothing changed'); return; }
  apply(todo);
})().catch(e => { console.error(`ERROR ${e.message}`); process.exit(1); });
