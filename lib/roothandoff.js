#!/usr/bin/env node
// The root hand-off (parity 1b; D-b revised by the owner, 2026-11-03): a package upgrade that needs root, for any source
// with needsRoot (apt now; dnf and zypper next). The steward itself never runs as root and never holds a password.
//   - before: what is installed, read as you (source.installed: dpkg-query), into a receipt under
//     <state>/backups/<source>-upgrade-<time>/ with each item's versions, why it was taken and the exact command
//   - at a terminal, after the plan's yes: the source's root refresh (`sudo apt-get update`: the system's lists can be
//     older than the steward's own copy, so root apt wouldn't know the version; owner, 2026-11-03), then `sudo <the
//     pinned command>`, each a child on your terminal; you type your password into sudo's own prompt, once. A failed
//     step stops the ones after it. With no terminal (a pipe, an agent, --unattended): the line is handed over, the
//     receipt waits (outcome waiting-on-you), the exit is 4, and `steward sc upgrade --resume` finishes it
//   - after: read again as you; every package at its wanted version is done, anything else is named as failed
//   - the way back: the versions from before that the repos still offer (source.offered: apt-cache madison, from the
//     steward's own lists); `steward sc rollback <receipt>` puts them back the same way (terminal, or handed over)
// Every command goes through ctx.run (as you) or o.spawn (sudo), so tests hand it stand-ins.
// Usage: roothandoff.js --resume      roothandoff.js --rollback <receipt>      (DRY_RUN=1: shown, nothing run)
const fs = require('fs');
const path = require('path');
const { spawn: childSpawn } = require('child_process');
const C = require('./config.js');

const KIND = 'root-upgrade';
const RESUME = 'steward sc upgrade --resume';

const backups = ctx => path.join(ctx.cfg.paths.state, 'backups');
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const line = c => `sudo ${[c.cmd, ...c.args].join(' ')}`;
// steps(source, c) — what runs as root for command c: the source's refresh first, when it has one
const steps = (source, c) => [source.rootRefresh, c].filter(Boolean);
const chain = list => list.map(line).join(' && ');
// runAll(list, spawn, print) — each step through sudo, in order, stopping at the first that fails: {code, label}
async function runAll(list, spawn, print) {
  for (const s of list) {
    print(`   $ ${line(s)}   (sudo asks for your password the first time)`);
    const code = await spawn('sudo', [s.cmd, ...s.args]);
    if (code) return { code, label: `${s.cmd} ${s.args[0]}` };
  }
  return { code: 0, label: '' };
}
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function save(rp, r) {
  fs.writeFileSync(`${rp}.tmp`, `${JSON.stringify(r, null, 1)}\n`);
  fs.renameSync(`${rp}.tmp`, rp);
}
// newDir(ctx, source) — a fresh folder for one run's receipt
function newDir(ctx, source) {
  const base = path.join(backups(ctx), `${source.id}-upgrade-${stamp(new Date())}`);
  let dir = base;
  for (let i = 1; fs.existsSync(dir); i++) dir = `${base}-${i}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// sudo(cmd, args) — sudo as a child on this terminal: its prompt, its output; the exit status (127 when it can't start)
const sudo = (cmd, args) => new Promise(resolve => {
  const p = childSpawn(cmd, args, { stdio: 'inherit' });
  p.on('error', () => resolve(127));
  p.on('close', code => resolve(code === null ? 1 : code));
});
// terminal() — can sudo ask for a password here: stdin and stdout are a terminal, and the run isn't --unattended
const terminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY) && !require('./autonomy.js').unattended();

function handOver(print, cmd, then) {
  print('==> this needs root, and there is no terminal here for sudo to ask your password: run it yourself, at a terminal');
  print(`   ${cmd}`);
  print(`   waiting on you: then ${then}`);
}

// wayBack(ctx, source, r) — {items: [{name, to}], none: [{name, have, reason}], command}: for each package that moved,
// the version from before when the repos still offer it
async function wayBack(ctx, source, r) {
  const items = [], none = [];
  for (const i of r.items) {
    const was = (r.before || {})[i.name] || i.have;
    if (!was || (r.after || {})[i.name] === was) continue;
    if ((await source.offered(ctx, i.name)).includes(was)) items.push({ name: i.name, to: was });
    else none.push({ name: i.name, have: was, reason: `the archive no longer offers ${was}` });
  }
  return { items, none, command: items.length ? chain(steps(source, source.rollbackCmd(items))) : '' };
}

// finish(ctx, source, rp, r, ran, print) — read the versions again, record the outcome and the way back; the exit code.
// ran: {code, label} of the root steps (label: the one that failed)
async function finish(ctx, source, rp, r, ran, print) {
  r.after = await source.installed(ctx, r.items.map(i => i.name));
  const stuck = r.items.filter(i => r.after[i.name] !== i.want);
  r.back = await wayBack(ctx, source, r);
  r.complete = true;
  r.finished_at = new Date().toISOString();
  r.outcome = ran.code ? `failed: sudo ${ran.label} exited ${ran.code}`
    : stuck.length ? `failed: not at the wanted version: ${stuck.map(i => `${i.name} (${r.after[i.name] || 'not installed'}, wanted ${i.want})`).join(', ')}` : 'done';
  save(rp, r);
  const rel = C.tilde(rp);
  if (r.outcome === 'done') print(`==> ${source.provider}: ${r.items.length} package(s) upgraded and checked; receipt ${rel}`);
  else print(`\x1b[1;31mERROR\x1b[0m ${source.provider}: ${r.outcome}; receipt ${rel}`);
  if (r.back.items.length) print(`   way back: steward sc rollback ${rel} (${r.back.command})`);
  for (const n of r.back.none) print(`   no way back for ${n.name}: ${n.reason}`);
  return r.outcome === 'done' ? 0 : 1;
}

// upgrade(ctx, source, items, o) — the hand-off for one source's items [{name, have, want, why}]; the exit code: 0 done,
// 1 failed, 4 handed over (waiting on you). o: {tty, spawn, print, dry}
async function upgrade(ctx, source, items, o = {}) {
  const print = o.print || console.log, spawn = o.spawn || sudo;
  const c = source.upgradeCmd(items), list = steps(source, c), cmd = chain(list);
  if (o.dry) { for (const s of list) print(`   $ ${line(s)}`); return 0; }
  const rp = path.join(newDir(ctx, source), 'receipt.json');
  const r = { kind: KIND, source: source.id, at: new Date().toISOString(), engine: C.ENGINE_VERSION, ...require('./autonomy.js').mark(),
    complete: false, outcome: 'started', command: cmd, items, before: await source.installed(ctx, items.map(i => i.name)) };
  save(rp, r);
  if (!o.tty) {
    r.outcome = 'waiting-on-you';
    save(rp, r);
    handOver(print, cmd, `${RESUME} checks the versions and finishes the receipt (${C.tilde(rp)})`);
    return 4;
  }
  return finish(ctx, source, rp, r, await runAll(list, spawn, print), print);
}

// waiting(ctx) — the newest root-upgrade receipt not yet finished (handed over, or stopped midway), or null
function waiting(ctx) {
  let names = [];
  try { names = fs.readdirSync(backups(ctx)).sort(); } catch { return null; }
  for (const n of names.reverse()) {
    const rp = path.join(backups(ctx), n, 'receipt.json');
    const r = readJSON(rp);
    if (r && r.kind === KIND && r.complete === false) return rp;
  }
  return null;
}

// resume(ctx, o) — finish the hand-off waiting: done once every package moved, still waiting (4) while none has
async function resume(ctx, o = {}) {
  const print = o.print || console.log;
  const rp = waiting(ctx);
  if (!rp) { print('==> nothing waiting: no root upgrade was handed over'); return 0; }
  const r = readJSON(rp);
  const source = o.source || require('./providers/index.js').byId(r.source);
  if (!source) { print(`\x1b[1;31mERROR\x1b[0m ${C.tilde(rp)}: no package source ${r.source}`); return 1; }
  const now = await source.installed(ctx, r.items.map(i => i.name));
  if (r.items.every(i => now[i.name] === (r.before || {})[i.name])) {
    print(`==> still waiting: ${r.items.map(i => i.name).join(', ')} not upgraded yet. Run this at a terminal, then ${RESUME}`);
    print(`   ${r.command}`);
    return 4;
  }
  return finish(ctx, source, rp, r, { code: 0, label: '' }, print);
}

// rollback(ctx, source, rp, o) — put back the versions the receipt's way back names: shown, asked, then sudo at a
// terminal or handed over (4). Run again after a hand-off, it checks and records without sudo. o: {tty, spawn, print,
// dry, ask(q) → yes}
async function rollback(ctx, source, rp, o = {}) {
  const print = o.print || console.log, spawn = o.spawn || sudo;
  const r = readJSON(rp);
  if (!r || r.kind !== KIND) { print(`\x1b[1;31mERROR\x1b[0m ${C.tilde(rp)} is not a root upgrade's receipt`); return 1; }
  if (r.rolled_back) { print(`==> already put back (${r.rolled_back.at})`); return 0; }
  const back = r.back || { items: [], none: [] };
  for (const n of back.none || []) print(`   no way back for ${n.name}: ${n.reason}`);
  if (!back.items.length) { print('==> nothing the repos still offer to put back'); return 0; }
  const list = steps(source, source.rollbackCmd(back.items)), cmd = chain(list);
  const record = () => { r.rolled_back = { at: new Date().toISOString(), command: cmd }; save(rp, r); print(`==> put back and checked: ${back.items.map(i => `${i.name} ${i.to}`).join(', ')}`); };
  const isBack = async () => { const now = await source.installed(ctx, back.items.map(i => i.name)); return back.items.every(i => now[i.name] === i.to); };
  if (await isBack()) { record(); return 0; }
  for (const i of back.items) print(`   put back: ${i.name} ${(r.after || {})[i.name] || '?'} -> ${i.to}`);
  if (o.dry) { for (const s of list) print(`   $ ${line(s)}`); return 0; }
  if (!(await (o.ask || (async () => false))('Put these versions back?'))) { print('aborted'); return 1; }
  if (!o.tty) { handOver(print, cmd, `steward sc rollback ${C.tilde(rp)} again, to check and record it`); return 4; }
  const ran = await runAll(list, spawn, print);
  if (!ran.code && (await isBack())) { record(); return 0; }
  print(`\x1b[1;31mERROR\x1b[0m the rollback didn't take${ran.code ? ` (sudo ${ran.label} exited ${ran.code})` : ''}; the versions now: steward sc audit`);
  return 1;
}

// ask(q) — [y/N] on the terminal; under --unattended, [autonomy] answers for the class rollback
async function ask(q) {
  const a = require('./autonomy.js').answer('rollback', q);
  if (a !== null && a !== undefined) return a;
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^[Yy]$/.test(ans.trim());
}

module.exports = { upgrade, resume, rollback, waiting, terminal, KIND };

if (require.main === module) {
  (async () => {
    const ctx = require('../supply-chain/bin/audit.js').context();
    const dry = process.env.DRY_RUN === '1';
    const i = process.argv.indexOf('--rollback');
    if (i > 0) {
      const rp = C.userPath(process.argv[i + 1] || '');
      const r = readJSON(rp) || {};
      const source = require('./providers/index.js').byId(r.source);
      if (!source) { console.error(`\x1b[1;31mERROR\x1b[0m ${C.tilde(rp)}: no package source ${r.source}`); return 1; }
      return rollback(ctx, source, rp, { tty: terminal(), dry, ask });
    }
    if (process.argv.includes('--resume')) return resume(ctx);
    console.error('usage: roothandoff.js --resume | --rollback <receipt>');
    return 2;
  })().then(code => { process.exitCode = code; }).catch(e => { console.error(`\x1b[1;31mERROR\x1b[0m ${e.message}`); process.exitCode = 1; });
}
