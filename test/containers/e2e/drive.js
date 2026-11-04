#!/usr/bin/env node
// The end-to-end run's user phase (parity 1c, `just linux-test <id> --e2e`): run as the steward user inside a container whose
// root phase (apt.sh) installed sudo, allowed `apt-get` only, and seeded older packages. Against the real repositories:
//   1. `sc plan`: every apt line's age and source checked against snapshot.debian.org or Launchpad, asked here directly;
//      a version neither knows must be "first seen here"; takes are past the gate, holds aren't (security pockets: at once)
//   2. `sc upgrade` at a terminal (a pty, `script -qec`): the taken versions are installed, the receipt says done
//   3. `sc rollback <receipt>`: the versions from before are back
//   4. `sc upgrade` with no terminal: handed over (exit 4, the receipt waiting on you); the handed-over line run as the
//      user would; `sc upgrade --resume` finishes it (done)
//   5. `sc audit`'s OS updates (parity 1e): the restart apt.sh left is an action; the end of free support matches the
//      date matrix.json records by hand from the vendor's page, and the newer-release line what the live source says
// Each answer is typed only once its prompt's text has been seen: node's readline swallows answers sent early (1b).
// It prints node --test's summary lines (ℹ tests/pass/fail), which tools/linux-test.js reads. Engine tooling.
// Usage: drive.js apt <distro>     (in /work/src, a copy of the checkout)
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// responder(steps, always) — fn(chunk) → the answers to type now; steps in order, each once; always: whenever seen.
// Each step and rule is {expect: string or RegExp, send}. fn.pending() is how many steps never saw their prompt.
function responder(steps, always = []) {
  let buf = '', i = 0;
  const seen = (e, s) => (e instanceof RegExp ? e.test(s) : s.includes(e));
  const fn = chunk => {
    buf += chunk;
    const out = [];
    for (;;) {
      const next = i < steps.length && seen(steps[i].expect, buf) ? steps[i++] : always.find(a => seen(a.expect, buf));
      if (!next) break;
      out.push(`${next.send}\n`);
      buf = '';
    }
    return out;
  };
  fn.pending = () => steps.length - i;
  return fn;
}

const strip = s => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

// pty(cmd, steps, always) — cmd on a terminal of its own (script), answered by the responder: {code, out, pending}
function pty(cmd, steps = [], always = []) {
  return new Promise(resolve => {
    const p = spawn('script', ['-qec', cmd, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const r = responder(steps, always);
    let out = '';
    const take = d => { const s = d.toString(); out += s; process.stdout.write(s); for (const a of r(strip(s))) p.stdin.write(a); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const timer = setTimeout(() => p.kill('SIGKILL'), 15 * 60 * 1000);
    p.on('close', code => { clearTimeout(timer); resolve({ code: code === null ? 1 : code, out: strip(out), pending: r.pending() }); });
  });
}

// sh(cmd, input) — cmd with no terminal (a pipe on stdin): {code, out}
function sh(cmd, input = '') {
  const r = spawnSync('bash', ['-c', cmd], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(r.stdout || ''); process.stdout.write(r.stderr || '');
  return { code: r.status === null ? 1 : r.status, out: strip(`${r.stdout || ''}${r.stderr || ''}`) };
}

// planLines(out) — the apt section's take and hold lines: {act, name, have, want, days, from, pocket}
function planLines(out) {
  const rows = [];
  for (const l of strip(out).split('\n')) {
    const m = l.trim().match(/^(take|hold)\s+(\S+) (\S+) -> (\S+) \((?:(\d+)d old, ([^)]+)|security pocket: ([^)]+))\)$/);
    if (m) rows.push({ act: m[1], name: m[2], have: m[3], want: m[4], days: m[5] === undefined ? null : Number(m[5]), from: m[6] || null, pocket: m[7] || null });
  }
  return rows;
}

const enc = encodeURIComponent;
const getJSON = async url => { try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; } };
// published(distro, name, want, release) — the service's own date for that version (ISO), or null when it has none
async function published(distro, name, want, release) {
  if (distro === 'debian' || distro === 'lmde') {
    const j = await getJSON(`https://snapshot.debian.org/mr/binary/${enc(name)}/${enc(want)}/binfiles?fileinfo=1`);
    const seen = Object.values((j && j.fileinfo) || {}).flat().filter(f => /^debian(-security)?$/.test(f.archive_name)).map(f => f.first_seen).sort();
    return seen.length ? seen[0].replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z') : null;
  }
  const arch = spawnSync('dpkg', ['--print-architecture'], { encoding: 'utf8' }).stdout.trim();
  const j = await getJSON(`https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedBinaries&binary_name=${enc(name)}&exact_match=true&version=${enc(want)}&distro_arch_series=${enc(`https://api.launchpad.net/1.0/ubuntu/${release}/${arch}`)}&ws.size=50`);
  const d = ((j && j.entries) || []).filter(e => ['Release', 'Updates', 'Security'].includes(e.pocket) && e.status !== 'Deleted' && e.date_published).map(e => new Date(e.date_published).toISOString()).sort();
  return d.length ? d[0] : null;
}

const installed = name => spawnSync('dpkg-query', ['-W', '-f', '${Version}', name], { encoding: 'utf8' }).stdout.trim();
function receipts() {
  const out = [];
  const walk = d => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'receipt.json') out.push(p); } };
  walk(path.join(process.env.HOME, '.local', 'state'));
  return out.map(p => { try { return { p, r: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch { return null; } }).filter(x => x && x.r.kind === 'root-upgrade').sort((a, b) => a.p.localeCompare(b.p));
}

async function apt(distro) {
  const results = [];
  const check = (ok, what) => { results.push(ok); console.log(`\ne2e ${ok ? 'PASS' : 'FAIL'}: ${what}`); return ok; };
  const steward = 'node bin/steward.js';
  const gate = 3;
  const rel = fs.readFileSync('/etc/os-release', 'utf8');
  const release = ((rel.match(/^UBUNTU_CODENAME=(\S+)/m) || rel.match(/^VERSION_CODENAME=(\S+)/m) || [])[1] || '').replace(/"/g, '');
  const seeded = fs.readFileSync('/work/seeded.txt', 'utf8').split('\n').filter(Boolean).map(l => { const [name, have, from] = l.split('\t'); return { name, have, from }; });
  console.log(`e2e: ${distro} (${release}); seeded: ${seeded.map(s => `${s.name} ${s.have}${s.from ? ` (${s.from})` : ''}`).join(', ')}`);

  // 1. the plan, every apt line checked against the services themselves
  const plan = sh(`DRY_RUN=1 ${steward} sc plan --plain`);
  const lines = planLines(plan.out);
  check(plan.code === 0 && lines.length > 0, `sc plan ran and listed ${lines.length} apt line(s)`);
  const now = Date.now();
  for (const l of lines) {
    if (l.pocket) { check(l.act === 'take' && /-security$/.test(l.pocket.split(',').pop()), `${l.name} ${l.want}: taken at once from the security pocket ${l.pocket}`); continue; }
    const date = await published(distro, l.name, l.want, release);
    const want = date ? (distro === 'debian' || distro === 'lmde' ? 'snapshot' : 'Launchpad') : 'first seen here';
    const days = date ? Math.floor((now - Date.parse(date)) / 86400000) : 0;
    check(l.from === want && Math.abs(l.days - days) <= 1, `${l.name} ${l.want}: ${l.days}d old, ${l.from} (the service says ${date || 'nothing: first seen here'}, ${days}d)`);
    check(l.act === (l.days >= gate ? 'take' : 'hold'), `${l.name} ${l.want}: ${l.act} at ${l.days}d against the ${gate}-day gate`);
  }
  const takes = lines.filter(l => l.act === 'take' && seeded.some(s => s.name === l.name));
  if (!check(takes.length > 0, `a seeded package is taken (${takes.map(t => t.name).join(', ') || 'none'})`)) return results;
  if (distro === 'mint' || distro === 'lmde') {
    const mint = lines.filter(l => l.from === 'first seen here');
    if (seeded.some(s => s.from === 'mint')) check(mint.length > 0 && mint.every(l => l.act === 'hold'), `Mint's own repo: ${mint.map(l => l.name).join(', ') || 'nothing'} first seen here, held`);
    else console.log('\ne2e note: no package in Mint\'s own repo had an older version to seed, so its first-seen hold was not seen here');
  }

  // 2. the upgrade at a terminal
  const up = await pty(`${steward} sc upgrade`, [{ expect: 'Apply this plan? [y/N]', send: 'y' }], [{ expect: /Do you want to continue\? \[Y\/n\]/, send: 'y' }]);
  const after = takes.map(t => ({ ...t, now: installed(t.name) }));
  check(up.code === 0 && up.pending === 0, `sc upgrade at a terminal exited ${up.code}`);
  check(after.every(t => t.now === t.want), `installed: ${after.map(t => `${t.name} ${t.now}`).join(', ')}`);
  const r1 = receipts().pop();
  check(Boolean(r1 && r1.r.outcome === 'done'), `the receipt says done (${r1 ? `${r1.r.outcome}, ${r1.p}` : 'none'})`);

  // 3. the way back
  if (r1) {
    const back = await pty(`${steward} sc rollback ${r1.p}`, [], [{ expect: /\[y\/N\] $/, send: 'y' }, { expect: /Do you want to continue\? \[Y\/n\]/, send: 'y' }]);
    const was = takes.map(t => ({ ...t, now: installed(t.name) }));
    check(back.code === 0, `sc rollback exited ${back.code}`);
    check(was.every(t => t.now === t.have), `rolled back: ${was.map(t => `${t.name} ${t.now} (was ${t.have})`).join(', ')}`);
  }

  // 4. no terminal: handed over, then finished by --resume
  const hand = sh(`${steward} sc upgrade`, 'y\n');
  check(hand.code === 4, `sc upgrade with no terminal exited ${hand.code} (4: waiting on you)`);
  const r2 = receipts().pop();
  check(Boolean(r2 && r2.r.outcome === 'waiting-on-you'), `the receipt waits on you (${r2 ? r2.r.outcome : 'none'})`);
  const line = ((hand.out.match(/(sudo apt-get update && sudo apt-get install[^\n]*)/) || [])[1] || '').trim();
  if (check(Boolean(line), `the handed-over line: ${line || 'not found'}`)) {
    const ran = await pty(line, [], [{ expect: /Do you want to continue\? \[Y\/n\]/, send: 'y' }]);
    check(ran.code === 0, `the handed-over line, run as you would, exited ${ran.code}`);
    const res = sh(`${steward} sc upgrade --resume`);
    const r3 = receipts().pop();
    check(res.code === 0 && Boolean(r3 && r3.r.outcome === 'done'), `sc upgrade --resume exited ${res.code}; the receipt says ${r3 ? r3.r.outcome : 'none'}`);
  }
  // 5. the OS updates section, against the live sources (parity 1e)
  const OS = require(path.join(process.cwd(), 'lib', 'osupdates.js'));
  const audit = sh(`${steward} sc audit --plain`);
  check(/os: restart needed: \/run\/reboot-required \(steward-e2e-restart\)/.test(audit.out), 'sc audit: the pending restart is an action');
  const w = OS.which('/');
  const row = JSON.parse(fs.readFileSync(path.join('test', 'containers', 'matrix.json'), 'utf8')).rows.find(r => r.id === `${w.distro}-${w.version}`);
  const until = row && row.supported_until ? row.supported_until.date : undefined;
  const ends = (audit.out.match(/free security support until (\d{4}-\d\d-\d\d)/) || [])[1] || null;
  check(Boolean(row) && ends === until, `sc audit: free support until ${ends || 'no date'}; matrix.json (${row ? row.id : 'no row'}) records ${until === null ? 'no date' : until}`);
  if (until === null) check(audit.out.includes('free security support: no end date published'), 'sc audit: no end date published, and says so');
  const today = new Date().toISOString().slice(0, 10);
  const src = await fetch(w.distro === 'mint' || w.distro === 'lmde' ? OS.SOURCES.mint : OS.SOURCES[w.distro]).then(r => r.text()).catch(() => '');
  const live = w.distro === 'mint' || w.distro === 'lmde' ? OS.fromMintPage(src, w.distro, w.version, today) : OS.fromCsv(src, w.distro, w.codename, today);
  const newer = (audit.out.match(/newer release: (.+?) is out/) || [])[1] || null;
  check(Boolean(live) && newer === (live.newer ? live.newer.name : null), `sc audit: newer release ${newer || 'none'}; the live source says ${live ? (live.newer ? live.newer.name : 'none') : 'nothing readable'}`);
  return results;
}

module.exports = { responder, planLines };

if (require.main === module) {
  const [kind, distro] = process.argv.slice(2);
  (kind === 'apt' ? apt(distro) : Promise.reject(new Error(`no e2e for ${kind}`))).then(results => {
    const pass = results.filter(Boolean).length;
    console.log(`\nℹ tests ${results.length}\nℹ pass ${pass}\nℹ fail ${results.length - pass}`);
    process.exitCode = results.length && pass === results.length ? 0 : 1;
  }).catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
