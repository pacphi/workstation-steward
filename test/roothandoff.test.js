// The root hand-off (parity 1b, D-b revised 2026-11-03, lib/roothandoff.js): a package upgrade that needs root, run by
// the steward through sudo at a terminal after the plan's yes (you type your password into sudo's own prompt), or
// handed over as the exact line when there is no terminal, with a pending receipt that `steward sc upgrade --resume`
// finishes. Root refreshes the system's package lists first (apt-get update; owner, 2026-11-03), because they can be
// older than the steward's own copy (the Debian container's real run: "Version … was not found"). Before and after are
// read as you (dpkg-query); the way back is offered only for versions the repos still have (apt-cache madison, from the
// steward's own lists). No real sudo, apt or dpkg: stand-ins record every call.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../lib/roothandoff.js');
const A = require('../lib/providers/apt.js');

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
    now: NOW, platform: 'linux', family: 'debian', cfg: { paths: { state }, policy: { min_release_age_days: 3 } },
    run: async (cmd, args = []) => {
      m.calls.push([cmd, ...args].join(' '));
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
    for (const a of args) { const [n, v] = a.split('='); if (v && !(o.stuck || []).includes(n)) m.installed[n] = v; }
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
  assert.deepEqual(r.back.none, [{ name: 'libc6', have: LIBC.have, reason: `the archive no longer offers ${LIBC.have}` }]);
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
  assert.ok(m.printed.some(l => l.includes('libc6') && l.includes('no longer offers')), 'what can\'t go back is said');
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
