// Offboarding (D31): take the AI tools' wiring and files out of a project whose registry entry has no AI tools.
// plan(dir) says what would change; apply(plan) does it with a backup folder and a receipt; undo(receipt) reverses it.
// - Launchers and settings (untracked or ignored only): the tools' MCP servers, plugins, marketplaces, settings keys,
//   env keys, hooks, status line and approval rules come out (ai-tooling.toml [offboard]); everything else in the file
//   stays, in its own format. A file left with nothing in it is moved to the backup instead.
// - Paths: stores, the tools' helper folders and files, and the units they copied into .claude/ and .agents/ are
//   moved into the backup folder, never copied or deleted, so undo moves them back. Contents are never opened: units
//   are recognized by name (the qualified installs' own names), and a skill also by its SKILL.md `author: rUv` line.
// - Never: a tracked file, a path with anything tracked under it, a repo mid-merge or rebase, a project where Claude
//   Code, Codex or Node is running.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const C = require('./config.js');
const P = require('./projects.js');
const F = require('./profiles.js');
const W = require('./write.js');
const O = require('./onboard.js');

const POL = F.POLICY.offboard || {};
const MAX_DEPTH = C.load().values.projects.max_depth; // how far below a folder Git lists whole the store walk looks
const TOOL_RE = new RegExp(POL.tool_pattern || '$^');
const SERVERS = new Set(POL.servers || []);
const MKTS = new Set(POL.marketplaces || []);
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const git = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch { return null; } };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const plugin = name => MKTS.has(String(name).split('@')[1]);
const toolEnv = k => (POL.env_prefixes || []).some(p => k.startsWith(p)) || (POL.env_names || []).includes(k);
const glob = g => new RegExp(`^${g.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

// target(dir, entry?) — the registry entry that governs dir, or why offboarding stops (`entry` stands in for tests)
function target(dir, given) {
  const kind = P.gitKind(dir) || (P.exists(dir) ? 'dir' : null);
  if (!kind) return { stop: `no such folder: ${P.tilde(dir)}` };
  const reg = given ? [{ ...given, abs: dir }] : P.loadRegistry();
  let entry = reg.find(r => r.abs === dir);
  if (!entry && kind === 'worktree') { const m = P.worktreeMain(dir); entry = m && reg.find(r => r.abs === m); }
  if (!entry) return { kind, stop: 'not in the registry: decide it first (steward projects decide)' };
  if ((entry.ai || []).length) return { kind, entry, stop: `AI tools are chosen for it (${entry.ai.join(', ')}): offboarding is for projects with none` };
  return { kind, entry };
}

// running(dir) — Claude Code, Codex or Node processes whose working folder is dir or under it
function running(dir) {
  let out;
  try { out = execFileSync('lsof', ['-a', '-d', 'cwd', '-c', 'claude', '-c', 'codex', '-c', 'node', '-Fpcn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { out = (e.stdout || '').toString(); }
  const hits = [];
  let pid, cmd;
  for (const l of out.split('\n')) {
    if (l[0] === 'p') pid = l.slice(1); else if (l[0] === 'c') cmd = l.slice(1);
    else if (l[0] === 'n' && (l.slice(1) === dir || l.slice(1).startsWith(dir + '/'))) hits.push(`${cmd} (pid ${pid})`);
  }
  return hits;
}

// tracked(dir) — a test for "this path, or anything under it, is tracked" (always false outside Git)
function tracked(dir, kind) {
  if (kind === 'dir') return () => false;
  const files = (git(dir, ['ls-files', '-z']) || '').split('\0').filter(Boolean);
  const set = new Set(files), dirs = new Set();
  for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  return rel => set.has(rel) || dirs.has(rel);
}

// stores(dir, kind) — every store-named path in the project that isn't tracked: from Git's untracked and ignored
// listings (folders collapsed), or a walk outside Git; never inside node_modules
function stores(dir, kind) {
  const names = new Set(POL.stores || []);
  const out = new Set();
  const consider = rel => {
    const parts = rel.replace(/\/$/, '').split('/');
    if (parts.includes('node_modules') || parts.includes('.git')) return;
    const i = parts.findIndex(p => names.has(p));
    if (i >= 0) out.add(parts.slice(0, i + 1).join('/'));
  };
  if (kind !== 'dir') {
    for (const args of [['ls-files', '-z', '-o', '--exclude-standard', '--directory'], ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory']]) {
      for (const rel of (git(dir, args) || '').split('\0').filter(Boolean)) {
        consider(rel);
        // a folder Git lists whole may hold stores further down (an ignored docs/guide/ with .agentic-qe/ in it)
        if (rel.endsWith('/') && !names.has(path.basename(rel)) && !/(^|\/)(node_modules|\.git)\/$/.test(rel)) walk(path.join(dir, rel), rel.replace(/\/$/, ''), consider, names);
      }
    }
  } else walk(dir, '', consider, names);
  // a store inside another store moves with it
  const all = [...out].sort();
  return all.filter(p => !all.some(q => q !== p && p.startsWith(q + '/')));
}
function walk(abs, rel, consider, names, depth = 0) {
  if (depth > MAX_DEPTH) return;
  let es; try { es = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (names.has(e.name)) { consider(r); continue; }
    if (e.isDirectory()) walk(path.join(abs, e.name), r, consider, names, depth + 1);
  }
}

// vendorNames() — per copy folder, the unit names the qualified Ruflo and AQE installs ship there
function vendorNames() {
  const r = F.render(['ruflo', 'aqe'], os.tmpdir());
  const out = {};
  for (const c of r.copies) {
    if (!fs.existsSync(c.from) || !fs.statSync(c.from).isDirectory()) continue;
    const s = (out[c.to] = out[c.to] || new Set());
    for (const n of fs.readdirSync(c.from)) s.add(n);
  }
  out['.agents/skills'] = new Set(out['.claude/skills'] || []);
  return out;
}
const ruvSkill = abs => { try { return /^author:\s*["']?rUv["']?\s*$/m.test(fs.readFileSync(path.join(abs, 'SKILL.md'), 'utf8').split(/^---\s*$/m)[1] || ''); } catch { return false; } };

// hooksLeft(hooks) — {next, removed}: the hooks object without the tools' commands (empty groups and events dropped)
function hooksLeft(hooks) {
  const next = {}, removed = [];
  for (const [ev, groups] of Object.entries(hooks || {})) {
    const g2 = [];
    for (const g of groups || []) {
      const hs = (g.hooks || []).filter(h => { const t = TOOL_RE.test(String(h.command || '')); if (t) removed.push(`${ev}${g.matcher ? ` ${g.matcher}` : ''}: ${String(h.command).slice(0, 70)}`); return !t; });
      if (hs.length) g2.push({ ...g, hooks: hs });
    }
    if (g2.length) next[ev] = g2;
  }
  return { next, removed };
}

// stripSettings(data) — {next, changes} for a Claude Code settings file
function stripSettings(data) {
  const next = JSON.parse(JSON.stringify(data)), changes = [];
  const drop = (obj, key, label) => { delete obj[key]; changes.push(`- ${label}`); };
  for (const k of POL.settings_keys || []) if (k in next) drop(next, k, k);
  if (isObj(next.hooks)) {
    const h = hooksLeft(next.hooks);
    for (const r of h.removed) changes.push(`- hook ${r}`);
    if (Object.keys(h.next).length) next.hooks = h.next; else delete next.hooks;
  }
  if (next.statusLine && TOOL_RE.test(JSON.stringify(next.statusLine))) drop(next, 'statusLine', 'statusLine (runs a tool helper)');
  for (const k of ['mcpServers']) if (isObj(next[k])) { for (const s of Object.keys(next[k]).filter(s => SERVERS.has(s))) drop(next[k], s, `${k}.${s}`); if (!Object.keys(next[k]).length) delete next[k]; }
  for (const k of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) if (Array.isArray(next[k])) {
    const gone = next[k].filter(s => SERVERS.has(s));
    if (gone.length) { next[k] = next[k].filter(s => !SERVERS.has(s)); changes.push(`- ${k}: ${gone.join(', ')}`); if (!next[k].length) delete next[k]; }
  }
  if (isObj(next.enabledPlugins)) { for (const p of Object.keys(next.enabledPlugins).filter(plugin)) drop(next.enabledPlugins, p, `enabledPlugins.${p}`); if (!Object.keys(next.enabledPlugins).length) delete next.enabledPlugins; }
  if (isObj(next.extraKnownMarketplaces)) { for (const m of Object.keys(next.extraKnownMarketplaces).filter(m => MKTS.has(m))) drop(next.extraKnownMarketplaces, m, `extraKnownMarketplaces.${m}`); if (!Object.keys(next.extraKnownMarketplaces).length) delete next.extraKnownMarketplaces; }
  if (isObj(next.env)) { for (const k of Object.keys(next.env).filter(toolEnv)) drop(next.env, k, `env.${k}`); if (!Object.keys(next.env).length) delete next.env; }
  if (isObj(next.permissions)) for (const k of ['allow', 'ask']) if (Array.isArray(next.permissions[k])) {
    const gone = next.permissions[k].filter(r => TOOL_RE.test(r) || r === 'Bash(node .claude/*)');
    if (gone.length) { next.permissions[k] = next.permissions[k].filter(r => !gone.includes(r)); changes.push(`- permissions.${k}: ${gone.join(', ')}`); if (!next.permissions[k].length) delete next.permissions[k]; }
  }
  if (isObj(next.permissions) && !Object.keys(next.permissions).length) delete next.permissions;
  return { next, changes };
}

// stripCodex(text, data) — {text, next, changes, kept} for a Codex config: the tools' server and plugin tables go by
// line (W.tomlRemoveTables); the env table goes when every key in it is the tools'
function stripCodex(text, data) {
  const next = JSON.parse(JSON.stringify(data)), changes = [], kept = [];
  let out = text;
  const removeTable = (pfx, label) => { out = W.tomlRemoveTables(out, pfx); delete pfx.slice(0, -1).reduce((o, k) => o[k], next)[pfx[pfx.length - 1]]; changes.push(`- ${label}`); };
  for (const s of Object.keys(data.mcp_servers || {}).filter(s => SERVERS.has(s))) removeTable(['mcp_servers', s], `mcp_servers.${s}`);
  if (next.mcp_servers && !Object.keys(next.mcp_servers).length) delete next.mcp_servers;
  for (const p of Object.keys(data.plugins || {}).filter(plugin)) removeTable(['plugins', p], `plugins."${p}"`);
  if (next.plugins && !Object.keys(next.plugins).length) delete next.plugins;
  const set = ((data.shell_environment_policy || {}).set) || {};
  const env = Object.keys(set);
  if (env.length && env.every(toolEnv)) {
    removeTable(['shell_environment_policy', 'set'], `shell_environment_policy.set (${env.join(', ')})`);
  } else if (env.some(toolEnv)) kept.push(`shell_environment_policy.set mixes the tools' keys with others; left as is (${env.filter(toolEnv).join(', ')})`);
  // removing the last tables can take the file's final newline (or leave extra blank lines) with them
  if (changes.length) out = out.replace(/\n*$/, text.endsWith('\n') ? '\n' : '');
  return { text: out, next, changes, kept };
}

// plan(dir, {also: [path…], entry}) — everything offboarding would do to one project
function plan(dirIn, opts = {}) {
  const dir = path.resolve(P.untilde(dirIn));
  const t = target(dir, opts.entry);
  const out = { project: P.tilde(dir), dir, kind: t.kind, configs: [], moves: [], left: [], plugins: [], notes: [] };
  if (t.stop) return { ...out, stop: t.stop };
  if (t.kind !== 'dir') {
    const gp = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].find(p => { const g = (git(dir, ['rev-parse', '--git-path', p]) || '').trim(); return g && fs.existsSync(path.resolve(dir, g)); });
    if (gp) return { ...out, stop: `the repo is mid-operation (${gp}): finish or abort it first` };
  }
  if (!opts.skipRunning) { const r = running(dir); if (r.length) return { ...out, stop: `running here: ${r.join(', ')}: close them first` }; }
  const isTracked = tracked(dir, t.kind);
  const exists = rel => fs.existsSync(path.join(dir, rel));

  // launchers and settings
  const cfg = (rel, fn) => {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) return;
    if (isTracked(rel)) { out.left.push(`${rel}: tracked; its tool entries need a PR`); return; }
    const text = fs.readFileSync(abs, 'utf8');
    const toml = rel.endsWith('.toml');
    const data = toml ? P.toml(abs) : (() => { try { return JSON.parse(text); } catch { return null; } })();
    if (data === null) { out.left.push(`${rel}: doesn't parse; fix it by hand`); return; }
    const r = fn(text, data);
    for (const k of r.kept || []) out.notes.push(`${rel}: ${k}`);
    if (!r.changes.length) return;
    // nothing left but comments and blank lines (TOML), or an empty object (JSON): the whole file moves instead
    const archive = toml ? !r.text.split('\n').some(l => l.trim() && !l.trim().startsWith('#')) : !Object.keys(r.next).length;
    out.configs.push({ path: rel, action: archive ? 'archive' : 'edit', changes: r.changes, sha: sha(abs), next: r.next, text: archive ? undefined : (toml ? r.text : W.jsonText(text, data, r.next)) });
  };
  cfg('.claude/settings.json', (_, d) => stripSettings(d));
  cfg('.claude/settings.local.json', (_, d) => stripSettings(d));
  cfg('.mcp.json', (_, d) => {
    const next = JSON.parse(JSON.stringify(d)), changes = [];
    for (const s of Object.keys(d.mcpServers || {}).filter(s => SERVERS.has(s))) { delete next.mcpServers[s]; changes.push(`- mcpServers.${s}`); }
    if (next.mcpServers && !Object.keys(next.mcpServers).length) delete next.mcpServers;
    return { next, changes };
  });
  cfg('.codex/config.toml', stripCodex);
  for (const c of out.configs) if (c.action === 'edit' && !c.path.endsWith('.toml')) {
    if (W.canon(JSON.parse(c.text)) !== W.canon(c.next)) throw new Error(`${c.path}: the new text wouldn't parse to the planned result`);
  }

  // moves: stores, whole tool paths, copied units, the owner's --also paths
  // one move per path: a path under one already moving goes with it; a parent takes over the moves under it
  const move = (rel, why) => {
    if (out.moves.some(m => m.path === rel || rel.startsWith(m.path + '/'))) return;
    out.moves = out.moves.filter(m => !m.path.startsWith(rel + '/'));
    out.moves.push({ path: rel, why });
  };
  for (const s of stores(dir, t.kind)) if (!isTracked(s)) move(s, 'store');
  for (const g of POL.paths || []) {
    const parent = path.dirname(g), re = glob(path.basename(g));
    let es; try { es = fs.readdirSync(path.join(dir, parent)); } catch { continue; }
    for (const n of es.filter(n => re.test(n))) {
      const rel = parent === '.' ? n : `${parent}/${n}`;
      if (isTracked(rel)) { out.left.push(`${rel}: tracked (or holds tracked files)`); continue; }
      if (n === 'hooks.json') {
        let h; try { h = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')).hooks; } catch { h = null; }
        const cmds = Object.values(h || {}).flat().flatMap(g2 => g2.hooks || []);
        if (!cmds.length || cmds.some(c => !TOOL_RE.test(String(c.command)))) { out.left.push(`${rel}: has hooks that aren't the tools'; left`); continue; }
      }
      move(rel, 'tool file');
    }
  }
  const known = vendorNames();
  for (const d of POL.copy_dirs || []) {
    let es; try { es = fs.readdirSync(path.join(dir, d)); } catch { continue; }
    for (const n of es.filter(n => n !== '.DS_Store')) {
      const rel = `${d}/${n}`;
      if (isTracked(rel)) continue; // the project's own
      const why = (known[d] || new Set()).has(n) ? 'a qualified install ships this name'
        : d === '.agents/skills' && /^source-command-/.test(n) ? 'Codex copy of a Ruflo command'
        : /skills$/.test(d) && ruvSkill(path.join(dir, rel)) ? 'SKILL.md author: rUv' : null;
      if (why) move(rel, why); else out.left.push(`${rel}: untracked, not recognized as a tool copy; left (name it with --also to move it)`);
    }
  }
  for (const a of opts.also || []) {
    const rel = a.replace(/^\.\//, '').replace(/\/$/, '');
    if (!exists(rel)) out.left.push(`${rel} (--also): not there`);
    else if (isTracked(rel)) out.left.push(`${rel} (--also): tracked; never moved`);
    else move(rel, 'named by the owner (--also)');
  }
  for (const m of out.moves) { m.hash = O.unitHash(path.join(dir, m.path)); }
  // folders the moves leave empty are removed too (and recreated on undo)
  const gone = new Set(out.moves.map(m => m.path));
  const archived = new Set(out.configs.filter(c => c.action === 'archive').map(c => c.path));
  const emptied = d => { let es; try { es = fs.readdirSync(path.join(dir, d)); } catch { return false; } return es.every(n => n === '.DS_Store' || gone.has(`${d}/${n}`) || archived.has(`${d}/${n}`) || (fs.statSync(path.join(dir, d, n)).isDirectory() && emptied(`${d}/${n}`))); };
  out.rmdirs = ['.claude/agents', '.claude/commands', '.claude/skills', '.claude/docs', '.agents/skills', '.agents', '.codex', '.claude']
    .filter(d => exists(d) && !isTracked(d) && !gone.has(d) && emptied(d));

  // anything else untracked in the tools' folders: reported, so the owner can name it with --also
  const handled = rel => out.moves.some(m => m.path === rel || rel.startsWith(m.path + '/')) || out.configs.some(c => c.path === rel)
    || (POL.copy_dirs || []).includes(rel) || ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml'].includes(rel) || out.rmdirs.includes(rel);
  for (const d of ['.claude', '.codex', '.agents']) {
    let es; try { es = fs.readdirSync(path.join(dir, d)); } catch { continue; }
    for (const n of es.filter(n => n !== '.DS_Store')) {
      const rel = `${d}/${n}`;
      if (isTracked(rel) || handled(rel) || (POL.copy_dirs || []).some(c => c.startsWith(rel + '/'))) continue;
      out.left.push(`${rel}: untracked, not a file offboarding knows; left (name it with --also to move it)`);
    }
  }
  // project-scope plugin installs Claude Code records: its own CLI removes them (listed, never run)
  try {
    const ip = JSON.parse(fs.readFileSync(path.join(C.load().values.paths.claude_dir, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [name, arr] of Object.entries(ip.plugins || {})) for (const e of arr || []) {
      if (e.scope === 'project' && e.projectPath === dir && plugin(name)) out.plugins.push(name);
    }
  } catch { /* no plugin records */ }
  return out;
}

// refusals(plan) — why apply won't run, or []
function refusals(p) {
  return p.stop ? [p.stop] : [];
}

// moveTo(src, dst) — rename, or copy and remove across file systems
function moveTo(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  if (fs.existsSync(dst)) throw new Error(`${dst} already exists`);
  try { fs.renameSync(src, dst); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

// apply(plan) — config edits first (so no hook calls a helper that's gone), then the moves, then empty folders.
// Every step is in the receipt as it happens; on a failure the applied part is undone. Returns the receipt path.
function apply(p) {
  const why = refusals(p);
  if (why.length) throw new Error(why.join('; '));
  const dir = p.dir;
  const bdir = C.newBackupDir(`offboard-${path.basename(dir)}`);
  const rp = path.join(bdir, 'receipt.json');
  const receipt = { kind: 'offboard', at: new Date().toISOString(), engine: C.ENGINE_VERSION, project: p.project, backup: P.tilde(bdir), entries: [], complete: false };
  const save = () => fs.writeFileSync(rp, JSON.stringify(receipt, null, 1) + '\n', { mode: 0o600 });
  const stash = rel => path.join(bdir, 'moved', rel);
  save();
  try {
    for (const c of p.configs) {
      const abs = path.join(dir, c.path);
      if (sha(abs) !== c.sha) throw new Error(`${c.path} changed since the plan: run the plan again`);
      if (c.action === 'archive') {
        receipt.entries.push({ path: c.path, action: 'move', to: P.tilde(stash(c.path)), hash: c.sha });
        save();
        moveTo(abs, stash(c.path));
      } else {
        const b = path.join(bdir, 'files', c.path);
        fs.mkdirSync(path.dirname(b), { recursive: true, mode: 0o700 });
        fs.copyFileSync(abs, b, fs.constants.COPYFILE_EXCL);
        const e = { path: c.path, action: 'edit', backup: P.tilde(b), sha_before: c.sha };
        receipt.entries.push(e);
        save();
        const tmp = `${abs}.offboard-${process.pid}`;
        fs.writeFileSync(tmp, c.text, { mode: fs.statSync(abs).mode & 0o777 });
        fs.renameSync(tmp, abs);
        e.sha_after = sha(abs);
        save();
      }
    }
    for (const m of p.moves) {
      const abs = path.join(dir, m.path);
      if (O.unitHash(abs) !== m.hash) throw new Error(`${m.path} changed since the plan: run the plan again`);
      receipt.entries.push({ path: m.path, action: 'move', to: P.tilde(stash(m.path)), hash: m.hash });
      save();
      moveTo(abs, stash(m.path));
    }
    for (const d of p.rmdirs) {
      const abs = path.join(dir, d);
      try { fs.rmSync(path.join(abs, '.DS_Store'), { force: true }); } catch { /* none */ }
      try { fs.rmdirSync(abs); receipt.entries.push({ path: d, action: 'rmdir' }); save(); } catch { /* not empty after all: leave it */ }
    }
    receipt.complete = true;
    save();
  } catch (e) {
    try { undo(receipt); } catch (u) { e.message += `; undoing also failed (${u.message}): restore by hand from ${P.tilde(bdir)}`; }
    receipt.undone = true;
    save();
    throw e;
  }
  return rp;
}

// changedSince(receipt) — what undo would overwrite: a moved path that exists again, an edited file changed since
function changedSince(rc) {
  const dir = P.untilde(rc.project), out = [];
  for (const e of rc.entries) {
    const abs = path.join(dir, e.path);
    if (e.action === 'move') { if (fs.existsSync(abs)) out.push(`${e.path} (exists again)`); else if (!fs.existsSync(P.untilde(e.to))) out.push(`${e.to} (missing from the backup)`); }
    else if (e.action === 'edit' && (!fs.existsSync(abs) || sha(abs) !== e.sha_after)) out.push(e.path);
  }
  return out;
}

// undo(receipt) — last step first: recreate removed folders, move paths back, restore edited files
function undo(rc) {
  const dir = P.untilde(rc.project);
  for (const e of [...rc.entries].reverse()) {
    const abs = path.join(dir, e.path);
    if (e.action === 'rmdir') fs.mkdirSync(abs, { recursive: true });
    else if (e.action === 'move' && fs.existsSync(P.untilde(e.to))) { fs.mkdirSync(path.dirname(abs), { recursive: true }); if (!fs.existsSync(abs)) moveTo(P.untilde(e.to), abs); }
    else if (e.action === 'edit') fs.copyFileSync(P.untilde(e.backup), abs);
  }
}

module.exports = { plan, apply, undo, changedSince, refusals, stripSettings, stripCodex, hooksLeft, stores };
