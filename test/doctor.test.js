// lib/doctor.js and lib/prereqs.json: the list is well formed, matches mise/config.toml and docs/prereqs.md, and the
// doctor reports missing tools and aborts an install on "n" without running anything. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DATA = JSON.parse(fs.readFileSync(path.join(REPO, 'lib', 'prereqs.json'), 'utf8'));
const doctor = (args, env = {}, input = '') => spawnSync(process.execPath, [path.join(REPO, 'lib', 'doctor.js'), ...args], { encoding: 'utf8', input, env: { ...process.env, NO_PROGRESS: '1', NO_COLOR: '1', ...env } });

test('prereqs.json: unique names, known areas, needs and sources; installable ones say how', () => {
  const names = DATA.prereqs.map(p => p.name);
  assert.equal(new Set(names).size, names.length);
  for (const p of DATA.prereqs) {
    assert.ok(p.area in DATA.areas, `${p.name}: area ${p.area}`);
    assert.ok(['required', 'optional'].includes(p.need), `${p.name}: need`);
    assert.ok(['system', 'mise', 'brew', 'manual'].includes(p.source), `${p.name}: source`);
    assert.ok(p.bin && p.why, `${p.name}: bin and why`);
    if (p.source === 'mise') assert.ok(p.mise, `${p.name}: mise name`);
    if (p.source === 'brew') assert.ok(p.brew, `${p.name}: brew formula`);
    if (p.source !== 'system') assert.ok(p.install, `${p.name}: install hint`);
  }
});

test('prereqs.json: every required mise tool is pinned in the instance mise/config.toml', () => {
  // The instance's toolchain (D39); optional tools (renovate, lychee …) are the user's choice
  const cfg = fs.readFileSync(require('../lib/config.js').instance('mise/config.toml'), 'utf8');
  for (const p of DATA.prereqs.filter(x => x.source === 'mise' && x.need === 'required')) {
    const q = p.mise.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(cfg, new RegExp(`^"?${q}"?\\s*=`, 'm'), `${p.name}: ${p.mise} is not in mise/config.toml`);
  }
});

test('docs/prereqs.md carries exactly the table the doctor prints', () => {
  const table = execFileSync(process.execPath, [path.join(REPO, 'lib', 'doctor.js'), '--markdown'], { encoding: 'utf8' }).trimEnd();
  const md = fs.readFileSync(path.join(REPO, 'docs', 'prereqs.md'), 'utf8');
  const m = md.match(/<!-- prereqs:start -->\n([\s\S]*?)\n<!-- prereqs:end -->/);
  assert.ok(m, 'markers missing');
  assert.equal(m[1], table, 'run: node lib/doctor.js --markdown, and paste it between the markers');
});

// A PATH holding only the named fake commands, so everything else is missing.
function fakePath(...cmds) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-doctor-')));
  for (const c of cmds) fs.writeFileSync(path.join(d, c), '#!/bin/sh\necho "fake 1.2.3"\n', { mode: 0o755 });
  return d;
}

test('doctor: reports missing required tools and exits 1; --json says which', () => {
  const p = fakePath('git');
  const r = doctor([], { PATH: p });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /MISSING +node/);
  assert.match(r.stdout, /ok +git +1\.2\.3/);
  const j = JSON.parse(doctor(['--json'], { PATH: p }).stdout);
  assert.equal(j.find(x => x.name === 'git').ok, true);
  assert.equal(j.find(x => x.name === 'node').ok, false);
});

test('doctor: --area limits the check; an unknown area is a usage error', () => {
  const p = fakePath();
  const r = doctor(['--area', 'dev'], { PATH: p });
  assert.doesNotMatch(r.stdout, /supply-chain/);
  assert.equal(r.status, 0); // dev holds only optional tools
  assert.equal(doctor(['--area', 'nope']).status, 2);
});

test('doctor --install: the plan names the mise and brew commands and what is by hand; "n" aborts and runs nothing', () => {
  const marker = path.join(fakePath(), 'ran');
  const p = fakePath(); // nothing present
  for (const c of ['mise', 'brew']) fs.writeFileSync(path.join(p, c), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  const r = doctor(['--install'], { PATH: p }, 'n\n');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /\$ mise install yq/);
  assert.match(r.stdout, /\$ brew install jq/);
  assert.match(r.stdout, /by hand: git: xcode-select --install/);
  assert.equal(fs.existsSync(marker), false, 'nothing may run on "n"');
});

test('doctor --install: "y" installs, rechecks and writes a receipt that starts no soak', () => {
  const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-doctor-state-')));
  const p = fakePath();
  // a fake mise that "installs" by creating the tool (without an npm: prefix, as the real bin) in the same PATH folder
  fs.writeFileSync(path.join(p, 'mise'), `#!/bin/sh\nprintf '#!/bin/sh\\necho "fake 9.9.9"\\n' > "${p}/\${2#npm:}"; /bin/chmod +x "${p}/\${2#npm:}"\n`, { mode: 0o755 });
  const r = doctor(['--install', '--area', 'dev'], { PATH: p, XDG_STATE_HOME: state }, 'y\n');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const bk = path.join(state, 'workstation-steward', 'backups');
  const dir = fs.readdirSync(bk).find(d => d.startsWith('doctor-install'));
  assert.ok(dir, 'receipt folder');
  const rc = JSON.parse(fs.readFileSync(path.join(bk, dir, 'receipt.json'), 'utf8'));
  assert.equal(rc.kind, 'doctor-install');
  assert.ok(rc.installed.length >= 1 && rc.installed.every(x => x.ok));
});

// --- per platform (parity 0.6, D69) ---------------------------------------------------------------------------------
// as(platform) — the doctor run as that platform and family (STEWARD_DOCTOR_AS, for tests), in a PATH of stand-ins:
// each records its call in calls.log, and ldconfig lists libatomic when asked to
function standins(...cmds) {
  const d = fakePath(...cmds);
  for (const c of cmds) fs.writeFileSync(path.join(d, c), `#!/bin/sh\necho "${c} $*" >> "${d}/calls.log"\necho "fake 1.2.3"\n`, { mode: 0o755 });
  if (cmds.includes('ldconfig')) fs.writeFileSync(path.join(d, 'ldconfig'), '#!/bin/sh\necho "\tlibatomic.so.1 (libc6,AArch64) => /usr/lib/aarch64-linux-gnu/libatomic.so.1"\n', { mode: 0o755 });
  return { dir: d, calls: () => { try { return fs.readFileSync(path.join(d, 'calls.log'), 'utf8'); } catch { return ''; } } };
}
const MAC_ONLY = ['macOS', 'shasum', 'security', 'softwareupdate', 'mas'];

test('doctor on macOS lists exactly the entries it listed before (the Mac is unchanged)', () => {
  const j = JSON.parse(doctor(['--json'], { STEWARD_DOCTOR_AS: 'macos' }).stdout);
  assert.deepEqual(j.map(x => x.name), ['macOS', 'bash', 'git', 'curl', 'mise', 'node', 'just', 'yq', 'Homebrew', 'npm', 'shasum', 'security', 'softwareupdate', 'mas', 'Docker',
    'gh', 'gh login', 'jq', 'shellcheck', 'markdownlint-cli2', 'lychee', 'renovate']);
  assert.equal(j.find(x => x.name === 'Homebrew').need, 'required');
});

test('doctor on Linux: no macOS-only entries; the OS, libatomic and sha256sum instead; Homebrew optional', () => {
  const s = standins('sh', 'git', 'ldconfig', 'sha256sum');
  const j = JSON.parse(doctor(['--json'], { PATH: s.dir, STEWARD_DOCTOR_AS: 'linux:debian' }).stdout);
  const names = j.map(x => x.name);
  for (const m of MAC_ONLY) assert.ok(!names.includes(m), `${m} is macOS only`);
  for (const n of ['Linux', 'libatomic', 'sha256sum']) assert.ok(names.includes(n), n);
  assert.equal(j.find(x => x.name === 'libatomic').ok, true, 'ldconfig -p lists it');
  assert.equal(j.find(x => x.name === 'libatomic').need, 'required');
  assert.equal(j.find(x => x.name === 'Homebrew').need, 'optional');
});

test('doctor --install on Linux: a missing libatomic or jq is a by-hand sudo step with the family\'s command; sudo is never run', () => {
  for (const [family, atomic, jq] of [['debian', 'sudo apt-get install libatomic1', 'sudo apt-get install jq'], ['rhel', 'sudo dnf install libatomic', 'sudo dnf install jq'], ['suse', 'sudo zypper install libatomic1', 'sudo zypper install jq']]) {
    const s = standins('sh', 'git', 'sudo', 'mise', 'brew');
    const r = doctor(['--install'], { PATH: s.dir, STEWARD_DOCTOR_AS: `linux:${family}` }, 'y\n');
    assert.match(r.stdout, new RegExp(`MISSING +libatomic +required, from system: ${atomic}`), r.stdout);
    assert.ok(r.stdout.includes(`  by hand: libatomic: ${atomic}`), r.stdout);
    assert.ok(r.stdout.includes(`  by hand: jq: ${jq}`), r.stdout);
    assert.ok(!/^sudo /m.test(s.calls()), `sudo ran: ${s.calls()}`);
  }
});

test('doctor --markdown: one table for every platform, with a Platforms column', () => {
  const t = doctor(['--markdown']).stdout.split('\n');
  assert.equal(t[0], '| Area | Tool | Platforms | Need | From | Used for | To install |');
  assert.ok(t.some(l => l.startsWith('| core | libatomic | linux | required |')), t.join('\n'));
  assert.ok(t.some(l => l.startsWith('| supply-chain | security | macos | required |')));
  assert.ok(t.some(l => l.startsWith('| core | git | all | required |')));
});
