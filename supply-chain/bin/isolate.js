#!/usr/bin/env node
// steward sc isolate (D66): switch a tool off without removing it, while it carries a vulnerability with no fix (or one
// being exploited), and switch it back on with --undo. Writes only after a plan and a yes; a backup, a receipt, and the
// list of what is isolated (<state>/isolated.json), which steward brief shows.
//   - a mise tool: added to [settings] disable_tools in the config folder's mise/config.toml, mise's own switch: it
//     ignores the tool though a config lists it, so it survives a reshim and `mise install` (a config-repo change,
//     sent with steward config sync like any other);
//   - an npm -g hybrid: its command links in the active Node's bin folder move to <state>/isolated/<name>/bin.
// Refused: Node and anything in [vulns] isolate_never, and a tool AI tooling owns unless [vulns] isolate_ai_owned
// (the ai-tooling skill decides those: its projects' launchers would break).
// Usage: isolate.js <tool> [--why "<reason>"] [--apply]   the plan; --apply asks (class isolate)
//        isolate.js --undo <tool> [--apply]                 switch it back on
//        isolate.js --list                                  what is isolated, since when and why
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const C = require('../../lib/config.js');
const V = require('../../lib/vulns.js');
const W = require('../../lib/write.js');

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// disabled(text) — the disable_tools list in a mise config's text (yq), [] when unset
function disabled(file) {
  const r = spawnSync('yq', ['-p', 'toml', '-o', 'json', '.settings.disable_tools // []', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${C.tilde(file)} doesn't parse`);
  return JSON.parse(r.stdout || '[]') || [];
}

// hybridLinks(nodeDir, name) — [{from, target}]: the command links in nodeDir/bin that lead into the hybrid's folder
function hybridLinks(nodeDir, name) {
  const bin = path.join(nodeDir, 'bin'), pkg = path.join(nodeDir, 'lib', 'node_modules', name);
  let entries = [];
  try { entries = fs.readdirSync(bin); } catch { return []; }
  return entries.map(n => path.join(bin, n)).filter(f => {
    try { return fs.lstatSync(f).isSymbolicLink() && path.resolve(bin, fs.readlinkSync(f)).startsWith(`${pkg}${path.sep}`); } catch { return false; }
  }).map(f => ({ from: f, target: fs.readlinkSync(f) }));
}

// resolve(tool, ls, nodeDir) — {kind: 'mise' | 'hybrid', tool, name}: a mise tool by its key, or an npm -g hybrid by
// its name (or 'npm -g <name>'); null when it's neither
function resolve(tool, ls, nodeDir) {
  if (ls[tool]) return { kind: 'mise', tool, name: tool };
  const name = tool.replace(/^npm -g /, '');
  if (nodeDir && fs.existsSync(path.join(nodeDir, 'lib', 'node_modules', name, 'package.json'))) return { kind: 'hybrid', tool: `npm -g ${name}`, name };
  return null;
}

// planIsolate(o) — {ok, why?, target, change}: o = {tool, ls, nodeDir, s (settings), owned, config (mise config file),
// state (isolated.json data), reason, advisories}
function planIsolate(o) {
  const t = resolve(o.tool, o.ls, o.nodeDir);
  if (!t) return { ok: false, why: `${o.tool} is neither a mise tool nor an npm -g hybrid in the active Node` };
  const no = V.isolatable(t.tool, o.s, o.owned);
  if (no) return { ok: false, why: no };
  if (o.state.tools[t.tool]) return { ok: false, why: `${t.tool} is already isolated (since ${o.state.tools[t.tool].at}); steward sc isolate --undo ${t.tool} switches it back on` };
  if (!o.reason && !o.advisories.length) return { ok: false, why: `${t.tool} has no serious finding in steward sc vulns; give the reason with --why "<reason>"` };
  if (t.kind === 'mise') {
    const have = disabled(o.config);
    return { ok: true, target: t, change: { file: o.config, disable_tools: [...have, t.tool] } };
  }
  const links = hybridLinks(o.nodeDir, t.name);
  if (!links.length) return { ok: false, why: `${t.tool} has no command links in ${C.tilde(path.join(o.nodeDir, 'bin'))} to move` };
  return { ok: true, target: t, change: { links } };
}

// setDisabled(file, list) — mise/config.toml with [settings] disable_tools = list, one line changed; checked by parsing
function setDisabled(file, list) {
  const before = read(file) || '';
  fs.writeFileSync(file, W.tomlSet(before, 'settings', 'disable_tools', list));
  try {
    const got = disabled(file);
    if (JSON.stringify(got) !== JSON.stringify(list)) throw new Error('disable_tools did not read back as written');
  } catch (e) { fs.writeFileSync(file, before); throw e; }
}

// isolate(p, o) — do it: o = {dir (backup folder), stateDir, stateFile, state, reason, advisories, exec}; returns the receipt
function isolate(p, o) {
  const rp = path.join(o.dir, 'receipt.json');
  const t = p.target;
  const r = { kind: 'isolate', action: 'isolate', name: t.tool, at: new Date().toISOString(), engine: C.ENGINE_VERSION, outcome: 'started', reason: o.reason || '', advisories: o.advisories,
    rollback: `steward sc isolate --undo ${t.tool} --apply` };
  const save = () => fs.writeFileSync(rp, `${JSON.stringify(r, null, 1)}\n`);
  save();
  if (t.kind === 'mise') {
    fs.copyFileSync(p.change.file, path.join(o.dir, 'config.toml'));
    setDisabled(p.change.file, p.change.disable_tools);
    o.exec('mise', ['reshim'], {});
    r.config = p.change.file;
  } else {
    const to = path.join(o.stateDir, 'isolated', t.name, 'bin');
    fs.mkdirSync(to, { recursive: true });
    r.moved = [];
    for (const l of p.change.links) {
      const dest = path.join(to, path.basename(l.from));
      fs.renameSync(l.from, dest);
      r.moved.push({ from: l.from, to: dest });
      save();
    }
  }
  o.state.tools[t.tool] = { kind: t.kind, at: r.at, reason: r.reason, advisories: o.advisories, receipt: rp, ...(r.moved ? { moved: r.moved } : {}), ...(r.config ? { config: r.config } : {}) };
  fs.mkdirSync(path.dirname(o.stateFile), { recursive: true });
  fs.writeFileSync(o.stateFile, `${JSON.stringify(o.state, null, 1)}\n`);
  r.outcome = 'done';
  save();
  return r;
}

// undo(tool, o) — switch an isolated tool back on: o = {dir, stateFile, state, exec}; returns the receipt, or throws why not
function undo(tool, o) {
  const key = o.state.tools[tool] ? tool : o.state.tools[`npm -g ${tool}`] ? `npm -g ${tool}` : null;
  if (!key) throw new Error(`${tool} isn't isolated (steward sc isolate --list)`);
  const e = o.state.tools[key];
  const rp = path.join(o.dir, 'receipt.json');
  const r = { kind: 'isolate', action: 'undo', name: key, at: new Date().toISOString(), engine: C.ENGINE_VERSION, outcome: 'started', was: e };
  const save = () => fs.writeFileSync(rp, `${JSON.stringify(r, null, 1)}\n`);
  save();
  if (e.kind === 'mise') {
    fs.copyFileSync(e.config, path.join(o.dir, 'config.toml'));
    setDisabled(e.config, disabled(e.config).filter(x => x !== key));
    o.exec('mise', ['reshim'], {});
  } else {
    for (const m of e.moved || []) if (fs.existsSync(m.from)) throw new Error(`${C.tilde(m.from)} exists again; move it aside first`);
    for (const m of e.moved || []) fs.renameSync(m.to, m.from);
  }
  delete o.state.tools[key];
  fs.writeFileSync(o.stateFile, `${JSON.stringify(o.state, null, 1)}\n`);
  r.outcome = 'done';
  r.rollback = `steward sc isolate ${key} --why ${JSON.stringify(e.reason || 'again')} --apply`;
  save();
  return r;
}

async function ask(q, cls) {
  if (process.env.DRY_RUN === '1') return false;
  if (require('../../lib/autonomy.js').answer(cls, q)) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise(res => rl.question(`${q} [y/N] `, res));
  rl.close();
  return /^y$/i.test(a.trim());
}

module.exports = { resolve, hybridLinks, planIsolate, isolate, undo, disabled };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const { values } = C.load();
    const stateDir = values.paths.state, stateFile = path.join(stateDir, 'isolated.json');
    const state = readJSON(stateFile) || { tools: {} };
    const execInherit = (cmd, args, env) => spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;
    if (argv[0] === '--list' || !argv.length) {
      const list = Object.entries(state.tools);
      if (!list.length) { console.log('nothing is isolated'); return; }
      for (const [k, e] of list) console.log(`  ${k}  since ${e.at.slice(0, 10)}  ${(e.advisories || []).map(a => a.id).join(', ') || e.reason}  (undo: steward sc isolate --undo ${k} --apply)`);
      return;
    }
    if (argv[0] === '--undo') {
      const tool = argv[1];
      if (!tool) { console.error('usage: isolate.js --undo <tool> [--apply]'); process.exit(2); }
      const e = state.tools[tool] || state.tools[`npm -g ${tool}`];
      if (!e) { console.error(`ERROR ${tool} isn't isolated (steward sc isolate --list)`); process.exit(1); }
      console.log(`==> switch ${tool} back on: ${e.kind === 'mise' ? `remove it from disable_tools in ${C.tilde(e.config)}, then mise reshim` : `move ${(e.moved || []).length} command link(s) back into the active Node's bin`}`);
      if (!argv.includes('--apply')) { console.log('\nplan only. Add --apply to do it (asks first).'); return; }
      if (!(await ask(`Switch ${tool} back on?`, 'isolate'))) { console.log('nothing changed'); process.exitCode = 1; return; }
      const dir = C.newBackupDir('isolate');
      undo(tool, { dir, stateFile, state, exec: execInherit });
      console.log(`==> ${tool} is back on. receipt ${C.tilde(path.join(dir, 'receipt.json'))}`);
      return;
    }
    const tool = argv[0];
    const wi = argv.indexOf('--why');
    const reason = wi > 0 ? argv[wi + 1] || '' : '';
    const s = (require('../../lib/host.js').load().policy.vulns) || V.SETTINGS;
    const owned = values.profiles.ai_tooling ? V.aiOwned(C.policy('ai-tooling/ai-tooling.toml')) : [];
    const ls = JSON.parse(spawnSync('mise', ['ls', '--json'], { encoding: 'utf8' }).stdout || '{}');
    const node = (ls.node || []).find(i => i.active);
    // the serious findings that are the reason (unless --why gives one): steward sc vulns for this tool
    let advisories = [];
    if (!reason) {
      const { context } = require('./audit.js');
      const ctx = context();
      const inv = await V.inventory(ctx, s);
      inv.packages = inv.packages.filter(p => p.tool === tool || p.tool === `npm -g ${tool}`);
      const { findings } = await V.lookup(ctx, ctx.policy.advisory_feed || [], inv, () => {}, s);
      advisories = findings.filter(f => V.serious(f, s) && !V.ignored(f, ctx.policy.advisory_ignore, ctx.today)).map(f => ({ id: f.id, url: f.url, severity: f.severity, kev: f.kev, package: `${f.pkg.name}@${f.pkg.version}` }));
    }
    const p = planIsolate({ tool, ls, nodeDir: node && node.install_path, s, owned, config: C.instance('mise/config.toml'), state, reason, advisories });
    if (!p.ok) { console.error(`ERROR not isolated: ${p.why}`); process.exit(1); }
    console.log(`==> isolate ${p.target.tool}: ${reason || advisories.map(a => `${a.id} (${a.severity}${a.kev ? ', exploited' : ''})`).join(', ')}`);
    if (p.target.kind === 'mise') {
      console.log(`  set [settings] disable_tools = ${JSON.stringify(p.change.disable_tools)} in ${C.tilde(p.change.file)}`);
      console.log('  then mise reshim; send the change with steward config sync');
    }
    else for (const l of p.change.links) console.log(`  move ${C.tilde(l.from)} to ${C.tilde(path.join(stateDir, 'isolated', p.target.name, 'bin'))}`);
    console.log(`  it stays installed; steward sc isolate --undo ${p.target.tool} --apply switches it back on`);
    if (!argv.includes('--apply')) { console.log('\nplan only. Add --apply to do it (asks first).'); return; }
    if (!(await ask(`Isolate ${p.target.tool}?`, 'isolate'))) { console.log('nothing changed'); process.exitCode = 1; return; }
    const r = isolate(p, { dir: C.newBackupDir('isolate'), stateDir, stateFile, state, reason, advisories, exec: execInherit });
    console.log(`==> ${p.target.tool} is isolated. way back: ${r.rollback}`);
  })().catch(e => { console.error(`ERROR ${e.message}`); process.exitCode = 1; });
}
