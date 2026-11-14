// Kept packages (D88; owner, 2026-11-13): the steward's own copy of the OS packages a root upgrade replaces, so the way
// back is the exact build you had, even after the repos drop it (Fedora's updates repo keeps only its newest build;
// Tumbleweed on ARM has no archive at all). Used by lib/roothandoff.js for every source with needsRoot.
//   - before a root upgrade, as you (no sudo): each package's build from before (while the repos still offer it) and the
//     build it moves to are downloaded by the source's own tool (source.download: apt-get download, dnf5 download,
//     zypper download) into <state>/kept/<source>/<name>/, with each file's SHA-256 in that folder's index. The tool
//     checks the repository's signatures as it downloads
//   - the way back prefers a kept copy whose hash still matches; else what the repos still offer (D76's rule); else none,
//     said so. The hash is checked again just before sudo installs the file
//   - the first upgrade has a way back only when the repos still offer the build from before; every one after it does
//   - clean-up: per package, the newest [policy] kept_versions copies (default 2) and the installed build stay; older
//     copies are deleted, and the receipt names them. 0 keeps none
// Every command goes through ctx.run, so tests hand it stand-ins.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = (ctx, source) => path.join(ctx.cfg.paths.state, 'kept', source.id);
const safe = s => String(s).replace(/[^A-Za-z0-9._+-]/g, '_');
const indexFile = (ctx, source) => path.join(root(ctx, source), 'index.json');
const limit = ctx => {
  const n = Number(((ctx.cfg || {}).policy || {}).kept_versions);
  return Number.isInteger(n) && n >= 0 ? n : 2;
};

function load(ctx, source) {
  try { return JSON.parse(fs.readFileSync(indexFile(ctx, source), 'utf8')); } catch { return {}; }
}
function store(ctx, source, idx) {
  const f = indexFile(ctx, source);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(idx, null, 1)}\n`);
  fs.renameSync(`${f}.tmp`, f);
}
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// find(ctx, source, name, version) — {file, sha256} of a kept copy whose hash still matches, or null
function find(ctx, source, name, version) {
  const e = ((load(ctx, source)[name]) || {})[version];
  if (!e || !e.file) return null;
  try { return sha256(e.file) === e.sha256 ? { file: e.file, sha256: e.sha256 } : null; } catch { return null; }
}

// verified(item) — does the kept file a way-back item names still hash to what was recorded
function verified(item) {
  try { return Boolean(item.file && item.sha256 && sha256(item.file) === item.sha256); } catch { return false; }
}

// keep(ctx, source, name, version) — a kept copy of that build: the one already kept, else downloaded now; null when
// the source can't fetch it (the repos no longer offer it, or no network)
async function keep(ctx, source, name, version) {
  if (!limit(ctx) || !source.download || !version) return null;
  const have = find(ctx, source, name, version);
  if (have) return have;
  const base = root(ctx, source);
  const tmp = path.join(base, `.download-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const got = await source.download(ctx, name, version, tmp);
    if (!got || !fs.existsSync(got)) return null;
    const dest = path.join(base, safe(name), path.basename(got));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(got, dest);
    const e = { file: dest, sha256: sha256(dest), at: (ctx.now || new Date()).toISOString() };
    const idx = load(ctx, source);
    idx[name] = { ...(idx[name] || {}), [version]: e };
    store(ctx, source, idx);
    return { file: e.file, sha256: e.sha256 };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// keepAll(ctx, source, items) — before a root upgrade: keep each item's build from before and the one it moves to.
// {name: {have, want}}, each true when a copy is kept (a failed download never stops the upgrade)
async function keepAll(ctx, source, items) {
  const out = {};
  for (const i of items) {
    out[i.name] = {
      have: Boolean(i.have && await keep(ctx, source, i.name, i.have).catch(() => null)),
      want: Boolean(i.want && await keep(ctx, source, i.name, i.want).catch(() => null)),
    };
  }
  return out;
}

// prune(ctx, source, names, installed, named) — for each name, delete the copies past the newest kept_versions, never
// the installed build's nor a file a way back names (named: a Set of paths); the files removed
function prune(ctx, source, names, installed = {}, named = new Set()) {
  const n = limit(ctx), idx = load(ctx, source), gone = [];
  for (const name of names) {
    const vs = Object.entries(idx[name] || {}).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    vs.forEach(([v, e], k) => {
      if (k < n || v === installed[name] || named.has(e.file)) return;
      try { fs.rmSync(e.file, { force: true }); } catch { /* already gone */ }
      delete idx[name][v];
      gone.push(e.file);
    });
    if (idx[name] && !Object.keys(idx[name]).length) delete idx[name];
  }
  if (gone.length) store(ctx, source, idx);
  return gone;
}

// downloaded(dir, test) — the one file in dir whose name passes test, or null (the tools name files their own way)
function downloaded(dir, test) {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  let files = [];
  try { files = walk(dir).filter(f => test(path.basename(f))); } catch { return null; }
  return files.length === 1 ? files[0] : null;
}

module.exports = { keep, keepAll, find, verified, prune, downloaded, limit, root };
