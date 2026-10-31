#!/usr/bin/env node
// steward config sync (D50): keep your config repo and GitHub in step, both ways. Plan by default; each step asks.
//   pull  the commits GitHub has: fast-forward only (never a rebase, a merge or a dropped edit), a receipt, then
//         `mise install` when mise/ changed (asks) and `steward check`
//   send  everything local (edits and unpushed commits) as a branch, steward/sync-<time>, and a PR in the config
//         repo, never straight to its default branch. This Mac stays on that branch until you merge; the next sync
//         sees the PR merged, moves the default branch to GitHub's tip, switches to it, and deletes the send branch
//         here and on GitHub.
// Edits git can combine: an edit to a file the pull (or the finish, or a rollback) also changes, on other lines, is set
// aside (a copy in the receipt's folder, then git stash), the step is taken, and the edit is put back (git stash pop).
// The plan checks this first with git merge-file; if the put-back conflicts anyway, the step is undone and the edits go
// back as they were, byte for byte, and it refuses. Staged, new or deleted files in the way are refused, as before.
// --rollback <receipt>: a pull moves the branch back (git reset --keep); a send closes the PR (if not merged) and puts
// this Mac back as it was. STEWARD_GH names the gh binary (tests put a stand-in there).
// Usage: configsync.js [--apply] [--no-fetch]       DRY_RUN=1 shows the plan only
//        configsync.js --rollback <receipt>
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const C = require('./config.js');
const CR = require('./configrepo.js');
const A = require('./autonomy.js');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const die = (m, code = 1) => { console.error(`config sync: ${m}`); process.exit(code); };
const dir = C.INSTANCE_ROOT;
const at = `git -C ${C.tilde(dir)}`;
const SEND = 'steward/sync-';
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };
const gh = (...a) => execFileSync(process.env.STEWARD_GH || 'gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGh = (...a) => { try { return gh(...a); } catch { return null; } };
const errLine = e => String(e.stderr || e.message).trim().split('\n')[0];
const H = t => `\x1b[1;34m==>\x1b[0m ${t}`;
const STATE = C.load().values.paths.state;
const apply = () => flag('--apply') && process.env.DRY_RUN !== '1';

// ask(question, cls) — one line from stdin, read a byte at a time so a second question gets the next line. Under
// --unattended, [autonomy] answers by the question's class (lib/autonomy.js): pull, install, push or rollback
function ask(q, cls) {
  if (process.env.DRY_RUN === '1') return false;
  if (A.answer(cls, q)) return true;
  fs.writeSync(1, `${q} [y/N] `);
  const b = Buffer.alloc(1); let line = '';
  try { while (fs.readSync(0, b, 0, 1, null) === 1 && b[0] !== 10) line += String.fromCharCode(b[0]); } catch { /* no stdin */ }
  return /^\s*y/i.test(line);
}

// busy() — a merge, rebase, cherry-pick or revert in progress, by its marker in the git folder, or null. A rebase is
// judged as git does, by rebase-merge/ or rebase-apply/: a REBASE_HEAD can outlive the rebase.
function busy() {
  for (const m of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const p = tryGit('rev-parse', '--git-path', m);
    if (p && fs.existsSync(path.resolve(dir, p))) return m.startsWith('rebase') ? 'rebase' : m.replace(/_HEAD$/, '').replace('_', '-').toLowerCase();
  }
  return null;
}

// newReceipt(name, fields) — a receipt in a fresh backups folder; returns { rc, rp, save }
function newReceipt(name, fields) {
  const rp = path.join(C.newBackupDir(name), 'receipt.json');
  const rc = { kind: name, at: new Date().toISOString(), engine: C.ENGINE_VERSION, repo: dir, ...fields, ...(A.unattended() ? { unattended: true } : {}), complete: false };
  const save = () => fs.writeFileSync(rp, `${JSON.stringify(rc, null, 1)}\n`);
  save();
  return { rc, rp, save };
}

const lit = f => `:(literal)${f}`; // a path, never a pattern
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const refuse = m => { console.log(`\n${m}`); process.exit(2); };

// inTheWay(verb, files, upstream, why) — today's refusal for edits in the way, with the reason
const inTheWay = (verb, files, upstream, why) => `not ${verb}: your edits to ${files.join(', ')} are in the way of the ${verb === 'syncing' ? 'pull' : 'switch'} (${why}). Compare yours (${at} diff ${files.join(' ')}) with GitHub's (${at} log -p HEAD..${upstream} -- ${files.join(' ')}), keep what you want, then sync again.`;

// codes(files) — each file's two-letter git status (' M' is an unstaged edit to a tracked file)
function codes(files) {
  const out = (tryGit('status', '--porcelain', '--untracked-files=all', '--', ...files.map(lit)) || '').split('\n').filter(Boolean);
  return Object.fromEntries(out.map(l => [l.slice(3).replace(/^"|"$/g, ''), l.slice(0, 2)]));
}

// combinable(files, to) — null when the edits to files (against HEAD) can be set aside and put back on commit `to`
// with no conflict, else why not. Only unstaged edits to plain tracked files, present at `to`, are carried: anything
// staged, new, deleted or left mid-conflict is refused as before. The check is git merge-file on temporary copies
// (yours, HEAD's, to's), so nothing in the checkout changes; the real put-back is git stash pop, checked again.
function combinable(files, to) {
  const c = codes(files);
  for (const f of files) {
    const code = c[f] || '??';
    if (code === '??' || code[0] === 'A') return `${f} is new here`;
    if (code.includes('U') || code === 'DD') return `${f} has a conflict left over`;
    if (code.includes('D')) return `${f} is deleted here`;
    if (code !== ' M') return `${f} is staged (git add), which the steward doesn't set aside: ${at} restore --staged ${f}`;
    for (const rev of ['HEAD', to]) if (!/^100(644|755) blob /.test(tryGit('ls-tree', rev, '--', f) || '')) return `${f} is not a plain file in ${rev}`;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-sync-'));
  try {
    for (const f of files) {
      const base = path.join(tmp, 'base'), theirs = path.join(tmp, 'theirs');
      fs.writeFileSync(base, execFileSync('git', ['-C', dir, 'cat-file', 'blob', `HEAD:${f}`]));
      fs.writeFileSync(theirs, execFileSync('git', ['-C', dir, 'cat-file', 'blob', `${to}:${f}`]));
      const r = spawnSync('git', ['merge-file', '-p', '-q', path.join(dir, f), base, theirs], { stdio: 'ignore' });
      if (r.status !== 0) return `both change the same lines of ${f}`;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return null;
}

// carryEdits(files, copies, note, save, step, undo) — set the edits to files aside (a copy of each under copies, then
// git stash push for just those paths), take step, then put them back (git stash pop). note (a receipt field) records
// the copies, their sha256 and the stash; save writes the receipt. If step throws (it must leave nothing changed), or
// the edits don't go back cleanly (git stash pop conflicts; undo then takes the step back), the edits are put back
// where they were and checked byte for byte against the copies. Returns null when carried, else why not.
function carryEdits(files, copies, note, save, step, undo) {
  Object.assign(note, { files, copies, sha256: {}, stash: null });
  for (const f of files) {
    const to = path.join(copies, f);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(dir, f), to);
    note.sha256[f] = sha256(to);
  }
  save();
  const label = `steward config sync: ${C.tilde(copies)}`;
  try { git('stash', 'push', '-q', '-m', label, '--', ...files.map(lit)); } catch (e) { return `setting them aside failed: ${errLine(e)}`; }
  // a push that saved nothing exits 0 too, leaving a stash of yours on top: ours carries the label
  if (!(tryGit('log', '-1', '--format=%s', 'stash@{0}') || '').endsWith(label)) return 'setting them aside saved nothing';
  note.stash = git('rev-parse', 'stash@{0}'); save();
  const kept = `your edits are in git stash (${note.stash.slice(0, 7)}) and copied to ${C.tilde(copies)}`;
  // pop only our own entry: a stash of yours stays where it is
  const putBack = () => { if (tryGit('rev-parse', '-q', '--verify', 'stash@{0}') !== note.stash) throw new Error('the top stash entry is not ours'); git('stash', 'pop', '-q'); };
  let why = null;
  try { step(); } catch (e) { why = errLine(e); }
  if (!why) {
    try { putBack(); return null; } catch { why = 'they did not go back cleanly'; }
    try { git('checkout', '-q', 'HEAD', '--', ...files.map(lit)); undo(); } catch (e) { die(`putting this Mac back failed: ${errLine(e)}. ${kept}`); }
  }
  try { putBack(); } catch (e) { die(`putting your edits back failed: ${errLine(e)}. ${kept}`); }
  for (const f of files) {
    if (sha256(path.join(dir, f)) === note.sha256[f]) continue;
    fs.copyFileSync(path.join(copies, f), path.join(dir, f));
    console.log(`  ${f}: put back from its copy`);
  }
  return why;
}

// afterPull(files) — mise install when mise/ changed (asks; a change receipt starts the soak), then steward check
function afterPull(files, label) {
  if (files.some(f => f.startsWith('mise/'))) {
    if (ask('mise/ changed: run mise install for its pins?', 'install')) {
      const r = spawnSync('mise', ['install'], { cwd: dir, stdio: 'inherit' });
      if (r.status !== 0) console.log(`  mise install failed (exit ${r.status}); run it again once the cause is fixed`);
      else {
        // installs changed what runs here: start the soak, as an upgrade does (lib/soak.js)
        const d = path.join(STATE, 'changes');
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

// move(m) — the move of a pull or a finish, with its receipt (kind config-sync): m.step() takes it and leaves nothing
// changed when it throws; m.undo() takes it back. Edits in m.carry are carried across it (carryEdits); if they can't
// be, everything is put back and it refuses. Returns { rc, rp }.
function move({ branch, upstream, before, commits, files, carry, step, undo, verb, failed }) {
  const { rc, rp, save } = newReceipt('config-sync', { branch, upstream, before, after: null, commits, files, carried: null });
  if (carry.length) {
    rc.carried = {};
    const why = carryEdits(carry, path.join(path.dirname(rp), 'edits'), rc.carried, save, step, undo);
    if (why) { rc.restored = `nothing changed: ${why}`; save(); refuse(`${inTheWay(verb, carry, upstream, why)} Nothing changed.`); }
  } else try { step(); } catch (e) { die(`${failed}, nothing changed: ${errLine(e)}`); }
  rc.after = git('rev-parse', 'HEAD'); rc.complete = true; save();
  return { rc, rp };
}

// told(rc, rp) — what a move did, with its receipt and the way back
function told(rc, rp) {
  console.log(H(`fast-forwarded ${rc.before.slice(0, 7)} → ${rc.after.slice(0, 7)}`));
  if (rc.carried) console.log(`  your edits to ${rc.carried.files.join(', ')}: set aside and put back (a copy: ${C.tilde(rc.carried.copies)})`);
  console.log(`  receipt:  ${C.tilde(rp)}`);
  console.log(`  rollback: steward config sync --rollback ${C.tilde(rp)}`);
}

// fastForward(branch, upstream, commits, files, carry) — the pull: fast-forward with a receipt, carrying the edits to
// carry across it, then afterPull
function fastForward(branch, upstream, commits, files, carry = []) {
  const before = git('rev-parse', 'HEAD');
  const { rc, rp } = move({
    branch, upstream, before, commits, files, carry, verb: 'syncing', failed: 'fast-forward failed',
    step: () => git('merge', '--ff-only', upstream), undo: () => git('reset', '-q', '--keep', before),
  });
  told(rc, rp);
  afterPull(files, `pulling ${before.slice(0, 7)}..${rc.after.slice(0, 7)}`);
}

// why(files, kinds) — what changed each file, in words: the steward commands whose change receipts (state/changes)
// came after the last commit, for the mise files they edit; anything else is new, deleted or an edit on this Mac
// (kinds: lib/configrepo.js state's, so a stray new file stands out)
const BY_HAND = { new: 'new on this Mac', deleted: 'deleted on this Mac', edit: 'an edit on this Mac' };
function why(files, kinds = {}) {
  const since = Date.parse(tryGit('log', '-1', '--format=%cI') || '1970-01-01T00:00:00Z');
  const d = path.join(STATE, 'changes');
  let cmds = [];
  try {
    cmds = fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } })
      .filter(r => r && r.kind !== 'config-sync' && Date.parse(r.at) > since)
      .map(r => `steward sc ${r.kind} ${r.what} (${new Date(r.at).toLocaleString('sv-SE').slice(0, 16)})`);
  } catch { /* no change receipts */ }
  return files.map(f => ({ f, by: f.startsWith('mise/') && cmds.length && kinds[f] !== 'deleted' ? cmds.join('; ') : BY_HAND[kinds[f] || 'edit'] }));
}

// message(reasons, commits) — the commit and PR text: a title, then each file and what changed it
function message(reasons, commits) {
  const host = os.hostname().replace(/\.local$/, '');
  const title = `chore(config): changes from ${host}`;
  const body = [`Sent by \`steward config sync\` from ${host}.`, ''];
  if (reasons.length) body.push('| File | Changed by |', '| --- | --- |', ...reasons.map(r => `| \`${r.f}\` | ${r.by} |`), '');
  if (commits.length) body.push('Commits made on this Mac:', '', ...commits.map(c => `- ${c}`), '');
  body.push('After merging, run `steward config sync` on that Mac: it switches back to the default branch and deletes this one.');
  return { title, body: body.join('\n') };
}

// prOf(slug, branch) — the newest PR from branch: { number, state, url, headRefOid } or null; undefined if gh fails
function prOf(slug, branch) {
  const out = tryGh('pr', 'list', '-R', slug, '--head', branch, '--state', 'all', '--json', 'number,state,url,headRefOid', '--limit', '5');
  if (out === null) return undefined;
  const prs = JSON.parse(out || '[]');
  return prs.sort((a, b) => b.number - a.number)[0] || null;
}

const needSlug = s => { if (!s.slug) die(`sending goes as a GitHub pull request, and origin is ${tryGit('config', '--get', 'remote.origin.url') || 'not set'}: only pulling works here`); };

// off(why, steps) — config sync needs a Git repository of its own with a GitHub remote: say what's missing, how to set
// it up, and stop with exit 3, as a command of an add-on that's off does. Nothing changes.
function off(why, steps) {
  console.error(`config sync is off: ${why}`);
  console.error(`To turn it on (docs/config-repo.md):`);
  for (const s of steps) console.error(`  ${s}`);
  process.exit(3);
}
const createRepo = `gh repo create <you>/steward-config --private --source ${C.tilde(dir)} --remote origin --push`;
const needGh = () => { if (tryGh('auth', 'status') === null) die('sending needs the GitHub CLI, logged in: gh auth login (the pull side works without it)'); };
const findSend = branch => {
  const d = path.join(STATE, 'backups');
  for (const f of fs.readdirSync(d).filter(x => x.startsWith('config-sync-send-')).sort().reverse()) {
    try { const rc = JSON.parse(fs.readFileSync(path.join(d, f, 'receipt.json'), 'utf8')); if (rc.branch === branch) return { rc, rp: path.join(d, f, 'receipt.json') }; } catch { /* skip */ }
  }
  return null;
};

// send(s, base) — everything local onto a new steward/sync-<time> branch, pushed, with a PR against base
function send(s, base) {
  const now = CR.state(dir);
  const files = now.changed;
  const ahead = git('log', '--format=%h %s', `${s.upstream}..HEAD`).split('\n').filter(Boolean);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  let branch = `${SEND}${stamp}`;
  for (let n = 2; tryGit('rev-parse', '--verify', '-q', `refs/heads/${branch}`) !== null; n++) branch = `${SEND}${stamp}-${n}`;
  const reasons = why(files, now.kinds);
  const { title, body } = message(reasons, ahead);
  const origHead = git('rev-parse', 'HEAD');
  const { rc, rp, save } = newReceipt('config-sync-send', { base, upstream: s.upstream, branch, origHead, tip: null, files, commits: ahead, pr: null });
  git('switch', '-q', '-c', branch);
  if (files.length) { git('add', '-A'); git('commit', '-q', '-m', title, '-m', body); }
  rc.tip = git('rev-parse', 'HEAD'); save();
  try { git('push', '-q', '-u', 'origin', branch); } catch (e) { die(`push failed: ${errLine(e)}. You're on ${branch} with the commit; run steward config sync again to retry. Receipt: ${C.tilde(rp)}`); }
  let url;
  try { url = gh('pr', 'create', '-R', s.slug, '--base', base, '--head', branch, '--title', title, '--body', body); } catch (e) { die(`gh pr create failed: ${errLine(e)}. The branch is pushed; run steward config sync again to retry. Receipt: ${C.tilde(rp)}`); }
  rc.pr = { number: Number((url.match(/\/pull\/(\d+)/) || [])[1]) || null, url };
  git('branch', '-f', base, s.upstream); // base matches GitHub again; the changes live on the branch until you merge
  rc.complete = true; save();
  console.log(H(`sent as PR #${rc.pr.number}: ${url}`));
  console.log(`  this Mac stays on ${branch} until you merge; then steward config sync switches back to ${base}`);
  console.log(`  receipt:  ${C.tilde(rp)}`);
  console.log(`  rollback: steward config sync --rollback ${C.tilde(rp)}   (closes the PR, puts this Mac back as it was)`);
}

// onSendBranch(s) — on our own steward/sync-* branch: finish after the merge, add new edits to the open PR, or say why not
function onSendBranch(s) {
  needSlug(s);
  const branch = s.branch;
  const pr = prOf(s.slug, branch);
  if (pr === undefined) die('could not ask GitHub about this branch\'s PR (gh auth status)');
  const base = ((tryGit('rev-parse', '--abbrev-ref', 'origin/HEAD') || 'origin/main').replace(/^origin\//, ''));
  const tip = git('rev-parse', 'HEAD');
  console.log(`${C.tilde(dir)}  (${s.slug}, ${branch}${pr ? `, PR #${pr.number} ${pr.state.toLowerCase()}` : ', no PR yet'})`);
  if (pr && pr.state === 'MERGED') {
    if (pr.headRefOid !== tip) die(`PR #${pr.number} merged, but ${branch} has commits made after it: switch to ${base} by hand and bring them over (${at} log ${pr.headRefOid.slice(0, 7)}..)`);
    const upstream = `origin/${base}`;
    // straight to GitHub's tip: move base there first, then switch, never through the old base, whose older files
    // would be in the way of an edit made since the send (2026-10-29: a new mise.lock pin stopped the switch)
    const before = tryGit('rev-parse', '-q', '--verify', `refs/heads/${base}`);
    if (!before) die(`there's no local ${base} to switch back to: ${at} branch --track ${base} ${upstream}, then sync again`);
    if (tryGit('merge-base', '--is-ancestor', before, upstream) === null) die(`${base} has commits ${upstream} doesn't (${at} log ${upstream}..${base}). The steward never merges or rebases: bring them over by hand`);
    const files = git('diff', '--name-only', before, upstream).split('\n').filter(Boolean);
    const commits = git('log', '--format=%h %s', `${before}..${upstream}`).split('\n').filter(Boolean);
    const fresh = git('diff', '--name-only', tip, upstream).split('\n').filter(Boolean); // what others merged meanwhile
    const carry = s.changed.filter(f => fresh.includes(f)); // edits git switch can't take along by itself
    const remote = tryGit('ls-remote', '--heads', 'origin', branch);
    console.log(`  finish  PR #${pr.number} is merged: switch to ${base}, fast-forward ${commits.length} commit(s), delete ${branch}${remote ? ' here and on GitHub' : ''}`);
    if (s.changed.length) console.log(`  stays   ${s.changed.length} local edit(s), carried over to ${base}`);
    if (carry.length) {
      const why = combinable(carry, upstream);
      if (why) refuse(inTheWay('finishing', carry, upstream, why));
      console.log(`  keeps   your edits to ${carry.join(', ')} are set aside and put back (git combines them with what GitHub merged)`);
    }
    if (!apply()) { console.log('\nplan only. Add --apply to do it (asks first).'); return; }
    if (!ask(`\nSwitch to ${base}, fast-forward and delete ${branch}?`, 'pull')) { console.log('nothing changed'); return; }
    const { rc, rp } = move({
      branch: base, upstream, before, commits, files, carry, verb: 'finishing', failed: `switching to ${base} failed`,
      step: () => {
        git('branch', '-f', base, upstream);
        try { git('switch', '-q', base); } catch (e) { git('branch', '-f', base, before); throw e; }
      },
      undo: () => { git('switch', '-q', branch); git('branch', '-f', base, before); },
    });
    git('branch', '-D', branch);
    if (remote) { try { git('push', '-q', 'origin', '--delete', branch); } catch (e) { console.log(`  couldn't delete ${branch} on GitHub: ${errLine(e)}`); } }
    console.log(H(`${branch} deleted (it was ${tip.slice(0, 7)}, merged as PR #${pr.number})`));
    told(rc, rp);
    afterPull(fresh, `finishing PR #${pr.number}, ${before.slice(0, 7)}..${rc.after.slice(0, 7)}`);
    return;
  }
  if (pr && pr.state === 'CLOSED') die(`PR #${pr.number} was closed without merging. To put this Mac back as before the send: steward config sync --rollback <its receipt> (find it with ls ${C.tilde(path.join(STATE, 'backups'))} | grep config-sync-send)`);
  const files = s.changed;
  const unpushed = s.upstream ? git('log', '--format=%h %s', `${s.upstream}..HEAD`).split('\n').filter(Boolean) : [];
  if (pr && !files.length && !unpushed.length) { console.log(`  waiting for you to merge PR #${pr.number}: ${pr.url}`); return; }
  if (files.length) console.log(`  add     ${files.length} file(s) to ${pr ? `PR #${pr.number}` : 'the branch'}: ${files.join(', ')}`);
  if (!pr) console.log(`  send    push ${branch} and open its PR against ${base}`);
  if (!apply()) { console.log('\nplan only. Add --apply to do it (asks first).'); return; }
  if (!ask(`\n${pr ? `Add these to PR #${pr.number}` : `Push ${branch} and open its PR`}?`, 'push')) { console.log('nothing changed'); return; }
  needGh();
  const reasons = why(files, s.kinds);
  const { title, body } = message(reasons, []);
  if (files.length) { git('add', '-A'); git('commit', '-q', '-m', title, '-m', body); }
  try { git('push', '-q', '-u', 'origin', branch); } catch (e) { die(`push failed: ${errLine(e)}`); }
  const found = findSend(branch);
  if (found) { found.rc.tip = git('rev-parse', 'HEAD'); found.rc.files = [...new Set([...found.rc.files, ...files])]; }
  if (!pr) {
    let url;
    try { url = gh('pr', 'create', '-R', s.slug, '--base', base, '--head', branch, '--title', title, '--body', body); } catch (e) { die(`gh pr create failed: ${errLine(e)}`); }
    if (found) { found.rc.pr = { number: Number((url.match(/\/pull\/(\d+)/) || [])[1]) || null, url }; found.rc.complete = true; }
    console.log(H(`sent as PR: ${url}`));
  } else console.log(H(`added to PR #${pr.number}: ${pr.url}`));
  if (found) fs.writeFileSync(found.rp, `${JSON.stringify(found.rc, null, 1)}\n`);
}

function rollback(file) {
  const rp = C.userPath(file);
  let rc;
  try { rc = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (e) { die(`can't read ${file}: ${e.message}`, 2); }
  if (!['config-sync', 'config-sync-send'].includes(rc.kind) || (rc.kind === 'config-sync' && !rc.complete)) die(`${file} is not a config sync receipt`, 2);
  if (rc.rolled_back) die(`already rolled back (${rc.rolled_back})`);
  const b = busy(); if (b) die(`a ${b} is in progress: finish or abort it first`);
  const head = tryGit('rev-parse', 'HEAD'), branch = tryGit('symbolic-ref', '--short', '-q', 'HEAD');
  if (rc.kind === 'config-sync') {
    if (branch !== rc.branch || head !== rc.after) die(`${rc.branch} moved since the sync (it's at ${(head || '?').slice(0, 7)}, the sync left ${rc.after.slice(0, 7)}): nothing changed`);
    // edits to files the sync changed (a carried edit, or one made since) are set aside and put back, as on the pull
    const carry = CR.state(dir).changed.filter(f => rc.files.includes(f));
    const why = carry.length ? combinable(carry, rc.before) : null;
    if (why) die(`your edits to ${carry.join(', ')} are in the way of moving back (${why}): nothing changed`, 2);
    console.log(`${C.tilde(dir)}: move ${rc.branch} back ${rc.commits.length} commit(s), to ${rc.before.slice(0, 7)}, stepping back over:`);
    for (const c of rc.commits) console.log(`  ${c}`);
    if (carry.length) console.log(`your edits to ${carry.join(', ')} are set aside and put back`);
    if (!ask(`Move ${rc.branch} back to ${rc.before.slice(0, 7)}?`, 'rollback')) { console.log('nothing changed'); return; }
    const save = () => fs.writeFileSync(rp, `${JSON.stringify(rc, null, 1)}\n`);
    const step = () => git('reset', '-q', '--keep', rc.before);
    if (carry.length) {
      rc.rollback_carried = {};
      const no = carryEdits(carry, path.join(path.dirname(rp), 'edits-at-rollback'), rc.rollback_carried, save, step, () => git('reset', '-q', '--keep', rc.after));
      if (no) { save(); die(`moving back would not keep your edits to ${carry.join(', ')} (${no}): nothing changed`, 2); }
    } else try { step(); } catch (e) { die(`git reset --keep refused (a local edit is in the way?): ${errLine(e)}`); }
    rc.rolled_back = new Date().toISOString();
    save();
    console.log(`moved back to ${rc.before.slice(0, 7)}; the next steward config sync pulls those commits again`);
    if (rc.files.some(f => f.startsWith('mise/'))) afterPull(rc.files, `rolling back ${rc.after.slice(0, 7)}`);
    return;
  }
  // a send: close the PR unless it merged, then this Mac back on base with the changes as they were before
  if (branch !== rc.branch || head !== rc.tip) die(`this Mac isn't on ${rc.branch} at ${String(rc.tip).slice(0, 7)} any more: nothing changed`);
  if (CR.state(dir).changed.length) die(`${rc.branch} has edits made after the send: send or move them aside first`);
  const slug = CR.githubRepo(tryGit('config', '--get', 'remote.origin.url'));
  const pr = slug ? prOf(slug, rc.branch) : null;
  if (pr && pr.state === 'MERGED') die(`PR #${pr.number} is merged: it's in ${rc.base} now; steward config sync finishes the switch`);
  console.log(`${C.tilde(dir)}: ${pr && pr.state === 'OPEN' ? `close PR #${pr.number}, ` : ''}delete ${rc.branch}, and put ${rc.base} back at ${rc.origHead.slice(0, 7)} with these as edits again: ${rc.files.join(', ') || '(none)'}${rc.commits.length ? `; ${rc.commits.length} commit(s) back on ${rc.base}` : ''}`);
  if (!ask('Undo the send?', 'rollback')) { console.log('nothing changed'); return; }
  if (pr && pr.state === 'OPEN') { try { gh('pr', 'close', String(pr.number), '-R', slug, '--delete-branch'); } catch (e) { die(`gh pr close failed, nothing changed: ${errLine(e)}`); } }
  git('branch', '-f', rc.base, rc.origHead);
  git('reset', '-q', '--soft', rc.origHead); // the branch's commit undone, its changes kept (staged) …
  git('switch', '-q', rc.base); // … onto base, which is at the same commit
  git('reset', '-q'); // and unstaged, as they were
  git('branch', '-D', rc.branch);
  rc.rolled_back = new Date().toISOString();
  fs.writeFileSync(rp, `${JSON.stringify(rc, null, 1)}\n`);
  console.log(`back on ${rc.base} at ${rc.origHead.slice(0, 7)}, with your changes as they were before the send`);
}

function sync() {
  const s = CR.state(dir, { fetch: !flag('--no-fetch') });
  if (s.inside) off(`your config (${C.tilde(dir)}) is inside another Git repository (${C.tilde(s.inside)}), not one of its own.`, ['keep it in a repository of its own: see "Keep the repo somewhere else"']);
  if (!s.repo) off(`your config (${C.tilde(dir)}) isn't a Git repository yet.`, [`cd ${C.tilde(dir)}`, `git init -b main && git add -A && git commit -m 'My steward config'`, createRepo.replace(`--source ${C.tilde(dir)}`, '--source .')]);
  if (!s.slug && !s.upstream && tryGit('config', '--get', 'remote.origin.url') === null) off('your config is a Git repository with no GitHub remote.', [createRepo]);
  if (!s.branch) die(`detached HEAD: ${at} switch <branch> first`);
  const b = busy(); if (b) die(`a ${b} is in progress: finish or abort it first`);
  if (s.fetchError) die(`fetch failed: ${s.fetchError}`);
  if (s.branch.startsWith(SEND)) return onSendBranch(s);
  if (!s.upstream) die(`${s.branch} has no upstream to follow: ${at} push -u origin ${s.branch}`);
  console.log(`${C.tilde(dir)}  (${s.slug || 'no GitHub remote'}, ${s.branch} → ${s.upstream})`);
  if (s.ahead && s.behind) die(`${s.branch} and ${s.upstream} have diverged (${s.ahead} commit(s) here, ${s.behind} there). The steward never merges or rebases: ${at} pull --rebase, by hand`);
  const base = s.upstream.replace(/^[^/]+\//, '');

  // pull
  let pull = null;
  if (s.behind) {
    const commits = git('log', '--format=%h %s', `HEAD..${s.upstream}`).split('\n').filter(Boolean);
    const files = git('diff', '--name-only', 'HEAD', s.upstream).split('\n').filter(Boolean);
    const inWay = s.changed.filter(f => files.includes(f));
    console.log(`  pull    ${commits.length} commit(s):`);
    for (const c of commits) console.log(`            ${c}`);
    console.log(`  files   ${files.join(', ')}`);
    if (inWay.length) {
      // an edit to a file the pull changes: set aside and put back when git can combine the two, else refuse
      const why = combinable(inWay, s.upstream);
      if (why) refuse(inTheWay('syncing', inWay, s.upstream, why));
      console.log(`  keeps   your edits to ${inWay.join(', ')} are set aside and put back (git combines them with the pull)`);
    }
    console.log(`  then    ${files.some(f => f.startsWith('mise/')) ? 'mise install (mise/ changed; asks), ' : ''}steward check`);
    pull = { commits, files, carry: inWay };
  }
  // send
  const local = s.changed.length || s.ahead;
  if (local) {
    console.log(`  send    ${s.changed.length} file(s)${s.ahead ? ` and ${s.ahead} commit(s)` : ''} as a PR to ${s.slug || '(no GitHub remote)'}, on a new ${SEND}<time> branch:`);
    for (const r of why(s.changed, s.kinds)) console.log(`            ${r.f.padEnd(28)} ${r.by}`);
    if (s.ahead) for (const c of git('log', '--format=%h %s', `${s.upstream}..HEAD`).split('\n').filter(Boolean)) console.log(`            ${c}`);
    console.log(`          this Mac stays on that branch until you merge the PR`);
  }
  if (!pull && !local) { console.log(`  up to date with ${s.upstream}; nothing to send`); return; }
  if (!apply()) { console.log(`\nplan only. Add --apply to do it (asks before each step; ${pull ? 'fast-forward only, ' : ''}never straight to ${base}).`); return; }

  if (pull) {
    if (ask(`\nFast-forward ${s.branch} to ${s.upstream}?`, 'pull')) fastForward(s.branch, s.upstream, pull.commits, pull.files, pull.carry);
    else if (local) { console.log('  not pulled; sending waits until it is, so the PR starts from GitHub\'s latest'); return; }
    else { console.log('nothing changed'); return; }
  }
  if (local) {
    needSlug(s);
    needGh();
    if (!ask(`\nSend ${s.changed.length} file(s)${s.ahead ? ` and ${s.ahead} commit(s)` : ''} as a PR to ${s.slug}?`, 'push')) { console.log('  not sent'); return; }
    send(CR.state(dir), base);
  }
}

if (flag('--rollback')) {
  const f = args[args.indexOf('--rollback') + 1];
  if (!f || f.startsWith('--')) die('usage: steward config sync --rollback <receipt.json>', 2);
  rollback(f);
} else sync();
