#!/usr/bin/env node
// leak-check: nothing private in what the public engine repo gets (D39). Read-only.
// Usage: leak-check.js [folder] [--terms <file>]
//   folder: a public tree to check (an export, or the public repo itself). Without one, this checkout: when it is an
//           engine and an instance at once (it holds a steward.toml), an export of it (tools/export.js, the allow-list);
//           otherwise, as in the public repo, where every committed file is public, every tracked file and every new
//           file Git doesn't ignore (what the next commit could add).
//   terms:  private words to look for, one per line (# comments), case-insensitive, as whole names: repo, client
//           and user names.
//           Default: leak-terms.txt in the instance ($STEWARD_INSTANCE, …), so the list itself is never public.
// Checks: no instance or private files (steward.toml, the policy files, archive/, owner/), no registry with entries,
// no home paths (/Users/<name>, /home/<name>; /Users/x and the CI runner's are allowed), and no private term.
// Exit 0 clean, 1 something found (each with file:line), 2 a usage or setup error.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = f => { const i = argv.indexOf(f); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const termsArg = opt('--terms');
const die = m => { console.error(`leak-check: ${m}`); process.exit(2); };

let root = argv[0];
const ENGINE = path.join(__dirname, '..');
const exported = !root && fs.existsSync(path.join(ENGINE, 'steward.toml'));
let listed = null; // the files to check when this is a pure engine checkout: Git's view, not the whole folder
if (exported) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-export-'));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'export.js'), root, '--no-check'], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) die('the export failed');
} else if (!root) {
  root = ENGINE;
  const r = spawnSync('git', ['-C', ENGINE, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  if (r.status !== 0) die('git ls-files failed: not a Git checkout?');
  listed = [...new Set(r.stdout.split('\0').filter(Boolean))].filter(f => fs.existsSync(path.join(ENGINE, f)));
}
root = path.resolve(root);
if (!fs.existsSync(root)) die(`no folder ${root}`);

const termsFile = termsArg || (() => {
  try { return require('../lib/config.js').instance('leak-terms.txt'); } catch { return null; }
})();
const terms = termsFile && fs.existsSync(termsFile)
  ? fs.readFileSync(termsFile, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean)
  : [];

// walk(dir) — every file under dir, relative; symlinks are listed, not followed
function walk(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => {
    const r = path.join(rel, e.name);
    if (e.name === '.git') return [];
    return e.isDirectory() ? walk(dir, r) : [r];
  });
}
const files = listed || walk(root);
const hits = [];
const PRIVATE = /^(archive\/|owner\/|steward\.toml$|renovate\.json$|mise\/|supply-chain\/(host|hybrids)\.toml$|supply-chain\/verify\.tsv$|supply-chain\/vendor\/|ai-tooling\/ai-tooling\.toml$|projects\/registry\.toml$|leak-terms\.txt$)/;
for (const f of files) if (PRIVATE.test(f)) hits.push(`${f}: a private or instance file`);

const HOME_PATH = /\/(?:Users|home)\/(?!x\/|x\b|runner\b|<)[a-z][a-z0-9._-]*/g;
// a term counts as a whole name, not inside a longer word: `acme-app` matches `org/acme-app` and `acme-app-2`, not
// `acme-application` (a public vendor name can contain a private term)
const termRe = terms.length ? new RegExp(`(?<![A-Za-z0-9])(?:${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
for (const f of files) {
  const abs = path.join(root, f);
  if (fs.lstatSync(abs).isSymbolicLink()) continue;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;   // binary
  if (/(^|\/)registry\.toml$/.test(f) && /^\[\[project\]\]/m.test(text)) hits.push(`${f}: a registry with projects in it`);
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(HOME_PATH)) hits.push(`${f}:${i + 1}: a home path (${m[0]})`);
    if (termRe) for (const m of line.matchAll(termRe)) hits.push(`${f}:${i + 1}: a private term (${m[0]})`);
  });
}

console.log(`leak-check: ${files.length} files in ${exported ? 'an export of this checkout' : listed ? 'this checkout (tracked and new)' : root}; ` +
  `${terms.length ? `${terms.length} private term(s) from ${termsFile.replace(os.homedir(), '~')}` : 'no private terms file (structural checks only)'}`);
for (const h of hits) console.log(`  LEAK ${h}`);
console.log(hits.length ? `${hits.length} finding(s): fix them before anything goes public` : 'clean');
process.exit(hits.length ? 1 : 0);
