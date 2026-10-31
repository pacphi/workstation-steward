#!/usr/bin/env node
// Delete local branches whose pull request merged. Plan by default; --apply asks, records each branch's tip in a
// receipt (so `git branch <name> <sha>` brings it back) and deletes.
// Usage: prune-merged.js <repo> [--apply] [--no-fetch]
//   <repo>   a Git checkout: its path, absolute or from the folder you run steward in (`.` for this one)
// A branch goes only when all three hold:
//   1. its remote branch is gone (after `git fetch --prune`; a squash-merge with --delete-branch does this);
//   2. GitHub shows a merged PR from a branch of that name;
//   3. every commit on the local branch is in that PR's head commit (nothing was added after the PR).
// Never touches the current branch, the default branch, a branch checked out in another worktree, or a branch that
// still has a remote. STEWARD_GH names the gh binary (tests put a fake one there).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../../lib/config.js');
const A = require('../../lib/autonomy.js');
const { progress } = require('../../lib/progress.js');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const rest = args.filter(a => !a.startsWith('--'));
const die = m => { console.error(`prune-merged: ${m}`); process.exit(1); };
if (rest.length !== 1) die('usage: prune-merged.js <repo> [--apply] [--no-fetch]');
let dir = C.userPath(rest[0]);
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (...a) => { try { return git(...a).trim(); } catch { return null; } };
const gh = (...a) => execFileSync(process.env.STEWARD_GH || 'gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
if (!fs.existsSync(dir) || tryGit('rev-parse', '--git-dir') === null) die(`${C.tilde(dir)} is not a Git checkout (<repo> is a path: absolute, ~/…, or from the folder you run steward in)`);
dir = tryGit('rev-parse', '--show-toplevel');

const pg = progress(3);
let s = pg.stage('reading the checkout');
const url = tryGit('config', '--get', 'remote.origin.url') || die('no origin remote');
const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
if (!m) die(`origin is not a GitHub remote: ${url}`);
const repo = m[1];
const current = tryGit('symbolic-ref', '--short', '-q', 'HEAD');
const dflt = (tryGit('symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD') || '').replace(/^origin\//, '');
const inWorktree = new Set(git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('branch ')).map(l => l.slice(7).replace(/^refs\/heads\//, '')));
if (!flag('--no-fetch')) { try { git('fetch', '--prune', 'origin'); } catch (e) { die(`fetch failed: ${String(e.stderr || e.message).trim()}`); } }
const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
s.done(`${repo}: ${branches.length} local branch(es)`);

s = pg.stage('checking each branch against GitHub');
const rows = [];
for (const b of branches) {
  s.detail(b);
  const keep = why => rows.push({ b, act: 'keep', why });
  if (b === current) { keep('current branch'); continue; }
  if (b === dflt || (!dflt && ['main', 'master'].includes(b))) { keep('default branch'); continue; }
  if (inWorktree.has(b)) { keep('checked out in a worktree'); continue; }
  if (tryGit('rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`) !== null) { keep('remote branch still exists'); continue; }
  let prs;
  try { prs = JSON.parse(gh('pr', 'list', '-R', repo, '--head', b, '--state', 'merged', '--json', 'number,headRefOid', '--limit', '20')); }
  catch (e) { keep(`could not ask GitHub (${String(e.stderr || e.message).trim().split('\n')[0]})`); continue; }
  if (!prs.length) { keep('no merged PR from this branch'); continue; }
  const tip = git('rev-parse', b).trim();
  let hit = null, extra = null;
  for (const pr of prs) {
    if (tryGit('cat-file', '-e', `${pr.headRefOid}^{commit}`) === null) { extra = extra ?? `PR #${pr.number} head ${pr.headRefOid.slice(0, 7)} is not in this clone`; continue; }
    const n = Number(git('rev-list', '--count', `${pr.headRefOid}..${b}`).trim());
    if (n === 0) { hit = pr; break; }
    extra = `${n} commit(s) not in PR #${pr.number}`;
  }
  if (hit) rows.push({ b, act: 'delete', why: `PR #${hit.number} merged, remote gone, nothing newer`, tip, pr: hit.number });
  else keep(extra);
}
s.done(`${rows.filter(r => r.act === 'delete').length} to delete`);

console.log(`\n${dir}`);
for (const r of rows) console.log(`  ${r.act === 'delete' ? 'delete' : 'keep  '} ${r.b}  (${r.why})`);
const del = rows.filter(r => r.act === 'delete');
if (!del.length) { console.log('\nnothing to delete.'); process.exit(0); }
if (!flag('--apply')) { console.log('\nplan only. Add --apply to delete (asks first, records each tip).'); process.exit(0); }

// under --unattended, [autonomy] answers by the class (lib/autonomy.js); else a person, on the terminal
if (!A.answer('after-merge', `Delete ${del.length} local branch(es)?`)) {
  fs.writeSync(2, `\nDelete ${del.length} local branch(es)? [y/N] `);
  const buf = Buffer.alloc(64); let n = 0; try { n = fs.readSync(0, buf, 0, 64, null); } catch { /* no stdin */ }
  if (!/^\s*y/i.test(buf.slice(0, n).toString())) die('aborted');
}
s = pg.stage('deleting');
const bdir = C.newBackupDir(`prune-merged-${path.basename(dir)}`);
const receipt = { kind: 'prune-merged', at: new Date().toISOString(), engine: C.ENGINE_VERSION, ...(A.unattended() ? { unattended: true } : {}), repo: dir, remote: repo, branches: del.map(r => ({ name: r.b, tip: r.tip, pr: r.pr })), deleted: [], complete: false };
const save = () => fs.writeFileSync(path.join(bdir, 'receipt.json'), JSON.stringify(receipt, null, 1) + '\n');
save();
for (const r of del) { git('branch', '-D', r.b); receipt.deleted.push(r.b); save(); }
receipt.complete = true; save();
s.done(`${del.length} deleted`);
pg.finish(`receipt ${C.tilde(path.join(bdir, 'receipt.json'))}. To bring one back: git branch <name> <tip> (tips are in the receipt).`);
