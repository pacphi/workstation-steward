#!/usr/bin/env node
// The maintainer's upstream watch (D52, docs/release-classes.md): for each [[updater]] the engine ships
// (supply-chain/host-defaults.toml) whose key pin names a `watch` URL, fetch the publisher's copy of the pinned file,
// find the pinned text with the pin's `match`, and hash it exactly as the steward hashes a machine's copy
// (lib/updaters.js pinHash). Each entry is unchanged, changed (with the new hash), could not be checked (with the
// reason), or skipped (no watch URL). Read-only: it changes no file and opens no pull request.
// With --issues (the weekly workflow, .github/workflows/upstream-watch.yml) a change also opens an issue labelled
// owner-decision, one per entry, found again by its title; a later run comments on it only when the upstream hash has
// moved since the last report. Issues are filed only in this package's own repository (package.json), so a private
// copy of the engine reports without filing. The label is created if the repository doesn't have it yet.
// Exit: 0 = every watched pin is unchanged; 10 = at least one changed; 1 = at least one couldn't be checked.
// With --issues a change is reported by its issue, so: 0 = nothing to check by hand; 1 = a pin couldn't be checked,
// or its issue couldn't be filed.
// Usage: upstream-watch.js [--issues] [--file <host-defaults.toml>]
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const U = require('../lib/updaters.js');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = path.join(ROOT, 'supply-chain', 'host-defaults.toml');
const LABEL = 'owner-decision';
const TIMEOUT_MS = 30e3;

// marker(name, have) — the hidden line each report carries, so a later run knows which hash it last reported
const marker = (name, have) => `<!-- upstream-watch:${name} sha256=${have} -->`;
const MARKER = /<!-- upstream-watch:(\S+) sha256=([0-9a-f]{64}) -->/g;
// title(name) — the issue's title: stable, so the next run finds the same issue
const title = name => `Upstream watch: the key pinned for ${name} changed`;
const short = h => `${String(h).slice(0, 12)}…`;

// history(url) — for a raw.githubusercontent.com URL, the file's commit history on GitHub; otherwise none
function history(url) {
  const m = String(url).match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/commits/${m[3]}/${m[4]}` : null;
}

// checkOne(u, {fetch}) — {name, state, url, pinned, have?, why?}; state is unchanged, changed, unknown or skipped.
// Never throws: a network error, an HTTP error or a match that finds nothing is unknown, with the reason
async function checkOne(u, { fetch }) {
  const pin = u.pin || {};
  const base = { name: u.name, url: pin.watch, pinned: String(pin.sha256 || '').toLowerCase() };
  if (!pin.watch) return { ...base, state: 'skipped', why: 'no watch URL' };
  let text;
  try {
    const res = await fetch(pin.watch, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ...base, state: 'unknown', why: `HTTP ${res.status} from ${pin.watch}` };
    text = await res.text();
  } catch (e) {
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    return { ...base, state: 'unknown', why: `network: ${e && e.message}${cause ? ` (${cause})` : ''}` };
  }
  const h = U.pinHash(text, pin);
  if (!h.found) return { ...base, state: 'unknown', why: `no match: the pin's match finds nothing in ${pin.watch}` };
  return { ...base, state: h.ok ? 'unchanged' : 'changed', have: h.have };
}

// watch(updaters, {fetch}) — checkOne for each entry that has a pin, in order (entries without a pin aren't listed)
async function watch(updaters, { fetch }) {
  const out = [];
  for (const u of (updaters || []).filter(x => x && x.pin)) out.push(await checkOne(u, { fetch }));
  return out;
}

// line(r) — one entry's report
function line(r) {
  if (r.state === 'skipped') return `${r.name}: skipped (${r.why})`;
  if (r.state === 'unchanged') return `${r.name}: unchanged (sha256 ${short(r.have)} at ${r.url})`;
  if (r.state === 'changed') return `${r.name}: CHANGED: the pinned text at ${r.url} now hashes to ${r.have}, not the reviewed ${r.pinned}`;
  return `${r.name}: could not check: ${r.why}`;
}

// body(r, {runUrl, repo}) — a new issue's text, or (comment) the text of a later report on it
function body(r, { runUrl, repo }, comment = false) {
  const runbook = `https://github.com/${repo}/blob/main/docs/maintainers.md#a-shipped-default-changed-upstream`;
  const seen = `${new Date().toISOString().slice(0, 10)}${runUrl ? ` ([run](${runUrl}))` : ''}`;
  const hist = history(r.url);
  if (comment) {
    return [marker(r.name, r.have), `The upstream hash moved again: it is now \`${r.have}\` (seen ${seen}). The reviewed pin is still \`${r.pinned}\`.`].join('\n\n');
  }
  return [
    marker(r.name, r.have),
    `The publisher's copy of the file that \`${r.name}\`'s key pin checks has changed: the text the pin's \`match\` finds no longer hashes to the reviewed \`sha256\`. That text is the key the tool's updater checks its signed data with, so the key may have been rotated.`,
    `Until the pin is reviewed, a machine that receives the new file refuses it: \`steward sc upgrade\` puts the reviewed file back and stops, and \`steward sc audit\` reports the mismatch.`,
    [
      '| | |',
      '| --- | --- |',
      `| Entry | \`${r.name}\` in \`supply-chain/host-defaults.toml\` |`,
      `| Watched file | ${r.url} |`,
      hist ? `| Its history | ${hist} |` : null,
      `| Pinned sha256 (reviewed) | \`${r.pinned}\` |`,
      `| sha256 upstream now | \`${r.have}\` |`,
      `| Seen | ${seen} |`,
    ].filter(Boolean).join('\n'),
    `**What to do:** follow the runbook, [A shipped default changed upstream](${runbook}). Confirm the new key from the publisher's own release notes or announcement, then update \`sha256\` and \`why\` in a reviewed engine PR, or turn the default off. Close this issue with that PR.`,
    'Opened by the weekly upstream watch (`.github/workflows/upstream-watch.yml`). It only reads: it never changes code or opens a pull request.',
  ].join('\n\n');
}

// ownRepo() — owner/name from package.json's repository URL (as tools/publish-guard.js reads it)
function ownRepo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return (String((pkg.repository && pkg.repository.url) || '').match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/) || [])[1];
}

// ghRun(args, input) — the gh CLI: {status, stdout, stderr}, never thrown
function ghRun(args, input) {
  const r = spawnSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  return { status: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.error ? String(r.error.message) : r.stderr || '' };
}

// fileIssues(results, {gh, repo, runUrl}) — for each changed entry: open its issue (creating the label first if the
// repository lacks it), or comment on the open one when the hash moved since its last report, or leave it be.
// Returns [{name, action: created | commented | already | failed, number?, why?}]
function fileIssues(results, { gh, repo, runUrl }) {
  const changed = results.filter(r => r.state === 'changed');
  if (!changed.length) return [];
  const R = ['--repo', repo];
  const fail = (r, what, x) => ({ name: r.name, action: 'failed', why: `${what}: ${(x.stderr || x.stdout).trim()}` });
  const labels = gh(['label', 'list', ...R, '--limit', '500', '--json', 'name']);
  if (labels.status !== 0) return changed.map(r => fail(r, 'gh label list', labels));
  if (!JSON.parse(labels.stdout || '[]').some(l => l.name === LABEL)) {
    const made = gh(['label', 'create', LABEL, ...R, '--color', 'FBCA04', '--description', "Waits for the owner's decision"]);
    if (made.status !== 0) return changed.map(r => fail(r, `gh label create ${LABEL}`, made));
  }
  const open = gh(['issue', 'list', ...R, '--state', 'open', '--label', LABEL, '--limit', '500', '--json', 'number,title']);
  if (open.status !== 0) return changed.map(r => fail(r, 'gh issue list', open));
  const issues = JSON.parse(open.stdout || '[]');
  return changed.map(r => {
    const found = issues.find(i => i.title === title(r.name));
    if (!found) {
      const made = gh(['issue', 'create', ...R, '--title', title(r.name), '--label', LABEL, '--body-file', '-'], body(r, { runUrl, repo }));
      if (made.status !== 0) return fail(r, 'gh issue create', made);
      return { name: r.name, action: 'created', number: Number((made.stdout.match(/\/issues\/(\d+)/) || [])[1]) || undefined };
    }
    const view = gh(['issue', 'view', String(found.number), ...R, '--json', 'body,comments']);
    if (view.status !== 0) return fail(r, 'gh issue view', view);
    const j = JSON.parse(view.stdout || '{}');
    const texts = [j.body || '', ...(j.comments || []).map(c => c.body || '')].join('\n');
    const last = [...texts.matchAll(MARKER)].filter(m => m[1] === r.name).map(m => m[2]).pop();
    if (last === r.have) return { name: r.name, action: 'already', number: found.number };
    const said = gh(['issue', 'comment', String(found.number), ...R, '--body-file', '-'], body(r, { runUrl, repo }, true));
    if (said.status !== 0) return fail(r, 'gh issue comment', said);
    return { name: r.name, action: 'commented', number: found.number };
  });
}

// readDefaults(file) — the shipped [[updater]] entries, parsed the way lib/host.js parses host-defaults.toml
const readDefaults = file => (JSON.parse(execFileSync('yq', ['-p', 'toml', '-o', 'json', '.', file], { encoding: 'utf8' })) || {}).updater || [];

/** @typedef {(url: string, init?: object) => Promise<{ok: boolean, status: number, text: () => Promise<string>}>} Fetch */
/** @typedef {(args: string[], input?: string) => {status: number, stdout: string, stderr: string}} Gh */

// main(argv, {fetch, gh, env, print}) — the exit status above
/** @param {string[]} argv @param {{fetch?: Fetch, gh?: Gh, env?: NodeJS.ProcessEnv, print?: (line: string) => void}} [o] */
async function main(argv, { fetch = globalThis.fetch, gh = ghRun, env = process.env, print = console.log } = {}) {
  const at = argv.indexOf('--file');
  const file = at >= 0 ? argv[at + 1] : DEFAULTS;
  const results = await watch(readDefaults(file), { fetch });
  const watched = results.filter(r => r.state !== 'skipped').length;
  const report = [`upstream watch: ${watched} shipped key pin(s) with a watch URL, in ${path.relative(ROOT, file) || file}`, ...results.map(r => `  ${line(r)}`)];
  for (const l of report) print(l);
  let status = results.some(r => r.state === 'unknown') ? 1 : results.some(r => r.state === 'changed') ? 10 : 0;

  if (argv.includes('--issues')) {
    const own = ownRepo();
    if (!env.GITHUB_REPOSITORY || env.GITHUB_REPOSITORY !== own) {
      print(`issues: not filed; they go to ${own} only, and this is ${env.GITHUB_REPOSITORY || 'not a GitHub Actions run'}`);
    } else {
      const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
      const filed = fileIssues(results, { gh, repo: own, runUrl });
      for (const f of filed) {
        const l = f.action === 'failed' ? `issue for ${f.name}: FAILED: ${f.why}` : `issue for ${f.name}: ${f.action}${f.number ? ` #${f.number}` : ''}`;
        report.push(`  ${l}`);
        print(l);
      }
      // the change is reported by its issue; the run fails only for what still needs a look
      status = results.some(r => r.state === 'unknown') || filed.some(f => f.action === 'failed') ? 1 : 0;
    }
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## Upstream watch\n\n\`\`\`text\n${report.join('\n')}\n\`\`\`\n`);
  return status;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(s => { process.exitCode = s; }, e => { console.error(`upstream-watch: ${e.message}`); process.exitCode = 1; });
}

module.exports = { checkOne, watch, fileIssues, main, title, marker, history, LABEL };
