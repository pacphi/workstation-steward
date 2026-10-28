#!/usr/bin/env node
// export: build the public engine repo's tree from this checkout (D39). Copies only TRACKED files that tools/public.txt
// allows (untracked and ignored files can never leak), keeps symlinks as symlinks, writes the public CLAUDE.md
// (`@AGENTS.md` only), adds the instance files to .gitignore, then runs tools/leak-check.js on the result and lists
// any Markdown link that points at a file the export left out.
// Usage: export.js <empty-or-new-folder> [--no-check]       e.g. just export ../workstation-steward-public
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const [dest, ...flags] = process.argv.slice(2);
const die = m => { console.error(`export: ${m}`); process.exit(2); };
if (!dest) die('usage: export.js <empty-or-new-folder> [--no-check]');
const out = path.resolve(dest);
if (fs.existsSync(out) && fs.readdirSync(out).length) die(`${out} is not empty`);

// public.txt: includes, then `!` excludes that win
const rules = fs.readFileSync(path.join(__dirname, 'public.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const match = (f, p) => (p.endsWith('/') ? f.startsWith(p) : f === p);
const include = rules.filter(r => !r.startsWith('!'));
const exclude = rules.filter(r => r.startsWith('!')).map(r => r.slice(1));
const allowed = f => include.some(p => match(f, p)) && !exclude.some(p => match(f, p));

const tracked = spawnSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
const files = tracked.filter(allowed).filter(f => f !== 'CLAUDE.md');
fs.mkdirSync(out, { recursive: true });
for (const f of files) {
  const src = path.join(REPO, f), dst = path.join(out, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
  else { fs.copyFileSync(src, dst); fs.chmodSync(dst, st.mode & 0o777); }
}
fs.writeFileSync(path.join(out, 'CLAUDE.md'), '@AGENTS.md\n');
fs.appendFileSync(path.join(out, '.gitignore'), `
# --- An instance (your config) never belongs in the engine repo (D39) ---------------------------------------------
/steward.toml
/renovate.json
/mise/
/supply-chain/host.toml
/supply-chain/hybrids.toml
/supply-chain/verify.tsv
/supply-chain/vendor/
/ai-tooling/ai-tooling.toml
/projects/registry.toml
/leak-terms.txt
/archive/
/owner/
`);
console.log(`export: ${files.length + 1} files (of ${tracked.length} tracked) into ${out}`);
if (flags.includes('--no-check')) process.exit(0);

// Links that point at something the export left out (archive/, owner/, the instance): broken in the public repo
const kept = new Set([...files, 'CLAUDE.md']);
const broken = [];
for (const f of files.filter(x => x.endsWith('.md'))) {
  const text = fs.readFileSync(path.join(out, f), 'utf8');
  for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    const t = m[1];
    if (/^[a-z]+:/.test(t)) continue;
    const resolved = path.normalize(path.join(path.dirname(f), t)).replace(/\/$/, '');
    if (!kept.has(resolved) && !files.some(k => k.startsWith(`${resolved}/`)) && tracked.some(k => k === resolved || k.startsWith(`${resolved}/`))) broken.push(`${f} -> ${t}`);
  }
}
for (const b of broken) console.log(`  LINK into a private file: ${b}`);
if (broken.length) console.log(`${broken.length} link(s) point at files that stay private`);
const r = spawnSync(process.execPath, [path.join(__dirname, 'leak-check.js'), out], { stdio: 'inherit' });
process.exit(r.status || (broken.length ? 1 : 0));
