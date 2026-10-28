#!/usr/bin/env node
// Release-age check for one mise npm: tool at a proposed version, including the packages it pulls in. mise's
// minimum_release_age gates the tool itself, but a transitive dependency can still be younger than the gate
// (2026-10-26: four of renovate 44.181.0's dependencies were 2 days old). Read-only for the real install.
// Usage: tool-age.js npm:<package> <version> [--config <file>] [-d DAYS]
//   e.g. tool-age.js npm:renovate 44.181.0
// What it does: installs <package>@<version> in a throwaway sandbox (every mise path, HOME and XDG_CACHE_HOME
// redirected; the real Node is linked in, not downloaded), using the tool's own entry and the [settings] from
// mise/config.toml so allow_builds, trust exclusions and the age gate match the real install. Then it compares the
// sandbox's aube-lock.yaml with the installed version's and lists each NEW package with its registry publish time
// (fleet/skill/scripts/lock-age.sh --files). Exit: 0 nothing under the cutoff, 1 something under it, 2 setup error.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const C = require('../../lib/config.js');
const { progress } = require('../../lib/progress.js');

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const configFile = opt('--config', C.instance('mise/config.toml'));
const days = opt('-d', null);
const [tool, version] = argv;
const die = m => { try { cleanup(); } catch { /* sandbox not made yet */ } console.error(`tool-age: ${m}`); process.exit(2); };
if (!/^npm:\S+$/.test(tool || '') || !/^\d+\.\d+\.\d+\S*$/.test(version || '')) die('usage: tool-age.js npm:<package> <version> [--config <file>] [-d DAYS]   (an exact version)');

// --- the tool's entry and the settings that shape an install, from the repo's mise config ---------------------
const text = fs.readFileSync(configFile, 'utf8');
const lines = text.split('\n');
const q = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const entry = lines.find(l => new RegExp(`^"${q}"\\s*=`).test(l)) || die(`${tool} is not in ${configFile}`);
const rhs = entry.replace(/^"[^"]+"\s*=\s*/, '');
let pinned, newRhs;
if (rhs.startsWith('{')) {
  const m = rhs.match(/version\s*=\s*"([^"]+)"/) || die(`${tool}'s entry has no version = "…"`);
  pinned = m[1]; newRhs = rhs.replace(/version\s*=\s*"[^"]+"/, `version = "${version}"`);
} else {
  const m = rhs.match(/^"([^"]+)"/) || die(`cannot read ${tool}'s entry: ${rhs}`);
  pinned = m[1]; newRhs = `"${version}"`;
}
if (pinned === version) die(`${tool} is already pinned at ${version}; nothing new to compare`);
if (!/^\d/.test(pinned)) die(`${tool} is pinned at "${pinned}", not an exact version: compare against the installed version by hand`);
const nodeVer = ((lines.find(l => /^node\s*=\s*"/.test(l)) || '').match(/"([^"]+)"/) || [])[1];
const settings = [];
for (let i = lines.findIndex(l => l.trim() === '[settings]') + 1; i > 0 && i < lines.length && !lines[i].startsWith('['); i++) {
  if (lines[i].trim()) settings.push(lines[i].replace(/^lockfile\s*=.*/, 'lockfile = false'));
}

const pg = progress(4);
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-tool-age-'));
const D = n => path.join(sb, n);
for (const d of ['data/installs', 'conf', 'cache', 'state', 'home', 'xdg']) fs.mkdirSync(D(d), { recursive: true });
const realWhere = spec => { try { return execFileSync('mise', ['where', spec], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const cleanup = () => fs.rmSync(sb, { recursive: true, force: true });
process.on('SIGINT', () => { cleanup(); process.exit(130); });
(async () => {
  try {
    // 1. sandbox
    let s = pg.stage('preparing the sandbox');
    const nodeDir = (nodeVer && realWhere(`node@${nodeVer}`)) || realWhere('node');
    if (!nodeDir) die('no installed Node to link into the sandbox');
    const nv = path.basename(nodeDir);
    fs.mkdirSync(D('data/installs/node'), { recursive: true });
    fs.symlinkSync(nodeDir, D(`data/installs/node/${nv}`));
    fs.writeFileSync(D('conf/config.toml'), `[settings]\n${settings.join('\n')}\n\n[tools]\nnode = "${nv}"\n"${tool}" = ${newRhs}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MISE_')));
    Object.assign(env, { HOME: D('home'), XDG_CACHE_HOME: D('xdg'), MISE_DATA_DIR: D('data'), MISE_CONFIG_DIR: D('conf'), MISE_GLOBAL_CONFIG_FILE: D('conf/config.toml'), MISE_CACHE_DIR: D('cache'), MISE_STATE_DIR: D('state'), MISE_YES: '1' });
    s.done(`${tool}@${version} (pinned now: ${pinned}), Node ${nv} linked`);

    // 2. install
    s = pg.stage(`installing ${tool}@${version} in the sandbox`);
    let log = '';
    const rc = await new Promise(res => {
      const p = spawn('mise', ['install', `${tool}@${version}`], { cwd: D('home'), env, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const st of [p.stdout, p.stderr]) st.on('data', d => { log += d; const l = String(d).trim().split('\n').pop(); if (l) s.detail(l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 80)); });
      p.on('close', res);
    });
    if (rc !== 0) { s.done('failed'); console.error(log.split('\n').slice(-12).join('\n')); die(`mise install exited ${rc} (an aube prompt, such as a low-downloads or build-script approval, shows as "user aborted": the tool's entry in ${configFile} needs the matching allow_… setting)`); }
    const newDir = (() => { try { return execFileSync('mise', ['where', `${tool}@${version}`], { encoding: 'utf8', env, cwd: D('home'), stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })();
    const newLock = path.join(newDir, 'aube-lock.yaml');
    if (!newDir || !fs.existsSync(newLock)) die(`the sandbox install has no aube-lock.yaml (${newDir || 'no install folder'})`);
    s.done('installed');

    // 3. the installed version's lockfile
    s = pg.stage('finding the installed version');
    const oldDir = realWhere(`${tool}@${pinned}`);
    const oldLock = oldDir && fs.existsSync(path.join(oldDir, 'aube-lock.yaml')) ? path.join(oldDir, 'aube-lock.yaml') : '/dev/null';
    s.done(oldLock === '/dev/null' ? `${pinned} is not installed here: every package counts as new` : `${pinned} at ${C.tilde(oldDir)}`);

    // 4. publish times of the new packages
    s = pg.stage('looking up publish times of new packages');
    const script = path.join(C.REPO_ROOT, 'fleet', 'skill', 'scripts', 'lock-age.sh');
    const out = [];
    let tail = '';
    const code = await new Promise(res => {
      const a = [...(days ? ['-d', days] : []), '--files', oldLock, newLock];
      const p = spawn(script, a, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i).split('\t')); buf = buf.slice(i + 1); s.detail(`${out.length} checked`); } });
      p.stderr.on('data', d => { tail += d; });
      p.on('close', res);
    });
    if (code === 2) { s.done('failed'); die(tail.trim()); }
    s.done(`${out.length} new package(s)`);

    // report: youngest first
    out.sort((x, y) => Number(x[3]) - Number(y[3]));
    console.log(`\n${tool} ${pinned} → ${version}: packages in the new lockfile that the installed one lacks`);
    console.log('package'.padEnd(46), 'published (UTC)'.padEnd(26), 'age (days)'.padEnd(11), 'result');
    for (const [, nv2, pub, age, flag] of out) console.log(nv2.padEnd(46), (pub || '-').padEnd(26), String(age).padEnd(11), flag === 'OK' ? 'ok' : flag === 'UNDER' ? 'UNDER THE GATE' : 'UNKNOWN (check by hand)');
    console.log(`\n${tail.trim()}`);
    if (code === 1) console.log(`Not eligible yet: wait until the youngest package clears the gate (its date plus the window), or record an advisory exception in the PR body.`);
    process.exitCode = code;
  } finally { cleanup(); }
})().catch(e => { cleanup(); die(e.message); });
