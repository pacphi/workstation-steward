#!/usr/bin/env node
// Build projects/profiles/known-units.json (D42, F3): the hash of every unit (a helper, a skill's folder, a command or
// agent file, AQE's hook) that a published Ruflo, claude-flow or agentic-qe release ships under a .claude folder.
// `steward projects reconcile` treats a project's unit with no receipt baseline as an unedited copy when its hash is
// listed, so it updates it like one the steward wrote.
// Source: jsDelivr's per-file sha256 listing of each npm version (no tarballs). Versions are sampled, then narrowed:
// between two fetched versions whose .claude units differ, the middle one is fetched, until every change is found.
// Versions between two identical ones are assumed identical (a change and its revert in between would be missed).
// Before writing, the listings for the installed Ruflo CLI and AQE versions are checked byte for byte against the
// installs on this machine; any mismatch stops the build.
// Listings are cached under $XDG_CACHE_HOME/workstation-steward/jsdelivr. Rerun after qualifying a new release.
// Usage: known-units.js [--per <n>]      (n sampled versions per package before narrowing; default 26)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PKGS = ['@claude-flow/cli', 'claude-flow', 'agentic-qe'];
const OUT = path.join(__dirname, '..', 'projects', 'profiles', 'known-units.json');
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'workstation-steward', 'jsdelivr');

const hex = b64 => Buffer.from(b64, 'base64').toString('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// unitOf(rel) — {unit, inner} for a path under .claude/, or null: helpers and skills are units by top-level entry
// (inner = the path inside a folder entry), commands and agents by file, and AQE's hook file (profiles.js byEntry)
function unitOf(rel) {
  const m = rel.match(/^(helpers|skills)\/([^/]+)(?:\/(.+))?$/);
  if (m) return { unit: `.claude/${m[1]}/${m[2]}`, inner: m[3] || '' };
  if (/^(commands|agents)\/./.test(rel) || rel === 'hooks/aqe-hook.cjs') return { unit: `.claude/${rel}`, inner: '' };
  return null;
}

// units(files) — Map unit → [hashes] for one version's listing [{name, hash (base64 sha256)}]: every .claude folder in
// the package counts (the shipped one and any template copy). A folder unit's hash is lib/onboard.js unitHash's: each
// file's relative path and sha256, sorted by path.
function units(files) {
  const roots = new Map();
  for (const f of files) {
    const k = f.name.lastIndexOf('/.claude/');
    if (k < 0) continue;
    const root = f.name.slice(0, k);
    if (!roots.has(root)) roots.set(root, []);
    roots.get(root).push({ rel: f.name.slice(k + 9), hex: hex(f.hash) });
  }
  const out = new Map();
  const add = (u, h) => { if (!out.has(u)) out.set(u, []); if (!out.get(u).includes(h)) out.get(u).push(h); };
  for (const fs_ of roots.values()) {
    const folders = new Map();
    for (const f of fs_) {
      const u = unitOf(f.rel);
      if (!u) continue;
      if (!u.inner) { add(u.unit, f.hex); continue; }
      if (!folders.has(u.unit)) folders.set(u.unit, []);
      folders.get(u.unit).push(u);
      u.hex = f.hex;
    }
    for (const [u, list] of folders) {
      const h = crypto.createHash('sha256');
      for (const f of list.sort((a, b) => byName(a.inner, b.inner))) h.update(`${f.inner}\0${f.hex}\0`);
      add(u, h.digest('hex'));
    }
  }
  return out;
}

// signature(units) — one hash of a version's whole .claude content, to tell versions apart
const signature = m => crypto.createHash('sha256').update(JSON.stringify([...m].sort((a, b) => byName(a[0], b[0])).map(([u, h]) => [u, [...h].sort()]))).digest('hex');

// narrow(n, sigOf, {per, batch}) — the version indexes (0…n-1) to fetch: `per` evenly spaced, then the middle of every
// pair of neighbours whose signatures differ, until neighbours are adjacent or equal. sigOf(i) is async (null when a
// listing can't be read, which counts as different).
async function narrow(n, sigOf, o = {}) {
  const per = Math.min(o.per || 26, n), batch = o.batch || 8;
  const seen = new Map();
  const get = async i => { if (!seen.has(i)) seen.set(i, await sigOf(i)); return seen.get(i); };
  const start = [...new Set(Array.from({ length: per }, (_, k) => Math.round((k * (n - 1)) / Math.max(per - 1, 1))))];
  for (let k = 0; k < start.length; k += batch) await Promise.all(start.slice(k, k + batch).map(get));
  let pairs = start.slice(1).map((b, k) => [start[k], b]);
  while (pairs.length) {
    const next = [];
    const mids = [];
    for (const [a, b] of pairs) {
      if (b - a <= 1) continue;
      const sa = seen.get(a), sb = seen.get(b);
      if (sa !== null && sa === sb) continue;
      const m = Math.floor((a + b) / 2);
      mids.push(m);
      next.push([a, m], [m, b]);
    }
    for (let k = 0; k < mids.length; k += batch) await Promise.all(mids.slice(k, k + batch).map(get));
    pairs = next;
  }
  return [...seen.keys()].sort((a, b) => a - b);
}

async function getJSON(url, file) {
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(j)); }
  return j;
}
const listing = (name, v) => getJSON(`https://data.jsdelivr.com/v1/packages/npm/${name}@${v}?structure=flat`, path.join(CACHE, `${name.replace(/[@/]/g, '_')}@${v}.json`));

// verify(name, v, dir) — mismatches between jsDelivr's listing of name@v and the install at dir (its .claude files)
async function verify(name, v, dir) {
  const j = await listing(name, v);
  if (!j) return [`no jsDelivr listing for ${name}@${v}`];
  const bad = [];
  for (const f of j.files.filter(x => x.name.startsWith('/.claude/'))) {
    const p = path.join(dir, f.name);
    if (!fs.existsSync(p)) continue; // a file the install doesn't carry (an excluded or pruned one) proves nothing
    if (crypto.createHash('sha256').update(fs.readFileSync(p)).digest('base64') !== f.hash) bad.push(`${name}@${v}${f.name}`);
  }
  return bad;
}

module.exports = { unitOf, units, signature, narrow };

if (require.main === module) (async () => {
  const pi = process.argv.indexOf('--per');
  const per = pi > 0 ? Number(process.argv[pi + 1]) : 26;
  const { progress } = require('../lib/progress.js');
  const F = require('../lib/profiles.js');
  const ph = F.placeholders(os.homedir());
  const pg = progress(PKGS.length + 2);

  let st = pg.stage('check jsDelivr against the installs on this machine');
  const installed = [['@claude-flow/cli', ph.RUFLO_CLI], ['agentic-qe', ph.AQE_PKG]];
  const bad = [];
  for (const [name, dir] of installed) {
    const v = ((JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version) || '').replace(/-local\..*$/, '');
    bad.push(...await verify(name, v, dir));
  }
  if (bad.length) { st.done(`${bad.length} mismatch(es)`); console.error(`jsDelivr disagrees with the installs:\n  ${bad.slice(0, 10).join('\n  ')}`); process.exitCode = 1; return; }
  st.done('identical');

  const known = new Map(); // unit → Map(hash → Map(pkg → [versions]))
  let fetched = 0;
  for (const name of PKGS) {
    st = pg.stage(name);
    const meta = await getJSON(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
    const vs = Object.keys(meta.versions).filter(v => meta.time[v]).sort((a, b) => byName(meta.time[a], meta.time[b]));
    const byIdx = new Map();
    const idx = await narrow(vs.length, async i => {
      st.detail(`${byIdx.size + 1} listings (${vs[i]})`);
      const j = await listing(name, vs[i]);
      if (!j) return null;
      const u = units(j.files);
      byIdx.set(i, u);
      return signature(u);
    }, { per });
    for (const i of idx) for (const [u, hs] of byIdx.get(i) || []) for (const h of hs) {
      if (!known.has(u)) known.set(u, new Map());
      const m = known.get(u);
      if (!m.has(h)) m.set(h, new Map());
      const p = m.get(h);
      if (!p.has(name)) p.set(name, []);
      p.get(name).push(vs[i]);
    }
    fetched += idx.length;
    st.done(`${idx.length} of ${vs.length} versions read`);
  }

  st = pg.stage('write');
  const out = { built: new Date().toISOString().slice(0, 10), source: 'jsDelivr per-file sha256 listings of the npm releases (tools/known-units.js)', packages: PKGS, units: {} };
  for (const [u, m] of [...known].sort((a, b) => byName(a[0], b[0]))) {
    out.units[u] = {};
    for (const [h, p] of m) out.units[u][h] = [...p].map(([name, v]) => (v.length > 1 ? `${name} ${v[0]}…${v[v.length - 1]}` : `${name} ${v[0]}`)).join('; ');
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0).replace(/^\{/, '{\n').replace(/\}$/, '\n}') + '\n');
  st.done(`${Object.keys(out.units).length} units, ${[...known.values()].reduce((s, m) => s + m.size, 0)} hashes, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB from ${fetched} listings`);
})().catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
