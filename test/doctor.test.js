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
