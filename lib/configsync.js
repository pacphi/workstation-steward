#!/usr/bin/env node
// steward config sync (D50): bring your config repo level with GitHub. Plan by default: fetch, the commits to pull,
// the files they change, and any local edit in their way. --apply asks, fast-forwards (never rebases, merges or drops
// an edit), writes a receipt, offers `mise install` when mise/ changed, and runs `steward check`. --rollback moves
// the branch back to where the sync found it (git reset --keep), after asking. Sending this Mac's changes comes next.
// Usage: configsync.js [--apply] [--no-fetch]       DRY_RUN=1 shows the plan only
//        configsync.js --rollback <receipt>
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const C = require('./config.js');
const CR = require('./configrepo.js');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const die = (m, code = 1) => { console.error(`config sync: ${m}`); process.exit(code); };
const dir = C.INSTANCE_ROOT;
const at = `git -C ${C.tilde(dir)}`;
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };
const H = t => `\x1b[1;34m==>\x1b[0m ${t}`;

// ask(question) — one line from stdin, read a byte at a time so a second question gets the next line
function ask(q) {
  if (process.env.DRY_RUN === '1') return false;
  fs.writeSync(1, `${q} [y/N] `);
  const b = Buffer.alloc(1); let line = '';
  try { while (fs.readSync(0, b, 0, 1, null) === 1 && b[0] !== 10) line += String.fromCharCode(b[0]); } catch { /* no stdin */ }
  return /^\s*y/i.test(line);
}

// busy() — a merge, rebase, cherry-pick or revert in progress, by its marker in the git folder, or null
function busy() {
  for (const m of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const p = tryGit('rev-parse', '--git-path', m);
    if (p && fs.existsSync(path.resolve(dir, p))) return m.replace(/_HEAD$/, '').replace('-', ' ').toLowerCase();
  }
  return null;
}

// afterPull(files) — mise install when the pulled commits changed mise/ (asks; a change receipt starts the soak),
// then steward check: the config may now want a newer steward
function afterPull(files, label) {
  if (files.some(f => f.startsWith('mise/'))) {
    if (ask('mise/ changed: run mise install for its pins?')) {
      const r = spawnSync('mise', ['install'], { cwd: dir, stdio: 'inherit' });
      if (r.status !== 0) console.log(`  mise install failed (exit ${r.status}); run it again once the cause is fixed`);
      else {
        // installs changed what runs here: start the soak, as an upgrade does (lib/soak.js)
        const d = path.join(C.load().values.paths.state, 'changes');
        fs.mkdirSync(d, { recursive: true, mode: 0o700 });
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        fs.writeFileSync(path.join(d, `${now.replace(/[-:]/g, '')}-config-sync.json`), `${JSON.stringify({ kind: 'config-sync', what: `mise install after ${label}`, at: now, engine: C.ENGINE_VERSION })}\n`);
      }
    } else console.log('  later: mise install');
  }
  console.log(H('steward check'));
  const r = spawnSync(process.execPath, [path.join(C.REPO_ROOT, 'bin', 'steward.js'), 'check'], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) console.log('  the config now wants something (above); steward config sync --rollback <receipt> goes back');
}

function rollback(file) {
  const rp = C.userPath(file);
  let rc;
  try { rc = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (e) { die(`can't read ${file}: ${e.message}`, 2); }
  if (rc.kind !== 'config-sync' || !rc.complete) die(`${file} is not a finished config sync receipt`, 2);
  if (rc.rolled_back) die(`already rolled back (${rc.rolled_back})`);
  const head = tryGit('rev-parse', 'HEAD'), branch = tryGit('symbolic-ref', '--short', '-q', 'HEAD');
  if (branch !== rc.branch || head !== rc.after) die(`${rc.branch} moved since the sync (it's at ${(head || '?').slice(0, 7)}, the sync left ${rc.after.slice(0, 7)}): nothing changed`);
  const b = busy(); if (b) die(`a ${b} is in progress: finish or abort it first`);
  console.log(`${C.tilde(dir)}: move ${rc.branch} back ${rc.commits.length} commit(s), to ${rc.before.slice(0, 7)}, stepping back over:`);
  for (const c of rc.commits) console.log(`  ${c}`);
  if (!ask(`Move ${rc.branch} back to ${rc.before.slice(0, 7)}?`)) { console.log('nothing changed'); return; }
  try { git('reset', '--keep', rc.before); } catch (e) { die(`git reset --keep refused (a local edit is in the way?): ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
  rc.rolled_back = new Date().toISOString();
  fs.writeFileSync(rp, `${JSON.stringify(rc, null, 1)}\n`);
  console.log(`moved back to ${rc.before.slice(0, 7)}; the next steward config sync pulls those commits again`);
  if (rc.files.some(f => f.startsWith('mise/'))) afterPull(rc.files, `rolling back ${rc.after.slice(0, 7)}`);
}

function sync() {
  const s = CR.state(dir, { fetch: !flag('--no-fetch') });
  if (!s.repo) die(`${C.tilde(dir)} is not a Git repository of its own${s.inside ? ` (it's inside ${C.tilde(s.inside)})` : ''}: docs/config-repo.md says how to make it one`, 2);
  if (!s.branch) die(`detached HEAD: ${at} switch <branch> first`);
  const b = busy(); if (b) die(`a ${b} is in progress: finish or abort it first`);
  if (!s.upstream) die(`${s.branch} has no upstream to follow: ${at} push -u origin ${s.branch}`);
  if (s.fetchError) die(`fetch failed: ${s.fetchError}`);
  console.log(`${C.tilde(dir)}  (${s.slug || 'no GitHub remote'}, ${s.branch} → ${s.upstream})`);
  if (s.ahead && s.behind) die(`${s.branch} and ${s.upstream} have diverged (${s.ahead} commit(s) here, ${s.behind} there). The steward never merges or rebases: ${at} pull --rebase, by hand`);
  if (!s.behind) {
    console.log(`  up to date with ${s.upstream}`);
    if (s.ahead) console.log(`  ${s.ahead} commit(s) here not pushed: ${at} push`);
    if (s.changed.length) console.log(`  ${s.changed.length} file(s) changed here: ${at} status`);
    return;
  }
  const commits = git('log', '--format=%h %s', `HEAD..${s.upstream}`).split('\n').filter(Boolean);
  const files = git('diff', '--name-only', 'HEAD', s.upstream).split('\n').filter(Boolean);
  const inWay = s.changed.filter(f => files.includes(f));
  console.log(`  pull    ${commits.length} commit(s):`);
  for (const c of commits) console.log(`            ${c}`);
  console.log(`  files   ${files.join(', ')}`);
  if (s.changed.length > inWay.length) console.log(`  stays   ${s.changed.length - inWay.length} local edit(s) GitHub doesn't touch`);
  if (inWay.length) {
    console.log(`\nnot syncing: your edits to ${inWay.join(', ')} are in the way of the pull. Commit them, or move them aside, then sync again (${at} diff ${inWay.join(' ')}).`);
    process.exit(2);
  }
  console.log(`  then    ${files.some(f => f.startsWith('mise/')) ? 'mise install (mise/ changed; asks), ' : ''}steward check`);
  if (!flag('--apply') || process.env.DRY_RUN === '1') { console.log('\nplan only. Add --apply to do it (asks first; fast-forward only, never a rebase or merge).'); return; }

  if (!ask(`\nFast-forward ${s.branch} to ${s.upstream}?`)) { console.log('nothing changed'); return; }
  const bdir = C.newBackupDir('config-sync');
  const before = git('rev-parse', 'HEAD');
  const receipt = { kind: 'config-sync', at: new Date().toISOString(), engine: C.ENGINE_VERSION, repo: dir, branch: s.branch, upstream: s.upstream, before, after: null, commits, files, complete: false };
  const rp = path.join(bdir, 'receipt.json');
  const save = () => fs.writeFileSync(rp, `${JSON.stringify(receipt, null, 1)}\n`);
  save();
  try { git('merge', '--ff-only', s.upstream); } catch (e) { die(`fast-forward failed, nothing changed: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
  receipt.after = git('rev-parse', 'HEAD'); receipt.complete = true; save();
  console.log(H(`fast-forwarded ${before.slice(0, 7)} → ${receipt.after.slice(0, 7)}`));
  console.log(`  receipt:  ${C.tilde(rp)}`);
  console.log(`  rollback: steward config sync --rollback ${C.tilde(rp)}`);
  afterPull(files, `pulling ${before.slice(0, 7)}..${receipt.after.slice(0, 7)}`);
}

if (flag('--rollback')) {
  const f = args[args.indexOf('--rollback') + 1];
  if (!f || f.startsWith('--')) die('usage: steward config sync --rollback <receipt.json>', 2);
  rollback(f);
} else sync();
