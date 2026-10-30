#!/usr/bin/env node
// The briefing's background refresh (D57, docs/briefing.md): the read-only checks that need the network or a slow walk,
// run now and then so `steward brief` can say more than what is already on disk. Nothing here changes your machine,
// your projects or your config. It writes one file, its cache (<state>/brief/refresh.json), and a lock beside it while
// it runs.
// Steps, each with its own time limit, all under a 120 s total:
//   config    git fetch of your config repo, without prompts ([brief] fetch; only when the config folder is its own
//             repo with an upstream). A fetch changes only FETCH_HEAD and the remote's branches
//   npm       the newest workstation-steward on npm (dist-tags.latest) and when it was published
//   projects  new and vanished projects under [projects] roots (the projects add-on)
//   drift     `steward ai drift --offline --json`, its DRIFT and WARN lines (the AI tooling add-on)
//   node      `mise current node`, the Node the hybrids should be installed for
// It never runs a full reconcile plan (that writes seen.json), the release-age gate's queue (that moves the review's
// anchor), `steward sc audit` or `gh`. A step that fails or runs out of time is recorded, and the rest still run.
// Usage: refresh.js            run it now, in the foreground, with progress; print what it found
//        refresh.js --child    what maybeRefresh starts: detached, low priority, no output
// Settings: [brief] refresh_hours (default 6; 0 = never unprompted), fetch (default true). STEWARD_NO_REFRESH or CI in
// the environment: never started unprompted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const C = require('./config.js');

const CAP = 120e3;               // the whole refresh
const LOCK_STALE = 10 * 60e3;    // a lock older than this, or whose process is gone, is left over: taken over
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const date = s => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

// files(state) — where the cache and the lock live
const files = (state = C.load().values.paths.state) => {
  const dir = path.join(state, 'brief');
  return { dir, cache: path.join(dir, 'refresh.json'), lock: path.join(dir, 'refresh.lock') };
};

// readCache(state) — the last refresh, {v, at, engine, steps}, or null
const readCache = state => readJSON(files(state).cache);

// alive(pid) — the process is still running (EPERM: running, as someone else)
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// takeLock(file, {pid, now}) — {ok} when this run holds the lock now; {ok: false, holder} when another refresh does.
// A lock older than 10 minutes, or whose process is gone, is left over from a run that died: it is taken over
function takeLock(file, { pid = process.pid, now = new Date() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid, at: now.toISOString() }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readJSON(file);
      const at = date(holder && holder.at);
      if (holder && at && now.getTime() - at.getTime() < LOCK_STALE && alive(holder.pid)) return { ok: false, holder };
      try { fs.unlinkSync(file); } catch { /* another run took it over first */ }
    }
  }
  return { ok: false, holder: readJSON(file) };
}

// setLock(file, pid) — the lock names this process (the detached child, once it is running)
const setLock = (file, pid, now = new Date()) => fs.writeFileSync(file, JSON.stringify({ pid, at: now.toISOString() }), { mode: 0o600 });
// releaseLock(file, pid) — removes the lock, only when it is this process's
function releaseLock(file, pid = process.pid) {
  const h = readJSON(file);
  if (h && h.pid === pid) { try { fs.unlinkSync(file); } catch { /* gone already */ } }
}

// defaultRun(cmd, args, {timeout, env, cwd}) — {code, stdout, stderr, timedOut}; never throws
/** @param {string} cmd @param {string[]} args @param {{timeout?: number, env?: object, cwd?: string}} [o] */
const defaultRun = (cmd, args, o = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout: o.timeout || 30e3, env: /** @type {any} */ (o.env || process.env), cwd: o.cwd || C.HOME, maxBuffer: 64 << 20, encoding: 'utf8' }, (e, stdout, stderr) => {
    const err = /** @type {any} */ (e);
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') || (err && !err.killed ? err.message : ''), timedOut: Boolean(err && err.killed) });
  });
});

const dur = ms => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);
const firstLine = s => String(s || '').trim().split('\n')[0].slice(0, 200);
const fail = (what, r) => new Error(r.timedOut ? `${what} ran out of time` : `${what} failed${r.stderr ? `: ${firstLine(r.stderr)}` : ` (exit ${r.code})`}`);

// The steps. Each: name, label (its progress line), timeout, when(values) (null to run, else why it is skipped), and
// fn(ctx) → its data. ctx: {values, run, timeout, instance, engine}
/** @type {Array<{name: string, label: string, timeout: number, when: (v: any) => string | null, fn: (ctx: any) => Promise<any>}>} */
const STEPS = [
  {
    name: 'config', label: 'fetching your config repo', timeout: 30e3,
    when: v => (v.brief.fetch ? null : '[brief] fetch = false'),
    async fn({ run, timeout, instance }) {
      const CR = require('./configrepo.js');
      const s = CR.state(instance);
      if (!s.repo) return { skipped: 'the config folder is not a Git repository of its own' };
      if (!s.upstream) return { skipped: `${s.branch || 'HEAD'} has no upstream` };
      // no prompt can wait for an answer nobody sees: no terminal prompt, and ssh in batch mode (your own ssh command,
      // if you set one, keeps its options)
      const cfg = await run('git', ['-C', instance, 'config', '--get', 'core.sshCommand'], { timeout: 5e3 });
      const ssh = process.env.GIT_SSH_COMMAND || (cfg.code === 0 && cfg.stdout.trim()) || 'ssh';
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` };
      const r = await run('git', CR.fetchArgs(s), { timeout, env });
      if (r.code !== 0) throw fail('git fetch', r);
      const after = CR.state(instance);
      return { upstream: after.upstream, behind: after.behind, ahead: after.ahead, fetchedAt: after.fetchedAt ? new Date(after.fetchedAt).toISOString() : null };
    },
  },
  {
    name: 'npm', label: 'the newest steward on npm', timeout: 20e3, when: () => null,
    async fn({ run, timeout }) {
      const r = await run('npm', ['view', 'workstation-steward', 'dist-tags.latest'], { timeout });
      const latest = r.stdout.trim().replace(/^"|"$/g, '');
      if (r.code !== 0 || !/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(latest)) throw fail('npm view', r.code === 0 ? { ...r, stderr: `unexpected answer "${firstLine(latest)}"` } : r);
      const GQ = require('./gatequeue.js');
      const published = await GQ.publishedAt('npm:workstation-steward', latest, async (cmd, args) => {
        const x = await run(cmd, args, { timeout });
        return x.code === 0 ? x.stdout : null;
      });
      return { latest, published: published ? published.toISOString() : null };
    },
  },
  {
    name: 'projects', label: 'new projects', timeout: 30e3, when: v => (v.profiles.projects ? null : 'the projects add-on is off'),
    // in a process of its own, so its time limit holds: the walk is synchronous
    async fn({ run, timeout }) {
      const r = await run(process.execPath, [__filename, '--projects'], { timeout });
      if (r.code !== 0) throw fail('the project walk', r);
      return JSON.parse(r.stdout);
    },
  },
  {
    name: 'drift', label: 'AI tooling drift', timeout: 60e3, when: v => (v.profiles.ai_tooling ? null : 'the AI tooling add-on is off'),
    async fn({ run, timeout, engine }) {
      const r = await run(process.execPath, [path.join(engine, 'ai-tooling', 'bin', 'drift.js'), '--offline', '--json'], { timeout });
      let all;
      try { all = JSON.parse(r.stdout); } catch { throw fail('steward ai drift', r.code === 0 ? { ...r, stderr: 'its output is not JSON' } : r); }
      const kept = all.filter(x => x.level === 'DRIFT' || x.level === 'WARN');
      return { drift: kept.filter(x => x.level === 'DRIFT').length, warn: kept.filter(x => x.level === 'WARN').length,
        items: kept.slice(0, 100).map(x => ({ level: x.level, area: x.area, msg: String(x.msg).slice(0, 400) })) };
    },
  },
  {
    name: 'node', label: 'the active Node', timeout: 5e3, when: () => null,
    // from the home folder, so it is the global Node (the one the hybrids are installed into), not a project's
    async fn({ run, timeout }) {
      const r = await run('mise', ['current', 'node'], { timeout, cwd: C.HOME });
      const node = r.stdout.trim().split(/\s+/)[0];
      if (r.code !== 0 || !/^\d+\.\d+\.\d+/.test(node || '')) throw fail('mise current node', r.code === 0 ? { ...r, stderr: `unexpected answer "${firstLine(r.stdout)}"` } : r);
      return { node };
    },
  },
];

// projectsSummary() — newAndGone() as the cache keeps it: counts, the first three paths of each with ~, the roots
function projectsSummary() {
  const P = require('./projects.js');
  const { fresh, gone, found } = P.newAndGone();
  return { found: found.length, fresh: fresh.length, gone: gone.length, first: fresh.slice(0, 3).map(f => P.tilde(f.path)), firstGone: gone.slice(0, 3).map(g => g.path), roots: P.ROOTS.map(P.tilde) };
}

// writeCache(file, data) — temp file and rename, so a reader never sees half of it; only you can read it
function writeCache(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// refresh({values, run, now, cap, steps, onStep}) — every step in turn, each within min(its timeout, what is left of
// the cap); writes the cache and returns it. onStep(step) → {done(record)}: progress, for the foreground
async function refresh({ values = C.load().values, run = defaultRun, now = () => new Date(), cap = CAP, steps = STEPS, onStep = null } = {}) {
  const start = now();
  const deadline = start.getTime() + cap;
  const out = { v: 1, at: start.toISOString(), engine: C.ENGINE_VERSION, steps: {} };
  for (const st of steps) {
    const t0 = now();
    const left = deadline - t0.getTime();
    const ui = onStep ? onStep(st) : null;
    let rec;
    const skip = st.when(values);
    if (skip) rec = { ok: true, skipped: skip };
    else if (left <= 0) rec = { ok: false, error: `not run: the refresh reached its ${dur(cap)} limit` };
    else {
      const timeout = Math.min(st.timeout, left);
      let timer;
      const late = new Promise(resolve => { timer = setTimeout(() => resolve({ late: true }), timeout); });
      try {
        const r = await Promise.race([st.fn({ values, run, timeout, instance: C.INSTANCE_ROOT, engine: C.REPO_ROOT }), late]);
        if (r && r.late) rec = { ok: false, error: `ran out of time after ${dur(timeout)}` };
        else if (r && r.skipped) rec = { ok: true, skipped: r.skipped };
        else rec = { ok: true, data: r };
      } catch (e) { rec = { ok: false, error: firstLine(e.message) }; }
      clearTimeout(timer);
    }
    rec = { ...rec, at: t0.toISOString(), ms: now().getTime() - t0.getTime() };
    out.steps[st.name] = rec;
    if (ui) ui.done(rec);
  }
  writeCache(files(values.paths.state).cache, out);
  return out;
}

// due({values, env, now}) — null when a refresh should start now, else why not
function due({ values = C.load().values, env = process.env, now = new Date() } = {}) {
  const hours = values.brief.refresh_hours;
  if (!hours) return '[brief] refresh_hours = 0';
  if (env.STEWARD_NO_REFRESH) return 'STEWARD_NO_REFRESH is set';
  if (env.CI) return 'CI is set';
  const c = readCache(values.paths.state);
  const at = date(c && c.at);
  if (at && now.getTime() - at.getTime() < hours * 3600e3) return 'the cache is fresh';
  return null;
}

// maybeRefresh({values, env, now, spawnFn}) — when the cache is older than [brief] refresh_hours, start the refresh as a
// detached, low-priority process and return at once; {started, why}. The briefing calls it after printing, so it
// never waits for the network. A refresh already running holds the lock: nothing starts
/** @param {{values?: any, env?: any, now?: Date, spawnFn?: (cmd: string, args: string[], opts: object) => any}} [o] */
function maybeRefresh({ values = C.load().values, env = process.env, now = new Date(), spawnFn = spawn } = {}) {
  const why = due({ values, env, now });
  if (why) return { started: false, why };
  const { lock } = files(values.paths.state);
  const l = takeLock(lock, { now });
  if (!l.ok) return { started: false, why: `a refresh is running (pid ${l.holder && l.holder.pid})` };
  try {
    const child = spawnFn(process.execPath, [__filename, '--child'], { detached: true, stdio: 'ignore', cwd: C.HOME, env });
    child.on('error', () => releaseLock(lock, child.pid || process.pid));
    if (!child.pid) { releaseLock(lock); return { started: false, why: 'it could not start' }; }
    setLock(lock, child.pid, now);
    child.unref();
    return { started: true, pid: child.pid };
  } catch (e) {
    releaseLock(lock);
    return { started: false, why: e.message };
  }
}

// summary(name, rec) — one line for what a step found, in words
function summary(name, rec) {
  if (rec.skipped) return `skipped: ${rec.skipped}`;
  if (!rec.ok) return `failed: ${rec.error}`;
  const d = rec.data || {};
  if (name === 'config') return `${d.behind} newer on ${d.upstream}, ${d.ahead} not pushed`;
  if (name === 'npm') return `${d.latest}${d.published ? `, published ${d.published.slice(0, 16).replace('T', ' ')}Z` : ''} (this is ${C.ENGINE_VERSION})`;
  if (name === 'projects') return `${d.found} found, ${d.fresh} new, ${d.gone} gone`;
  if (name === 'drift') return `${d.drift} drift, ${d.warn} warning(s)`;
  if (name === 'node') return d.node;
  return 'done';
}

// foreground() — `steward brief --refresh`: the refresh now, with a stage per step on stderr. {ok, cache, why}
async function foreground({ values = C.load().values, run = defaultRun } = {}) {
  const { lock } = files(values.paths.state);
  const l = takeLock(lock);
  if (!l.ok) return { ok: false, why: `a refresh is already running (pid ${l.holder && l.holder.pid}, since ${l.holder && l.holder.at}): try again in a minute` };
  try {
    const pg = require('./progress.js').progress(STEPS.length);
    const cache = await refresh({ values, run, onStep: st => { const s = pg.stage(st.label); return { done: rec => s.done(summary(st.name, rec)) }; } });
    pg.finish('refresh');
    return { ok: true, cache };
  } finally { releaseLock(lock); }
}

module.exports = { STEPS, CAP, LOCK_STALE, files, readCache, takeLock, releaseLock, refresh, due, maybeRefresh, foreground, summary, defaultRun };

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--projects') {
    process.stdout.write(JSON.stringify(projectsSummary()));
  } else if (arg === '--child') {
    // detached from the briefing that started it: low priority, a hard stop past the cap, the lock removed on the way out
    try { os.setPriority(19); } catch { /* not allowed here: run at normal priority */ }
    const values = C.load().values;
    const { lock } = files(values.paths.state);
    setLock(lock, process.pid);
    process.on('exit', () => releaseLock(lock));
    setTimeout(() => process.exit(1), CAP + 15e3).unref();
    refresh({ values }).catch(() => {}).finally(() => process.exit(0));
  } else {
    foreground().then(r => {
      if (!r.ok) { console.error(r.why); process.exit(1); }
      console.log(`refreshed ${C.tilde(files().cache)}`);
    }).catch(e => { console.error(`ERROR refresh: ${e.message}`); process.exit(1); });
  }
}
