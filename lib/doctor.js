#!/usr/bin/env node
// What this repo needs on the machine (lib/prereqs.json), checked read-only; or installed after a plan and a yes.
// Runs on plain Node, with no yq or just, so it still works on a machine that is missing them.
// Usage: doctor.js [--area core,fleet,…] [--json] [--markdown] [--install]
//   (none)      check; exit 1 if a required tool is missing
//   --json      the results as JSON
//   --markdown  the table docs/prereqs.md carries between its markers (a test keeps them equal)
//   --install   plan the missing mise and Homebrew tools, ask [y/N], install them, write a receipt. Tools that come
//               from macOS or need a manual step (Xcode tools, Homebrew itself, Docker, gh login) are listed, never run.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'prereqs.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const areaArg = (() => { const i = args.indexOf('--area'); return i < 0 ? null : (args[i + 1] || '').split(','); })();
const die = m => { console.error(`doctor: ${m}`); process.exit(2); };
for (const a of areaArg || []) if (!(a in DATA.areas)) die(`unknown area "${a}" (${Object.keys(DATA.areas).join(', ')})`);
const items = DATA.prereqs.filter(p => !areaArg || areaArg.includes(p.area));

// --- the table docs/prereqs.md carries ----------------------------------------------------------------------
if (flag('--markdown')) {
  const cell = s => String(s || '').replace(/\|/g, '\\|');
  const rows = ['| Area | Tool | Need | From | Used for | To install |', '| --- | --- | --- | --- | --- | --- |'];
  for (const a of Object.keys(DATA.areas)) {
    for (const p of items.filter(x => x.area === a)) {
      rows.push(`| ${a} | ${cell(p.name)} | ${p.need} | ${p.source} | ${cell(p.why)} | ${p.install ? `\`${cell(p.install)}\`` : 'comes with macOS'} |`);
    }
  }
  console.log(rows.join('\n'));
  process.exit(0);
}

// --- checking ------------------------------------------------------------------------------------------------
const sh = (cmd, timeout = 8000) => spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
function check(p) {
  const found = sh(`command -v ${p.bin}`);
  const where = found.status === 0 ? found.stdout.trim().split('\n')[0] : '';
  let ok = !!where;
  if (ok && p.check) ok = sh(p.check).status === 0;
  let version = '';
  if (ok && p.version) { const v = sh(p.version); const line = (v.stdout || v.stderr || '').trim().split('\n')[0] || ''; version = (line.match(/\d+(?:\.\d+)+/) || [line.slice(0, 40)])[0]; }
  return { ...p, ok, where, version };
}
const results = items.map(check);

if (flag('--json')) { console.log(JSON.stringify(results.map(({ name, area, need, source, ok, where, version }) => ({ name, area, need, source, ok, where, version })), null, 1)); process.exit(results.some(r => !r.ok && r.need === 'required') ? 1 : 0); }

const missing = results.filter(r => !r.ok);
const reqMissing = missing.filter(r => r.need === 'required');
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, Y = s => `\x1b[33m${s}\x1b[0m`;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (f, s) => (tty ? f(s) : s);
const home = require('os').homedir();
const tilde = s => (s.startsWith(home) ? `~${s.slice(home.length)}` : s);
for (const a of Object.keys(DATA.areas)) {
  const rs = results.filter(r => r.area === a);
  if (!rs.length) continue;
  console.log(`\n${a}  (${DATA.areas[a]})`);
  for (const r of rs) {
    const mark = r.ok ? paint(G, 'ok      ') : r.need === 'required' ? paint(R, 'MISSING ') : paint(Y, 'missing ');
    console.log(`  ${mark} ${r.name.padEnd(18)} ${r.ok ? `${r.version || ''}${r.where ? `  ${tilde(r.where)}` : ''}`.trim() : `${r.need}, from ${r.source}${r.install ? `: ${r.install}` : ''}`}`);
  }
}
console.log(`\n${results.length - missing.length} of ${results.length} present; ${reqMissing.length} required missing, ${missing.length - reqMissing.length} optional missing.`);

// --- installing ----------------------------------------------------------------------------------------------
const command = r => (r.source === 'mise' ? ['mise', 'install', r.mise] : r.source === 'brew' ? ['brew', 'install', r.brew] : null);
const installable = missing.filter(r => command(r));
const manual = missing.filter(r => !command(r));
if (!flag('--install')) {
  if (missing.length) console.log('Run `node lib/doctor.js --install` (or `steward doctor --install`) to plan the installs it can do.');
  process.exit(reqMissing.length ? 1 : 0);
}

console.log('\nPlan');
if (!installable.length) console.log('  nothing the doctor can install.');
for (const r of installable) console.log(`  $ ${command(r).join(' ')}    (${r.name}, ${r.need})`);
for (const r of manual) console.log(`  by hand: ${r.name}${r.install ? `: ${r.install}` : ''}`);
if (installable.some(r => r.source === 'mise')) console.log('  (mise installs the version pinned in mise/config.toml; run `steward sc link` first if ~/.config/mise is not this repo\'s.)');
if (!installable.length) process.exit(reqMissing.length ? 1 : 0);

fs.writeSync(2, '\nInstall the tools above? [y/N] ');
const buf = Buffer.alloc(64); let n = 0; try { n = fs.readSync(0, buf, 0, 64, null); } catch { /* no stdin */ }
if (!/^\s*y/i.test(buf.slice(0, n).toString())) die('aborted');

(async () => {
  const { progress } = require('./progress.js');
  const pg = progress(installable.length);
  const done = [];
  for (const r of installable) {
    const [cmd, ...a] = command(r);
    const s = pg.stage(`${cmd} ${a.join(' ')}`);
    let log = '';
    const rc = await new Promise(res => {
      const p = spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] });
      p.on('error', e => { log += String(e.message); res(127); });
      for (const st of [p.stdout, p.stderr]) st.on('data', d => { log += d; const l = String(d).trim().split('\n').pop(); if (l) s.detail(l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 80)); });
      p.on('close', res);
    });
    const after = check(r);
    if (rc === 0 && after.ok) { s.done(after.version || 'installed'); done.push({ name: r.name, command: [cmd, ...a].join(' '), version: after.version, ok: true }); }
    else { s.done('failed'); console.error(log.split('\n').slice(-6).join('\n')); done.push({ name: r.name, command: [cmd, ...a].join(' '), ok: false, exit: rc }); }
  }
  pg.finish(`${done.filter(d => d.ok).length} of ${done.length} installed.`);
  // The receipt: config (and so the state folder) needs yq, which may have just been installed; fall back to the default.
  let dir;
  try { dir = require('./config.js').newBackupDir('doctor-install'); }
  catch { dir = path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'workstation-steward', 'backups', `doctor-install-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ kind: 'doctor-install', engine: require('../package.json').version, at: new Date().toISOString(), installed: done, by_hand: manual.map(m => m.name) }, null, 1) + '\n');
  console.log(`receipt ${tilde(path.join(dir, 'receipt.json'))}`);
  process.exit(done.every(d => d.ok) ? 0 : 1);
})();
