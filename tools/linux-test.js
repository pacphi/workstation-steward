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
const { spawn } = require('child_process');
const { FAMILIES } = require('../lib/platform.js');

const LABEL = 'org.workstation-steward.test';
const REPO = path.join(__dirname, '..');
const HEX64 = /^[0-9a-f]{64}$/;

// loadMatrix(file) — test/containers/matrix.json, parsed
const loadMatrix = (file = path.join(REPO, 'test', 'containers', 'matrix.json')) => JSON.parse(fs.readFileSync(file, 'utf8'));

// validate(m) — what is wrong with the matrix, one message each ([] when it is right)
function validate(m) {
  const bad = [];
  for (const r of m.rows || []) {
    if (!FAMILIES.includes(r.family)) bad.push(`${r.id}: family must be one of ${FAMILIES.join(', ')} (not ${r.family})`);
    if (!/^[a-z0-9./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/.test(r.image || '')) bad.push(`${r.id}: image must name a digest (image:tag@sha256:<64 hex>)`);
    const e = r.gate_exception;
    if (e && !(e.why && e.decided && /^\d{4}-\d{2}-\d{2}$/.test(e.expires || ''))) bad.push(`${r.id}: gate_exception needs why, decided and expires (YYYY-MM-DD)`);
  }
  const mise = m.mise || {};
  if (!mise.version) bad.push('mise: version is missing');
  for (const a of ['arm64', 'x64']) if (!HEX64.test((mise.sha256 || {})[a] || '')) bad.push(`mise: sha256.${a} must be 64 hex characters`);
  return bad;
}

// imageTag(row, recipe, mise) — steward-test/<id>:<12 hex>, from the Dockerfile (and what it copies), the base and mise
const imageTag = (row, recipe, mise) => `steward-test/${row.id}:${crypto.createHash('sha256').update([recipe, row.image, mise.version, JSON.stringify(mise.sha256)].join('\0')).digest('hex').slice(0, 12)}`;

// buildArgs(row, {tag, mise, context, x64}) — `docker build` for a row: labelled, its base, mise for that CPU (x64: amd64,
// else arm64; run() sets x64 on an x64 machine or with --x64)
function buildArgs(row, { tag, mise, context, x64 = false }) {
  const arch = x64 ? 'x64' : 'arm64';
  const dir = path.join(context, 'test', 'containers');
  return ['build', '--label', `${LABEL}=1`, ...(x64 ? ['--platform', 'linux/amd64'] : []), '--build-arg', `BASE=${row.image}`, '--build-arg', `MISE_VERSION=${mise.version}`,
    '--build-arg', `MISE_ARCH=${arch}`, '--build-arg', `MISE_SHA256=${mise.sha256[arch]}`, '-f', path.join(dir, `${row.family}.Dockerfile`), '-t', tag, dir];
}

// the run inside the container: copy the read-only checkout onto tmpfs, then the tests against the example instance
const INSIDE = 'set -e; mkdir -p "$HOME" /work/src; cp -a /src/. /work/src/; cd /work/src; just test';

// runArgs({tag, name, checkout, x64}) — `docker run` for a row: removed after, no network, read-only, non-root, labelled
const runArgs = ({ tag, name, checkout, x64 = false }) => ['run', '--rm', '--name', name, '--label', `${LABEL}=1`, ...(x64 ? ['--platform', 'linux/amd64'] : []),
  '--network', 'none', '--read-only', '--user', 'steward', '--tmpfs', '/work:exec,mode=1777', '--tmpfs', '/tmp:exec,mode=1777', '-v', `${checkout}:/src:ro`,
  '-e', 'STEWARD_TEST_FIXTURES=1', '-e', 'STEWARD_INSTANCE=/work/src/examples', '-e', 'NO_PROGRESS=1', '-e', 'NO_COLOR=1', '-e', 'CI=1', tag, 'bash', '-c', INSIDE];

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
    if (r.status === 'no-summary') return `${id} ✗ the tests ended without a summary · ${dur(r.secs)} · ${r.log}`;
    if (r.status === 'pass') return `${id} ✓ ${r.pass}/${r.total} pass · ${dur(r.secs)} · ${r.log}`;
    return `${id} ✗ ${r.pass}/${r.total} pass · ${r.fail} fail · ${dur(r.secs)} · ${r.log}`;
  });
  return { lines, code: results.every(r => r.status === 'pass') ? 0 : 1 };
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
  if (argv.includes('--e2e')) { console.error('ERROR --e2e comes with each Linux provider (apt, dnf, zypper): docs/platforms/parity.md'); return 2; }
  if ((await docker(['info', '--format', '{{.ServerVersion}}'])).status !== 0) { console.error('ERROR docker is not running (OrbStack or Docker Desktop)'); return 1; }
  const x64 = argv.includes('--x64') || process.arch === 'x64', keep = argv.includes('--keep');
  const want = argv.filter(a => !a.startsWith('--'));
  const rows = !want.length || want.includes('all') ? m.rows : m.rows.filter(r => want.includes(r.id));
  const unknown = want.filter(w => w !== 'all' && !m.rows.some(r => r.id === w));
  if (unknown.length || !rows.length) { console.error(`ERROR no such row: ${unknown.join(', ') || want.join(', ')} (rows: ${m.rows.map(r => r.id).join(', ')})`); return 2; }
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) if (r.gate_exception) console.log(`note: ${r.id} runs under a release-age gate exception (${r.gate_exception.decided}; expires ${r.gate_exception.expires})${r.gate_exception.expires < today ? ': EXPIRED, move it to an image past the gate' : ''}`);

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
    const t0 = Date.now(), log = path.join(dir, `${row.id}-${stamp()}.txt`);
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
    const name = `steward-test-${row.id}-${stamp().toLowerCase()}`;
    const stop = onInterrupt(name, a => docker(a));
    const bye = async () => { await stop(); process.exit(130); };
    process.once('SIGINT', bye); process.once('SIGTERM', bye);
    st = pg.stage(`${row.id}: tests (no network)`);
    fs.appendFileSync(log, `\n# docker run (${name})\n`);
    const r = await stream(runArgs({ tag, name, checkout: REPO, x64 }), st, log);
    process.removeListener('SIGINT', bye); process.removeListener('SIGTERM', bye);
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

module.exports = { LABEL, IMAGES, markOurs, loadMatrix, validate, imageTag, buildArgs, runArgs, cleanPlan, cleanCommands, staleTags, onInterrupt, counts, summary };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const go = cmd === 'clean' ? clean : cmd === 'run' ? run : null;
  if (!go) { console.error('usage: linux-test.js run [<id>|all] [--x64] [--keep] | clean [--cache]'); process.exitCode = 2; }
  else go(rest).then(code => { process.exitCode = code; }).catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
