// The shared safety rules for steward commands that edit a project's untracked tooling files in place after a plan and a
// yes (D6): Git state, one ask, a backup under the state folder, an atomic write that is read back, a receipt, and a
// rollback that refuses a file changed since. `ai timeouts` and `ai approvals` use it; `ai repin` predates it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');
const C = require('./config.js');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const git = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// gitState(file) — 'not-git' | 'mid-merge' | 'untracked' | 'tracked'
function gitState(file) {
  const dir = path.dirname(file);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return 'not-git';
  for (const p of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
    const gp = git(dir, ['rev-parse', '--git-path', p]);
    if (gp && fs.existsSync(path.resolve(dir, gp))) return 'mid-merge';
  }
  return git(top, ['ls-files', '--error-unmatch', path.relative(top, file)]) === null ? 'untracked' : 'tracked';
}

// stateProblems(state) — why a file in this Git state can't be edited, or null
const stateProblems = state => (state === 'tracked' ? 'tracked by Git: change it through a PR' : state === 'mid-merge' ? 'repo is mid-merge or mid-rebase' : null);

// ask(q, cls) — [y/N] on the terminal; under --unattended, [autonomy] answers by the question's class (lib/autonomy.js)
async function ask(q, cls) {
  if (process.env.DRY_RUN === '1') return false;
  if (require('./autonomy.js').answer(cls, q)) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

// apply(kind, rows, hint) — rows: [{file, before (sha of the text read), next (new text), count}]. Backs up each file (under
// home/ when it is in the home folder, else abs/: a backup path must never leave the backup folder), writes it atomically,
// reads it back, and writes <backup folder>/receipt.json. Returns the receipt path.
function apply(kind, rows, hint = {}) {
  const dir = C.newBackupDir(kind);
  fs.mkdirSync(path.join(dir, 'home'), { mode: 0o700 });
  const receipt = { kind, at: new Date().toISOString(), engine: C.ENGINE_VERSION, backup: dir, files: [] };
  Object.assign(receipt, require('./autonomy.js').mark());   // --unattended (D58), and --yes-to (D59)
  for (const r of rows) {
    const bak = r.file.startsWith(C.HOME + path.sep) ? path.join(dir, 'home', path.relative(C.HOME, r.file)) : path.join(dir, 'abs', r.file);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(r.file, bak, fs.constants.COPYFILE_EXCL);
    const mode = fs.statSync(r.file).mode;
    const tmp = `${r.file}.${kind}-${process.pid}`;
    fs.writeFileSync(tmp, r.next, { mode });
    fs.renameSync(tmp, r.file);
    const after = fs.readFileSync(r.file, 'utf8');
    if (sha(after) !== sha(r.next)) throw new Error(`write check failed: ${r.file}`);
    receipt.files.push({ path: C.tilde(r.file), sha_before: r.before, sha_after: sha(after), backup: C.tilde(bak), changed: r.count });
  }
  const rp = path.join(dir, 'receipt.json');
  fs.writeFileSync(rp, JSON.stringify(receipt, null, 1) + '\n');
  console.log(`\x1b[1;34m==>\x1b[0m changed ${rows.length} file(s); receipt ${C.tilde(rp)}`);
  console.log(`  rollback: steward ai ${hint.recipe || kind} --rollback ${C.tilde(rp)}`);
  if (hint.note) console.log(`  ${hint.note}`);
  return rp;
}

// rollbackPlan(receiptPath) — the receipt, or exit 1 when any file changed since it was written
function rollbackPlan(receiptPath) {
  const rc = JSON.parse(fs.readFileSync(C.userPath(receiptPath), 'utf8'));
  const changed = rc.files.filter(f => fs.existsSync(C.untilde(f.path)) && sha(fs.readFileSync(C.untilde(f.path), 'utf8')) !== f.sha_after);
  if (changed.length) { console.error(`refusing: ${changed.length} file(s) changed since the fix, e.g. ${changed[0].path}`); process.exit(1); }
  return rc;
}

// runRollback(args) — the --rollback flow shared by the commands: list, ask, restore
async function runRollback(args) {
  const receipt = args[args.indexOf('--rollback') + 1];
  if (!receipt || receipt.startsWith('--')) { console.error('usage: --rollback <receipt.json>'); process.exit(2); }
  const rc = rollbackPlan(receipt);
  for (const f of rc.files) console.log(`  restore ${f.path}`);
  if (!(await ask(`Restore ${rc.files.length} file(s) from ${C.tilde(rc.backup)}?`, 'rollback'))) { console.log('nothing changed'); return; }
  for (const f of rc.files) fs.copyFileSync(C.untilde(f.backup), C.untilde(f.path));
  console.log(`restored ${rc.files.length} file(s)`);
}

module.exports = { sha, git, gitState, stateProblems, ask, apply, runRollback };
