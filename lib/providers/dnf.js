// dnf as a package source (parity dnf 1a, D81; 1b, D82; D-a per package): Fedora, the rhel family. dnf5 only (Fedora's
// dnf since 41; every supported release ships it). Reading is as the user; the upgrade goes through lib/roothandoff.js
// (D-b): each package pinned to the exact build the plan judged, and the way back only to builds the repos still offer.
//   - its own metadata cache: dnf5 runs as the user with cachedir under <state>/dnf, so the system's cache is never
//     touched and no sudo is needed (checked as uid 1000 on Fedora 43, 44 and 45, 2026-11-11)
//   - testing repos are never read (--disable-repo=*-testing): a version in updates-testing has no stable date, as
//     Ubuntu's Proposed is never used (the fedora:45 prerelease image ships with updates-testing on)
//   - each new version dated by when it reached the stable updates repo: Bodhi's date_stable for its advisory (the repo's
//     own updateinfo names the advisory; one Bodhi request per run for all of them), else for its source build; else,
//     for a version only in the release's own repo, the release's day; else the first-seen clock, as on Mint (owner,
//     2026-11-03), which is also what a Bodhi that can't be reached gives. Never the advisory's own issued time: for an
//     update that went stable in the newest compose it is still the day it went to testing (6 of 132 advisories on
//     Fedora 43, 44 and 45, 2026-11-11, up to 15 days early). Never the RPM's build time: it comes 1 to 16 days earlier
//   - a version whose advisory is of type security is taken at once and names the advisory, as apt's security pocket
//     does (owner, 2026-11-03); Fedora's severity is sometimes unset on a security update, so the type decides
// Every command goes through ctx.run, so tests hand it canned output.
const fs = require('fs');
const path = require('path');
const apt = require('./apt.js');

const id = 'dnf';
const BODHI = 'https://bodhi.fedoraproject.org';
const enc = encodeURIComponent;

// dir(ctx) — where the steward keeps its own dnf metadata and its first-seen clock
const dir = ctx => path.join(ctx.cfg.paths.state, 'dnf');
// opts(ctx) — dnf5's options: the steward's own cache, quiet, and never a testing repo
const opts = ctx => ['-q', `--setopt=cachedir=${dir(ctx)}/cache`, '--disable-repo=*-testing'];

// parseUpgrades(text) — [{name, want, arch, repo, srpm}] from `dnf5 repoquery --upgrades --qf '%{name} %{evr} %{arch}
// %{repoid} %{sourcerpm}\n'`; srpm is the source build's NVR (no .src.rpm). A testing repo's line is dropped here too
const parseUpgrades = text => String(text).split('\n').map(l => l.trim().split(/\s+/)).filter(f => f.length === 5)
  .map(([name, want, arch, repo, s]) => ({ name, want, arch, repo, srpm: s.replace(/\.src\.rpm$/, '') }))
  .filter(i => !/testing/.test(i.repo));

// parseInstalled(text) — {name: evr} from `rpm -q --qf '%{NAME} %{EPOCHNUM}:%{VERSION}-%{RELEASE}\n'`; epoch 0 is dropped,
// as dnf5's %{evr} drops it
const parseInstalled = text => Object.fromEntries(String(text).split('\n').map(l => l.trim().split(/\s+/)).filter(f => f.length === 2 && !f[1].includes('not installed'))
  .map(([n, v]) => [n, v.replace(/^0:/, '')]));

// issuedISO(v) — an advisory's issued time as ISO: dnf5 5.4 gives epoch seconds, 5.2 a UTC "YYYY-MM-DD HH:MM:SS"
// (both under the JSON key "buildtime", which holds the issued time all the same: checked against Bodhi, 2026-11-11)
function issuedISO(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  return m ? `${m[1]}T${m[2]}Z` : '';
}

// parseAdvisories(json) — {"name-evr": {id, type, issued, security}} from `dnf5 advisory list --json`: the arch dropped from
// each NEVRA; a version in more than one advisory keeps the earliest issued one, and is security if any of them is.
// issued is kept only to choose between them: it is not a release date (see above)
function parseAdvisories(text) {
  let list = [];
  try { list = JSON.parse(text); } catch { return {}; }
  const out = {};
  for (const a of Array.isArray(list) ? list : []) {
    const key = String(a.nevra || '').replace(/\.[^.]+$/, ''), issued = issuedISO(a.buildtime);
    if (!key || !a.name) continue;
    const had = out[key];
    if (!had || (issued && issued < had.issued)) out[key] = { id: a.name, type: a.type, issued, security: a.type === 'security' || (had ? had.security : false) };
    else if (a.type === 'security') had.security = true;
  }
  return out;
}

// bodhiStable(json) — {alias: ISO date_stable} for each stable update in a Bodhi /updates/ answer
function bodhiStable(j) {
  const out = {};
  for (const u of (j && j.updates) || []) if (u.alias && u.status === 'stable' && u.date_stable) out[u.alias] = issuedISO(u.date_stable);
  return out;
}

// bodhiDate(json) — date_stable of the stable update in Bodhi's answer for one build, as ISO (Bodhi's times are UTC)
function bodhiDate(j) {
  const t = ((j && j.updates) || []).filter(u => u.status === 'stable' && u.date_stable).map(u => issuedISO(u.date_stable)).filter(Boolean).sort();
  return t[0] || '';
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

const json = async (ctx, url) => {
  const r = await ctx.run('curl', ['-fsS', '--max-time', '20', '-H', 'Accept: application/json', url]);
  try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
};

// what each audit learned, per run: the upgrades (with repo and source build) and the advisories, by name-evr
const seen = new WeakMap();
const memo = ctx => { if (!seen.has(ctx)) seen.set(ctx, { items: {}, advisories: null, stable: null }); return seen.get(ctx); };

// advisories(ctx) — the repos' advisories by name-evr, read once per run (no network beyond the repos dnf already reads)
async function advisories(ctx) {
  const m = memo(ctx);
  if (!m.advisories) m.advisories = parseAdvisories((await ctx.run('dnf5', [...opts(ctx), 'advisory', 'list', '--json'])).stdout);
  return m.advisories;
}

// outdated(ctx) — what dnf would upgrade, from the steward's own cache (refreshed as needed, as the user: no sudo), with
// what is installed now
async function outdated(ctx) {
  const ups = parseUpgrades((await ctx.run('dnf5', [...opts(ctx), 'repoquery', '--upgrades', '--latest-limit=1',
    '--qf', '%{name} %{evr} %{arch} %{repoid} %{sourcerpm}\n'])).stdout);
  if (!ups.length) return [];
  const have = parseInstalled((await ctx.run('rpm', ['-q', '--qf', '%{NAME} %{EPOCHNUM}:%{VERSION}-%{RELEASE}\n', ...ups.map(u => u.name)])).stdout);
  const adv = await advisories(ctx), m = memo(ctx);
  return ups.map(u => {
    const a = adv[`${u.name}-${u.want}`];
    const it = { name: u.name, have: have[u.name] || '?', want: u.want, arch: u.arch, repo: u.repo, srpm: u.srpm, ...(a && a.security ? { advisory: a.id } : {}) };
    m.items[`${u.name} ${u.want}`] = { ...it, alias: a ? a.id : '' };
    return it;
  });
}

// stableDates(ctx) — {alias: ISO date_stable} for every advisory this run's upgrades name: the day's cache, then one
// Bodhi request for the rest (40 aliases a request); an alias Bodhi doesn't call stable is left out
async function stableDates(ctx) {
  const m = memo(ctx);
  if (m.stable) return m.stable;
  const f = path.join(ctx.cache, `dnf-${ctx.today.replace(/-/g, '')}`, 'bodhi-stable.json');
  let known = {};
  try { known = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* not yet today */ }
  const want = [...new Set(Object.values(m.items).map(i => i.alias).filter(a => a && !(a in known)))];
  for (let i = 0; i < want.length; i += 40) {
    const part = want.slice(i, i + 40);
    const j = await json(ctx, `${BODHI}/updates/?${part.map(a => `alias=${enc(a)}`).join('&')}&rows_per_page=100`);
    if (!j) continue;
    Object.assign(known, bodhiStable(j));
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(known));
  m.stable = known;
  return known;
}

// releaseDate(ctx, name, want) — {date, from}: when that version reached the stable repo, and how that is known
async function releaseDate(ctx, name, want) {
  const it = memo(ctx).items[`${name} ${want}`] || {};
  if (it.alias) {
    const date = (await stableDates(ctx))[it.alias];
    if (date) return { date, from: 'Bodhi' };
  } else if (it.srpm) {
    const date = await apt.cached(ctx, `bodhi-${it.srpm}`, async () => bodhiDate(await json(ctx, `${BODHI}/updates/?builds=${enc(it.srpm)}`)), 'dnf');
    if (date) return { date, from: 'Bodhi' };
  }
  const r = release(ctx);
  if (it.repo === 'fedora' && r.id === 'fedora' && r.version) {
    const day = await apt.cached(ctx, `release-F${r.version}`, async () => {
      const j = await json(ctx, `${BODHI}/releases/F${enc(r.version)}`);
      return j && /^\d{4}-\d{2}-\d{2}$/.test(j.released_on || '') ? `${j.released_on}T00:00:00Z` : '';
    }, 'dnf');
    if (day) return { date: day, from: 'release day' };
  }
  return { date: apt.firstSeen(path.join(dir(ctx), 'first-seen.json'), `${name} ${want}`, ctx.now), from: 'first seen here' };
}

// pin(i) — name-evr.arch for a planned item (dnf5 takes the exact build: checked on Fedora 44, 2026-11-11)
const pin = i => (typeof i === 'string' ? i : `${i.name}-${i.want}${i.arch ? `.${i.arch}` : ''}`);

// installed(ctx, names) — {name: evr} of those installed, read as you (rpm); a name not installed is left out
async function installed(ctx, names) {
  if (!names.length) return {};
  const have = parseInstalled((await ctx.run('rpm', ['-q', '--qf', '%{NAME} %{EPOCHNUM}:%{VERSION}-%{RELEASE}\n', ...names])).stdout);
  return Object.fromEntries(Object.entries(have).filter(([n]) => names.includes(n)));
}

// offered(ctx, name) — every build of name the repos offer (evr, epoch 0 dropped as rpm's is above), from the steward's
// own cache, testing repos left out: dnf5 repoquery lists what the repos have, never the rpm database. Fedora's updates
// repo keeps only its newest build, so this is often that and the release's own (dnf's step 0, 2026-11-11)
async function offered(ctx, name) {
  const r = await ctx.run('dnf5', [...opts(ctx), 'repoquery', '--qf', '%{evr}\n', name]);
  return [...new Set(String(r.stdout || '').split('\n').map(l => l.trim()).filter(Boolean))];
}

// arch(ctx, name) — the installed package's architecture (rpm), or '' when not installed
async function arch(ctx, name) {
  const r = await ctx.run('rpm', ['-q', '--qf', '%{ARCH}\n', name]);
  const a = String(r.stdout || '').split('\n')[0].trim();
  return r.status === 0 && /^[\w-]+$/.test(a) ? a : '';
}
// download(ctx, name, version, dest) — that build's .rpm into dest, as you, from the steward's own cache, the installed
// architecture only (dnf5 download checks the repository's signatures); the file, or null (kept packages, D88)
async function download(ctx, name, version, dest) {
  const a = await arch(ctx, name);
  await ctx.run('dnf5', [...opts(ctx), 'download', `--destdir=${dest}`, `${name}-${version}${a ? `.${a}` : ''}`]);
  const file = `${name}-${version.replace(/^\d+:/, '')}.`;
  return require('../kept.js').downloaded(dest, b => b.startsWith(file) && b.endsWith('.rpm') && !b.endsWith('.src.rpm'));
}

const source = {
  id, check: 'dnf', provider: id, name: 'dnf packages', title: 'dnf packages', noun: 'dnf package(s)', tag: 'dnf',
  platforms: ['linux'], families: ['rhel'], gateMode: 'per-package', exceptionKind: 'dnf', exceptionVersion: want => want,
  needsRoot: true, heldEta: true,
  back: 'steward sc rollback <receipt> (it printed its receipt above): the kept copy of each build from before, else the one the repos still offer',
  pocketWhy: 'security advisory', securityPocket: item => (item && item.advisory) || '',
  available: async ctx => (await ctx.run('dnf5', ['--version'])).status === 0 && (await ctx.run('rpm', ['--version'])).status === 0,
  refresh: () => null, outdated, releaseDate, manual: async () => [], manualText: (_w, l) => l,
  // root reads the system's own metadata, which can be older than the steward's copy, so it refreshes first (--refresh,
  // as apt's root runs apt-get update; owner, 2026-11-03), in the one command. The pins are exact, so a testing repo
  // the system turned on can't change which build goes in
  upgradeCmd: items => ({ cmd: 'dnf5', args: ['upgrade', '-y', '--refresh', ...items.map(pin)] }),
  // the way back: a downgrade to the build from before, from the steward's kept copy (a path: dnf5 takes a local .rpm),
  // else while the repos still offer it (owner, 2026-11-11, then kept packages, 2026-11-13: D88). dnf5 history undo is
  // not used: it fails whenever that build has left the updates repo (dnf's step 0)
  rollbackCmd: items => ({ cmd: 'dnf5', args: ['downgrade', '-y', '--refresh', ...items.map(i => i.file || `${i.name}-${i.to}`)] }),
  installed, offered, download,
};

module.exports = { source, arch, parseUpgrades, parseInstalled, parseAdvisories, issuedISO, bodhiDate, bodhiStable };
