#!/usr/bin/env node
// Your config folder (the instance) as a Git repository (D50): its branch, the files changed here, the commits not
// pushed, and the commits GitHub has that this Mac doesn't. Read-only. Without --fetch nothing touches the network:
// "newer on GitHub" is as of the last fetch, which steward review does, and says when that was.
// Usage: configrepo.js              the status, in words (steward config shows it too)
//        configrepo.js --fetch      fetch first, then the status
//        configrepo.js --banner     one line when something needs you, else nothing (the steward banner)
//        configrepo.js --json
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./config.js');

// githubRepo(url) — owner/name from a GitHub remote, HTTPS or SSH; a dot belongs to the name (pacphi/site.me), and
// only a trailing .git is dropped (2026-10-28: the review asked GitHub for pacphi/chrisphillipson, not .me)
const githubRepo = url => (String(url || '').match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/) || [])[1];

const when = d => d.toLocaleString('sv-SE').slice(0, 16); // local time, as the other banners show it

// state(dir, { fetch }) — { dir, repo, top, inside, slug, branch, upstream, changed, ahead, behind, fetchedAt, fetchError }
function state(dir = C.INSTANCE_ROOT, { fetch = false } = {}) {
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: fetch ? 30e3 : 5e3 });
    return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
  };
  const s = { dir, repo: false, top: null, inside: null, slug: null, branch: null, upstream: null, changed: [], ahead: 0, behind: 0, fetchedAt: null, fetchError: null };
  s.top = git('rev-parse', '--show-toplevel');
  if (s.top === null) return s;
  // only a repository of its own counts: an instance inside another repo (examples/ in the engine) is not one
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  if (real(s.top) !== real(dir)) { s.inside = s.top; s.top = null; return s; }
  s.repo = true;
  s.slug = githubRepo(git('config', '--get', 'remote.origin.url'));
  s.branch = git('symbolic-ref', '--short', '-q', 'HEAD');
  s.upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (fetch && s.upstream) {
    const remote = s.upstream.split('/')[0];
    const r = spawnSync('git', ['-C', dir, 'fetch', '--quiet', '--prune', remote], { encoding: 'utf8', timeout: 30e3 });
    if (r.status !== 0) s.fetchError = (r.stderr || r.error?.message || 'fetch failed').trim().split('\n')[0];
  }
  // git status lists paths from the top, quoted when unusual; untracked files count (a new policy file is a change).
  // s.kinds: how each changed: 'new' (untracked or added), 'deleted', else 'edit'
  const st = (git('status', '--porcelain', '--untracked-files=all') || '').split('\n').filter(Boolean);
  s.changed = st.map(l => l.slice(3).replace(/^"|"$/g, ''));
  s.kinds = Object.fromEntries(st.map((l, i) => [s.changed[i], /^(\?\?|A)/.test(l) ? 'new' : l.slice(0, 2).includes('D') ? 'deleted' : 'edit']));
  if (s.upstream) {
    const [ahead, behind] = (git('rev-list', '--left-right', '--count', 'HEAD...@{u}') || '0\t0').split(/\s+/).map(Number);
    Object.assign(s, { ahead, behind });
  }
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  try { s.fetchedAt = common ? fs.statSync(path.join(common, 'FETCH_HEAD')).mtime : null; } catch { /* never fetched */ }
  return s;
}

// needs(s) — what needs you, in words, with the command that acts on it
function needs(s) {
  // config sync pulls from any upstream but sends only to GitHub; where it can't, show the git command instead
  const sync = s.slug ? 'steward config sync' : null, at = `git -C ${C.tilde(s.dir)}`;
  const out = [];
  if (s.branch && s.branch.startsWith('steward/sync-')) out.push({ text: `sent as a pull request from ${s.branch}: merge it on GitHub`, cmd: 'steward config sync' });
  if (s.changed.length) out.push({ text: `${s.changed.length} file(s) changed here: ${s.changed.slice(0, 4).join(', ')}${s.changed.length > 4 ? ' …' : ''}`, cmd: sync || `${at} status` });
  if (s.ahead) out.push({ text: `${s.ahead} commit(s) not pushed to ${s.upstream}`, cmd: sync || `${at} push` });
  if (s.behind) out.push({ text: `${s.behind} newer commit(s) on ${s.upstream}${s.fetchedAt ? ` (as of ${when(s.fetchedAt)})` : ''}`, cmd: 'steward config sync' });
  return out;
}

// banner() — one line when the config repo needs you; nothing when it's in step or not a repo
function banner() {
  const s = state();
  if (!s.repo) return;
  const parts = [];
  if (s.branch && s.branch.startsWith('steward/sync-')) parts.push('your pull request is waiting for a merge');
  if (s.changed.length) parts.push(`${s.changed.length} file(s) changed here`);
  if (s.ahead) parts.push(`${s.ahead} commit(s) not pushed`);
  if (s.behind) parts.push(`${s.behind} newer on GitHub (as of ${s.fetchedAt ? when(s.fetchedAt) : 'the last fetch'})`);
  if (!parts.length) return;
  console.log(`\x1b[1;33mconfig\x1b[0m ${parts.join(', ')}: ${s.slug || s.behind ? 'steward config sync' : 'steward config'}`); // config names the git command for each
}

// describe(s) — the status in words, for steward config and configrepo.js
function describe(s) {
  if (!s.repo) return [`repo:        not a Git repository of its own${s.inside ? ` (it's inside ${C.tilde(s.inside)})` : ''}, so config sync is off; docs/config-repo.md says how to set it up`];
  const lines = [`repo:        ${s.slug || 'no GitHub remote'} (${s.branch || 'detached HEAD'}${s.upstream ? ` → ${s.upstream}` : ', no upstream'})`];
  if (!s.slug && !s.upstream) lines.push('             config sync is off until it has one', `               → gh repo create <you>/steward-config --private --source ${C.tilde(s.dir)} --remote origin --push`);
  if (s.fetchError) lines.push(`             fetch failed: ${s.fetchError}`);
  for (const n of needs(s)) lines.push(`             ${n.text}`, `               → ${n.cmd}`);
  if (lines.length === 1) lines.push(`             in step${s.fetchedAt ? ` (as of ${when(s.fetchedAt)})` : ''}`);
  return lines;
}

module.exports = { githubRepo, state, needs, banner, describe };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--banner')) banner();
  else {
    const s = state(C.INSTANCE_ROOT, { fetch: args.includes('--fetch') });
    if (args.includes('--json')) console.log(JSON.stringify(s, null, 1));
    else for (const l of describe(s)) console.log(l);
  }
}
