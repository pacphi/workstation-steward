// zypper as a package source (parity zypper 1a, D85; 1b, D86; D-a per package): openSUSE Leap, the suse family. Reading
// is as the user; the upgrade goes through lib/roothandoff.js (D-b), as apt's and dnf's: each package pinned to the exact
// edition the plan judged, and the way back an --oldpackage install of the edition from before, while the repos still
// offer it (Leap's update repo keeps older builds: zypper's step 0).
//   - its own metadata cache: zypper runs as the user with --cache-dir under <state>/zypper, so the system's cache is
//     never touched and no sudo is needed (checked as an unprivileged user on Leap 16.0 and Tumbleweed, zypper's step 0,
//     2026-11-12; about 84 MB)
//   - each new version dated by the issued time of the patch that brings it, from the update repo's own updateinfo,
//     which zypper keeps in that cache: on Leap 16.0 none of 1,057 patches was issued more than 30 minutes before its
//     packages reached the repo, and a late one errs on the safe side (step 0). So, unlike Fedora's (D81), the issued
//     time is the date, and no web service is asked. A version in no patch (the release's own repo) is dated by the
//     first-seen clock, as on Mint
//   - a version in a patch of category security is taken at once and names the patch, as apt's security pocket does
//   - Tumbleweed is not read here: its repo has no patches and keeps only the newest build, and it is updated as a whole
//     (zypper dup). The owner chose snapshot mode (2026-11-13): a later PR moves it whole to the newest snapshot past
//     the gate; until then it is "not checked"
// Every command goes through ctx.run, so tests hand it canned output.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const apt = require('./apt.js');

const id = 'zypper';

// dir(ctx) — where the steward keeps its own zypper metadata and its first-seen clock
const dir = ctx => path.join(ctx.cfg.paths.state, 'zypper');
// opts(ctx) — zypper's global options: never a question, the steward's own cache
const opts = ctx => ['--non-interactive', `--cache-dir=${dir(ctx)}/cache`];

// attrs(tag) — {name: value} of one XML start tag's attributes, entities decoded
const ent = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function attrs(tag) {
  const out = {};
  for (const m of String(tag).matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = ent(m[2]);
  for (const m of String(tag).matchAll(/([\w:-]+)\s*=\s*'([^']*)'/g)) out[m[1]] = ent(m[2]);
  return out;
}

// parseUpdates(xml) — [{name, want, have, arch, repo}] from `zypper --xmlout list-updates`: each <update kind="package">,
// its edition (the new version), edition-old (the installed one), and its <source alias>
function parseUpdates(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<update\s([^>]*?)(\/>|>([\s\S]*?)<\/update>)/g)) {
    const a = attrs(m[1]);
    if (a.kind !== 'package' || !a.name || !a.edition) continue;
    const src = attrs(((m[3] || '').match(/<source\b[^>]*>/) || [''])[0]);
    out.push({ name: a.name, want: a.edition, have: a['edition-old'] || '', arch: a.arch || '', repo: src.alias || '' });
  }
  return out;
}

// evr(p) — a package's epoch:version-release as zypper writes an edition: epoch 0 left out
const evr = p => `${p.epoch && p.epoch !== '0' ? `${p.epoch}:` : ''}${p.version}-${p.release}`;

// issuedISO(v) — a patch's issued date as ISO: openSUSE's updateinfo gives epoch seconds; a "YYYY-MM-DD HH:MM:SS" is UTC
function issuedISO(v) {
  const s = String(v || '').trim();
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}Z` : '';
}

// parseUpdateinfo(xml) — {"name edition": {id, issued, security}} from a repo's updateinfo.xml: every package each patch
// lists; a version in more than one patch keeps the earliest issued, and is security if any of them is
function parseUpdateinfo(xml) {
  const out = {};
  for (const m of String(xml).matchAll(/<update\s([^>]*)>([\s\S]*?)<\/update>/g)) {
    const a = attrs(m[1]), body = m[2];
    const pid = ((body.match(/<id>([^<]*)<\/id>/) || [])[1] || '').trim();
    const issued = issuedISO(attrs((body.match(/<issued\b[^>]*>/) || [''])[0]).date);
    const security = a.type === 'security';
    if (!pid) continue;
    for (const p of body.matchAll(/<package\b([^>]*?)\/?>/g)) {
      const pa = attrs(p[1]);
      if (!pa.name || !pa.version) continue;
      const key = `${pa.name} ${evr(pa)}`, had = out[key];
      if (!had || (issued && (!had.issued || issued < had.issued))) out[key] = { id: pid, issued, security: security || (had ? had.security : false) };
      else if (security) had.security = true;
    }
  }
  return out;
}

// readMaybe(file) — a metadata file's text, gunzipped or un-zstd'ed as its name says; '' when it can't be read
function readMaybe(file) {
  try {
    const b = fs.readFileSync(file);
    if (file.endsWith('.gz')) return zlib.gunzipSync(b).toString('utf8');
    if (file.endsWith('.zst')) return typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync(b).toString('utf8') : '';
    return b.toString('utf8');
  } catch { return ''; }
}

// updateinfo(ctx) — every patch's packages across the repos in the steward's cache (raw/<alias>/repodata/*updateinfo*),
// merged as parseUpdateinfo merges one repo's
function updateinfo(ctx) {
  const raw = path.join(dir(ctx), 'cache', 'raw');
  const files = [];
  let repos = [];
  try { repos = fs.readdirSync(raw); } catch { return {}; }
  for (const r of repos) {
    const rd = path.join(raw, r, 'repodata');
    let names = [];
    try { names = fs.readdirSync(rd); } catch { continue; }
    for (const n of names) if (/updateinfo\.xml(\.gz|\.zst)?$/.test(n)) files.push(path.join(rd, n));
  }
  const out = {};
  for (const f of files) {
    for (const [k, v] of Object.entries(parseUpdateinfo(readMaybe(f)))) {
      const had = out[k];
      if (!had || (v.issued && (!had.issued || v.issued < had.issued))) out[k] = { ...v, security: v.security || (had ? had.security : false) };
      else if (v.security) had.security = true;
    }
  }
  return out;
}

// release(ctx) — {id, version} from this machine's os-release
function release(ctx) {
  for (const f of ['etc/os-release', 'usr/lib/os-release']) {
    let t; try { t = fs.readFileSync(path.join(ctx.sysroot || '/', f), 'utf8'); } catch { continue; }
    const v = k => ((t.match(new RegExp(`^${k}=["']?([^"'\\n]*)`, 'm')) || [])[1] || '');
    return { id: v('ID'), version: v('VERSION_ID') };
  }
  return { id: '', version: '' };
}
const rolling = ctx => /tumbleweed|slowroll/.test(release(ctx).id);

// what each audit learned, per run: the upgrades and the patches, by "name edition"
const seen = new WeakMap();
const memo = ctx => { if (!seen.has(ctx)) seen.set(ctx, { items: {}, patches: null }); return seen.get(ctx); };
const patches = ctx => { const m = memo(ctx); if (!m.patches) m.patches = updateinfo(ctx); return m.patches; };

// outdated(ctx) — what zypper would update, from the steward's own cache (refreshed as zypper's autorefresh says, as the
// user: no sudo). On Tumbleweed, nothing: it is not checked here (see manual)
async function outdated(ctx) {
  if (rolling(ctx)) return [];
  const r = await ctx.run('zypper', [...opts(ctx), '--xmlout', 'list-updates']);
  const ups = parseUpdates(r.stdout);
  if (!ups.length) return [];
  const p = patches(ctx), m = memo(ctx);
  return ups.map(u => {
    const pt = p[`${u.name} ${u.want}`];
    const it = { name: u.name, have: u.have || '?', want: u.want, arch: u.arch, repo: u.repo, ...(pt && pt.security ? { advisory: pt.id } : {}) };
    m.items[`${u.name} ${u.want}`] = { ...it, patch: pt || null };
    return it;
  });
}

// releaseDate(ctx, name, want) — {date, from}: the issued time of the patch that brings it, else the first-seen clock
async function releaseDate(ctx, name, want) {
  const it = memo(ctx).items[`${name} ${want}`] || {};
  const pt = it.patch || patches(ctx)[`${name} ${want}`];
  if (pt && pt.issued) return { date: pt.issued, from: `patch ${pt.id}` };
  return { date: apt.firstSeen(path.join(dir(ctx), 'first-seen.json'), `${name} ${want}`, ctx.now), from: 'first seen here' };
}

// manual(ctx) — Tumbleweed's gap, said rather than shown as up to date
async function manual(ctx) {
  return rolling(ctx) ? ['Tumbleweed: not checked: a rolling release is updated as a whole (zypper dup), and how the steward gates it is still to be decided; Leap is checked package by package'] : [];
}

// pin(i) — name=edition for a planned item: zypper takes the exact version (zypper's step 0)
const pin = i => (typeof i === 'string' ? i : `${i.name}=${i.want}`);

// parseInstalled(text) — {name: edition} from `rpm -q --qf '%{NAME} %{EPOCHNUM}:%{VERSION}-%{RELEASE}\n'`, epoch 0 dropped
// as zypper's editions drop it; a package not installed is left out
const parseInstalled = text => Object.fromEntries(String(text).split('\n').map(l => l.trim().split(/\s+/)).filter(f => f.length === 2 && !f[1].includes('not installed'))
  .map(([n, v]) => [n, v.replace(/^0:/, '')]));

// installed(ctx, names) — {name: edition} of those installed, read as you (rpm)
async function installed(ctx, names) {
  if (!names.length) return {};
  const have = parseInstalled((await ctx.run('rpm', ['-q', '--qf', '%{NAME} %{EPOCHNUM}:%{VERSION}-%{RELEASE}\n', ...names])).stdout);
  return Object.fromEntries(Object.entries(have).filter(([n]) => names.includes(n)));
}

// parseSearch(xml, name) — every edition of name the repos offer, from `zypper --xmlout search --details --match-exact
// --type package <name>`: each <solvable> of that name from a repository (the rpm database's own row is not an offer)
function parseSearch(xml, name) {
  const out = [];
  for (const m of String(xml).matchAll(/<solvable\s([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.name !== name || !a.edition || (a.kind && a.kind !== 'package')) continue;
    if (!a.repository || /^\(?System Packages\)?$|^@System$/.test(a.repository)) continue;
    if (!out.includes(a.edition)) out.push(a.edition);
  }
  return out;
}

// offered(ctx, name) — the editions of name the repos offer, from the steward's own cache, as you
async function offered(ctx, name) {
  const r = await ctx.run('zypper', [...opts(ctx), '--xmlout', 'search', '--details', '--match-exact', '--type', 'package', name]);
  return parseSearch(r.stdout, name);
}

// download(ctx, name, version, dest) — that edition's .rpm into dest (--pkg-cache-dir), as you, from the steward's own
// cache, the installed architecture only (zypper checks the repository's signatures); the file, or null (D88)
async function download(ctx, name, version, dest) {
  const a = await require('./dnf.js').arch(ctx, name);
  await ctx.run('zypper', [...opts(ctx), `--pkg-cache-dir=${dest}`, 'download', `${name}${a ? `.${a}` : ''}=${version}`]);
  const file = `${name}-${version.replace(/^\d+:/, '')}.`;
  return require('../kept.js').downloaded(dest, b => b.startsWith(file) && b.endsWith('.rpm') && !b.endsWith('.src.rpm'));
}

const source = {
  id, check: 'zypper', provider: id, name: 'zypper packages', title: 'zypper packages', noun: 'zypper package(s)', tag: 'zypper',
  platforms: ['linux'], families: ['suse'], gateMode: 'per-package', exceptionKind: 'zypper', exceptionVersion: want => want,
  needsRoot: true, heldEta: true,
  back: 'steward sc rollback <receipt> (it printed its receipt above): the kept copy of each edition from before, else the one the repos still offer',
  pocketWhy: 'security patch', securityPocket: item => (item && item.advisory) || '',
  available: async ctx => (await ctx.run('zypper', ['--version'])).status === 0 && (await ctx.run('rpm', ['--version'])).status === 0,
  refresh: () => null, outdated, releaseDate, manual, manualText: (_w, l) => l,
  // root reads the system's own metadata, which can be older than the steward's copy, so it refreshes first, as apt's
  // root runs apt-get update (owner, 2026-11-03). The pins are exact, and --no-recommends adds nothing beside them
  rootRefresh: { cmd: 'zypper', args: ['--non-interactive', 'refresh'] },
  upgradeCmd: items => ({ cmd: 'zypper', args: ['--non-interactive', 'install', '--no-recommends', ...items.map(pin)] }),
  // the way back: the edition from before, from the steward's kept copy (a path: zypper installs a local .rpm), else
  // while the repos still offer it (D88); --oldpackage lets zypper install an older one (zypper's step 0: it put back the
  // exact build on Leap 16.0)
  rollbackCmd: items => ({ cmd: 'zypper', args: ['--non-interactive', 'install', '--oldpackage', '--no-recommends', ...items.map(i => i.file || `${i.name}=${i.to}`)] }),
  installed, offered, download,
};

module.exports = { source, parseUpdates, parseUpdateinfo, parseInstalled, parseSearch, issuedISO, evr, readMaybe, updateinfo };
