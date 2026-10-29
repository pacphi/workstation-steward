#!/usr/bin/env node
// Declared update sources (D52, docs/release-classes.md): an [[updater]] in the host policy (lib/host.js) is a source
// the steward doesn't install itself, such as a signed data bundle with its own updater. The steward runs the entry's
// commands; it doesn't know what the tool is. Its class says whether it waits for the release-age gate: gated (the
// default) waits, always_current and signed_data don't, and an exception doesn't until it expires (then it's gated).
// A declared source has no release date the steward can read, so a gated one that's behind is held for a person.
//   check   read-only; exit 0 = current, 10 = behind, anything else = couldn't tell. The audit and the plan run it
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
  for (const k of ['why', 'check', 'apply', 'backup']) if (missing(k)) out.push(`no ${k}`);
  if (u.backup !== undefined && !Array.isArray(u.backup)) out.push('backup must be a list of paths');
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

// selfUpdate(u) — {ok, have}: whether the tool's own updater is kept off (self_update_off's file holds its value)
function selfUpdate(u) {
  if (!u.self_update_off) return { ok: true };
  let have = '';
  try { have = fs.readFileSync(C.untilde(u.self_update_off.file), 'utf8').trim(); } catch { have = 'unset'; }
  return { ok: have === String(u.self_update_off.value), have };
}

// check(u, run) — {state: current | behind | unknown, status, out}, from the entry's read-only check command (no
// label: the audit would print exit 10, which means behind, as a failure)
async function check(u, run) {
  const r = await run('bash', ['-c', u.check], { stderr: true });
  return { state: r.status === 0 ? 'current' : r.status === 10 ? 'behind' : 'unknown', status: r.status, out: (r.stdout || '').trim() };
}

// run(cmd, args) — the audit's command runner for this file's own use: {status, stdout}, never thrown
const run = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', o.stderr ? 'pipe' : 'ignore'] });
  return Promise.resolve({ status: r.error ? 127 : r.status, stdout: (r.stdout || '') + (o.stderr ? r.stderr || '' : '') });
};

// copy(from, to) — a copy that keeps modes and times; an APFS clone where it can (a 1.4 GB folder in a moment, its
// blocks shared until one side changes), a plain copy elsewhere. True when it worked
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (process.platform === 'darwin' && spawnSync('cp', ['-Rpc', from, to]).status === 0) return true;
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

// apply(u, {today, newDir}) — the steps above; 0 when applied or already current, 1 when refused or failed
async function apply(u, o = {}) {
  const cls = classOf(u, o.today || today());
  if (cls === 'gated') { console.error(`ERROR ${u.name} is gated: a declared source has no release date, so the steward doesn't apply it`); return 1; }
  // signed_data is copied by the steward first (D52): a backup path that isn't there would leave nothing to roll back to
  const absent = cls === 'signed_data' ? u.backup.filter(p => !fs.existsSync(C.untilde(p))) : [];
  if (absent.length) { console.error(`ERROR ${u.name}: nothing to back up at ${absent.join(', ')}; signed_data is copied first, so nothing was changed`); return 1; }
  const before = pinState(u);
  if (!before.ok) { console.error(`ERROR ${u.name}: ${before.why}; review the new key, then update the pin in a config-repo PR`); return 1; }
  log(`${u.name}: check`);
  const c = await check(u, run);
  if (c.state === 'current') { log(`${u.name}: up to date`); return 0; }
  if (c.state === 'unknown') { console.error(`ERROR ${u.name}: its check couldn't tell (exit ${c.status}); nothing was changed`); return 1; }
  log(`${u.name}: behind (${cls}: ${SKIPS[cls]}); back up ${u.backup.join(', ')}, then: ${u.apply}`);
  if (DRY) return 0;

  const dir = (o.newDir || C.newBackupDir)(`updater-${u.name}`);
  const file = path.join(dir, 'receipt.json');
  const rc = {
    kind: `updater-${cls}`, at: new Date().toISOString(), engine: C.ENGINE_VERSION, name: u.name, class: cls, why: u.why,
    before: c.out, backups: [], outcome: 'started', rollback: `steward sc rollback ${C.tilde(file)}`,
  };
  u.backup.forEach((p, i) => {
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

  const r = await tee(u.apply);
  rc.output = lastLines(r.out.trim(), 60);
  const fail = why => { rc.outcome = `failed: ${why}`; writeReceipt(dir, rc); console.error(`ERROR ${u.name}: ${why}. Receipt ${C.tilde(file)}; to go back: ${rc.rollback}`); return 1; };
  if (r.status !== 0) return fail(`apply exited ${r.status}`);
  if (u.require_output && !r.out.includes(u.require_output)) return fail(`its output doesn't say "${u.require_output}"`);
  const after = pinState(u);
  if (!after.ok) {
    copy(path.join(dir, rc.pin.copy), `${C.untilde(u.pin.file)}.steward`);
    fs.renameSync(`${C.untilde(u.pin.file)}.steward`, C.untilde(u.pin.file));
    return fail(`the update changed the signing key (${after.why}); the reviewed ${u.pin.file} is back. Review the new key before the next apply`);
  }
  rc.after = (await check(u, run)).out;
  rc.outcome = 'applied';
  writeReceipt(dir, rc);
  log(`${u.name}: applied (${cls}). Receipt ${C.tilde(file)}; to go back: ${rc.rollback}`);
  return 0;
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
  if (!todo.length || todo.some(b => !fs.existsSync(path.join(dir, b.copy)))) { console.error(`ERROR ${C.tilde(dir)} no longer holds the copies (steward sc prune removes them after soak_days)`); return 1; }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  log(`${rc.name}: put back what ${rc.at} replaced`);
  todo.forEach((b, i) => { console.log(`  restore ${b.path} from ${C.tilde(path.join(dir, b.copy))} (what's there now moves to ${C.tilde(path.join(dir, `rolled-back-${stamp}`, String(i)))})`); });
  if (DRY) return 0;
  if (!(await (o.ask || ask)('Put these back?'))) { console.error('ERROR aborted'); return 1; }
  todo.forEach((b, i) => {
    const live = C.untilde(b.path);
    if (fs.existsSync(live)) move(live, path.join(dir, `rolled-back-${stamp}`, String(i), path.basename(live)));
    if (!copy(path.join(dir, b.copy), live)) throw new Error(`couldn't copy ${b.copy} back to ${b.path}`);
  });
  fs.writeFileSync(path.join(dir, `rollback-${stamp}.json`), `${JSON.stringify({ kind: 'updater-rollback', at: new Date().toISOString(), engine: C.ENGINE_VERSION, restored: todo.map(b => b.path) }, null, 1)}\n`);
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
    for (const d of fs.readdirSync(path.join(root, n))) if (d === 'copies' || d === 'pin' || d.startsWith('rolled-back-')) out.push(path.join(root, n, d));
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

module.exports = { CLASSES, SKIPS, problems, classOf, active, byName, pinHash, pinState, selfUpdate, check, apply, rollback, prunable };

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
