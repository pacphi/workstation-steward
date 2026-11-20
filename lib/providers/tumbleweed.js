// Tumbleweed as a package source, snapshot mode (parity D-a 'snapshot'; owner, 2026-11-13): openSUSE Tumbleweed is a
// rolling release updated as a whole (zypper dup), so the gate is on the dated snapshot, not on each package. One item:
// "tumbleweed", from the snapshot installed (os-release VERSION_ID, e.g. 20261118) to the newest archived snapshot
// that has been published at least [policy] min_release_age_days. x86_64 only for now: openSUSE keeps an archive of
// the last 20 snapshots for it (download.opensuse.org/history/); ARM has none (the wait-then-apply mode is a later PR).
//   - the date is the archive folder's own publish time, never its name: a folder appears 1 to 2.5 days after the
//     snapshot it is named for (Mac step 0, 2026-11-20)
//   - the move, as root (zypper's step 0, 2026-11-12; it works forward and back): disable the other repos, add the
//     snapshot's oss repo as snap-<date>, refresh it, then zypper dup from it with --allow-downgrade
//   - the way back is the snapshot from before while the archive still lists it (it keeps 20): the same chain with
//     its date. The steward never goes backwards on its own: a snapshot older than the installed one is never taken
//   - a restart may be needed after a dup (zypper needs-rebooting exits 102); the steward says so, never reboots
// Every command goes through ctx.run, so tests hand it canned output.
const fs = require('fs');
const path = require('path');

const id = 'tumbleweed';
const NAME = 'tumbleweed';
const BASE = 'https://download.opensuse.org/history';

const release = ctx => {
  for (const f of ['etc/os-release', 'usr/lib/os-release']) {
    let t; try { t = fs.readFileSync(path.join(ctx.sysroot || '/', f), 'utf8'); } catch { continue; }
    const v = k => ((t.match(new RegExp(`^${k}=["']?([^"'\\n]*)`, 'm')) || [])[1] || '');
    return { id: v('ID'), version: v('VERSION_ID') };
  }
  return { id: '', version: '' };
};
const rolling = ctx => /^opensuse-tumbleweed$|tumbleweed/.test(release(ctx).id);

// parseList(text) — the snapshot names (8 digits) from history/list, in the order given (newest first)
const parseList = text => [...new Set(String(text).split(/\s+/).filter(s => /^\d{8}$/.test(s)))];

// timeISO(v) — an ISO time from an epoch (seconds or milliseconds), a numeric string of one, or a date string; '' otherwise
function timeISO(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = typeof v === 'number' ? v : /^\d{9,13}$/.test(String(v).trim()) ? Number(v) : NaN;
  if (Number.isFinite(n)) return new Date(n < 1e11 ? n * 1000 : n).toISOString();
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

// parseTable(text) — {snapshot: ISO publish time} from history/?jsontable: any array of {name, mtime} objects (the array
// may sit under a key such as data), a name of 8 digits with an optional trailing slash; {} when it can't be read
function parseTable(text) {
  let j; try { j = JSON.parse(text); } catch { return {}; }
  const rows = [];
  const walk = x => {
    if (Array.isArray(x)) { for (const e of x) { if (e && typeof e === 'object' && !Array.isArray(e)) rows.push(e); else walk(e); } }
    else if (x && typeof x === 'object') for (const v of Object.values(x)) walk(v);
  };
  walk(j);
  const out = {};
  for (const r of rows) {
    const name = String(r.name || r.Name || '').replace(/\/$/, '');
    if (!/^\d{8}$/.test(name)) continue;
    const t = timeISO(r.mtime !== undefined ? r.mtime : r.time !== undefined ? r.time : r.mtimestamp !== undefined ? r.mtimestamp : r.date);
    if (t) out[name] = t;
  }
  return out;
}

const seen = new WeakMap();
// archive(ctx) — {names: [newest first], times: {name: ISO}}, read once per run; null when the archive can't be read
async function archive(ctx) {
  if (seen.has(ctx)) return seen.get(ctx);
  const get = async u => { const r = await ctx.run('curl', ['-fsS', '--max-time', '30', u]); return r.status === 0 ? r.stdout : ''; };
  const names = parseList(await get(`${BASE}/list`));
  const times = parseTable(await get(`${BASE}/?jsontable`));
  const a = names.length && Object.keys(times).length ? { names, times } : null;
  seen.set(ctx, a);
  return a;
}

const x86 = async ctx => ((await ctx.run('uname', ['-m'])).stdout || '').trim() === 'x86_64';
const days = ctx => Number(ctx.cfg.policy.min_release_age_days);

// outdated(ctx) — the one move: the newest snapshot past the gate and newer than the installed one; when none is past
// the gate yet, the newest newer one, so the plan can hold it and say when. [] when current, not Tumbleweed, not x86_64,
// or the archive can't be read (manual says so)
async function outdated(ctx) {
  if (!rolling(ctx) || !(await x86(ctx))) return [];
  const have = release(ctx).version, a = await archive(ctx);
  if (!a || !/^\d{8}$/.test(have)) return [];
  const newer = a.names.filter(n => n > have && a.times[n]);
  if (!newer.length) return [];
  const cutoff = ctx.now.getTime() - days(ctx) * 864e5;
  const ripe = newer.filter(n => Date.parse(a.times[n]) <= cutoff);
  const want = ripe.length ? ripe[0] : newer[0];
  return [{ name: NAME, have, want }];
}

async function releaseDate(ctx, _name, want) {
  const a = await archive(ctx);
  return a && a.times[want] ? { date: a.times[want], from: 'snapshot folder published' } : '';
}

async function manual(ctx) {
  if (!rolling(ctx)) return [];
  if (!(await x86(ctx))) return ['Tumbleweed on ARM: not checked yet: it has no snapshot archive, so the steward will wait the gate\'s days after a publish and keep the packages for the way back (a later release)'];
  const a = await archive(ctx), have = release(ctx).version;
  if (!a) return ["Tumbleweed: couldn't read the snapshot archive (download.opensuse.org/history): not checked"];
  if (!/^\d{8}$/.test(have)) return [`Tumbleweed: couldn't read the installed snapshot from os-release (VERSION_ID ${have || 'empty'}): not checked`];
  if (!a.names.includes(have)) return [`Tumbleweed: the installed snapshot ${have} is no longer in the archive's last ${a.names.length}, so there is no way back to it`];
  return [];
}

// installed(ctx) — {tumbleweed: VERSION_ID}, read as you
async function installed(ctx, names) { return names.includes(NAME) ? { [NAME]: release(ctx).version } : {}; }
// offered(ctx) — the snapshots the archive still lists (the way back goes to one of them)
async function offered(ctx) { const a = await archive(ctx); return a ? a.names : []; }

// chain(date) — the root steps that move the system to that snapshot, forward or back (zypper's step 0 on Tumbleweed)
const chain = date => {
  const alias = `snap-${date}`;
  return [
    { cmd: 'zypper', args: ['--non-interactive', 'modifyrepo', '--disable', '--all'] },
    { cmd: 'zypper', args: ['--non-interactive', 'addrepo', '--refresh', '--check', `${BASE}/${date}/tumbleweed/repo/oss/`, alias] },
    { cmd: 'zypper', args: ['--non-interactive', '--gpg-auto-import-keys', 'refresh', alias] },
    { cmd: 'zypper', args: ['--non-interactive', 'dup', '--from', alias, '--allow-downgrade', '--no-recommends', '--auto-agree-with-licenses'] },
  ];
};

const source = {
  id, check: 'tumbleweed', provider: 'zypper', name: 'Tumbleweed snapshot', title: 'Tumbleweed snapshot (gated as a whole, by the snapshot folder\'s publish time)', noun: 'Tumbleweed snapshot', tag: 'tumbleweed',
  platforms: ['linux'], families: ['suse'], gateMode: 'snapshot', exceptionKind: null,
  needsRoot: true, heldEta: true,
  back: 'steward sc rollback <receipt> (it printed its receipt above): zypper dup back to the snapshot from before, while the archive still lists it',
  available: async ctx => rolling(ctx) && (await ctx.run('zypper', ['--version'])).status === 0,
  refresh: () => null, outdated, releaseDate, manual, manualText: (_w, l) => l,
  upgradeCmd: items => chain(items[0].want),
  rollbackCmd: items => chain(items[0].to),
  installed, offered,
};

module.exports = { source, parseList, parseTable, timeISO, chain, rolling };
