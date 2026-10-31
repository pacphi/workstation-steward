#!/usr/bin/env node
// The soak window (D20): after anything changes what runs on this machine, old installs stay until steward.toml
// [policy] soak_days have passed, so going back is a link away instead of a reinstall. Read-only.
// A soak starts at the newest of these receipts under [paths] state:
//   changes/*.json          mise tool upgrades and Node patches (supply-chain/bin/upgrade-tool, node-patch)
//   hybrids/*.json          npm -g hybrid installs (install_hybrids in lib/lib.sh)
//   backups/*/receipt.json  launcher repins, onboarding, reconciling, the AQE hook transport and declared updaters; not
//                           offboarding or the guards, which change no install anything runs (offboarding's rollback points
//                           back at stable links), and not a signed_data update (D52: a daily source would keep the soak
//                           running for good; its copies are kept for soak_days instead)
// A full `steward sc prune` writes pruned.json; a soak that ended before the last prune has nothing left to wait for.
// Usage: soak.js            the soak state and the receipts behind it
//        soak.js --gate     exit 1 while a soak is running (prune's check)
//        soak.js --banner   one line while a soak runs or a finished one awaits a prune; nothing otherwise
const fs = require('fs');
const path = require('path');
const C = require('./config.js');

const { values } = C.load();
const STATE = values.paths.state;
const DAYS = values.policy.soak_days;
const DAY = 86400e3;
// receipt kinds that don't start a soak; a config sync starts one through changes/ only when it ran mise install
const NO_SOAK = /^(fix|coarse|offboard|guard|sync|prune-merged|doctor|timeouts|approvals|init|config-sync|updater-signed_data)/;

const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const list = d => { try { return fs.readdirSync(d); } catch { return []; } };

// what(receipt) — what a backups/ receipt changed: its files (repins, the transport), or its units (onboarding and
// reconciling list entries; a folder copy's entry holds several names), and the project when it names one
function what(r) {
  const n = Array.isArray(r.files) ? `${r.files.length} file(s)`
    : Array.isArray(r.entries) ? `${r.entries.reduce((s, e) => s + (Array.isArray(e.names) ? e.names.length : 1), 0)} unit(s)` : 'a change';
  return r.project ? `${n} in ${r.project}` : n;
}

// events() — [{at: Date, kind, what, file}] for every receipt that starts a soak, newest first
function events() {
  const out = [];
  const add = (file, at, kind, what) => { const t = new Date(at); if (!Number.isNaN(t.getTime())) out.push({ at: t, kind, what, file }); };
  for (const f of list(path.join(STATE, 'changes')).filter(f => f.endsWith('.json'))) {
    const r = readJSON(path.join(STATE, 'changes', f));
    if (r) add(path.join(STATE, 'changes', f), r.at, r.kind, r.what);
  }
  for (const f of list(path.join(STATE, 'hybrids')).filter(f => f.endsWith('.json'))) {
    const r = readJSON(path.join(STATE, 'hybrids', f));
    if (r) add(path.join(STATE, 'hybrids', f), r.installed_at, 'hybrid', `${r.name}@${r.version} on Node ${r.node}`);
  }
  for (const d of list(path.join(STATE, 'backups'))) {
    const f = path.join(STATE, 'backups', d, 'receipt.json');
    const r = fs.existsSync(f) && readJSON(f);
    const kind = r && (r.kind || d.replace(/-\d.*$/, ''));
    if (r && r.at && !NO_SOAK.test(kind)) add(f, r.at, kind, what(r));
  }
  return out.sort((a, b) => b.at - a.at);
}

// state() — { days, newest, until, running, lastPrune, awaitingPrune }
function state(now = new Date()) {
  const ev = events();
  const newest = ev[0] || null;
  const until = newest ? new Date(newest.at.getTime() + DAYS * DAY) : null;
  const pr = readJSON(path.join(STATE, 'pruned.json'));
  const lastPrune = pr && pr.at ? new Date(pr.at) : null;
  const running = Boolean(until && now < until);
  const awaitingPrune = Boolean(newest && !running && (!lastPrune || lastPrune < newest.at));
  return { days: DAYS, newest, until, running, lastPrune, awaitingPrune, events: ev };
}

const fmt = d => d.toLocaleString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
const left = (until, now = new Date()) => {
  const h = Math.ceil((until.getTime() - now.getTime()) / 3600e3);
  return h > 36 ? `${Math.ceil(h / 24)} days left` : `${h} hour(s) left`;
};

module.exports = { events, state };

if (require.main === module) {
  const mode = process.argv[2] || '';
  const s = state();
  const what = s.newest && `${s.newest.kind} ${fmt(s.newest.at)}`;
  if (mode === '--gate') {
    if (!s.running) process.exit(0);
    console.error(`soak running until ${fmt(s.until)} (${left(s.until)}; newest change: ${what}; [policy] soak_days = ${DAYS})`);
    process.exit(1);
  }
  if (mode === '--banner') {
    if (s.running) console.log(`\x1b[1;33msoak\x1b[0m ${left(s.until)}, until ${fmt(s.until)} (newest change: ${what}); prune waits. Daily: steward ai drift --offline`);
    else if (s.awaitingPrune) console.log(`\x1b[1;32msoak over\x1b[0m since ${fmt(s.until)}: when ready, DRY_RUN=1 steward sc prune, then steward sc prune`);
    process.exit(0);
  }
  console.log(`soak_days = ${DAYS} (steward.toml [policy])`);
  if (!s.newest) { console.log('no receipts yet: nothing to soak'); process.exit(0); }
  console.log(s.running ? `running: until ${fmt(s.until)} (${left(s.until)})` : `not running: the last soak ended ${fmt(s.until)}`);
  console.log(`last prune: ${s.lastPrune ? fmt(s.lastPrune) : 'none recorded'}${s.awaitingPrune ? ' (older than the newest change: prune when ready)' : ''}`);
  console.log('newest changes:');
  for (const e of s.events.slice(0, 8)) console.log(`  ${fmt(e.at)}  ${e.kind.padEnd(10)} ${e.what}  ${C.tilde(e.file)}`);
}
