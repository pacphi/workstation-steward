// Reconcile (D42, R5b): after a new Ruflo, AQE or Brain version is promoted on the machine, bring the copies onboarding
// put into a project in step with it. For every unit the steward copied (a helper, a skill's folder, a command or agent
// file, AQE's two hook files) it compares three hashes: the baseline (what the newest onboard or reconcile receipt
// says the steward wrote), disk (now) and the source (the qualified install today):
//   disk = source                       current
//   disk = baseline, source moved on    update: replaced with the new source, the old copy backed up
//   disk ≠ baseline, source moved on    edited: kept and reported; --take <unit> takes the new version
//   no baseline (from before the steward onboarded it)   yours: kept; --take adopts it. Unless its hash is an
//                                       unedited copy of a published release (known-units.json): then it counts as
//                                       the steward's own and is updated like one
//   missing on disk                     reported (`steward projects onboard` restores missing names)
//   the source no longer ships it       reported only (removal is `steward projects offboard`)
// A folder holding `.LOCKED` (Ruflo's helpers) is updated like any other: the marker turns Ruflo's own refresh off,
// and reconcile is the reviewed, backed-up refresh it asks for; the plan labels those units. Tracked units go through
// a PR and are never written (D6). Settings values stay adds-only with their fixers until receipts hold a baseline per
// key (D42). plan() is read-only; apply() writes a backup and a receipt that starts a soak; undo() reverses it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./config.js');
const P = require('./projects.js');
const F = require('./profiles.js');
const O = require('./onboard.js');

const STATE = () => C.load().values.paths.state;
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const list = d => { try { return fs.readdirSync(d); } catch { return []; } };
const norm = u => u.replace(/^\.\//, '').replace(/\/+$/, '');

// receipts(project) — the complete onboard, reconcile and offboard receipts for one project (its ~ path), oldest first.
// Failed applies (undone) and rolled-back ones don't count.
function receipts(project) {
  const out = [];
  const dir = path.join(STATE(), 'backups');
  for (const d of list(dir)) {
    if (!/^(onboard|reconcile|offboard)-/.test(d)) continue;
    const f = path.join(dir, d, 'receipt.json');
    const r = readJSON(f);
    if (r && r.project === project && r.complete && !r.undone && !r.rolled_back) out.push({ ...r, file: f });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// baselines(project) — Map unit → {hash, receipt, named}: what the steward last wrote for each unit, newest receipt
// wins; named = a name copied into a folder (a single file's entry may be a whole file onboarding wrote, like .LOCKED,
// so it counts only for a copy the profiles name). Receipts from before the newest offboard are stale: it took
// everything out.
function baselines(project) {
  const rs = receipts(project);
  const off = rs.map(r => r.kind).lastIndexOf('offboard');
  const out = new Map();
  for (const r of rs.slice(off + 1)) {
    for (const e of r.entries || []) {
      if (e.names) for (const n of e.names) out.set(`${e.path}/${n.name}`, { hash: n.hash, receipt: r.file, named: true });
      else if (r.kind === 'reconcile' && e.hash_after) out.set(e.path, { hash: e.hash_after, receipt: r.file, named: Boolean(e.named) });
      else if (e.sha_after) out.set(e.path, { hash: e.sha_after, receipt: r.file, named: false });
    }
  }
  return out;
}

// sources(tools, dir) — Map unit → {tool, from, folder, named}: every unit the chosen tools' profiles copy into this
// project today (named: a name in a copied folder, not a single copied file), with Ruflo's names owned by Ruflo (D26,
// through F.render)
function sources(tools, dir) {
  const out = new Map();
  for (const c of F.render(tools, dir).copies) {
    if (!fs.existsSync(c.from)) continue;
    if (!fs.statSync(c.from).isDirectory()) { out.set(c.to, { tool: c.tool, from: c.from, folder: path.dirname(c.to), named: false }); continue; }
    for (const n of F.names(c)) if (!out.has(`${c.to}/${n}`)) out.set(`${c.to}/${n}`, { tool: c.tool, from: path.join(c.from, n), folder: c.to, named: true });
  }
  return out;
}

// plan(dir, {take: [unit…], entry, cache}) — per unit its state and action, as data. `entry` stands in for the
// registry in tests only; `cache` (a Map) shares source hashes across the projects of one run, which all read the
// same installs. Actions: 'update' and 'take' are applied; 'pr' (tracked) and every other state are reported.
function plan(dirIn, opts = {}) {
  const cache = opts.cache || new Map();
  const srcHash = p => { if (!cache.has(p)) cache.set(p, O.unitHash(p)); return cache.get(p); };
  const dir = path.resolve(P.untilde(dirIn));
  const t = O.target(dir, opts.entry);
  const out = { project: P.tilde(dir), dir, tools: (t.entry && t.entry.ai) || [], units: [], notes: [] };
  if (t.stop) return { ...out, stop: t.stop };
  if (t.kind !== 'dir') { const op = O.midOperation(dir); if (op) return { ...out, stop: `the repo is mid-operation (${op}): finish or abort it first` }; }
  const src = sources(out.tools, dir);
  const base = baselines(out.project);
  const take = new Set((opts.take || []).map(norm));
  for (const u of take) if (!src.has(u)) out.notes.push(`--take ${u}: the qualified installs don't ship that unit`);
  const known = F.knownVendor(), released = F.knownUnits();
  // every unit shipped today, and every folder name the steward copied that no longer ships
  const all = [...new Set([...src.keys(), ...[...base].filter(([u, b]) => b.named && !src.has(u)).map(([u]) => u)])].sort();
  const states = P.gitStates(dir, all);
  const locked = new Map();
  const isLocked = folder => { if (!locked.has(folder)) locked.set(folder, P.exists(path.join(dir, folder, '.LOCKED'))); return locked.get(folder); };
  for (const u of all) {
    const s = src.get(u), b = base.get(u);
    const disk = O.unitHash(path.join(dir, u));
    const source = s ? srcHash(s.from) : null;
    let baseline = b ? b.hash : null;
    // D25: AQE's single files count as untouched when they are a known, unedited vendor copy
    const k = disk && known.get(disk);
    if (k && k.file === u) baseline = disk;
    // no receipt, but an unedited copy of some published release: as good as one the steward wrote
    const rel = baseline === null && disk && released.get(u) && released.get(u).get(disk);
    if (rel) baseline = disk;
    let state;
    if (disk === null) state = s ? 'missing' : null;
    else if (!s) state = 'dropped';
    else if (disk === source) state = 'current';
    else if (baseline === null) state = 'yours';
    else if (disk === baseline) state = 'behind';
    else state = source === baseline ? 'edited-same' : 'edited';
    if (!state) continue;
    let action = state === 'behind' ? 'update' : (state === 'edited' || state === 'yours') && take.has(u) ? 'take' : 'none';
    if (action !== 'none' && states[u] === 'tracked') action = 'pr';
    const folder = s ? s.folder : path.dirname(u);
    if (take.has(u) && action === 'none' && state !== 'dropped') out.notes.push(`--take ${u}: nothing to take (${state === 'missing' ? 'missing: `steward projects onboard` restores it' : 'the qualified install has nothing newer'})`);
    out.units.push({ unit: u, tool: s && s.tool, from: s && s.from, named: s ? s.named : true, state, action, disk, source, baseline, git: states[u], locked: /(^|\/)\.claude\/helpers$/.test(folder) && isLocked(folder), ...(rel ? { released: rel } : {}) });
  }
  return out;
}

const COUNT = ['update', 'take', 'pr', 'edited', 'yours', 'missing', 'dropped', 'current'];
// counts(plan) — {update, take, pr, edited, yours, missing, dropped, current}: what one project's plan holds
function counts(p) {
  const c = Object.fromEntries(COUNT.map(k => [k, 0]));
  for (const u of p.units) {
    if (u.action !== 'none') c[u.action]++;
    else if (u.state === 'edited-same' || u.state === 'current') c.current++;
    else c[u.state]++;
  }
  return c;
}

const todo = p => p.units.filter(u => u.action === 'update' || u.action === 'take');

// apply(plan) — replace each 'update' and 'take' unit with its source: the old copy goes to the backup folder first,
// and the receipt is written as it goes; on any failure the applied part is undone from it. Returns the receipt path.
function apply(p) {
  if (p.stop) throw new Error(p.stop);
  const dir = p.dir;
  const bdir = C.newBackupDir(`reconcile-${path.basename(dir)}`);
  fs.mkdirSync(path.join(bdir, 'files'), { mode: 0o700 });
  const rp = path.join(bdir, 'receipt.json');
  const receipt = { kind: 'reconcile', at: new Date().toISOString(), engine: C.ENGINE_VERSION, profiles: O.profileHashes(p.tools), project: p.project, tools: p.tools, backup: P.tilde(bdir), entries: [], pr: p.units.filter(u => u.action === 'pr').map(u => u.unit), complete: false };
  Object.assign(receipt, require('./autonomy.js').mark());   // --unattended (D58), and --yes-to (D59)
  const save = () => fs.writeFileSync(rp, JSON.stringify(receipt, null, 1) + '\n');
  save();
  try {
    for (const u of todo(p)) {
      const abs = path.join(dir, u.unit);
      if (O.unitHash(abs) !== u.disk) throw new Error(`${u.unit} changed since the plan: run the plan again`);
      if (O.unitHash(u.from) !== u.source) throw new Error(`${u.unit}: its source changed since the plan: run the plan again`);
      const b = path.join(bdir, 'files', u.unit);
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.cpSync(abs, b, { recursive: true, errorOnExist: true, force: false });
      const e = { path: u.unit, action: u.action, tool: u.tool, named: u.named, backup: P.tilde(b), hash_before: u.disk };
      receipt.entries.push(e);
      save();
      fs.rmSync(abs, { recursive: true, force: true });
      fs.cpSync(u.from, abs, { recursive: true, errorOnExist: true, force: false });
      e.hash_after = O.unitHash(abs);
      save();
    }
    receipt.complete = true;
    save();
  } catch (e) {
    try { undo(receipt); } catch (u) { e.message += `; undoing also failed (${u.message}): restore by hand from ${P.tilde(bdir)}`; }
    receipt.undone = true;
    save();
    throw e;
  }
  return rp;
}

// changedSince(receipt) — units that no longer match what reconcile wrote
function changedSince(rc) {
  const dir = P.untilde(rc.project);
  return rc.entries.filter(e => e.hash_after && O.unitHash(path.join(dir, e.path)) !== e.hash_after).map(e => e.path);
}

// undo(receipt) — last first: put each unit's backed-up copy back
function undo(rc) {
  const dir = P.untilde(rc.project);
  for (const e of [...rc.entries].reverse()) {
    const abs = path.join(dir, e.path), b = P.untilde(e.backup);
    if (!fs.existsSync(b)) continue; // the backup was never finished: the unit wasn't touched
    fs.rmSync(abs, { recursive: true, force: true });
    fs.cpSync(b, abs, { recursive: true });
  }
}

// markRolledBack(file) — note in a receipt that it was rolled back, so its hashes stop counting as baselines
function markRolledBack(file) {
  const rc = JSON.parse(fs.readFileSync(file, 'utf8'));
  rc.rolled_back = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(rc, null, 1) + '\n');
}

// diff(dir, unit, from) — `git diff --no-index` from the project's copy to the qualified source (text, or '' when equal)
function diff(dir, unit, from) {
  try { return execFileSync('git', ['diff', '--no-index', '--no-color', '--', path.join(dir, unit), from], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return e.status === 1 ? e.stdout : `(git diff failed: ${e.message})`; }
}

// Projects behind (F2): `steward review`, `steward check` and the banner say when a promotion left projects behind.
// A full plan takes seconds, so each one across every project is noted in <state>/reconcile/seen.json with the
// installs it compared against; the banner only compares those versions with today's (cheap) and repeats the count.
const SEEN = () => path.join(STATE(), 'reconcile', 'seen.json');

// versions() — {tool: "<version> <real path>"} for each install the profiles copy from: a promotion changes one
function versions() {
  const ph = F.placeholders(C.HOME);
  const v = dir => { const pkg = P.readJSON(path.join(dir, 'package.json')) || {}; let real = dir; try { real = fs.realpathSync(dir); } catch { /* not installed */ } return `${pkg.version || '?'} ${real}`; };
  return { ruflo: v(ph.RUFLO_CLI), aqe: v(ph.AQE_PKG) };
}

// all(opts) — a plan for every onboarded project with AI tools that exists, noted in seen.json
function all(opts = {}) {
  const rows = P.loadRegistry().filter(r => r.decision === 'onboarded' && (r.ai || []).length && P.exists(r.abs));
  const cache = new Map();
  const plans = rows.map((r, i) => { if (opts.each) opts.each(i, rows.length, r.abs); return plan(r.abs, { cache }); });
  noteSeen(plans, { all: true });
  return plans;
}

// behind(plans) — [{project, update, edited, pr}] for each project with copies to update; edited (kept, with a newer
// version) and tracked (PR) counts ride along but don't make a project behind, since they wait on the owner
const behind = plans => plans.filter(p => !p.stop).map(p => { const c = counts(p); return { project: p.project, update: c.update, edited: c.edited, pr: c.pr }; }).filter(b => b.update);

// noteSeen(plans, {all}) — record what these plans found: all replaces the list; otherwise only these projects change
function noteSeen(plans, o = {}) {
  const prev = (!o.all && readJSON(SEEN())) || { behind: [] };
  const mine = new Set(plans.map(p => p.project));
  const out = { at: o.all ? new Date().toISOString() : prev.at, versions: o.all ? versions() : prev.versions, behind: [...prev.behind.filter(b => !mine.has(b.project)), ...behind(plans)] };
  if (!out.at) return; // a single project's plan before any full one: nothing to compare yet
  fs.mkdirSync(path.dirname(SEEN()), { recursive: true });
  fs.writeFileSync(SEEN(), JSON.stringify(out, null, 1) + '\n');
}

// bannerLine() — one line when the installs changed since the last full plan, or it found projects behind; else null
function bannerLine() {
  const s = readJSON(SEEN());
  if (!s) return null;
  const now = versions();
  const moved = Object.keys(now).filter(t => s.versions && s.versions[t] !== now[t]);
  if (moved.length) return `${moved.join(' and ')} changed since the last reconcile check: steward projects reconcile --all`;
  if (s.behind.length) return `${s.behind.length} project(s) behind the qualified AI tools: steward projects reconcile --all`;
  return null;
}

module.exports = { plan, apply, undo, changedSince, counts, todo, baselines, receipts, markRolledBack, diff, all, behind, noteSeen, bannerLine, versions, COUNT };
