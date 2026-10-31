#!/usr/bin/env node
// Bring one checkout up to date with its upstream after PRs merged: fast-forward only, dropping only the local edits
// the upstream already has. Plan by default; --apply asks, backs up what it drops, writes a receipt.
// Usage: sync.js <repo> [--apply] [--replace <path>]... [--no-fetch]
//   <repo>            a Git checkout: its path, absolute or from the folder you run steward in (`.` for this one)
//   --replace <path>  also drop this local edit (or untracked file) in favour of upstream; for edits you named
// Per path that upstream changes and the checkout also touches:
//   drop     local content equals upstream's (byte for byte, as JSON, or already contained in a 3-way merge)
//   blocked  anything else; the sync stops until you name the path with --replace or deal with it yourself
// Local edits upstream doesn't touch stay as they are. Never rebases, resets, merges or commits; refuses a detached
// HEAD, a merge/rebase in progress, local commits, and a diverged history. Agents run the plan only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const C = require('../../lib/config.js');
const A = require('../../lib/autonomy.js');
const { progress } = require('../../lib/progress.js');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const replace = new Set();
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--replace') replace.add(args[++i]);
  else if (!args[i].startsWith('--')) rest.push(args[i]);
}
const die = m => { console.error(`sync: ${m}`); process.exit(1); };
if (rest.length !== 1) die('usage: sync.js <repo> [--apply] [--replace <path>]... [--no-fetch]');
let dir = C.userPath(rest[0]);
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitBuf = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
const tryGit = (...a) => { try { return git(...a).trim(); } catch { return null; } };
if (!fs.existsSync(dir) || tryGit('rev-parse', '--git-dir') === null) die(`${C.tilde(dir)} is not a Git checkout (<repo> is a path: absolute, ~/…, or from the folder you run steward in)`);
dir = tryGit('rev-parse', '--show-toplevel');

const pg = progress(4);
// 1. state
let s = pg.stage('checking the checkout');
const branch = tryGit('symbolic-ref', '--short', '-q', 'HEAD');
if (!branch) die('detached HEAD: check out a branch first');
// A rebase is judged as git does, by rebase-merge/ or rebase-apply/: a REBASE_HEAD can outlive the rebase.
for (const m of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
  const what = m.startsWith('rebase') ? 'rebase' : m.replace(/_HEAD$/, '').replace('_', '-').toLowerCase();
  if (fs.existsSync(path.resolve(dir, tryGit('rev-parse', '--git-path', m)))) die(`a ${what} is in progress: finish or abort it first`);
}
const upstream = tryGit('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') || (tryGit('rev-parse', '--verify', '-q', `origin/${branch}`) !== null ? `origin/${branch}` : null);
if (!upstream) die(`${branch} has no upstream to follow`);
s.done(`${branch} → ${upstream}`);

// 2. fetch
s = pg.stage('fetching');
if (!flag('--no-fetch')) { try { git('fetch', '--prune', upstream.split('/')[0]); } catch (e) { die(`fetch failed: ${String(e.stderr || e.message).trim()}`); } }
const [ahead, behind] = git('rev-list', '--left-right', '--count', `HEAD...${upstream}`).trim().split(/\s+/).map(Number);
s.done(`${ahead} ahead, ${behind} behind`);
if (ahead > 0) die(`${branch} has ${ahead} local commit(s) ${upstream} lacks${behind ? ' and has diverged' : ''}: sync only fast-forwards; push or rebase by hand`);
if (behind === 0) { console.log(`${dir}: ${branch} is already up to date with ${upstream}.`); process.exit(0); }

// 3. classify
s = pg.stage('comparing local edits with upstream');
const canon = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));
const changedUp = new Set(git('diff', '--name-only', '-z', 'HEAD', upstream).split('\0').filter(Boolean));
const st = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter(Boolean);
const local = []; // [{p, xy}]
for (let i = 0; i < st.length; i++) { const e = st[i]; local.push({ p: e.slice(3), xy: e.slice(0, 2) }); if (/^[RC]/.test(e)) i++; }
const blob = (ref, p) => { try { return gitBuf('show', `${ref}:${p}`); } catch { return null; } };
const work = p => { try { return fs.readFileSync(path.join(dir, p)); } catch { return null; } };
const same = (a, b) => (a === null || b === null ? a === b : a.equals(b));
const jsonEq = (a, b) => { try { return canon(JSON.parse(a)) === canon(JSON.parse(b)); } catch { return false; } };
function contained(p, loc, up) { // the local edit is already inside upstream: a 3-way merge of local, base, upstream gives upstream
  const base = blob('HEAD', p);
  if (base === null || loc === null || up === null) return false;
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-sync-'));
  try {
    const f = { l: path.join(t, 'l'), b: path.join(t, 'b'), u: path.join(t, 'u') };
    fs.writeFileSync(f.l, loc); fs.writeFileSync(f.b, base); fs.writeFileSync(f.u, up);
    const r = spawnSync('git', ['merge-file', '-p', f.l, f.b, f.u], { maxBuffer: 256 << 20 });
    return r.status === 0 && r.stdout.equals(up);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}
const plan = [];
for (const { p, xy } of local) {
  if (!changedUp.has(p)) continue; // upstream doesn't touch it: it stays
  const untracked = xy === '??';
  const loc = work(p), up = blob(upstream, p);
  const staged = !untracked && xy[0] !== ' ';
  let why = null;
  if (same(loc, up)) why = loc === null ? 'deleted here and upstream' : 'same as upstream';
  else if (loc !== null && up !== null && jsonEq(loc, up)) why = 'same JSON as upstream';
  else if (!untracked && !staged && contained(p, loc, up)) why = 'already inside upstream (3-way)';
  const named = replace.has(p);
  plan.push({ p, untracked, staged, action: why || named ? 'drop' : 'blocked', why: why || (named ? 'named with --replace' : untracked ? 'untracked, differs from upstream' : staged ? 'staged change differs from upstream' : 'differs from upstream'), loc: loc !== null });
}
for (const r of replace) if (!plan.some(x => x.p === r)) die(`--replace ${r}: no local edit there that upstream also changes`);
s.done(`${plan.length} overlapping path(s), ${local.length - plan.length} other local edit(s) stay`);

console.log(`\n${dir}\n${branch}: ${behind} commit(s) to fast-forward to ${upstream}`);
for (const x of plan) console.log(`  ${x.action === 'drop' ? 'drop   ' : 'BLOCKED'} ${x.p}  (${x.why})`);
const blocked = plan.filter(x => x.action === 'blocked');
if (blocked.length) { console.log(`\nnot syncing: ${blocked.length} path(s) differ from upstream. Look at each (git diff / diff), then rerun with --replace <path> to drop yours, or move your change aside.`); process.exit(2); }
if (!flag('--apply')) { console.log('\nplan only. Add --apply to do it (asks first, backs up what it drops).'); process.exit(0); }

// 4. apply
// under --unattended, [autonomy] answers by the class (lib/autonomy.js); else a person, on the terminal
if (!A.answer('after-merge', 'Drop the edits above and fast-forward?')) {
  fs.writeSync(2, '\nDrop the edits above and fast-forward? [y/N] ');
  const buf = Buffer.alloc(64); let n = 0; try { n = fs.readSync(0, buf, 0, 64, null); } catch { /* no stdin */ }
  if (!/^\s*y/i.test(buf.slice(0, n).toString())) die('aborted');
}
s = pg.stage('applying');
const bdir = C.newBackupDir(`sync-${path.basename(dir)}`);
const before = git('rev-parse', 'HEAD').trim();
const receipt = { kind: 'sync', at: new Date().toISOString(), engine: C.ENGINE_VERSION, ...(A.unattended() ? { unattended: true } : {}), repo: dir, branch, upstream, before, after: null, dropped: [], complete: false };
const save = () => fs.writeFileSync(path.join(bdir, 'receipt.json'), JSON.stringify(receipt, null, 1) + '\n');
save();
for (const x of plan) {
  const b = path.join(bdir, 'files', x.p);
  if (x.loc) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(path.join(dir, x.p), b, fs.constants.COPYFILE_EXCL); }
  receipt.dropped.push({ path: x.p, untracked: x.untracked, existed: x.loc, backup: x.loc ? C.tilde(b) : null, why: x.why });
  save();
  if (x.untracked) fs.rmSync(path.join(dir, x.p), { force: true });
  else git('checkout', 'HEAD', '--', x.p);
}
try { git('merge', '--ff-only', upstream); }
catch (e) { save(); die(`fast-forward failed after dropping ${plan.length} edit(s): ${String(e.stderr || e.message).trim()}\nbackups: ${C.tilde(bdir)}`); }
receipt.after = git('rev-parse', 'HEAD').trim(); receipt.complete = true; save();
s.done(`${before.slice(0, 7)} → ${receipt.after.slice(0, 7)}`);
pg.finish(`receipt ${C.tilde(path.join(bdir, 'receipt.json'))}. To restore a dropped edit, copy it back from its backup.`);
