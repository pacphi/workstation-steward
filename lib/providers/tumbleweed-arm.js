// Tumbleweed on ARM (aarch64) as a package source, snapshot mode (parity D91; owner, 2026-11-13 and 2026-11-25): openSUSE
// keeps no archive of past ARM snapshots (only x86_64 has one: lib/providers/tumbleweed.js), so the one thing it can
// move to is the live snapshot of the ports repo, https://download.opensuse.org/ports/aarch64/tumbleweed/repo/oss/.
//   - one plan item, "tumbleweed": from os-release's VERSION_ID to the live snapshot's name (media.1/products)
//   - the date is the repo's own publish time, repodata/repomd.xml <revision> (the Mac's step 0, 2026-11-20: 2026-11-19
//     04:25 UTC for snapshot 20261118), never the name (a name is 1 to 2.5 days earlier). It is taken once that is
//     [policy] min_release_age_days old; else held, with the day it becomes eligible. A snapshot that is replaced before
//     it is old enough is never taken: the next one starts its own clock
//   - the plan reads what the move would change as you: `zypper dup --dry-run` against the steward's own repo file
//     (<state>/zypper/arm-repos) and cache, so the system's repos never matter and no sudo is needed. The receipt and the
//     kept copies are per package (`members`); the plan shows one line
//   - the move, as root (the same chain as x86): disable the other repos, add the live repo as snap-arm-<name>, refresh,
//     `dup --from` it. The live repo can't be pinned, so `preflight` re-reads media.1/products before sudo and refuses a
//     snapshot other than the planned one
//   - the way back is the kept copy of each package's build from before (D88, lib/kept.js): the repo offers only its
//     newest build, so the first move has none; each move keeps the builds it installs for the next one. Installed with
//     `zypper install --oldpackage` from the files; zypper exits 106 offline although the install worked, which counts as
//     success here and is verified with rpm
// Every command goes through ctx.run, so tests hand it canned output.
const fs = require('fs');
const path = require('path');
const zypper = require('./zypper.js');
const tw = require('./tumbleweed.js');

const id = 'tumbleweed-arm';
const NAME = 'tumbleweed';
const BASE = 'https://download.opensuse.org/ports/aarch64/tumbleweed/repo/oss/';

const dir = ctx => path.join(ctx.cfg.paths.state, 'zypper');
const reposDir = ctx => path.join(dir(ctx), 'arm-repos');
// opts(ctx) — zypper as you, on the steward's own cache and its own repo file: never the system's
const opts = ctx => ['--non-interactive', '--gpg-auto-import-keys', `--cache-dir=${dir(ctx)}/cache`, `--reposd-dir=${reposDir(ctx)}`];
function writeRepo(ctx) {
  fs.mkdirSync(reposDir(ctx), { recursive: true });
  const f = path.join(reposDir(ctx), 'tumbleweed-arm.repo');
  const text = `[tw-arm]\nname=Tumbleweed ARM (the steward's read-only view)\nenabled=1\nautorefresh=1\ngpgcheck=1\nbaseurl=${BASE}\n`;
  try { if (fs.readFileSync(f, 'utf8') === text) return f; } catch { /* write it */ }
  fs.writeFileSync(f, text);
  return f;
}

// parseProducts(text) — the snapshot name (8 digits) from media.1/products ("/ openSUSE 20261118-1"); '' otherwise
const parseProducts = text => ((String(text).match(/openSUSE\s+(\d{8})(?:-\d+)?/) || [])[1] || '');
// parseRevision(xml) — the repo's publish time as ISO, from repomd's <revision> (epoch seconds); '' when unreadable
function parseRevision(xml) {
  const n = Number(((String(xml).match(/<revision>\s*(\d{9,11})\s*<\/revision>/) || [])[1]));
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : '';
}
// parseDup(xml) — [{name, have, want, arch}] from `zypper --xmlout dup --dry-run`: each package in the install summary
// that replaces another (edition-old); new installs and removals are left to dup itself
function parseDup(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<solvable\s([^>]*?)\/?>/g)) {
    const a = zypperAttrs(m[1]);
    if ((a.type && a.type !== 'package') || !a.name || !a.edition || !a['edition-old']) continue;
    out.push({ name: a.name, have: a['edition-old'], want: a.edition, arch: a.arch || '' });
  }
  return out;
}
function zypperAttrs(tag) {
  const o = {};
  for (const m of String(tag).matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2].replace(/&amp;/g, '&');
  return o;
}

const arm = async ctx => tw.rolling(ctx) && ((await ctx.run('uname', ['-m'])).stdout || '').trim() === 'aarch64';
const days = ctx => Number(ctx.cfg.policy.min_release_age_days);
const get = async (ctx, u) => { const r = await ctx.run('curl', ['-fsS', '--max-time', '30', u]); return r.status === 0 ? r.stdout : ''; };
// fetchLive(ctx) — {name, published} read now, or null
async function fetchLive(ctx) {
  const name = parseProducts(await get(ctx, `${BASE}media.1/products`));
  const published = parseRevision(await get(ctx, `${BASE}repodata/repomd.xml`));
  return name && published ? { name, published } : null;
}
const seen = new WeakMap();
const memo = ctx => { if (!seen.has(ctx)) seen.set(ctx, {}); return seen.get(ctx); };
async function live(ctx) { const m = memo(ctx); if (!('live' in m)) m.live = await fetchLive(ctx); return m.live; }
// packages(ctx) — what the move would change, once per run; null when zypper can't say
async function packages(ctx) {
  const m = memo(ctx);
  if (!('packages' in m)) {
    writeRepo(ctx);
    const r = await ctx.run('zypper', [...opts(ctx), '--xmlout', 'dup', '--dry-run', '--no-recommends', '--allow-downgrade']);
    const list = r.status === 0 || r.stdout ? parseDup(r.stdout) : [];
    m.packages = list.length ? list : null;
  }
  return m.packages;
}
const have = ctx => snapshotOf(ctx);
function snapshotOf(ctx) {
  for (const f of ['etc/os-release', 'usr/lib/os-release']) {
    let t; try { t = fs.readFileSync(path.join(ctx.sysroot || '/', f), 'utf8'); } catch { continue; }
    return ((t.match(/^VERSION_ID=["']?([^"'\n]*)/m) || [])[1] || '');
  }
  return '';
}

// outdated(ctx) — the one move to the live snapshot, held or not (the plan judges its date); [] when current, not
// Tumbleweed on ARM, or unreadable (manual says so)
async function outdated(ctx) {
  if (!(await arm(ctx))) return [];
  const cur = have(ctx), l = await live(ctx);
  if (!l || !/^\d{8}$/.test(cur) || l.name <= cur) return [];
  const pk = await packages(ctx);
  if (!pk) return [];
  return [{ name: NAME, have: cur, want: l.name, packages: pk.length }];
}
async function releaseDate(ctx, _name, want) {
  const l = await live(ctx);
  return l && l.name === want ? { date: l.published, from: 'ARM repo published' } : '';
}
async function manual(ctx) {
  if (!(await arm(ctx))) return [];
  const cur = have(ctx), l = await live(ctx);
  if (!l) return ["Tumbleweed on ARM: couldn't read the live ARM snapshot (download.opensuse.org/ports/aarch64): not checked"];
  if (!/^\d{8}$/.test(cur)) return [`Tumbleweed on ARM: couldn't read the installed snapshot from os-release (VERSION_ID ${cur || 'empty'}): not checked`];
  if (l.name > cur && !(await packages(ctx))) return [`Tumbleweed on ARM: snapshot ${l.name} is live, but zypper couldn't list what moving to it changes: not checked`];
  return [];
}

// members(ctx, items) — the per-package items behind the one plan line, for the receipt and the kept copies
async function members(ctx, items) {
  const pk = (await packages(ctx)) || [];
  const why = (items[0] || {}).why;
  return pk.map(p => ({ ...p, ...(why ? { why } : {}) }));
}
// preflight(ctx, items) — before sudo: null, or why not (the live repo can't be pinned, so a newer snapshot is refused)
async function preflight(ctx, items) {
  const l = await fetchLive(ctx), want = (items[0] || {}).want;
  if (!l) return "couldn't read the live ARM snapshot again before sudo: run the plan again";
  return l.name === want ? null : `the live ARM snapshot is now ${l.name}, not the planned ${want}: run the plan again`;
}

// installed(ctx, names) — tumbleweed: os-release's snapshot; any other name: its rpm edition
async function installed(ctx, names) {
  const out = {};
  if (names.includes(NAME)) out[NAME] = have(ctx);
  Object.assign(out, await zypper.source.installed(ctx, names.filter(n => n !== NAME)));
  return out;
}
const offered = async () => []; // ARM's repo offers only its newest build: nothing older to go back to without a kept copy

// download(ctx, name, version, dest) — that build's .rpm as you, from the steward's own repo file (kept packages, D88)
async function download(ctx, name, version, dest) {
  writeRepo(ctx);
  await ctx.run('zypper', [...opts(ctx), `--pkg-cache-dir=${dest}`, 'download', `${name}=${version}`]);
  const file = `${name}-${version.replace(/^\d+:/, '')}.`;
  return require('../kept.js').downloaded(dest, b => b.startsWith(file) && b.endsWith('.rpm') && !b.endsWith('.src.rpm'));
}

// chain(name) — the root steps that move the system to the live snapshot, which must be the one named (preflight)
const chain = name => {
  const alias = `snap-arm-${name}`;
  return [
    { cmd: 'zypper', args: ['--non-interactive', 'modifyrepo', '--disable', '--all'] },
    { cmd: 'zypper', args: ['--non-interactive', 'addrepo', '--refresh', '--check', BASE, alias] },
    { cmd: 'zypper', args: ['--non-interactive', '--gpg-auto-import-keys', 'refresh', alias] },
    { cmd: 'zypper', args: ['--non-interactive', 'dup', '--from', alias, '--allow-downgrade', '--no-recommends', '--auto-agree-with-licenses'], ok: [106] },
  ];
};

const source = {
  id, check: id, provider: 'zypper', name: 'Tumbleweed ARM snapshot', title: "Tumbleweed ARM snapshot (gated as a whole, by the ARM repo's publish time)", noun: 'Tumbleweed ARM snapshot', tag: 'tumbleweed-arm',
  platforms: ['linux'], families: ['suse'], gateMode: 'snapshot', exceptionKind: null,
  needsRoot: true, heldEta: true,
  back: "steward sc rollback <receipt> (it printed its receipt above): each package's kept copy from before; the first move has none",
  available: async ctx => (await arm(ctx)) && (await ctx.run('zypper', ['--version'])).status === 0,
  refresh: () => null, outdated, releaseDate, manual, manualText: (_w, l) => l,
  upgradeCmd: items => chain(items[0].want),
  // the live repo is the only source of a build of the snapshot being left, so the way back is always a kept file
  rollbackCmd: items => ({ cmd: 'zypper', args: ['--non-interactive', 'install', '--oldpackage', '--no-recommends', '--no-refresh', ...items.map(i => i.file || `${i.name}=${i.to}`)], ok: [106] }),
  members, preflight, installed, offered, download,
};

module.exports = { source, parseProducts, parseRevision, parseDup, chain, BASE };
