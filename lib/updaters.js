#!/usr/bin/env node
// Declared update sources (D52, docs/release-classes.md): an [[updater]] in the host policy (lib/host.js) is a source
// the steward doesn't install itself, such as a signed data bundle with its own updater. The steward runs the entry's
// commands; it doesn't know what the tool is. Its class says whether it waits for the release-age gate: gated (the
// default) waits, always_current and signed_data don't, and an exception doesn't until it expires (then it's gated).
// A declared source has no release date the steward can read, so a gated one that's behind is held for a person,
// unless it is dated (D72): `released` names where its release dates are published, so the steward picks the newest
// version past the gate itself and installs that one.
//   check   read-only; exit 0 = current, 10 = behind, anything else = couldn't tell. The audit and the plan run it
//   (a dated entry has no check: `installed` prints the version in use, `released` lists the versions with dates,
//   `apply` installs {version}, and `verify` compares the installed file with the sha256 its vendor publishes)
//   apply   run by `steward sc upgrade` only when the key pin holds, check says behind and every `backup` path is
//           copied; then require_output must appear in what it printed, and the pin must still hold (if not, the
//           reviewed file is put back from its copy and the run stops)
// Each apply writes a receipt (kind updater-<class>). A signed_data one starts no soak (lib/soak.js); every apply's
// copies are removed by `steward sc prune` once they're older than soak_days.
// Usage: updaters.js --apply <name>          (DRY_RUN=1: the steps only)
//        updaters.js --rollback <receipt>    put the copies back; asks first
//        updaters.js --prunable | --prune    the copies older than soak_days; prune removes them (bin/prune asks)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const C = require('./config.js');

const CLASSES = ['gated', 'always_current', 'signed_data', 'exception'];
const DAY = 86400e3;
const DRY = process.env.DRY_RUN === '1';
const log = s => console.log(`\x1b[1;34m==>\x1b[0m ${s}`);

// problems(u) — what keeps an [[updater]] from being used, as text; none when it's complete (lib/host.js leaves an
// entry with problems out and reports them)
function problems(u) {
  const out = [];
  const missing = k => u[k] === undefined || u[k] === '' || (Array.isArray(u[k]) && !u[k].length);
  if (!u.name) out.push('no name');
  if (!CLASSES.includes(u.class ?? 'gated')) out.push(`class "${u.class}" is not one of ${CLASSES.join(', ')}`);
  for (const k of ['why', ...(dated(u) ? ['installed'] : ['check']), 'apply', 'backup']) if (missing(k)) out.push(`no ${k}`);
  if (u.backup !== undefined && !Array.isArray(u.backup)) out.push('backup must be a list of paths');
  if (dated(u)) {
    const r = u.released;
    if (!r || typeof r !== 'object' || (!r.npm && !r.github)) out.push('released must name a source: { npm = "<package>" } or { github = "<owner>/<repo>" }');
    else if (r.github && !/^[\w.-]+\/[\w.-]+$/.test(r.github)) out.push(`released.github "${r.github}" is not <owner>/<repo>`);
    if (u.apply && !String(u.apply).includes('{version}')) out.push('a dated apply must say {version}');
    if (u.verify && ['url', 'json', 'file'].some(k => !u.verify[k])) out.push('verify needs url, json and file');
  }
  for (const o of offList(u)) if (!o || !o.file || o.value === undefined) out.push('self_update_off needs file and value');
  if (u.class === 'signed_data') {
    if (!u.pin || ['file', 'match', 'sha256'].some(k => !u.pin[k])) out.push('signed_data needs a pin (file, match, sha256)');
    if (missing('require_output')) out.push('signed_data needs require_output');
  }
  if (u.class === 'exception' && !/^\d{4}-\d{2}-\d{2}$/.test(String(u.expires ?? ''))) out.push('an exception needs expires = "YYYY-MM-DD"');
  if (u.pin && u.pin.match) { try { new RegExp(u.pin.match); } catch (e) { out.push(`pin.match doesn't compile: ${e.message}`); } }
  return out;
}

// classOf(u, today) — the class in force today: an exception past its expiry is gated again
const classOf = (u, today) => (u.class === 'exception' && String(u.expires) < today ? 'gated' : u.class || 'gated');
// dated(u) — whether the entry names where its release dates come from (D72)
const dated = u => u.released !== undefined;
// offList(u) — self_update_off as a list: one table, or several of which any one holding is enough
const offList = u => (u.self_update_off === undefined ? [] : [].concat(u.self_update_off));
// why a class may skip the gate, as the plan says it
const SKIPS = { always_current: 'never held', signed_data: 'skips the gate', exception: 'skips the gate until it expires' };

// active(policy) — the updaters that hold here: no `when`, or its path exists (a default for a tool you don't have
// is inactive and silent)
const active = policy => (policy.updater || []).filter(u => !u.when || fs.existsSync(C.untilde(u.when)));
const byName = (policy, name) => (policy.updater || []).find(u => u.name === name);

// pinHash(text, pin) — {found, have, ok}: the sha256 (hex) of the first text pin.match finds, and whether it is pin.sha256.
// pinState checks a file on this machine with it; the maintainer's upstream watch (tools/upstream-watch.js) checks the
// publisher's copy with it, so both hash exactly the same text
function pinHash(text, pin) {
  const m = String(text).match(new RegExp(pin.match));
  if (!m) return { found: false, ok: false };
  const have = crypto.createHash('sha256').update(m[0]).digest('hex');
  return { found: true, have, ok: have === String(pin.sha256).toLowerCase() };
}

// pinState(u) — {ok, have, why}: whether the text pin.match finds in pin.file hashes to pin.sha256
function pinState(u) {
  if (!u.pin) return { ok: true };
  let text;
  try { text = fs.readFileSync(C.untilde(u.pin.file), 'utf8'); } catch { return { ok: false, why: `${u.pin.file} is missing` }; }
  const { found, have, ok } = pinHash(text, u.pin);
  if (!found) return { ok: false, why: `the pinned text isn't in ${u.pin.file}` };
  if (ok) return { ok: true, have };
  return { ok: false, have, why: `the signing key in ${u.pin.file} hashes to ${have.slice(0, 12)}…, not the pinned ${String(u.pin.sha256).slice(0, 12)}…` };
}

// selfUpdate(u) — {ok, have, where, want}: whether the tool's own updater is kept off. Each self_update_off entry names a
// file and the value it must hold: the whole file, or with `key` one JSON value in it (a dotted path, so env.X reads
// {"env": {"X": …}}). Several entries: any one holding is enough, for a tool that moves its switch (Claude Code moves
// autoUpdates from ~/.claude.json to env.DISABLE_AUTOUPDATER in ~/.claude/settings.json when it installs)
function selfUpdate(u) {
  const list = offList(u);
  if (!list.length) return { ok: true };
  const seen = list.map(o => {
    let have = 'unset';
    try {
      const text = fs.readFileSync(C.untilde(o.file), 'utf8');
      if (o.key === undefined) have = text.trim();
      else {
        const v = String(o.key).split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), JSON.parse(text));
        if (v !== undefined) have = String(v);
      }
    } catch { /* a missing or unreadable file is unset */ }
    return { ok: have === String(o.value), have, where: o.key === undefined ? o.file : `${o.file} ${o.key}`, want: String(o.value) };
  });
  const hit = seen.find(x => x.ok);
  if (hit) return { ok: true, have: hit.have, ...(list.length > 1 ? { where: hit.where } : {}) };
  if (list.length === 1) return { ok: false, have: seen[0].have, where: seen[0].where, want: seen[0].want };
  return { ok: false, have: seen.map(x => `${x.where} = ${x.have}`).join(', '), where: seen.map(x => x.where).join(' or '), want: seen.map(x => `${x.where} = ${x.want}`).join(' or ') };
}

/**
 * @typedef {{ state: string, status?: any, out: string, installed?: string, target?: string, waiting?: string,
 *   waitingClears?: string, major?: string, publishedAt?: string, clearsAt?: string }} CheckResult
 */
// check(u, run, o) — {state: current | behind | young | unknown, status, out, …}: from the entry's read-only check
// command (no label: the audit would print exit 10, which means behind, as a failure), or for a dated entry from its
// release dates (datedState). o: {minDays, now}, the gate's days and the clock
/** @returns {Promise<CheckResult>} */
async function check(u, run, o = {}) {
  if (dated(u)) return datedState(u, run, o);
  const r = await run('bash', ['-c', u.check], { stderr: true });
  return { state: r.status === 0 ? 'current' : r.status === 10 ? 'behind' : 'unknown', status: r.status, out: (r.stdout || '').trim() };
}

// The dated source (D72). A version is x.y.z with no prerelease tag; a newer major (or a 0.x minor) is never picked,
// since majors are deliberate
const VER = /(?<![\d.])(\d+)\.(\d+)\.(\d+)((?:-[0-9A-Za-z.-]+)?)(?![\d])/;
const parts = v => { const m = String(v).match(VER); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4], text: `${m[1]}.${m[2]}.${m[3]}${m[4]}` } : null; };
function cmpVer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  return x.pre === y.pre ? 0 : !x.pre ? 1 : !y.pre ? -1 : x.pre < y.pre ? -1 : 1;
}
const sameLine = (a, b) => { const x = parts(a).n, y = parts(b).n; return x[0] === y[0] && (x[0] > 0 || x[1] === y[1]); };
const json = s => { try { return JSON.parse(s); } catch { return null; } };

// platform() — the vendor's name for this machine, as release manifests key their builds: darwin-arm64, linux-x64,
// and -musl on a Linux without glibc
function platform() {
  const musl = process.platform === 'linux' && !(process.report && /** @type {any} */ (process.report.getReport()).header.glibcVersionRuntime);
  return `${process.platform}-${process.arch}${musl ? '-musl' : ''}`;
}
// fill(text, vars) — {version}, {installed} and {platform} put in
const fill = (text, vars) => String(text).replace(/\{(version|installed|platform)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k]));

// releases(u, run) — [{version, at}] (at in ms), from the npm registry's time map (`npm view <pkg> time --json`; npm
// 12 prints it inside an array) or a GitHub repo's releases (`gh api`, drafts and prereleases left out). null when
// the source couldn't be read
async function releases(u, run) {
  const r = u.released;
  if (r.npm) {
    const x = json((await run('npm', ['view', r.npm, 'time', '--json'])).stdout);
    const t = Array.isArray(x) ? Object.assign({}, ...x) : x;
    if (!t || typeof t !== 'object') return null;
    return Object.entries(t).filter(([v]) => parts(v) && parts(v).text === v).map(([version, at]) => ({ version, at: Date.parse(at) })).filter(e => e.at);
  }
  const x = json((await run('gh', ['api', `repos/${r.github}/releases?per_page=100`])).stdout);
  if (!Array.isArray(x)) return null;
  return x.filter(e => !e.draft && !e.prerelease && parts(e.tag_name)).map(e => ({ version: parts(e.tag_name).text, at: Date.parse(e.published_at) })).filter(e => e.at);
}

// installedVersion(u, run) — the version the entry's `installed` command prints, or null
async function installedVersion(u, run) {
  const p = parts((await run('bash', ['-c', u.installed])).stdout || '');
  return p ? p.text : null;
}

// datedState(u, run, {minDays, now}) — {state, installed, target, out, …}:
//   young    the installed version was published less than minDays ago (installed early, by hand or its own updater):
//            nothing is taken, and clears says when it is past the gate
//   behind   target, the newest version on the installed line past the gate, is newer than the installed one
//   current  neither; waiting names a newer one still inside the gate, major a newer major (yours to take)
//   unknown  the installed version or the release dates couldn't be read
/** @returns {Promise<CheckResult>} */
async function datedState(u, run, o = {}) {
  const minDays = o.minDays ?? 3;
  const now = (o.now || new Date()).getTime();
  const installed = await installedVersion(u, run);
  if (!installed) return { state: 'unknown', status: 'no version', out: `\`${u.installed}\` printed no version` };
  const list = await releases(u, run);
  if (!list) return { state: 'unknown', status: 'no dates', installed, out: `the release dates from ${u.released.npm ? `npm ${u.released.npm}` : `GitHub ${u.released.github}`} couldn't be read` };
  const stable = list.filter(e => !parts(e.version).pre);
  const day = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const mine = list.find(e => e.version === installed);
  if (mine && now - mine.at < minDays * DAY) {
    const clears = mine.at + minDays * DAY;
    return { state: 'young', installed, publishedAt: day(mine.at), clearsAt: day(clears), out: `${installed} is installed, published ${day(mine.at)}: it clears the ${minDays}-day wait at ${day(clears)}` };
  }
  const newer = stable.filter(e => cmpVer(e.version, installed) > 0).sort((a, b) => cmpVer(b.version, a.version));
  const line = newer.filter(e => sameLine(e.version, installed));
  const ready = line.find(e => now - e.at >= minDays * DAY);
  const waiting = line.find(e => now - e.at < minDays * DAY);
  const major = newer.find(e => !sameLine(e.version, installed));
  const extra = { ...(waiting ? { waiting: waiting.version, waitingClears: day(waiting.at + minDays * DAY) } : {}), ...(major ? { major: major.version } : {}) };
  if (ready) return { state: 'behind', installed, target: ready.version, out: `${installed} -> ${ready.version} (published ${day(ready.at)}, past the ${minDays}-day wait)`, ...extra };
  return { state: 'current', installed, out: `${installed}`, ...extra };
}

// run(cmd, args) — the audit's command runner for this file's own use: {status, stdout}, never thrown
const run = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', o.stderr ? 'pipe' : 'ignore'] });
  return Promise.resolve({ status: r.error ? 127 : r.status, stdout: (r.stdout || '') + (o.stderr ? r.stderr || '' : '') });
};

// copy(from, to) — a copy that keeps modes and times; an APFS clone on macOS (a 1.4 GB folder in a moment, its blocks
// shared until one side changes), a reflink where the Linux file system has them, else a plain copy. True when it worked
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (process.platform === 'darwin' && spawnSync('cp', ['-Rpc', from, to]).status === 0) return true; // bsd-ok: the APFS clone, macOS only
  if (process.platform === 'linux' && spawnSync('cp', ['-a', '--reflink=auto', from, to]).status === 0) return true;
  return spawnSync('cp', ['-Rp', from, to]).status === 0;
}

// tee(command) — run it in bash with its output shown as it comes and kept: {status, out}
const tee = command => new Promise(resolve => {
  let out = '';
  const p = spawn('bash', ['-c', command], { stdio: ['inherit', 'pipe', 'pipe'] });
  p.stdout.on('data', d => { out += d; process.stdout.write(d); });
  p.stderr.on('data', d => { out += d; process.stderr.write(d); });
  p.on('error', () => resolve({ status: 127, out }));
  p.on('close', status => resolve({ status, out }));
});

const lastLines = (s, n) => s.split('\n').slice(-n).join('\n');
const writeReceipt = (dir, r) => fs.writeFileSync(path.join(dir, 'receipt.json'), `${JSON.stringify(r, null, 1)}\n`);

// sha256File(file) — the hex sha256 of a file's bytes (through a link)
function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// expected(u, vars, run) — {sha256} the vendor publishes for this version and platform (verify.url fetched with curl,
// verify.json a dotted path into it), or {why} it couldn't be read
async function expected(u, vars, run) {
  const url = fill(u.verify.url, vars);
  const r = await run('curl', ['-fsSL', '--max-time', '30', url]);
  const doc = r.status === 0 ? json(r.stdout) : null;
  if (!doc) return { why: `no manifest at ${url}` };
  const v = fill(u.verify.json, vars).split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), doc);
  return /^[0-9a-f]{64}$/i.test(String(v)) ? { sha256: String(v).toLowerCase() } : { why: `the manifest at ${url} has no sha256 for ${vars.platform}` };
}

// apply(u, {today, newDir, run, minDays, now}) — the steps above; 0 when applied, already current or held young, 1 when
// refused or failed. run: the command runner for the reads (tests pass a stand-in); the apply itself runs in bash
async function apply(u, o = {}) {
  const cls = classOf(u, o.today || today());
  const reads = o.run || run;
  if (cls === 'gated' && !dated(u)) { console.error(`ERROR ${u.name} is gated: a declared source has no release date, so the steward doesn't apply it`); return 1; }
  const before = pinState(u);
  if (!before.ok) { console.error(`ERROR ${u.name}: ${before.why}; review the new key, then update the pin in a config-repo PR`); return 1; }
  log(`${u.name}: check`);
  const c = await check(u, reads, { minDays: cls === 'gated' ? o.minDays ?? minDaysNow() : 0, now: o.now });
  if (c.state === 'current') { log(`${u.name}: up to date${c.installed ? ` (${c.installed})` : ''}`); return 0; }
  if (c.state === 'young') { log(`${u.name}: held: ${c.out}`); return 0; }
  if (c.state === 'unknown') { console.error(`ERROR ${u.name}: its check couldn't tell (${dated(u) ? c.out : `exit ${c.status}`}); nothing was changed`); return 1; }
  const vars = { version: c.target, installed: c.installed, platform: platform() };
  const backup = u.backup.map(p => fill(p, vars));
  const command = fill(u.apply, vars);
  // signed_data and dated entries are copied by the steward first (D52, D72): a backup path that isn't there would
  // leave nothing to roll back to
  const absent = cls === 'signed_data' || dated(u) ? backup.filter(p => !fs.existsSync(C.untilde(p))) : [];
  if (absent.length) { console.error(`ERROR ${u.name}: nothing to back up at ${absent.join(', ')}; it is copied first, so nothing was changed`); return 1; }
  let want = null;
  if (u.verify) {
    want = await expected(u, vars, reads);
    if (!want.sha256) { console.error(`ERROR ${u.name}: ${want.why}; nothing was changed`); return 1; }
  }
  log(`${u.name}: ${dated(u) ? c.out : `behind (${cls}: ${SKIPS[cls]})`}; back up ${backup.join(', ')}, then: ${command}`);
  if (DRY) return 0;

  const dir = (o.newDir || C.newBackupDir)(`updater-${u.name}`);
  const file = path.join(dir, 'receipt.json');
  /** @type {Record<string, any>} */
  const rc = {
    kind: `updater-${cls}`, at: new Date().toISOString(), engine: C.ENGINE_VERSION, name: u.name, class: cls, why: u.why,
    before: c.out, ...(dated(u) ? { from: c.installed, to: c.target } : {}), backups: [], outcome: 'started', rollback: `steward sc rollback ${C.tilde(file)}`,
  };
  backup.forEach((p, i) => {
    const from = C.untilde(p), to = path.join('copies', String(i), path.basename(from));
    if (!fs.existsSync(from)) { rc.backups.push({ path: p, copy: null }); return; }
    if (!copy(from, path.join(dir, to))) throw new Error(`couldn't copy ${p} to ${C.tilde(dir)}; nothing was changed`);
    rc.backups.push({ path: p, copy: to });
  });
  if (u.pin) {
    rc.pin = { file: u.pin.file, sha256: u.pin.sha256, copy: path.join('pin', path.basename(u.pin.file)) };
    copy(C.untilde(u.pin.file), path.join(dir, rc.pin.copy));
  }
  writeReceipt(dir, rc);
  log(`backed up to ${C.tilde(dir)}`);

  const r = await tee(command);
  rc.output = lastLines(r.out.trim(), 60);
  const fail = why => { rc.outcome = `failed: ${why}`; writeReceipt(dir, rc); console.error(`ERROR ${u.name}: ${why}. Receipt ${C.tilde(file)}; to go back: ${rc.rollback}`); return 1; };
  if (r.status !== 0) return fail(`apply exited ${r.status}`);
  if (u.require_output && !r.out.includes(u.require_output)) return fail(`its output doesn't say "${u.require_output}"`);
  if (want) {
    const target = C.untilde(fill(u.verify.file, vars));
    let have = null;
    try { have = sha256File(target); } catch { /* missing: fails below */ }
    rc.verify = { file: fill(u.verify.file, vars), want: want.sha256, have };
    if (have !== want.sha256) {
      restore(dir, rc, `rejected-${stamp()}`);
      return fail(`${rc.verify.file} ${have ? `hashes to ${have.slice(0, 12)}…` : 'is missing'}, not the vendor's ${want.sha256.slice(0, 12)}…; what it replaced is back`);
    }
  }
  const after = pinState(u);
  if (!after.ok) {
    copy(path.join(dir, rc.pin.copy), `${C.untilde(u.pin.file)}.steward`);
    fs.renameSync(`${C.untilde(u.pin.file)}.steward`, C.untilde(u.pin.file));
    return fail(`the update changed the signing key (${after.why}); the reviewed ${u.pin.file} is back. Review the new key before the next apply`);
  }
  rc.after = (await check(u, reads, { minDays: cls === 'gated' ? o.minDays ?? minDaysNow() : 0, now: o.now })).out;
  rc.outcome = 'applied';
  writeReceipt(dir, rc);
  log(`${u.name}: applied (${cls}${dated(u) ? `, ${c.installed} -> ${c.target}` : ''}). Receipt ${C.tilde(file)}; to go back: ${rc.rollback}`);
  return 0;
}

// lexists(p) — whether anything is at p, a link included even when its target is gone
const lexists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const minDaysNow = () => C.load().values.policy.min_release_age_days;

// restore(dir, rc, aside) — put a receipt's copies back; what's there now moves to dir/aside/<i>, so nothing is lost.
// A link is put back as the link it was (the copy is a link)
function restore(dir, rc, aside) {
  const todo = rc.backups.filter(b => b.copy);
  todo.forEach((b, i) => {
    const live = C.untilde(b.path);
    let there = false;
    try { fs.lstatSync(live); there = true; } catch { /* nothing there */ }
    if (there) move(live, path.join(dir, aside, String(i), path.basename(live)));
    if (!copy(path.join(dir, b.copy), live)) throw new Error(`couldn't copy ${b.copy} back to ${b.path}`);
  });
  return todo;
}

// move(from, to) — a rename, or a copy and delete across volumes
function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV' || !copy(from, to)) throw e;
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// rollback(file, {ask}) — put an updater receipt's copies back; what's there now moves beside them, so nothing is lost
async function rollback(file, o = {}) {
  const f = fs.statSync(file).isDirectory() ? path.join(file, 'receipt.json') : file;
  const rc = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!String(rc.kind).startsWith('updater-')) { console.error(`ERROR ${C.tilde(f)} is not an updater receipt (kind ${rc.kind})`); return 1; }
  const dir = path.dirname(f);
  const todo = rc.backups.filter(b => b.copy);
  if (!todo.length || todo.some(b => !lexists(path.join(dir, b.copy)))) { console.error(`ERROR ${C.tilde(dir)} no longer holds the copies (steward sc prune removes them after soak_days)`); return 1; }
  const at = stamp();
  log(`${rc.name}: put back what ${rc.at} replaced`);
  todo.forEach((b, i) => { console.log(`  restore ${b.path} from ${C.tilde(path.join(dir, b.copy))} (what's there now moves to ${C.tilde(path.join(dir, `rolled-back-${at}`, String(i)))})`); });
  if (DRY) return 0;
  if (!(await (o.ask || ask)('Put these back?'))) { console.error('ERROR aborted'); return 1; }
  restore(dir, rc, `rolled-back-${at}`);
  fs.writeFileSync(path.join(dir, `rollback-${at}.json`), `${JSON.stringify({ kind: 'updater-rollback', at: new Date().toISOString(), engine: C.ENGINE_VERSION, restored: todo.map(b => b.path) }, null, 1)}\n`);
  log(`${rc.name}: restored. Check with: steward sc audit --only updaters`);
  return 0;
}

// prunable(state, days, now) — the copy folders of updater receipts older than soak_days
function prunable(state, days, now = new Date()) {
  const root = path.join(state, 'backups');
  let names = [];
  try { names = fs.readdirSync(root).filter(n => n.startsWith('updater-')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    let rc;
    try { rc = JSON.parse(fs.readFileSync(path.join(root, n, 'receipt.json'), 'utf8')); } catch { continue; }
    if (!(now.getTime() - Date.parse(rc.at) > days * DAY)) continue;
    for (const d of fs.readdirSync(path.join(root, n))) if (d === 'copies' || d === 'pin' || d.startsWith('rolled-back-') || d.startsWith('rejected-')) out.push(path.join(root, n, d));
  }
  return out;
}

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^[Yy]$/.test(a.trim());
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

module.exports = { CLASSES, SKIPS, problems, classOf, dated, active, byName, pinHash, pinState, selfUpdate, check, datedState, releases, platform, fill, cmpVer, apply, rollback, prunable };

if (require.main === module) {
  const [mode, arg] = process.argv.slice(2);
  const main = async () => {
    if (mode === '--prunable' || mode === '--prune') {
      const { values } = C.load();
      for (const d of prunable(values.paths.state, values.policy.soak_days)) {
        console.log(C.tilde(d));
        if (mode === '--prune' && !DRY) fs.rmSync(d, { recursive: true, force: true });
      }
      return 0;
    }
    if (mode === '--rollback' && arg) return rollback(C.userPath(arg));
    if (mode === '--apply' && arg) {
      const u = byName(require('./host.js').load().policy, arg);
      if (!u) { console.error(`ERROR no [[updater]] named ${arg} (steward sc host lists them)`); return 1; }
      return apply(u);
    }
    console.error('usage: updaters.js --apply <name> | --rollback <receipt> | --prunable | --prune');
    return 2;
  };
  main().then(code => { process.exitCode = code; }).catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
