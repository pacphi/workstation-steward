// The root hand-off (parity 1b, D-b revised 2026-11-03, lib/roothandoff.js): a package upgrade that needs root, run by
// the steward through sudo at a terminal after the plan's yes (you type your password into sudo's own prompt), or
// handed over as the exact line when there is no terminal, with a pending receipt that `steward sc upgrade --resume`
// finishes. Root refreshes the system's package lists first (apt-get update; owner, 2026-11-03), because they can be
// older than the steward's own copy (the Debian container's real run: "Version … was not found"). Before and after are
// read as you (dpkg-query); the way back is offered only for versions the repos still have (apt-cache madison, from the
// steward's own lists), or, first, the steward's own kept copy of the build from before (D88). No real sudo, apt or dpkg:
// stand-ins record every call.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../lib/roothandoff.js');
const A = require('../lib/providers/apt.js');
const K = require('../lib/kept.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-roothandoff-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NOW = new Date('2026-11-03T12:00:00Z');
const TZ = { name: 'tzdata', have: '2026e-0+deb13u1', want: '2026f-0+deb13u1', why: 'gate: 6d old, snapshot' };
const LIBC = { name: 'libc6', have: '2.41-12+deb13u1', want: '2.41-12+deb13u2', why: 'security pocket: trixie-security' };
const PINNED = ['apt-get', 'install', '--only-upgrade', 'tzdata=2026f-0+deb13u1', 'libc6=2.41-12+deb13u2'];
const REFRESH = ['sudo', 'apt-get', 'update'];
const LINE = `sudo apt-get update && sudo ${PINNED.join(' ')}`;

// machine(o) — a Debian machine: what dpkg says is installed (changed by the stand-in sudo when it "upgrades"), what
// the repos offer (apt-cache madison), and every call made, as you or through sudo
function machine(o = {}) {
  const m = { installed: { tzdata: TZ.have, libc6: LIBC.have, ...(o.installed || {}) }, calls: [], sudo: [], printed: [] };
  const offered = o.offered || { tzdata: [TZ.want, TZ.have], libc6: [LIBC.want] };
  const state = path.join(ROOT, `state-${Math.random().toString(36).slice(2)}`);
  m.ctx = {
    now: NOW, platform: 'linux', family: 'debian', cfg: { paths: { state }, policy: { min_release_age_days: 3, ...(o.policy || {}) } },
    run: async (cmd, args = [], ro = {}) => {
      m.calls.push([cmd, ...args].join(' '));
      // apt-get download (o.download): writes name_version_arch.deb into its folder when the repos offer that version
      if (o.download && cmd === 'apt-get' && args.includes('download')) {
        const [n, v] = args[args.length - 1].split('=');
        if (!(offered[n] || []).includes(v)) return { status: 100, stdout: '' };
        fs.writeFileSync(path.join(ro.cwd, `${n}_${v.replace(/:/g, '%3a')}_arm64.deb`), `${n} ${v}`);
        return { status: 0, stdout: '' };
      }
      if (cmd === 'dpkg-query') return { status: 0, stdout: args.slice(2).filter(n => m.installed[n]).map(n => `${n}\t${m.installed[n]}\n`).join('') };
      if (cmd === 'apt-cache' && args.includes('madison')) {
        const n = args[args.length - 1];
        return { status: 0, stdout: (offered[n] || []).map(v => ` ${n} | ${v} | http://deb.debian.org/debian trixie/main arm64 Packages\n`).join('') };
      }
      return { status: 1, stdout: '' };
    },
  };
  // sudo(cmd, args) — the stand-in for sudo on your terminal: records the line, and "installs" each pinned version
  // unless o.stuck names it; o.fail names the apt-get subcommand (update, install) that exits 100 instead
  m.spawn = async (cmd, args) => {
    m.sudo.push([cmd, ...args]);
    if (o.fail && args[1] === o.fail) return 100;
    for (const a of args) {
      // a kept .deb by its path (name_version_arch.deb), else name=version
      const f = a.includes('/') && a.endsWith('.deb') && path.basename(a).split('_');
      const [n, v] = f ? [f[0], decodeURIComponent(f[1])] : a.split('=');
      if (v && !(o.stuck || []).includes(n)) m.installed[n] = v;
    }
    return 0;
  };
  m.print = s => m.printed.push(String(s).replace(/\x1b\[[0-9;]*m/g, ''));
  m.o = extra => ({ spawn: m.spawn, print: m.print, dry: false, ...extra });
  m.backups = () => { try { return fs.readdirSync(path.join(state, 'backups')); } catch { return []; } };
  return m;
}
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('apt: the root refresh, pinned upgrade and downgrade lines; installed versions from dpkg-query; offered ones from madison', async () => {
  assert.deepEqual(A.source.rootRefresh, { cmd: 'apt-get', args: ['update'] });
  assert.deepEqual(A.source.upgradeCmd([TZ, LIBC]), { cmd: 'apt-get', args: PINNED.slice(1) });
  assert.deepEqual(A.source.rollbackCmd([{ name: 'tzdata', to: TZ.have }]), { cmd: 'apt-get', args: ['install', '--allow-downgrades', 'tzdata=2026e-0+deb13u1'] });
  const m = machine();
  assert.deepEqual(await A.source.installed(m.ctx, ['tzdata', 'libc6', 'gone']), { tzdata: TZ.have, libc6: LIBC.have });
  assert.deepEqual(await A.source.offered(m.ctx, 'tzdata'), [TZ.want, TZ.have]);
  assert.ok(m.calls.find(c => c.startsWith('apt-cache') && c.includes('Dir::State::Lists=')), 'madison reads the steward\'s own lists');
  assert.ok(!m.calls.some(c => c.startsWith('sudo')), 'all as you');
});

test('apt: a security pocket is one whose suite ends in -security, alone or among others', () => {
  assert.equal(A.source.securityPocket({ suite: 'trixie-security' }), 'trixie-security');
  assert.equal(A.source.securityPocket({ suite: 'noble-updates,noble-security' }), 'noble-security');
  assert.equal(A.source.securityPocket({ suite: 'stable-updates' }), '');
  assert.equal(A.source.securityPocket({}), '');
});

test('at a terminal: sudo refreshes the system\'s lists, then runs exactly the pinned line; the receipt has before, after, why and the way back', async () => {
  const m = machine();
  const code = await H.upgrade(m.ctx, A.source, [TZ, LIBC], m.o({ tty: true }));
  assert.equal(code, 0, m.printed.join('\n'));
  assert.deepEqual(m.sudo, [REFRESH, ['sudo', ...PINNED]]);
  assert.ok(m.printed.some(l => l.includes('$ sudo apt-get update')), m.printed.join('\n'));
  const [name] = m.backups();
  assert.match(name, /^apt-upgrade-\d{8}T\d{6}Z$/);
  const r = read(path.join(m.ctx.cfg.paths.state, 'backups', name, 'receipt.json'));
  assert.equal(r.kind, 'root-upgrade');
  assert.equal(r.source, 'apt');
  assert.equal(r.complete, true);
  assert.equal(r.outcome, 'done');
  assert.equal(r.command, LINE);
  assert.deepEqual(r.items, [TZ, LIBC]);
  assert.deepEqual(r.after, { tzdata: TZ.want, libc6: LIBC.want });
  assert.deepEqual(r.back.items, [{ name: 'tzdata', to: TZ.have }], 'only what the repos still offer');
  assert.deepEqual(r.back.none, [{ name: 'libc6', have: LIBC.have, reason: `no kept copy, and the repos no longer offer ${LIBC.have}` }]);
  assert.equal(r.back.command, 'sudo apt-get update && sudo apt-get install --allow-downgrades tzdata=2026e-0+deb13u1');
  assert.ok(typeof r.engine === 'string' && r.engine.length);
});

test('without a terminal: sudo is never called; the line is handed over, the receipt waits, and the exit is 4; --resume finishes it', async () => {
  const m = machine();
  const code = await H.upgrade(m.ctx, A.source, [TZ, LIBC], m.o({ tty: false }));
  assert.equal(code, 4);
  assert.deepEqual(m.sudo, [], 'never sudo without a terminal');
  assert.ok(m.printed.some(l => l.includes(LINE)), `both lines, ready to paste: ${m.printed.join('\n')}`);
  assert.ok(m.printed.some(l => l.includes('steward sc upgrade --resume')), m.printed.join('\n'));
  const rp = H.waiting(m.ctx);
  assert.ok(rp, 'a receipt waits');
  const r = read(rp);
  assert.equal(r.complete, false);
  assert.equal(r.outcome, 'waiting-on-you');

  // you ran the line yourself
  Object.assign(m.installed, { tzdata: TZ.want, libc6: LIBC.want });
  m.printed.length = 0;
  assert.equal(await H.resume(m.ctx, m.o()), 0, m.printed.join('\n'));
  assert.deepEqual(m.sudo, [], 'resume only reads');
  const done = read(rp);
  assert.equal(done.complete, true);
  assert.equal(done.outcome, 'done');
  assert.equal(H.waiting(m.ctx), null, 'nothing waits after');
});

test('--resume before you ran the line: still waiting, says so, exit 4; with nothing waiting: says so, exit 0', async () => {
  const m = machine();
  await H.upgrade(m.ctx, A.source, [TZ], m.o({ tty: false }));
  m.printed.length = 0;
  assert.equal(await H.resume(m.ctx, m.o()), 4);
  assert.ok(m.printed.some(l => l.includes('still waiting') && l.includes('tzdata')), m.printed.join('\n'));
  assert.equal(read(H.waiting(m.ctx)).outcome, 'waiting-on-you');
  const empty = machine();
  assert.equal(await H.resume(empty.ctx, empty.o()), 0);
  assert.ok(empty.printed.some(l => l.includes('nothing waiting')), empty.printed.join('\n'));
});

test('a package that didn\'t move ends as failed, named, with the way back for those that did', async () => {
  const m = machine({ stuck: ['libc6'] });
  // (the refresh ran, the install ran, libc6 just didn't move)
  assert.equal(await H.upgrade(m.ctx, A.source, [TZ, LIBC], m.o({ tty: true })), 1);
  const r = read(path.join(m.ctx.cfg.paths.state, 'backups', m.backups()[0], 'receipt.json'));
  assert.equal(r.complete, true);
  assert.equal(r.outcome, `failed: not at the wanted version: libc6 (${LIBC.have}, wanted ${LIBC.want})`);
  assert.deepEqual(r.back.items, [{ name: 'tzdata', to: TZ.have }]);
  assert.ok(m.printed.some(l => l.includes('libc6')), m.printed.join('\n'));
});

test('sudo failing (a wrong password, apt refusing) is a failure; nothing moved, so there is no way back to take', async () => {
  const m = machine({ fail: 'install' });
  assert.equal(await H.upgrade(m.ctx, A.source, [TZ, LIBC], m.o({ tty: true })), 1);
  const r = read(path.join(m.ctx.cfg.paths.state, 'backups', m.backups()[0], 'receipt.json'));
  assert.equal(r.outcome, `failed: sudo ${PINNED.slice(0, 2).join(' ')} exited 100`);
  assert.deepEqual(r.back.items, []);
});

test('the refresh failing stops before the install: nothing is installed from lists that didn\'t refresh', async () => {
  const m = machine({ fail: 'update' });
  assert.equal(await H.upgrade(m.ctx, A.source, [TZ, LIBC], m.o({ tty: true })), 1);
  assert.deepEqual(m.sudo, [REFRESH], 'no install after a failed refresh');
  const r = read(path.join(m.ctx.cfg.paths.state, 'backups', m.backups()[0], 'receipt.json'));
  assert.equal(r.outcome, 'failed: sudo apt-get update exited 100');
});

test('DRY_RUN: the line is shown; nothing is run and nothing is written', async () => {
  const m = machine();
  assert.equal(await H.upgrade(m.ctx, A.source, [TZ, LIBC], m.o({ tty: true, dry: true })), 0);
  assert.deepEqual(m.sudo, []);
  assert.deepEqual(m.backups(), []);
  assert.ok(m.printed.some(l => l.includes(`sudo ${PINNED.join(' ')}`)), m.printed.join('\n'));
});

test('rollback at a terminal: asks, then sudo downgrades to what the receipt names; checked, then recorded', async () => {
  const m = machine();
  await H.upgrade(m.ctx, A.source, [TZ, LIBC], m.o({ tty: true }));
  const rp = path.join(m.ctx.cfg.paths.state, 'backups', m.backups()[0], 'receipt.json');
  m.sudo.length = 0;
  const no = await H.rollback(m.ctx, A.source, rp, m.o({ tty: true, ask: async () => false }));
  assert.equal(no, 1);
  assert.deepEqual(m.sudo, [], 'no yes, no sudo');
  assert.equal(await H.rollback(m.ctx, A.source, rp, m.o({ tty: true, ask: async () => true })), 0, m.printed.join('\n'));
  assert.deepEqual(m.sudo, [REFRESH, ['sudo', 'apt-get', 'install', '--allow-downgrades', 'tzdata=2026e-0+deb13u1']]);
  assert.equal(m.installed.tzdata, TZ.have);
  const r = read(rp);
  assert.ok(r.rolled_back && r.rolled_back.at, 'recorded');
  assert.ok(m.printed.some(l => l.includes('libc6') && l.includes('no longer offer')), 'what can\'t go back is said');
});

test('rollback without a terminal: handed over, exit 4; run again once you ran it, it checks and records without sudo', async () => {
  const m = machine();
  await H.upgrade(m.ctx, A.source, [TZ], m.o({ tty: true }));
  const rp = path.join(m.ctx.cfg.paths.state, 'backups', m.backups()[0], 'receipt.json');
  m.sudo.length = 0;
  assert.equal(await H.rollback(m.ctx, A.source, rp, m.o({ tty: false, ask: async () => true })), 4);
  assert.deepEqual(m.sudo, []);
  assert.ok(m.printed.some(l => l.includes('sudo apt-get install --allow-downgrades tzdata=2026e-0+deb13u1')), m.printed.join('\n'));
  m.installed.tzdata = TZ.have;
  assert.equal(await H.rollback(m.ctx, A.source, rp, m.o({ tty: false, ask: async () => true })), 0);
  assert.deepEqual(m.sudo, []);
  assert.ok(read(rp).rolled_back);
});

test('steward sc rollback <receipt> sends a root-upgrade receipt to the root hand-off (DRY_RUN: shown, not run)', () => {
  const dir = path.join(ROOT, 'rb-state', 'backups', 'apt-upgrade-20261103T120000Z');
  fs.mkdirSync(dir, { recursive: true });
  const rp = path.join(dir, 'receipt.json');
  // versions no real machine has: the rollback reads this machine's own dpkg, and Debian 13's image has tzdata 2026e-0+deb13u1
  // installed, so TZ's versions read as already put back there (found by the Debian 13 container row, parity 1c)
  const tz = { ...TZ, have: '0~steward.test1', want: '0~steward.test2' };
  fs.writeFileSync(rp, JSON.stringify({ kind: 'root-upgrade', source: 'apt', complete: true, outcome: 'done', items: [tz], after: { tzdata: tz.want },
    back: { items: [{ name: 'tzdata', to: tz.have }], none: [], command: 'sudo apt-get install --allow-downgrades tzdata=0~steward.test1' } }));
  const r = spawnSync('bash', [path.join(__dirname, '..', 'supply-chain', 'bin', 'rollback'), rp], {
    encoding: 'utf8', env: { ...process.env, DRY_RUN: '1', STEWARD_INSTANCE: path.join(__dirname, '..', 'examples'), XDG_STATE_HOME: path.join(ROOT, 'rb-xdg'), NO_COLOR: '1' },
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  assert.ok(out.includes('sudo apt-get install --allow-downgrades tzdata=0~steward.test1'), out);
  assert.ok(!out.includes('updaters.js'), 'not the declared updaters\' rollback');
});

// Kept packages (D88; owner, 2026-11-13): the steward keeps its own copy of the builds a root upgrade moves between,
// so the way back is the exact build from before, even after the repos drop it.
test('kept packages: before sudo, copies of the builds from before and after are downloaded as you; the way back prefers them', async () => {
  const m = machine({ download: true });
  assert.equal(await H.upgrade(m.ctx, A.source, [TZ, LIBC], m.o({ tty: true })), 0, m.printed.join('\n'));
  const dl = m.calls.filter(c => c.startsWith('apt-get') && c.includes(' download '));
  assert.ok(dl.every(c => c.includes('Dir::State::Lists=')), 'from the steward\'s own lists, as you');
  const r = read(path.join(m.ctx.cfg.paths.state, 'backups', m.backups()[0], 'receipt.json'));
  assert.deepEqual(r.kept, { tzdata: { have: true, want: true }, libc6: { have: false, want: true } }, 'libc6\'s old build had left the repos');
  const tz = r.back.items.find(i => i.name === 'tzdata');
  assert.match(tz.file, /kept\/apt\/tzdata\/tzdata_2026e-0\+deb13u1_arm64\.deb$/);
  assert.match(tz.sha256, /^[0-9a-f]{64}$/);
  assert.match(r.back.command, /apt-get install --allow-downgrades \/.*tzdata_2026e-0\+deb13u1_arm64\.deb$/);
  assert.deepEqual(r.back.none.map(n => n.name), ['libc6'], 'the first upgrade has no way back for a build the repos dropped');
  assert.ok(m.printed.some(l => l.includes('tzdata 2026e-0+deb13u1: from the steward\'s kept copy')), m.printed.join('\n'));
});

test('kept packages: the next upgrade goes back to the kept build even though the repos dropped it; rollback installs that file', async () => {
  const U3 = '2.41-12+deb13u3';
  const offered = { tzdata: [TZ.want, TZ.have], libc6: [LIBC.want] };
  const m = machine({ download: true, offered });
  await H.upgrade(m.ctx, A.source, [LIBC], m.o({ tty: true }));
  offered.libc6 = [U3]; // u2 leaves the repos
  await H.upgrade(m.ctx, A.source, [{ ...LIBC, have: LIBC.want, want: U3 }], m.o({ tty: true }));
  const rp = path.join(m.ctx.cfg.paths.state, 'backups', m.backups().sort()[1], 'receipt.json');
  const r = read(rp);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(r.back.items.map(i => [i.name, i.to]), [['libc6', LIBC.want]]);
  m.sudo.length = 0;
  assert.equal(await H.rollback(m.ctx, A.source, rp, m.o({ tty: true, ask: async () => true })), 0, m.printed.join('\n'));
  assert.equal(m.installed.libc6, LIBC.want);
  assert.match(m.sudo[1].join(' '), /apt-get install --allow-downgrades \/.*libc6_2\.41-12\+deb13u2_arm64\.deb$/);
});

test('kept packages: a kept file changed since it was downloaded is never handed to sudo', async () => {
  const m = machine({ download: true });
  await H.upgrade(m.ctx, A.source, [TZ], m.o({ tty: true }));
  const rp = path.join(m.ctx.cfg.paths.state, 'backups', m.backups()[0], 'receipt.json');
  fs.writeFileSync(read(rp).back.items[0].file, 'tampered');
  m.sudo.length = 0;
  assert.equal(await H.rollback(m.ctx, A.source, rp, m.o({ tty: true, ask: async () => true })), 0);
  assert.deepEqual(m.sudo, [], 'nothing installed');
  assert.ok(m.printed.some(l => l.includes('missing or changed since it was downloaded')), m.printed.join('\n'));
});

test('kept packages: kept_versions = 0 downloads nothing, and the way back is what the repos offer', async () => {
  const m = machine({ download: true, policy: { kept_versions: 0 } });
  await H.upgrade(m.ctx, A.source, [TZ], m.o({ tty: true }));
  assert.ok(!m.calls.some(c => c.includes(' download ')));
  const r = read(path.join(m.ctx.cfg.paths.state, 'backups', m.backups()[0], 'receipt.json'));
  assert.deepEqual(r.back.items, [{ name: 'tzdata', to: TZ.have }]);
});

test('kept packages: the clean-up keeps the newest kept_versions, the installed build and any the way back names', () => {
  const state = path.join(ROOT, 'prune');
  const ctx = { cfg: { paths: { state }, policy: { kept_versions: 1 } } };
  const src = { id: 'apt' };
  const dir = path.join(K.root(ctx, src), 'x');
  fs.mkdirSync(dir, { recursive: true });
  const idx = { x: {} };
  ['1', '2', '3', '4'].forEach((v, k) => {
    const file = path.join(dir, `x_${v}_all.deb`);
    fs.writeFileSync(file, v);
    idx.x[v] = { file, sha256: '0', at: `2026-11-0${k + 1}T00:00:00.000Z` };
  });
  fs.writeFileSync(path.join(K.root(ctx, src), 'index.json'), JSON.stringify(idx));
  const gone = K.prune(ctx, src, ['x'], { x: '2' }, new Set([idx.x['3'].file]));
  assert.deepEqual(gone.map(f => path.basename(f)), ['x_1_all.deb'], 'newest (4), installed (2) and the way back (3) stay');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['x_2_all.deb', 'x_3_all.deb', 'x_4_all.deb']);
});

test('kept packages: dnf and zypper install a kept .rpm by its path, else the pinned build', () => {
  const D = require('../lib/providers/dnf.js'), Z = require('../lib/providers/zypper.js');
  const items = [{ name: 'a', to: '1.0-1.fc44', file: '/k/a-1.0-1.fc44.x86_64.rpm' }, { name: 'b', to: '2.0-1.fc44' }];
  assert.deepEqual(D.source.rollbackCmd(items).args.slice(-2), ['/k/a-1.0-1.fc44.x86_64.rpm', 'b-2.0-1.fc44']);
  assert.deepEqual(Z.source.rollbackCmd(items).args.slice(-2), ['/k/a-1.0-1.fc44.x86_64.rpm', 'b=2.0-1.fc44']);
  assert.equal(typeof D.source.download, 'function');
  assert.equal(typeof Z.source.download, 'function');
});

test('kept packages: dnf5 and zypper download the installed architecture into the given folder, as you', async () => {
  const D = require('../lib/providers/dnf.js'), Z = require('../lib/providers/zypper.js');
  const dest = fs.mkdtempSync(path.join(ROOT, 'dl-'));
  const calls = [];
  const ctx = { cfg: { paths: { state: path.join(ROOT, 'dl-state') } }, run: async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'rpm') return { status: 0, stdout: 'x86_64\n' };
    const d = (args.find(a => /^--(destdir|pkg-cache-dir)=/.test(a)) || '').split('=')[1];
    fs.mkdirSync(path.join(d, 'repo-oss', 'x86_64'), { recursive: true });
    fs.writeFileSync(path.join(d, 'repo-oss', 'x86_64', 'curl-8.1-1.1.x86_64.rpm'), 'rpm');
    return { status: 0, stdout: '' };
  } };
  assert.match(await D.source.download(ctx, 'curl', '8.1-1.1', dest), /curl-8\.1-1\.1\.x86_64\.rpm$/);
  assert.ok(calls.some(c => c[0] === 'dnf5' && c.includes('download') && c.includes('curl-8.1-1.1.x86_64') && c.includes(`--destdir=${dest}`)));
  const dest2 = fs.mkdtempSync(path.join(ROOT, 'dl-'));
  assert.match(await Z.source.download(ctx, 'curl', '8.1-1.1', dest2), /curl-8\.1-1\.1\.x86_64\.rpm$/);
  assert.ok(calls.some(c => c[0] === 'zypper' && c.includes('download') && c.includes('curl.x86_64=8.1-1.1') && c.includes(`--pkg-cache-dir=${dest2}`)));
  assert.ok(!calls.some(c => c[0] === 'sudo'));
});
