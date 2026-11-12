#!/usr/bin/env node
// Local container tests for each Linux distribution (parity 0.9): `just linux-test [<id>|all] [--x64] [--keep]` builds
// one image per row of test/containers/matrix.json (cached by a hash of what goes into it) and runs `just test` in a
// throwaway container: removed after the run, no network, a read-only root, a non-root user, the checkout mounted
// read-only and copied onto tmpfs. Each row's full output goes to <state>/linux-test/<id>-<time>.txt and a summary to
// latest.txt; the exit code is 0 only when every row passed. `just linux-clean [--cache]` removes what these runs made.
// Everything they create carries LABEL, and only labelled containers, images, volumes and networks are ever listed or
// removed; the build cache, which every project on this Docker shares, only with --cache, after its own yes.
// It adds to the CI matrix and never replaces it (parity 0.9). Engine tooling: not part of the npm package.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { FAMILIES } = require('../lib/platform.js');

const LABEL = 'org.workstation-steward.test';
const REPO = path.join(__dirname, '..');
const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROLES = ['oldest', 'newest', 'rolling'];
const ARCHES = ['amd64', 'arm64'];

// loadMatrix(file) — test/containers/matrix.json, parsed
const loadMatrix = (file = path.join(REPO, 'test', 'containers', 'matrix.json')) => JSON.parse(fs.readFileSync(file, 'utf8'));

// validate(m) — what is wrong with the matrix, one message each ([] when it is right)
function validate(m) {
  const bad = [];
  for (const r of m.rows || []) {
    if (!FAMILIES.includes(r.family)) bad.push(`${r.id}: family must be one of ${FAMILIES.join(', ')} (not ${r.family})`);
    if (!/^[a-z0-9./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/.test(r.image || '')) bad.push(`${r.id}: image must name a digest (image:tag@sha256:<64 hex>)`);
    if (!r.distro || !(r.id === r.distro || String(r.id).startsWith(`${r.distro}-`))) bad.push(`${r.id}: distro is missing, and the id must be <distro> or <distro>-<version>`);
    if (!ROLES.includes(r.role)) bad.push(`${r.id}: role must be one of ${ROLES.join(', ')}`);
    const u = r.supported_until;
    if (r.role !== 'rolling' && !(u && u.source && (DAY.test(u.date || '') || (u.date === null && u.why)))) bad.push(`${r.id}: supported_until needs a date (YYYY-MM-DD, or null with why) and its source`);
    if (r.arch && !(Array.isArray(r.arch) && r.arch.length && r.arch.every(a => ARCHES.includes(a)))) bad.push(`${r.id}: arch must list amd64 and/or arm64`);
    if (r.extra && !(Array.isArray(r.extra) && r.extra.every(x => /^[a-z0-9][a-z0-9.+-]*=[\w.+:~-]+$/.test(x)))) bad.push(`${r.id}: extra must list package=version pins`);
    const e = r.gate_exception;
    if (e && !(e.why && e.decided && DAY.test(e.expires || ''))) bad.push(`${r.id}: gate_exception needs why, decided and expires (YYYY-MM-DD)`);
  }
  const ids = (m.rows || []).map(r => r.id);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) bad.push(`${id}: the id is used twice`);
  const mise = m.mise || {};
  if (!mise.version) bad.push('mise: version is missing');
  for (const a of ['arm64', 'x64']) if (!HEX64.test((mise.sha256 || {})[a] || '')) bad.push(`mise: sha256.${a} must be 64 hex characters`);
  return bad;
}

// select(rows, want) — {rows, unknown}: rows by id, a distribution's rows by its name (`debian`: every Debian row), or all
function select(rows, want) {
  if (!want.length || want.includes('all')) return { rows, unknown: [] };
  const unknown = want.filter(w => !rows.some(r => r.id === w || r.distro === w));
  return { rows: rows.filter(r => want.some(w => r.id === w || r.distro === w)), unknown };
}

// rowX64(row, x64) — whether the row runs as amd64: on an x64 machine, with --x64, or when its images are amd64 only (Mint)
const rowX64 = (row, x64) => x64 || (Array.isArray(row.arch) && !row.arch.includes('arm64'));

// emulated(row, x64, arch) — whether the row runs emulated here: as amd64 on a host that isn't x64 (Mint on an Apple-silicon
// Mac). Its tests then get STEWARD_TEST_EMULATED=1, and timing limits loosen (owner, 2026-11-03); CI runs x64 natively
const emulated = (row, x64, arch = process.arch) => rowX64(row, x64) && arch !== 'x64';

// STALE_DAYS — a rolling row's pin older than this is said loudly: Tumbleweed's latest is rebuilt about daily, so the
// 3-day gate may never let Renovate move it (the owner, 2026-11-04)
const STALE_DAYS = 30;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// pinnedSince(row, file) — the day (YYYY-MM-DD) the commit that brought this row's digest into matrix.json was made, or
// null when git can't see it (not a checkout, a shallow one, or a digest never committed). The image can't say: its
// build date is a fixed timestamp
function pinnedSince(row, file = path.join(__dirname, '..', 'test', 'containers', 'matrix.json')) {
  const digest = (String(row.image).match(/@(sha256:[0-9a-f]{64})$/) || [])[1];
  if (!digest) return null;
  const cwd = path.dirname(file);
  // a shallow clone's tip seems to bring in every line, so its date would read as a fresh pin
  const sh = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8' });
  if (sh.status !== 0 || sh.stdout.trim() !== 'false') return null;
  const r = spawnSync('git', ['log', '-1', '--format=%cs', `-S${digest}`, '--', path.basename(file)], { cwd, encoding: 'utf8' });
  const day = r.status === 0 ? r.stdout.trim() : '';
  return DAY.test(day) ? day : null;
}
// pinDates(rows) — {id: day or null} for the rolling rows, for notes() and ci()
const pinDates = rows => Object.fromEntries(rows.filter(r => r.role === 'rolling').map(r => [r.id, pinnedSince(r)]));

// notes(rows, today, pinned) — what to say before a run: a row past its support end (drop it), a gate exception and its
// expiry, and a rolling row's pin that is stale or can't be dated (pinned: pinDates(); rows it doesn't name aren't checked)
function notes(rows, today, pinned = {}) {
  const out = [];
  for (const r of rows) {
    if (r.role === 'rolling' && r.id in pinned) {
      const since = pinned[r.id];
      if (!since) out.push(`PIN AGE UNKNOWN: ${r.id}: git can't see when its digest was pinned (a shallow checkout?)`);
      else if (daysBetween(since, today) > STALE_DAYS) out.push(`STALE PIN: ${r.id} pinned since ${since} (${daysBetween(since, today)} days): Renovate hasn't moved it; repin by hand`);
    }
    const u = r.supported_until;
    if (u && u.date && u.date < today) out.push(`PAST SUPPORT: ${r.id} was supported until ${u.date} (${u.source}): drop the row`);
    const e = r.gate_exception;
    if (e) out.push(`note: ${r.id} runs under a release-age gate exception (${e.decided}; expires ${e.expires})${e.expires < today ? ': EXPIRED, move it to an image past the gate' : ''}`);
  }
  return out;
}

// ci(m, today) — {rows, warnings} for test.yml: every row's id (parity T.1), and each note other than a plain one as a warning
const ci = (m, today, pinned = {}) => ({ rows: m.rows.map(r => r.id), warnings: notes(m.rows, today, pinned).filter(n => !n.startsWith('note: ') || n.includes('EXPIRED')).map(n => `::warning title=linux-test::${n}`) });

// imageTag(row, recipe, mise) — steward-test/<id>:<12 hex>, from the Dockerfile (and what it copies), the base, its extras and mise
const imageTag = (row, recipe, mise) => `steward-test/${row.id}:${crypto.createHash('sha256').update([recipe, row.image, mise.version, JSON.stringify(mise.sha256), ...(row.extra || [])].join('\0')).digest('hex').slice(0, 12)}`;

// buildArgs(row, {tag, mise, context, x64}) — `docker build` for a row: labelled, its base, mise for that CPU (x64: amd64,
// else arm64; run() sets x64 on an x64 machine or with --x64)
function buildArgs(row, { tag, mise, context, x64 = false }) {
  const arch = x64 ? 'x64' : 'arm64';
  const dir = path.join(context, 'test', 'containers');
  return ['build', '--label', `${LABEL}=1`, ...(x64 ? ['--platform', 'linux/amd64'] : []), '--build-arg', `BASE=${row.image}`, '--build-arg', `MISE_VERSION=${mise.version}`,
    '--build-arg', `MISE_ARCH=${arch}`, '--build-arg', `MISE_SHA256=${mise.sha256[arch]}`, ...(row.extra && row.extra.length ? ['--build-arg', `EXTRA=${row.extra.join(' ')}`] : []), '-f', path.join(dir, `${row.family}.Dockerfile`), '-t', tag, dir];
}

// the run inside the container: copy the read-only checkout onto tmpfs, then the tests against the example instance
const INSIDE = 'set -e; mkdir -p "$HOME" /work/src; cp -a /src/. /work/src/; cd /work/src; just test';

// runArgs({tag, name, checkout, x64}) — `docker run` for a row: removed after, no network, read-only, non-root, labelled
const runArgs = ({ tag, name, checkout, x64 = false, emulated: emu = false }) => ['run', '--rm', '--name', name, '--label', `${LABEL}=1`, ...(x64 ? ['--platform', 'linux/amd64'] : []),
  '--network', 'none', '--read-only', '--user', 'steward', '--tmpfs', '/work:exec,mode=1777', '--tmpfs', '/tmp:exec,mode=1777', '-v', `${checkout}:/src:ro`,
  '-e', 'STEWARD_TEST_FIXTURES=1', '-e', 'STEWARD_INSTANCE=/work/src/examples', '-e', 'NO_PROGRESS=1', '-e', 'NO_COLOR=1', '-e', 'CI=1', ...(emu ? ['-e', 'STEWARD_TEST_EMULATED=1'] : []), tag, 'bash', '-c', INSIDE];

// e2eRefusal(row) — null when --e2e runs for the row's family, else why not: each Linux provider brings its own (parity 1c: apt; dnf 1c: dnf)
const E2E = { debian: 'apt.sh', rhel: 'dnf.sh' };
// IC_CLAUDE_CODE — the Claude Code version a local install check uses when CLAUDE_CODE isn't set: the workflow's default
const IC_CLAUDE_CODE = (fs.readFileSync(path.join(REPO, '.github', 'workflows', 'install-check.yml'), 'utf8').match(/claude_code:[\s\S]*?default: '([\d.]+)'/) || [])[1] || '';
const e2eRefusal = row => (E2E[row.family] ? null : `${row.id}: --e2e comes with the ${row.family} family's provider (docs/platforms/parity.md)`);

// e2eArgs({tag, name, checkout, x64, family}) — `docker run` for an end-to-end run: the real repos (network on), writable, started
// as root for sudo and the seed, then the script drops to the steward user; the checkout read-only, labelled, removed after
const e2eArgs = ({ tag, name, checkout, x64 = false, family = 'debian' }) => ['run', '--rm', '--name', name, '--label', `${LABEL}=1`, ...(x64 ? ['--platform', 'linux/amd64'] : []),
  '--user', 'root', '-v', `${checkout}:/src:ro`, '-e', 'NO_PROGRESS=1', '-e', 'NO_COLOR=1', tag, 'bash', `/src/test/containers/e2e/${E2E[family]}`];

// the install check's own inputs (tools/install-check.sh), the only variables that go into its container
const IC_PASS = ['IC_VERSION', 'IC_REF', 'CLAUDE_CODE', 'RELEASE_AGE_DAYS'];
// INSIDE_IC: git worktree add writes into the subject's .git, so the read-only subject is copied onto tmpfs first
const INSIDE_IC = 'set -e; mkdir -p "$HOME" /work/subject; cp -a /subject/. /work/subject/; cd /work/subject; bash /tooling/tools/install-check.sh /work/subject';

// installCheckArgs({tag, name, tooling, subject, x64, env}) — `docker run` for the install check (parity 1d, T.4): the row's
// image, with a fresh home and an empty mise (the image's /opt/mise toolchain off PATH, so mise install downloads it again,
// owner 2026-11-03), the network on, read-only, non-root, the tooling and the subject read-only, labelled, removed after
const installCheckArgs = ({ tag, name, tooling, subject, x64 = false, env = {} }) => ['run', '--rm', '--name', name, '--label', `${LABEL}=1`, ...(x64 ? ['--platform', 'linux/amd64'] : []),
  '--read-only', '--user', 'steward', '--tmpfs', '/work:exec,mode=1777', '--tmpfs', '/tmp:exec,mode=1777', '-v', `${tooling}:/tooling:ro`, '-v', `${subject}:/subject:ro`,
  ...['STEWARD_INSTALL_CHECK=1', 'HOME=/work/home', 'MISE_DATA_DIR=/work/home/.local/share/mise', 'MISE_CACHE_DIR=/work/home/.cache/mise', 'MISE_STATE_DIR=/work/home/.local/state/mise',
    'MISE_GLOBAL_CONFIG_FILE=/work/home/.config/mise/config.toml', 'MISE_OFFLINE=0', 'PATH=/usr/local/bin:/usr/bin:/bin', 'NO_PROGRESS=1', 'NO_COLOR=1', 'CI=1',
    ...IC_PASS.filter(k => env[k] !== undefined).map(k => `${k}=${env[k]}`)].flatMap(e => ['-e', e]), tag, 'bash', '-c', INSIDE_IC];

// icPassed(out, status) — an install check passed: exit 0 and the script's last line
const icPassed = (out, status) => status === 0 && /^install check: passed$/m.test(String(out));
// icSummary(out) — the script's results, its SUMMARY lines, for the job summary
const icSummary = out => String(out).split('\n').map(l => l.match(/^SUMMARY (.*)$/)).filter(Boolean).map(m => m[1]);

// parseArgs(argv) — `run`'s arguments: rows, --x64, --keep, and one of --e2e and --install-check (with --ref <commit>)
function parseArgs(argv) {
  const o = { want: [], x64: false, keep: false, e2e: false, installCheck: false, ref: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--ref needs a commit (a SHA, a tag or a branch)');
      o.ref = argv[++i];
    } else if (a === '--x64') o.x64 = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--e2e') o.e2e = true;
    else if (a === '--install-check') o.installCheck = true;
    else if (!a.startsWith('--')) o.want.push(a);
  }
  if (o.e2e && o.installCheck) throw new Error('use one of --e2e and --install-check');
  return o;
}

// jsonLines(text) — docker's `--format '{{json .}}'` output, one object per line
const jsonLines = text => String(text || '').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
// ours(o) — whether a docker object carries LABEL (its Labels is "k=v,k2=v2")
const ours = o => String(o.Labels || '').split(',').some(kv => kv.split('=')[0] === LABEL);

// IMAGES — how our images are listed: `docker images` prints no labels in its JSON (ps, volume ls and network ls do), so
// a label filter picks ours and markOurs() records that on each line
const IMAGES = ['images', '--filter', `label=${LABEL}=1`, '--format', '{{json .}}'];
const markOurs = text => jsonLines(text).map(o => JSON.stringify({ ...o, Labels: `${LABEL}=1` })).join('\n');

// cleanPlan({containers, images, volumes, networks}) — the labelled ones of each, from `docker … --format '{{json .}}'`
const cleanPlan = t => ({ containers: jsonLines(t.containers).filter(ours), images: jsonLines(t.images).filter(ours), volumes: jsonLines(t.volumes).filter(ours), networks: jsonLines(t.networks).filter(ours) });

// cleanCommands(plan) — the docker commands that remove them, containers first (an image in use can't go)
function cleanCommands(p) {
  const cmds = [];
  if (p.containers.length) cmds.push(['rm', '-f', ...p.containers.map(c => c.ID)]);
  if (p.images.length) cmds.push(['image', 'rm', '-f', ...p.images.map(i => i.ID)]);
  if (p.volumes.length) cmds.push(['volume', 'rm', ...p.volumes.map(v => v.Name)]);
  if (p.networks.length) cmds.push(['network', 'rm', ...p.networks.map(n => n.ID)]);
  return cmds;
}

// staleTags(images, id, keep) — after a build: this row's labelled tags other than the one just built
const staleTags = (images, id, keep) => jsonLines(images).filter(i => ours(i) && i.Repository === `steward-test/${id}` && i.Tag !== keep).map(i => `${i.Repository}:${i.Tag}`);

// onInterrupt(name, docker) — what Ctrl-C or a kill does: remove the run's container, so none is left behind
const onInterrupt = (name, docker) => () => docker(['rm', '-f', name]);

// counts(output) — {total, pass, fail} from node --test's summary, or null when it never got that far
function counts(out) {
  const n = k => { const m = String(out).match(new RegExp(`^ℹ ${k} (\\d+)$`, 'm')); return m ? Number(m[1]) : null; };
  const total = n('tests'), pass = n('pass'), fail = n('fail');
  return total === null || pass === null || fail === null ? null : { total, pass, fail };
}

const dur = s => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
// summary(results) — {lines, code}: one line per row; code 0 only when every row passed
function summary(results) {
  const lines = results.map(r => {
    const id = r.id.padEnd(11);
    if (r.status === 'build-failed') return `${id} ✗ the image did not build · ${dur(r.secs)} · ${r.log}`;
    if (r.status === 'ic-pass') return `${id} ✓ install check passed · ${dur(r.secs)} · ${r.log}`;
    if (r.status === 'ic-fail') return `${id} ✗ install check failed (exit ${r.exit}) · ${dur(r.secs)} · ${r.log}`;
    if (r.status === 'no-summary') return `${id} ✗ the tests ended without a summary · ${dur(r.secs)} · ${r.log}`;
    if (r.status === 'pass') return `${id} ✓ ${r.pass}/${r.total} pass · ${dur(r.secs)} · ${r.log}`;
    return `${id} ✗ ${r.pass}/${r.total} pass · ${r.fail} fail · ${dur(r.secs)} · ${r.log}`;
  });
  return { lines, code: results.every(r => r.status === 'pass' || r.status === 'ic-pass') ? 0 : 1 };
}

// docker(args, {log, st}) — run docker; its output to the log file (when given) and its last line to the live stage
function docker(args, o = {}) {
  return new Promise(resolve => {
    const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = d => {
      const s = d.toString();
      out += s;
      if (o.log) fs.appendFileSync(o.log, s);
      const last = s.trim().split('\n').pop();
      if (o.st && last) o.st.detail(last.replace(/\s+/g, ' ').slice(0, 80));
    };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('error', e => resolve({ status: 127, stdout: String(e.message) }));
    p.on('close', code => resolve({ status: code === null ? 1 : code, stdout: out }));
  });
}
// stream(args, st, log) — a long docker step, shown live (its last line) and kept whole in the log
const stream = (args, st, log) => docker(args, { st, log });

// ask(q) — [y/N] on a terminal; never yes without one
async function ask(q) {
  if (!process.stdin.isTTY) { console.log(`${q} [y/N] no terminal: nothing removed`); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^[Yy]$/.test(a.trim());
}

const stateDir = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'workstation-steward', 'linux-test');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const tilde = p => p.replace(os.homedir(), '~');
const LS = { containers: ['ps', '-a', '--format', '{{json .}}'], images: IMAGES, volumes: ['volume', 'ls', '--format', '{{json .}}'], networks: ['network', 'ls', '--format', '{{json .}}'] };
const listAll = async () => Object.fromEntries(await Promise.all(Object.entries(LS).map(async ([k, a]) => [k, k === 'images' ? markOurs((await docker(a)).stdout) : (await docker(a)).stdout])));

async function run(argv) {
  const { progress } = require('../lib/progress.js');
  const m = loadMatrix();
  const bad = validate(m);
  if (bad.length) { for (const b of bad) console.error(`ERROR matrix.json: ${b}`); return 1; }
  if ((await docker(['info', '--format', '{{.ServerVersion}}'])).status !== 0) { console.error('ERROR docker is not running (OrbStack or Docker Desktop)'); return 1; }
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`ERROR ${e.message}`); return 2; }
  const { want, keep, e2e, installCheck, ref } = args, hostX64 = args.x64 || process.arch === 'x64';
  const { rows, unknown } = select(m.rows, want);
  if (unknown.length || !rows.length) { console.error(`ERROR no such row: ${unknown.join(', ') || want.join(', ')} (rows: ${m.rows.map(r => r.id).join(', ')}; or a distribution: ${[...new Set(m.rows.map(r => r.distro))].join(', ')})`); return 2; }
  if (e2e) {
    const no = rows.map(e2eRefusal).filter(Boolean);
    if (no.length) { for (const n of no) console.error(`ERROR ${n}`); return 2; }
  }
  for (const n of notes(rows, new Date().toISOString().slice(0, 10), pinDates(rows))) console.log(n);

  // a container a crashed run left: named, and removed only on a yes
  const left = cleanPlan({ containers: (await docker(['ps', '-a', '--format', '{{json .}}'])).stdout }).containers;
  if (left.length) {
    console.log(`a run left ${left.length} container(s): ${left.map(c => `${c.Names} (${c.State})`).join(', ')}`);
    if (await ask('Remove them first?')) await docker(['rm', '-f', ...left.map(c => c.ID)]);
  }

  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const ctxDir = path.join(REPO, 'test', 'containers');
  fs.copyFileSync(path.join(REPO, 'examples', 'mise', 'config.toml'), path.join(ctxDir, '.mise-config.toml'));
  const pg = progress(rows.length * 2);
  const results = [];
  for (const row of rows) {
    const x64 = rowX64(row, hostX64);
    const kind = e2e ? 'e2e' : installCheck ? 'ic' : 'test';
    const t0 = Date.now(), log = path.join(dir, `${row.id}${kind === 'test' ? '' : `-${kind}`}-${stamp()}.txt`);
    const secs = () => Math.round((Date.now() - t0) / 1000);
    const recipe = ['Dockerfile', 'install-mise.sh', '.mise-config.toml'].map(f => fs.readFileSync(path.join(ctxDir, f === 'Dockerfile' ? `${row.family}.Dockerfile` : f), 'utf8')).join('\0');
    const tag = imageTag(row, recipe, m.mise) + (x64 ? '-x64' : '');
    let st = pg.stage(`${row.id}: image ${tag}`);
    if ((await docker(['image', 'inspect', tag])).status === 0) st.done('built before');
    else {
      fs.writeFileSync(log, `# docker build for ${row.id} (${row.image})\n`);
      const b = await stream(buildArgs(row, { tag, mise: m.mise, context: REPO, x64 }), st, log);
      if (b.status !== 0) { st.fail(`FAILED (exit ${b.status})`); results.push({ id: row.id, status: 'build-failed', secs: secs(), log: tilde(log) }); pg.stage(`${row.id}: tests`).done('skipped: no image'); continue; }
      st.done('built');
      if (!keep) {
        const old = staleTags(markOurs((await docker(IMAGES)).stdout), row.id, tag.split(':')[1]);
        if (old.length) await docker(['image', 'rm', ...old]);
        await docker(['image', 'prune', '-f', '--filter', `label=${LABEL}=1`]);
      }
    }
    const name = `steward-${kind}-${row.id.replace(/\./g, '-')}-${stamp().toLowerCase()}`;
    const stop = onInterrupt(name, a => docker(a));
    const bye = async () => { await stop(); process.exit(130); };
    process.once('SIGINT', bye); process.once('SIGTERM', bye);
    st = pg.stage(e2e ? `${row.id}: end to end (network on, the real repos)` : installCheck ? `${row.id}: install check (network on, a fresh home)` : `${row.id}: tests (no network)`);
    fs.appendFileSync(log, `\n# docker run (${name})\n`);
    const subject = process.env.IC_SUBJECT || REPO;
    const icEnv = { ...process.env, ...(ref ? { IC_REF: ref } : {}), CLAUDE_CODE: process.env.CLAUDE_CODE || IC_CLAUDE_CODE };
    const r = installCheck ? await stream(installCheckArgs({ tag, name, tooling: REPO, subject, x64, env: icEnv }), st, log)
      : await stream(e2e ? e2eArgs({ tag, name, checkout: REPO, x64, family: row.family }) : runArgs({ tag, name, checkout: REPO, x64, emulated: emulated(row, hostX64) }), st, log);
    process.removeListener('SIGINT', bye); process.removeListener('SIGTERM', bye);
    if (installCheck) {
      const ok = icPassed(r.stdout, r.status);
      if (ok) st.done('passed'); else st.fail(`FAILED (exit ${r.status})`);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${icSummary(r.stdout).map(l => (l.startsWith('## ') ? `${l} (${row.id})` : l)).join('\n')}\n`);
      results.push({ id: row.id, status: ok ? 'ic-pass' : 'ic-fail', exit: r.status, secs: secs(), log: tilde(log) });
      continue;
    }
    const c = counts(r.stdout);
    const status = !c ? 'no-summary' : c.fail === 0 && r.status === 0 ? 'pass' : 'fail';
    if (status === 'pass') st.done(`${c.pass}/${c.total} pass`);
    else st.fail(c ? `${c.pass}/${c.total} pass, ${c.fail} fail` : `no test summary (exit ${r.status})`);
    results.push({ id: row.id, status, ...(c || {}), secs: secs(), log: tilde(log) });
  }
  const s = summary(results);
  console.log(s.lines.join('\n'));
  fs.writeFileSync(path.join(dir, 'latest.txt'), `${s.lines.join('\n')}\n`);
  return s.code;
}

async function clean(argv) {
  const p = cleanPlan(await listAll());
  const n = p.containers.length + p.images.length + p.volumes.length + p.networks.length;
  console.log(`just linux-clean: only what carries ${LABEL}`);
  for (const c of p.containers) console.log(`  container ${c.Names} (${c.State})`);
  for (const i of p.images) console.log(`  image     ${i.Repository}:${i.Tag} (${i.Size})`);
  for (const v of p.volumes) console.log(`  volume    ${v.Name}`);
  for (const w of p.networks) console.log(`  network   ${w.Name}`);
  if (!n) console.log('  nothing to remove');
  else if (await ask(`Remove these ${n}?`)) for (const c of cleanCommands(p)) { const r = await docker(c); console.log(`  docker ${c.slice(0, 2).join(' ')} …: ${r.status === 0 ? 'done' : `exit ${r.status}`}`); }
  if (argv.includes('--cache')) {
    const df = (await docker(['system', 'df'])).stdout.split('\n').find(l => /^Build Cache/.test(l)) || 'Build Cache: unknown';
    console.log(`the build cache is shared by every project on this Docker: ${df.replace(/\s+/g, ' ')}`);
    if (await ask('Prune the whole build cache (docker builder prune)?')) console.log(`  docker builder prune: exit ${(await docker(['builder', 'prune', '-f'])).status}`);
  }
  return 0;
}

module.exports = { LABEL, IMAGES, markOurs, loadMatrix, validate, select, rowX64, emulated, pinnedSince, notes, ci, imageTag, buildArgs, runArgs, e2eRefusal, e2eArgs, parseArgs, installCheckArgs, icPassed, icSummary, cleanPlan, cleanCommands, staleTags, onInterrupt, counts, summary };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  // ci: the rows for test.yml's matrix, as GITHUB_OUTPUT's rows=<json>, and each warning as a GitHub annotation
  const ciCmd = async () => {
    const m = loadMatrix(), bad = validate(m);
    if (bad.length) { for (const b of bad) console.error(`ERROR matrix.json: ${b}`); return 1; }
    const c = ci(m, new Date().toISOString().slice(0, 10), pinDates(m.rows));
    for (const w of c.warnings) console.log(w);
    const line = `rows=${JSON.stringify(c.rows)}\n`;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line); else process.stdout.write(line);
    return 0;
  };
  const go = cmd === 'clean' ? clean : cmd === 'run' ? run : cmd === 'ci' ? ciCmd : null;
  if (!go) { console.error('usage: linux-test.js run [<id>|<distro>|all] [--x64] [--keep] [--e2e | --install-check [--ref <commit>]] | ci | clean [--cache]'); process.exitCode = 2; }
  else go(rest).then(code => { process.exitCode = code; }).catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
