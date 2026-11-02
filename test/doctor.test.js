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
// every run gets its own state folder unless a test names one, so --install's receipt never lands in the real one
const doctor = (args, env = {}, input = '') => spawnSync(process.execPath, [path.join(REPO, 'lib', 'doctor.js'), ...args], { encoding: 'utf8', input, env: { ...process.env, NO_PROGRESS: '1', NO_COLOR: '1', XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'steward-doctor-state-')), ...env } });

test('prereqs.json: unique names, known areas, needs and sources; installable ones say how', () => {
  const names = DATA.prereqs.map(p => p.name);
  assert.equal(new Set(names).size, names.length);
  // a value may be per platform or family (parity 0.6): each of its values is checked
  const vals = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v) : [v]);
  for (const p of DATA.prereqs) {
    assert.ok(p.area in DATA.areas, `${p.name}: area ${p.area}`);
    for (const n of vals(p.need)) assert.ok(['required', 'optional'].includes(n), `${p.name}: need`);
    for (const s of vals(p.source)) assert.ok(['system', 'mise', 'brew', 'manual'].includes(s), `${p.name}: source`);
    assert.ok(p.bin && p.why, `${p.name}: bin and why`);
    if (p.platforms) for (const x of p.platforms) assert.ok(['macos', 'linux'].includes(x), `${p.name}: platform ${x}`);
    if (vals(p.source).includes('mise')) assert.ok(p.mise, `${p.name}: mise name`);
    if (vals(p.source).includes('brew')) assert.ok(p.brew, `${p.name}: brew formula`);
    if (vals(p.source).some(s => s !== 'system')) assert.ok(p.install, `${p.name}: install hint`);
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
  // the Mac's plan; Linux's is its own test below. jq comes from mise everywhere (the owner, 2026-11-02)
  const r = doctor(['--install'], { PATH: p, STEWARD_DOCTOR_AS: 'macos' }, 'n\n');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /\$ mise install yq/);
  assert.match(r.stdout, /\$ mise install jq/);
  assert.doesNotMatch(r.stdout, /brew install jq/);
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
  // the stand-ins first, then the system's own tools (the libatomic check pipes ldconfig through grep)
  const j = JSON.parse(doctor(['--json'], { PATH: `${s.dir}:/usr/bin:/bin`, STEWARD_DOCTOR_AS: 'linux:debian' }).stdout);
  const names = j.map(x => x.name);
  for (const m of MAC_ONLY) assert.ok(!names.includes(m), `${m} is macOS only`);
  for (const n of ['Linux', 'libatomic', 'sha256sum']) assert.ok(names.includes(n), n);
  assert.equal(j.find(x => x.name === 'libatomic').ok, true, 'ldconfig -p lists it');
  assert.equal(j.find(x => x.name === 'libatomic').need, 'required');
  assert.equal(j.find(x => x.name === 'Homebrew').need, 'optional');
});

test('doctor --install on Linux: a missing libatomic is a by-hand sudo step with the family\'s command; jq comes from mise; sudo is never run', () => {
  for (const [family, atomic] of [['debian', 'sudo apt-get install libatomic1'], ['rhel', 'sudo dnf install libatomic'], ['suse', 'sudo zypper install libatomic1']]) {
    const s = standins('sh', 'git', 'sudo', 'mise', 'brew');
    const r = doctor(['--install'], { PATH: s.dir, STEWARD_DOCTOR_AS: `linux:${family}` }, 'y\n');
    assert.match(r.stdout, new RegExp(`MISSING +libatomic +required, from system: ${atomic}`), r.stdout);
    assert.ok(r.stdout.includes(`  by hand: libatomic: ${atomic}`), r.stdout);
    assert.match(r.stdout, /\$ mise install jq/, 'jq from mise, no sudo');
    assert.ok(!r.stdout.includes('by hand: jq'), r.stdout);
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

test('doctor on Linux: a check-only entry (Linux, libatomic) shows no path; the sh that runs its check is not where it lives', () => {
  const s = standins('sh', 'ldconfig');
  const r = doctor(['--area', 'core'], { PATH: `${s.dir}:/usr/bin:/bin`, STEWARD_DOCTOR_AS: 'linux:debian' });
  const line = r.stdout.split('\n').find(l => /^\s+ok\s+libatomic/.test(l));
  assert.ok(line, r.stdout);
  assert.ok(!line.includes('/sh'), line);
});

// --- a mise tool missing from the user's own toolchain (a config made before the tool joined examples/) ---------
// instanceWith(lines) — a throwaway instance whose mise/config.toml holds those tool lines
function instanceWith(lines) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-doctor-inst-')));
  fs.writeFileSync(path.join(d, 'steward.toml'), 'schema = 1\n');
  fs.mkdirSync(path.join(d, 'mise'));
  fs.writeFileSync(path.join(d, 'mise', 'config.toml'), `[tools]\n${lines.join('\n')}\n`);
  return d;
}

test('doctor: a missing mise tool that isn\'t in your mise/config.toml names the line to add; --install lists it by hand', () => {
  const inst = instanceWith(['node = "26"', 'yq = "latest"']);
  const s = standins('git', 'mise', 'brew');
  const env = { PATH: s.dir, STEWARD_INSTANCE: inst, STEWARD_DOCTOR_AS: 'macos' };
  const cfg = path.join(inst, 'mise', 'config.toml');
  const r = doctor(['--area', 'fleet'], env);
  assert.match(r.stdout, new RegExp(`MISSING +jq +required, from mise: add jq = "latest" to ${cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, then mise install jq`), r.stdout);
  const i = doctor(['--install', '--area', 'fleet'], env, 'y\n');
  assert.ok(i.stdout.includes(`  by hand: jq: add jq = "latest" to ${cfg}, then mise install jq`), i.stdout);
  assert.ok(!i.stdout.includes('$ mise install jq'), 'no mise install that would not stick');
  assert.ok(!/^mise install jq/m.test(s.calls()), s.calls());
});

test('doctor: a missing mise tool that is in your mise/config.toml installs as before', () => {
  const inst = instanceWith(['node = "26"', 'jq = "latest"']);
  const s = standins('git', 'mise', 'brew');
  const i = doctor(['--install', '--area', 'fleet'], { PATH: s.dir, STEWARD_INSTANCE: inst, STEWARD_DOCTOR_AS: 'macos' }, 'n\n');
  assert.match(i.stdout, /\$ mise install jq/);
  assert.ok(!i.stdout.includes('by hand: jq'));
});

test('doctor tests never write to the real state folder: --install\'s receipt lands in the test\'s own XDG_STATE_HOME', () => {
  const before = (() => { try { return fs.readdirSync(path.join(os.homedir(), '.local', 'state', 'workstation-steward', 'backups')).filter(n => n.startsWith('doctor-install-')).length; } catch { return 0; } })();
  const s = standins('git', 'mise', 'brew');
  doctor(['--install', '--area', 'core'], { PATH: s.dir, STEWARD_DOCTOR_AS: 'macos' }, 'y\n');
  const after = (() => { try { return fs.readdirSync(path.join(os.homedir(), '.local', 'state', 'workstation-steward', 'backups')).filter(n => n.startsWith('doctor-install-')).length; } catch { return 0; } })();
  assert.equal(after, before, 'a doctor-install receipt was written to the real state folder (40 leaked before this test existed)');
});
