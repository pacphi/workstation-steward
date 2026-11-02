// The indicators-of-compromise sweep on every platform (parity 0.4, supply-chain/checks/index.js): processes with their
// environment (ps on macOS, /proc on Linux), "not fully checked" instead of "clean" when the process list can't be read,
// and Python packages in site-packages and dist-packages under the system, per-user and tool folders. A real process
// carries a marker in its environment, so the Mac (ps) and every Linux container (/proc, D65) prove the list for real.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const K = require('../supply-chain/checks/index.js');
const { audit } = require('../supply-chain/bin/audit.js');
const PL = require('../lib/platform.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-ioc-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const put = (f, text = '') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const lines = () => { const out = []; return { out, write: s => out.push(s.replace(/\x1b\[[0-9;]*m/g, '')) }; };

// ctx(commands, extra) — what the IOC check reads; commands are canned (a key ending in * matches by prefix), and each
// call is recorded in ctx.calls
function ctx(commands = {}, extra = {}) {
  const calls = [];
  const run = async (cmd, args = []) => {
    const k = [cmd, ...args].join(' ');
    calls.push(k);
    const v = k in commands ? commands[k] : Object.entries(commands).find(([p]) => p.endsWith('*') && k.startsWith(p.slice(0, -1)))?.[1];
    if (v === undefined) return { status: 1, stdout: '' };
    return typeof v === 'string' ? { status: 0, stdout: v } : v;
  };
  return {
    run, calls, now: new Date('2026-11-02T12:00:00Z'), today: '2026-11-02', platform: 'macos', home: path.join(ROOT, 'home'), instance: ROOT, engine: path.join(__dirname, '..'),
    cache: path.join(ROOT, 'cache'), cfg: { policy: { min_release_age_days: 3 }, paths: { mise_data_dir: path.join(ROOT, 'mise') }, ioc: { extra_roots: [] } },
    policy: { ioc: [] }, appDirs: [], ...extra,
  };
}

test('processes on Linux: /proc gives each command line with its environment; our own process and unreadable ones are left out', async () => {
  const proc = path.join(ROOT, 'proc');
  put(path.join(proc, '101', 'cmdline'), 'python3\0-m\0worker\0');
  put(path.join(proc, '101', 'environ'), 'HOME=/srv\0PRIVCOLLECT_ACTIVE=1\0');
  put(path.join(proc, '102', 'cmdline'), '/usr/bin/mylovelyminer\0--x\0');   // another user's: environ not readable
  put(path.join(proc, '103', 'cmdline'), '');                               // a kernel thread: no command line
  put(path.join(proc, String(process.pid), 'cmdline'), 'node\0audit\0PRIVCOLLECT_ACTIVE\0');
  put(path.join(proc, 'self', 'cmdline'), 'x');
  const r = await K.processes(ctx({}, { platform: 'linux', proc }));
  assert.equal(r.error, null);
  assert.deepEqual(r.list, [{ pid: 101, cmd: 'python3 -m worker', env: 'HOME=/srv PRIVCOLLECT_ACTIVE=1' }, { pid: 102, cmd: '/usr/bin/mylovelyminer --x', env: null }]);
  const none = await K.processes(ctx({}, { platform: 'linux', proc: path.join(ROOT, 'no-proc') }));
  assert.match(none.error, /^\/proc can't be read/);
});

test('processes: a real process\'s command line is seen everywhere; its environment on Linux, and on macOS never (it doesn\'t show it)', async () => {
  const tag = crypto.randomBytes(6).toString('hex');
  const arg = `steward-ioc-probe-${tag}`, env = `STEWARD_IOC_PROBE_${tag}`;
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', arg], { env: { ...process.env, [env]: '1' }, stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 300));
    const run = async (cmd, args = []) => { const p = spawnSync(cmd, args, { encoding: 'utf8' }); return { status: p.error ? 127 : p.status, stdout: p.stdout || '' }; };
    const r = await K.processes(ctx({}, { platform: PL.current(), run }));
    assert.equal(r.error, null);
    const me = r.list.find(p => p.pid === child.pid);
    assert.ok(me, `pid ${child.pid} among ${r.list.length} processes`);
    assert.ok(me.cmd.includes(arg), me.cmd);
    if (PL.current() === 'linux') assert.ok(me.env && me.env.includes(`${env}=1`), 'Linux: its environment, from /proc');
    else assert.equal(me.env, null, 'macOS: no environment (confirmed on macOS 27.2, 2026-11-02)');
  } finally { child.kill(); }
});

test('a process list that can\'t be read: one action, and each process indicator "not fully checked", never "clean"', async () => {
  const ioc = [
    { name: 'LiteLLM', _source: 'default', files: ['/nonexistent/a'], processes: ['PRIVCOLLECT_ACTIVE'] },
    { name: 'Files only', _source: 'yours', files: ['/nonexistent/b'] },
    { name: 'Present', _source: 'default', files: [__filename], processes: ['x'] },
  ];
  const c = ctx({ 'docker info': { status: 1, stdout: '' }, 'ps -axeww -o pid=,command=': { status: 1, stdout: '' } }, { policy: { ioc } });
  const w = lines();
  const r = await audit(c, { only: ['ioc'], write: w.write });
  assert.deepEqual(r.actions, ['ioc: the process list couldn\'t be read (ps failed, exit 1); process indicators were not checked']);
  assert.ok(w.out.includes('  info   LiteLLM (default): not fully checked: processes (ps failed, exit 1)'), w.out.join('\n'));
  assert.ok(!w.out.some(l => /clean\s+LiteLLM/.test(l)));
  assert.ok(w.out.includes('  clean  Files only (yours)'), 'an indicator without processes is still clean');
  assert.deepEqual(r.alerts, [`Present: file present ${__filename}`], 'the rest is still checked');
});

test('Python packages: site-packages and dist-packages, under the system, per-user and tool folders that exist', async () => {
  const home = path.join(ROOT, 'home');
  const sys = path.join(ROOT, 'sysroot');
  for (const d of ['usr/lib/python3', 'usr/lib/python3.13', 'usr/local/lib/python3.12', 'usr/lib/perl5']) fs.mkdirSync(path.join(sys, d), { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'lib', 'python3.13'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Library', 'Python', '3.12'), { recursive: true });
  const linux = K.pythonRoots(ctx({}, { platform: 'linux', home, sysroot: sys }));
  for (const d of ['usr/lib/python3', 'usr/lib/python3.13', 'usr/local/lib/python3.12']) assert.ok(linux.includes(path.join(sys, d)), d);
  assert.ok(linux.includes(path.join(home, '.local', 'lib', 'python3.13')));
  assert.ok(!linux.some(r => r.includes('perl5')), 'only Python folders');
  assert.ok(!linux.some(r => r.includes(path.join('Library', 'Python'))), 'the macOS folder is not a Linux root');
  const mac = K.pythonRoots(ctx({}, { platform: 'macos', home, sysroot: sys }));
  assert.ok(mac.includes(path.join(home, 'Library', 'Python', '3.12')));
  assert.ok(!mac.some(r => r.startsWith(path.join(sys, 'usr'))), 'no Linux system folders on macOS');
  for (const r of [...linux, ...mac]) assert.ok(fs.existsSync(r), `${r} exists`);

  const ioc = [{ name: 'LiteLLM', _source: 'default', site_packages_files: ['cook.pth'] }];
  const c = ctx({ 'docker info': { status: 1, stdout: '' }, 'ps -axeww -o pid=,command=': '  1 /sbin/launchd\n', 'find *': `${sys}/usr/lib/python3/dist-packages/cook.pth\n` }, { platform: 'macos', home, sysroot: sys, policy: { ioc } });
  const r = await audit(c, { only: ['ioc'], write: lines().write });
  const find = c.calls.find(k => k.startsWith('find '));
  assert.ok(find.includes('-path */site-packages/cook.pth -o -path */dist-packages/cook.pth'), find);
  assert.deepEqual(r.alerts, [`LiteLLM: ${sys}/usr/lib/python3/dist-packages/cook.pth`]);
});

// a fake /proc with one process: the given command line and environment
function oneProc(name, cmdline, environ) {
  const proc = path.join(ROOT, name);
  put(path.join(proc, '201', 'cmdline'), cmdline.split(' ').join('\0'));
  if (environ !== undefined) put(path.join(proc, '201', 'environ'), environ.split(' ').join('\0'));
  return proc;
}

test('environment markers: matched in the environment only; a processes marker matches the command line only', async () => {
  const proc = oneProc('proc-env', 'python3 worker.py', 'HOME=/srv PRIVCOLLECT_ACTIVE=1');
  const ioc = [{ name: 'Env', _source: 'default', environment: ['PRIVCOLLECT_ACTIVE'] }, { name: 'Cmd', _source: 'default', processes: ['PRIVCOLLECT_ACTIVE'] }];
  const w = lines();
  const r = await audit(ctx({ 'docker info': { status: 1, stdout: '' } }, { platform: 'linux', proc, policy: { ioc } }), { only: ['ioc'], write: w.write });
  assert.deepEqual(r.alerts, ["Env: process environment matching 'PRIVCOLLECT_ACTIVE' (pid 201)"]);
  assert.ok(w.out.includes('  clean  Cmd (default)'), 'an environment variable is not a command line');
});

test('environment markers on macOS: "not fully checked", never "clean"; the IOC\'s other markers still checked', async () => {
  const ioc = [{ name: 'LiteLLM', _source: 'default', environment: ['PRIVCOLLECT_ACTIVE'], processes: ['remote_code_loader'] }];
  const w = lines();
  const r = await audit(ctx({ 'docker info': { status: 1, stdout: '' }, 'ps -axeww -o pid=,command=': '  301 /usr/bin/python3 remote_code_loader\n' }, { policy: { ioc } }), { only: ['ioc'], write: w.write });
  assert.deepEqual(r.alerts, ["LiteLLM: process matching 'remote_code_loader'"]);
  assert.deepEqual(r.actions, [], 'a platform limit is no action');
  const w2 = lines();
  await audit(ctx({ 'docker info': { status: 1, stdout: '' }, 'ps -axeww -o pid=,command=': '  1 /sbin/launchd\n' }, { policy: { ioc } }), { only: ['ioc'], write: w2.write });
  assert.ok(w2.out.includes("  info   LiteLLM (default): not fully checked: environment (macOS doesn't show process environments)"), w2.out.join('\n'));
});

test('the coverage line: what the sweep can and can\'t see on this machine, in one format on every platform', async () => {
  const home = path.join(ROOT, 'cov-home');
  fs.mkdirSync(path.join(home, 'Library', 'Python', '3.12'), { recursive: true });
  const w = lines();
  await audit(ctx({ 'docker info': { status: 1, stdout: '' }, 'ps -axeww -o pid=,command=': '  1 /sbin/launchd\n' }, { home }), { only: ['ioc'], write: w.write });
  assert.ok(w.out.includes("  info   coverage here: files ✓ · command lines ✓ · environments ✗ (macOS doesn't show them) · Python packages ✓ (1 folder) · Docker images ✗ (not running)"), w.out.join('\n'));
  const proc = oneProc('proc-cov', 'bash', 'HOME=/srv');
  const w2 = lines();
  await audit(ctx({ 'docker info': '', 'docker images --digests --format {{.Digest}}': '' }, { platform: 'linux', proc, home: path.join(ROOT, 'empty-home'), sysroot: path.join(ROOT, 'empty-sys') }), { only: ['ioc'], write: w2.write });
  assert.ok(w2.out.includes('  info   coverage here: files ✓ · command lines ✓ · environments ✓ (your processes; others need root) · Python packages ✗ (no Python folders found) · Docker images ✓'), w2.out.join('\n'));
  const w3 = lines();
  await audit(ctx({ 'docker info': { status: 1, stdout: '' } }, { platform: 'linux', proc: path.join(ROOT, 'no-proc-here'), home: path.join(ROOT, 'empty-home') }), { only: ['ioc'], write: w3.write });
  assert.ok(w3.out.some(l => l.startsWith("  info   coverage here: files ✓ · command lines ✗ (/proc can't be read") && l.includes("environments ✗ (/proc can't be read")), w3.out.join('\n'));
});
