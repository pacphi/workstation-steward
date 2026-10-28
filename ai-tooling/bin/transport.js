#!/usr/bin/env node
// Install the AQE hook transport (D24) into the shared AQE runtime: ai-tooling/transports/aqe-hook-bundle.cjs, the
// source of record, copied to ai-tooling.toml [aqe] hook_transport. Projects' settings.local.json point
// AQE_HOOK_BUNDLE at it, and `steward projects onboard --apply` refuses until the installed copy matches the source.
// Same modes as transport v1 beside it (folder 700, file 600: node reads it, nothing executes it directly).
// Usage: transport.js                    plan only: installed, missing or different
//        transport.js --apply            plan, ask [y/N], then install (DRY_RUN=1 stops after the plan)
//        transport.js --rollback <receipt.json>   put back what was there before (if unchanged since)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const C = require('../../lib/config.js');
const P = require('../../lib/projects.js');

const policy = C.policy('ai-tooling/ai-tooling.toml');
const SRC = path.join(P.REPO_ROOT, 'ai-tooling', 'transports', 'aqe-hook-bundle.cjs');
const DEST = C.untilde(policy.aqe.hook_transport);
const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };

async function ask(q) {
  if (process.env.DRY_RUN === '1') return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

// state() — 'installed' | 'missing' | 'differs'
const state = () => (!fs.existsSync(DEST) ? 'missing' : sha(DEST) === sha(SRC) ? 'installed' : 'differs');

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--rollback')) {
    const receipt = args[args.indexOf('--rollback') + 1];
    if (!receipt || receipt.startsWith('--')) { console.error('usage: --rollback <receipt.json>'); process.exit(2); }
    const rc = JSON.parse(fs.readFileSync(C.userPath(receipt), 'utf8'));
    if (sha(C.untilde(rc.file)) !== rc.sha_after) { console.error(`refusing: ${rc.file} changed since the install`); process.exit(1); }
    const what = rc.backup ? `restore ${rc.file} from ${rc.backup}` : `remove ${rc.file} (it didn't exist before)`;
    if (!(await ask(`${what[0].toUpperCase()}${what.slice(1)}?`))) { console.log('nothing changed'); return; }
    if (rc.backup) fs.copyFileSync(C.untilde(rc.backup), C.untilde(rc.file)); else fs.unlinkSync(C.untilde(rc.file));
    console.log(`done: ${what}`);
    return;
  }
  const st = state();
  console.log(`\x1b[1;34m==>\x1b[0m AQE hook transport v2: ${C.tilde(DEST)} (ai-tooling.toml [aqe] hook_transport)`);
  console.log(`  source ${path.relative(P.REPO_ROOT, SRC)} sha256 ${sha(SRC).slice(0, 12)}; installed: ${st === 'missing' ? 'missing' : `${st} (sha256 ${sha(DEST).slice(0, 12)})`}`);
  if (st === 'installed') { console.log('  nothing to do'); return; }
  if (!args.includes('--apply')) { console.log('  plan only; run `steward ai transport --apply` to install (asks first)'); return; }
  if (!(await ask(`${st === 'missing' ? 'Install' : 'Replace'} ${C.tilde(DEST)}?`))) { console.log('nothing changed'); return; }
  const dir = C.newBackupDir('aqe-transport');
  let bak = null;
  if (st === 'differs') { bak = path.join(dir, path.basename(DEST)); fs.copyFileSync(DEST, bak, fs.constants.COPYFILE_EXCL); }
  fs.mkdirSync(path.dirname(DEST), { recursive: true, mode: 0o700 });
  const tmp = `${DEST}.install-${process.pid}`;
  fs.copyFileSync(SRC, tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, DEST);
  if (sha(DEST) !== sha(SRC)) throw new Error(`write check failed: ${DEST}`);
  const receipt = { kind: 'aqe-transport', at: new Date().toISOString(), engine: C.ENGINE_VERSION, file: C.tilde(DEST), source: path.relative(P.REPO_ROOT, SRC), sha_before: bak ? sha(bak) : null, sha_after: sha(DEST), backup: bak && C.tilde(bak) };
  const rp = path.join(dir, 'receipt.json');
  fs.writeFileSync(rp, JSON.stringify(receipt, null, 1) + '\n');
  console.log(`\x1b[1;34m==>\x1b[0m installed ${C.tilde(DEST)}; receipt ${C.tilde(rp)}`);
  console.log(`  rollback: steward ai transport --rollback ${C.tilde(rp)}`);
})().catch(e => { console.error(`ERROR ${e.message}`); process.exit(1); });
