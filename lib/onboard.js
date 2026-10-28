// Onboarding plan (5a step 4): what `steward projects onboard <path>` would do to one project, as data. Read-only:
// nothing here writes. The apply step (5a step 5) applies exactly this plan, so what the owner sees is what changes.
// Every change only adds (D18): a key, hook, server or file a project already has is kept, and the keep-off list
// (ai-tooling.toml, D23) is never written. How each file may change follows its Git state (D6): files Git doesn't
// track are edited in place; tracked ones go through a PR; files onboarding creates are kept out of `git status`
// with .git/info/exclude unless the repo already ignores them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const os = require('os');
const C = require('./config.js');
const P = require('./projects.js');
const F = require('./profiles.js');
const W = require('./write.js');

const CONFIGS = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.codex/config.toml'];
// action per Git state: edit in place (D6), a PR (tracked), or create (with an exclude entry only when 'absent')
const ACTION = { untracked: 'edit', ignored: 'edit', 'not-git': 'edit', tracked: 'pr', absent: 'create', 'absent-ignored': 'create' };

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const git = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

// leafKeys(v, key) — the dotted keys of every leaf under v (v itself when it isn't a non-empty object)
const leafKeys = (v, key) => (isObj(v) && Object.keys(v).length ? Object.entries(v).flatMap(([k, x]) => leafKeys(x, `${key}.${k}`)) : [key]);

// addOnly(have, want) — {next, added}: have with every key of want it lacks; keys it has are kept as they are
function addOnly(have, want, pre = '', added = []) {
  const out = isObj(have) ? { ...have } : {};
  for (const [k, v] of Object.entries(want || {})) {
    const key = pre ? `${pre}.${k}` : k;
    if (!(k in out)) {
      if (isObj(v) && !Object.keys(v).length) continue; // an empty table carries nothing (a new server keeps its own)
      out[k] = v; added.push(...leafKeys(v, key));
    }
    else if (isObj(out[k]) && isObj(v)) out[k] = addOnly(out[k], v, key, added).next;
  }
  return { next: out, added };
}

// flatHooks(hooks) — every hook as {event, matcher, command, timeout, group, entry}; group and entry are the objects
// inside `hooks`, so a caller can remove one in place
const flatHooks = hooks => {
  const out = [];
  for (const [event, groups] of Object.entries(hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) out.push({ event, matcher: g.matcher || '', command: h.command || '', timeout: h.timeout, group: g, entry: h });
  return out;
};

// Older hook forms --replace-older swaps for the profile's: only these, each named in the plan. Any other older form
// (other quoting, a different path to the same script) is still kept.
const REPLACEABLE = [
  { why: 'transport v1 set inline (overrides settings.local.json)', test: o => /AQE_HOOK_BUNDLE=[^ ]*transports\/v1/.test(o.command) },
  { why: '`npx agentic-qe hooks` (an unpinned fetch on every hook)', test: o => /npx agentic-qe hooks/.test(o.command) },
  { why: 'matcher ^Task$ (misses the Agent tool)', test: (o, h) => o.matcher === '^Task$' && h.matcher === '^(Task|Agent)$' },
];

// mergeHooks(have, want, {replaceOlder}) — {next, added, kept, replaced}: a profile hook is added unless the project
// already runs the same work on that event (F.hookKey); an older form of it is kept, never doubled, or with
// replaceOlder swapped for the profile's hook when it is one of REPLACEABLE
function mergeHooks(haveHooks, want, opts = {}) {
  const next = JSON.parse(JSON.stringify(haveHooks || {}));
  const have = flatHooks(next), before = have.slice();
  const added = [], kept = [], replaced = [], gone = new Set();
  const place = h => {
    const groups = (next[h.event] = next[h.event] || []);
    let g = groups.find(x => (x.matcher || '') === h.matcher);
    if (!g) { g = h.matcher ? { matcher: h.matcher, hooks: [] } : { hooks: [] }; groups.push(g); }
    g.hooks.push({ type: 'command', command: h.command, timeout: h.timeout, ...(h.continueOnError ? { continueOnError: true } : {}) });
    have.push({ event: h.event, matcher: h.matcher, command: h.command });
  };
  for (const h of want) {
    if (have.some(x => x.event === h.event && x.matcher === h.matcher && x.command === h.command)) continue;
    const k = F.hookKey(h.command);
    // only the project's own hooks count as an older form; the matcher counts too when the profile itself splits one
    // key by matcher (PreCompact manual and auto)
    const split = want.filter(x => x.event === h.event && F.hookKey(x.command) === k).length > 1;
    const older = k && before.find(x => !gone.has(x) && x.event === h.event && F.hookKey(x.command) === k && (!split || x.matcher === h.matcher));
    if (older) {
      const why = opts.replaceOlder && REPLACEABLE.filter(r => r.test(older, h)).map(r => r.why);
      if (!why || !why.length) { kept.push({ tool: h.tool, event: h.event, key: k, have: older, replaceable: REPLACEABLE.some(r => r.test(older, h)) }); continue; }
      older.group.hooks.splice(older.group.hooks.indexOf(older.entry), 1);
      gone.add(older);
      place(h);
      replaced.push({ tool: h.tool, event: h.event, matcher: h.matcher, key: k, why, was: { matcher: older.matcher, command: older.command } });
      continue;
    }
    place(h);
    added.push({ tool: h.tool, event: h.event, matcher: h.matcher, key: k || h.command.slice(0, 40) });
  }
  // drop groups and events a replacement emptied
  for (const ev of Object.keys(next)) {
    next[ev] = next[ev].filter(g => (g.hooks || []).length);
    if (!next[ev].length) delete next[ev];
  }
  return { next, added, kept, replaced };
}

// read(file) — {exists, data, bad}: parsed JSON or TOML; bad when it exists but doesn't parse (never merged into)
function read(file) {
  if (!P.exists(file)) return { exists: false, data: {} };
  const data = file.endsWith('.toml') ? P.toml(file) : P.readJSON(file);
  return data === null ? { exists: true, data: {}, bad: true } : { exists: true, data };
}

// ignored(dir, rel) — whether the repo's own ignore rules cover rel (a path that isn't tracked)
const ignored = (dir, rel) => { try { execFileSync('git', ['-C', dir, 'check-ignore', '-q', rel], { stdio: 'ignore' }); return true; } catch { return false; } };

// shownUntracked(dir) — the untracked folders `git status` already lists in dir (`?? folder/`), or null outside Git
function shownUntracked(dir) {
  const out = git(dir, ['status', '--porcelain', '--untracked-files=normal']);
  if (out === null) return null;
  return out.split('\n').filter(l => l.startsWith('?? ') && l.endsWith('/')).map(l => l.slice(3).replace(/^"|"$/g, ''));
}

// midOperation(dir) — the Git operation in progress (merge, rebase, cherry-pick), or null
function midOperation(dir) {
  for (const p of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
    const gp = git(dir, ['rev-parse', '--git-path', p]);
    if (gp && fs.existsSync(path.resolve(dir, gp))) return p;
  }
  return null;
}

// engines — the lowest Node each chosen tool's qualified install declares
function engines(tools, ph) {
  const pkg = { ruflo: ph.RUFLO, aqe: ph.AQE_PKG };
  return tools.filter(t => pkg[t]).map(t => {
    const e = ((P.readJSON(path.join(pkg[t], 'package.json')) || {}).engines || {}).node || '';
    const m = e.match(/>=\s*(\d+(?:\.\d+){0,2})/);
    return { tool: t, min: m ? m[1] : null, range: e || null };
  });
}
const below = (v, min) => {
  const a = String(v).split('.').map(Number), b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
};

// target(dir, entry?) — {entry, kind, parent?, stop?}: the registry entry that governs dir and why onboarding might
// stop. `entry` stands in for the registry in tests only (scratch projects); the CLI never passes it.
function target(dir, given) {
  const reg = given ? [{ ...given, abs: dir }] : P.loadRegistry();
  const kind = P.gitKind(dir) || (P.exists(dir) ? 'dir' : null);
  if (!kind) return { stop: `no such folder: ${P.tilde(dir)}` };
  if (dir.split(path.sep).join('/').includes('/.claude/worktrees/')) return { kind, stop: 'a Claude Code agent worktree: not an onboarding target (D19); its files come from the agent session' };
  let entry = reg.find(r => r.abs === dir), parent = null;
  if (!entry && kind === 'worktree') {
    parent = P.worktreeMain(dir);
    const pe = parent && reg.find(r => r.abs === parent);
    if (pe && P.WORKTREES === 'inherit') entry = { ...pe, inherits: pe.path };
  }
  if (!entry) return { kind, stop: 'not in the registry: decide it first (steward projects scan, then steward projects decide)' };
  if (entry.decision !== 'onboarded') return { kind, entry, stop: `registry decision is "${entry.decision}"` };
  if (!(entry.ai || []).length) return { kind, entry, stop: 'no AI tools chosen for it (ai = [])' };
  return { kind, entry, parent };
}

// plan(dir, {refresh: [file…], approvals, replaceOlder, fixKeepOff, removeUnpinned}) — everything onboarding would do to one project
function plan(dirIn, opts = {}) {
  const dir = path.resolve(P.untilde(dirIn));
  const t = target(dir, opts.entry);
  const out = { project: P.tilde(dir), dir, kind: t.kind, tools: (t.entry && t.entry.ai) || [], inherits: t.entry && t.entry.inherits, files: [], exclude: [], keepoff: [], manual: [], notes: [] };
  if (t.stop) return { ...out, stop: t.stop };
  if (t.kind !== 'dir') {
    const op = midOperation(dir);
    if (op) return { ...out, stop: `the repo is mid-operation (${op}): finish or abort it first` };
  }
  if (t.parent) {
    const pp = plan(t.parent, opts);
    if (!pp.stop && pp.files.some(f => f.action !== 'none')) return { ...out, stop: `its main checkout ${pp.project} isn't onboarded yet: onboard that first` };
    out.notes.push(`a worktree of ${P.tilde(t.parent)}: tools from its registry entry (D15); files bound to this worktree's own folder`);
  }
  const tools = out.tools;
  const want = F.render(tools, dir, { approvals: opts.approvals });
  const ph = F.placeholders(dir);
  const refresh = new Set((opts.refresh || []).map(f => f.replace(/^\.\//, '')));
  const paths = [...new Set([...CONFIGS, ...want.copies.map(c => c.to), ...want.writes.map(w => w.path)])];
  const states = P.gitStates(dir, paths);
  // A created path needs a .git/info/exclude entry only when it would add a line to `git status`: not when an
  // untracked folder above it is already listed (the .gitignore audit decides those), and never outside Git.
  const listed = t.kind === 'dir' ? null : shownUntracked(dir);
  const file = (p, changes, extra = {}) => {
    const st = states[p];
    let action = changes.length ? ACTION[st] : 'none';
    if (extra.bad) action = 'manual';
    // a folder Git tracks part of: a new name the repo already ignores is an untracked file like any other (D6);
    // only names that would show in `git status` go through a PR
    if (action === 'pr' && extra.names && extra.names.length && !extra.visible.length) action = 'edit';
    const abs = path.join(dir, p);
    const isFile = fs.existsSync(abs) && fs.statSync(abs).isFile();
    out.files.push({ path: p, state: st, action, changes, sha: isFile ? sha(abs) : null, ...extra });
    if (action === 'create' && st === 'absent' && listed) {
      const under = listed.find(d => p.startsWith(d));
      if (under) out.notes.push(`${p}: lands in ${under}, which \`git status\` already lists (untracked); no exclude entry (left for the .gitignore audit)`);
      else out.exclude.push(`/${p}`);
    }
  };

  // configuration files: keys, hooks, servers and approvals, adds only
  const have = Object.fromEntries(CONFIGS.map(p => [p, read(path.join(dir, p))]));
  // keepOffFixes(fileKey, data, next) — with fixKeepOff, set each keep-off entry with a required value that the
  // project breaks to that value (in next, a copy); the change lines. JSON settings only: no keep-off entry with a
  // value lives in .mcp.json or the Codex config, and the TOML writer only inserts.
  const KEEPOFF_FILES = { settings: '.claude/settings.json', settings_local: '.claude/settings.local.json' };
  const keepOffFixes = (fileKey, data, next) => {
    if (!opts.fixKeepOff) return [];
    const lines = [];
    for (const k of (F.POLICY.keep_off || []).filter(k => k.file === fileKey && 'value' in k)) {
      const v = F.get(data, k.key);
      if (v === undefined || same(v, k.value)) continue;
      const parts = k.key.split('.');
      const parent = parts.slice(0, -1).reduce((o, x) => o[x], next);
      parent[parts[parts.length - 1]] = k.value;
      lines.push(`~ ${k.key}: ${JSON.stringify(v)} → ${JSON.stringify(k.value)} (keep-off: ${k.why})`);
    }
    return lines;
  };
  {
    const h = have['.claude/settings.json'];
    const { hooks, ...rest } = h.data;
    const keys = addOnly(rest, want.settings);
    const hk = mergeHooks(hooks, want.hooks, { replaceOlder: opts.replaceOlder });
    const next = JSON.parse(JSON.stringify({ ...keys.next, ...(Object.keys(hk.next).length ? { hooks: hk.next } : {}) }));
    const fixes = keepOffFixes('settings', h.data, next);
    file('.claude/settings.json', [...keys.added.map(k => `+ ${k}`), ...hk.added.map(a => `+ hook ${a.tool} ${a.event}${a.matcher ? ` ${a.matcher}` : ''} ${a.key}`),
      ...hk.replaced.map(r => `~ hook ${r.tool} ${r.event}${r.matcher ? ` ${r.matcher}` : ''} ${r.key}: replaces the older form, ${r.why.join('; ')}`), ...fixes],
      { bad: h.bad, next, kept: hk.kept.map(k => `${k.tool} ${k.event} ${k.key}: an older form is there${k.have.matcher ? ` (matcher ${k.have.matcher})` : ''}; kept, not doubled${k.replaceable ? ' (--replace-older replaces it)' : ''}`) });
  }
  // removeUnpinned: a launcher the keep-off list says is never written (ruflo, ruv-swarm, flow-nexus) whose command
  // fetches an unpinned version ([launchers] forbid) is removed from .mcp.json and the Codex config (5b). Nothing else.
  const neverWritten = new Set((F.POLICY.keep_off || []).filter(k => k.file === 'mcp' && !('value' in k) && /^mcpServers\.[^.]+$/.test(k.key)).map(k => k.key.slice(11)));
  const forbid = ((F.POLICY.launchers || {}).forbid) || [];
  const unpinned = (servers, next, label) => {
    if (!opts.removeUnpinned) return { lines: [], removed: [] };
    const lines = [], removed = [];
    for (const [name, s] of Object.entries(servers || {})) {
      const cmd = [s && s.command, ...((s && s.args) || [])].join(' ');
      if (!neverWritten.has(name) || !forbid.some(x => cmd.includes(x))) continue;
      delete next[name];
      removed.push(name);
      const why = ((F.POLICY.keep_off || []).find(k => k.key === `mcpServers.${name}`) || {}).why;
      lines.push(`- ${label}.${name} (${cmd.slice(0, 50)}): removed (keep-off: ${why})`);
    }
    return { lines, removed };
  };
  /** @type {[string, object][]} */
  const rest = [['.claude/settings.local.json', want.settings_local], ['.mcp.json', want.mcp], ['.codex/config.toml', want.codex]];
  for (const [p, w] of rest) {
    const h = have[p];
    const r = addOnly(h.data, w);
    const next = JSON.parse(JSON.stringify(r.next));
    const fixes = p === '.claude/settings.local.json' ? keepOffFixes('settings_local', h.data, next) : [];
    const un = p === '.mcp.json' ? unpinned((h.data || {}).mcpServers, next.mcpServers || {}, 'mcpServers')
      : p === '.codex/config.toml' ? unpinned((h.data || {}).mcp_servers, next.mcp_servers || {}, 'mcp_servers') : { lines: [], removed: [] };
    file(p, [...r.added.map(k => `+ ${k}`), ...fixes, ...un.lines], { bad: h.bad, next, ...(un.removed.length ? { removed: un.removed.map(n => [p === '.mcp.json' ? 'mcpServers' : 'mcp_servers', n]) } : {}) });
  }

  // files written whole when absent
  for (const w of want.writes) {
    if (P.exists(path.join(dir, w.path))) file(w.path, []);
    else file(w.path, ['+ whole file'], { text: w.text });
  }

  // files and folders copied from the qualified installs
  for (const c of want.copies) {
    const to = path.join(dir, c.to);
    const isDir = fs.existsSync(c.from) && fs.statSync(c.from).isDirectory();
    if (!isDir) {
      if (!P.exists(to)) { file(c.to, [`+ from ${c.tool}`], { from: c.from }); continue; }
      if (sha(to) === sha(c.from)) { file(c.to, []); continue; }
      const k = F.knownVendor().get(sha(to));
      if ((k && k.file === c.to) || refresh.has(c.to)) {
        const why = k && k.file === c.to ? `unedited vendor copy (${k.origin})` : 'an edited copy the owner named (--refresh)';
        // a refresh replaces a whole file: inside a tracked folder or as a tracked file it is a PR like any edit
        file(c.to, [`refresh: ${why}`], { from: c.from, refresh: true, backup: true });
      } else {
        file(c.to, []);
        out.notes.push(`${c.to}: an edited copy; kept (name it with --refresh ${c.to} to replace it)`);
      }
      continue;
    }
    const locked = P.exists(path.join(to, '.LOCKED'));
    const present = new Set(F.names({ ...c, exclude: [] }, to));
    const add = F.names(c).filter(n => !present.has(n));
    const visible = states[c.to] === 'tracked' ? add.filter(n => !ignored(dir, `${c.to}/${n}`)) : [];
    const ch = add.length ? [`+ ${add.length} name(s)${locked ? ' (locked folder: missing names only)' : ''}${states[c.to] === 'tracked' ? (visible.length ? `; ${visible.length} would show in \`git status\`` : '; all ignored by the repo (it tracks only its own files here)') : ''}`] : [];
    file(c.to, ch, { tool: c.tool, from: c.from, names: add, visible, locked });
  }

  // what the project already breaks on the keep-off list: reported, and changed only with fixKeepOff (above)
  const files = { settings: have['.claude/settings.json'].data, settings_local: have['.claude/settings.local.json'].data, mcp: have['.mcp.json'].data, codex: have['.codex/config.toml'].data };
  for (const k of F.POLICY.keep_off || []) {
    if (!('value' in k) || (opts.fixKeepOff && k.file in KEEPOFF_FILES)) continue;
    const v = F.get(files[k.file], k.key);
    if (v !== undefined && !same(v, k.value)) out.keepoff.push({ file: k.file, key: k.key, found: v, want: k.value, why: k.why });
  }

  // the Node a bare `node` runs in this folder, which is what every hook here runs
  const node = P.nodeFor(dir);
  out.node = { version: node, engines: engines(tools, ph) };
  if (!/^\d/.test(node)) out.notes.push(`hooks run a bare \`node\`; mise resolves "${node}" here: check it before applying`);
  for (const e of out.node.engines) if (e.min && /^\d/.test(node) && below(node, e.min)) out.notes.push(`Node ${node} is below ${e.tool}'s minimum (${e.range}): its hooks would fail here`);

  for (const f of out.files.filter(f => f.state === 'untracked' && f.action !== 'none')) out.notes.push(`${f.path} already shows in \`git status\` (untracked, not ignored); left for the .gitignore audit`);
  out.manual = want.manual;
  return out;
}

// profileHashes(tools) — { tool: sha256 of projects/profiles/<tool>.toml }: which profile revision an onboarding used (D40)
function profileHashes(tools) {
  return Object.fromEntries(tools.map(t => [t, sha(path.join(__dirname, '..', 'projects', 'profiles', `${t}.toml`))]));
}

// unitHash(p) — a file's sha256, or a folder's (each file's relative path and sha256, sorted)
function unitHash(p) {
  try {
    if (!fs.statSync(p).isDirectory()) return sha(p);
    const h = crypto.createHash('sha256');
    for (const f of F.listFiles(p).sort()) h.update(`${f}\0${sha(path.join(p, f))}\0`);
    return h.digest('hex');
  } catch { return null; }
}

const TRANSPORT_SRC = path.join(P.REPO_ROOT, 'ai-tooling', 'transports', 'aqe-hook-bundle.cjs');

// refusals(plan, opts) — why apply won't run, or []
function refusals(p, opts = {}) {
  const out = [];
  if (p.stop) out.push(p.stop);
  for (const f of p.files.filter(f => f.action === 'manual')) out.push(`${f.path} exists but doesn't parse: fix it by hand first`);
  if (p.tools.includes('aqe') && !opts.skipTransportCheck) {
    const dest = P.untilde(F.POLICY.aqe.hook_transport);
    if (sha(dest) !== sha(TRANSPORT_SRC)) out.push(`the AQE hook transport v2 isn't installed as ai-tooling/transports/aqe-hook-bundle.cjs (${P.tilde(dest)}): steward ai transport --apply`);
  }
  return out;
}

// mkdirs(dir, rel) — create rel's missing parent folders under dir; the ones created, outermost first
function mkdirs(dir, rel) {
  const made = [];
  let cur = dir;
  for (const part of path.dirname(rel).split('/').filter(x => x && x !== '.')) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) { fs.mkdirSync(cur); made.push(path.relative(dir, cur)); }
  }
  return made;
}

// atomic(file, text, mode) — write through a temporary file in the same folder
function atomic(file, text, mode) {
  const tmp = `${file}.onboard-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

// configText(dir, f) — the new text for a config file, parse-checked against the plan's merged object
function configText(dir, f) {
  const abs = path.join(dir, f.path);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if ((text === null ? null : sha(abs)) !== f.sha) throw new Error(`${f.path} changed since the plan: run the plan again`);
  const toml = f.path.endsWith('.toml');
  const have = text === null ? {} : toml ? P.toml(abs) : JSON.parse(text);
  let base = text || '', from = have;
  if (toml && f.removed) {
    // tables onboarding removes (--remove-unpinned) go first, by line; then anything to add is inserted
    for (const pfx of f.removed) base = W.tomlRemoveTables(base, pfx);
    from = JSON.parse(JSON.stringify(have));
    for (const pfx of f.removed) delete pfx.slice(0, -1).reduce((o, k) => o[k], from)[pfx[pfx.length - 1]];
  }
  const out = toml ? W.tomlAdd(base, from, f.next) : W.jsonText(text, have, f.next);
  let parsed;
  if (toml) {
    const t = path.join(os.tmpdir(), `steward-check-${process.pid}.toml`);
    fs.writeFileSync(t, out);
    parsed = P.toml(t);
    fs.unlinkSync(t);
  } else parsed = JSON.parse(out);
  if (W.canon(parsed) !== W.canon(f.next)) throw new Error(`${f.path}: the written text wouldn't parse to the planned result`);
  return { text: out, existed: text !== null };
}

// apply(plan, {skipTransportCheck}) — make the plan's edit and create changes (PR items are listed, never applied).
// Order: copied files and folders, whole files, settings.json (its hooks call those files), the other configs,
// then .git/info/exclude. Every touched path is backed up or recorded as created in a receipt that is written as
// it goes; on any failure the applied part is undone from it. Returns the receipt path.
function apply(p, opts = {}) {
  const why = refusals(p, opts);
  if (why.length) throw new Error(why.join('; '));
  const dir = p.dir;
  const bdir = C.newBackupDir(`onboard-${path.basename(dir)}`);
  const stamp = path.basename(bdir).slice(`onboard-${path.basename(dir)}-`.length);
  fs.mkdirSync(path.join(bdir, 'files'), { mode: 0o700 });
  const rp = path.join(bdir, 'receipt.json');
  const receipt = { kind: 'onboard', at: new Date().toISOString(), engine: C.ENGINE_VERSION, profiles: profileHashes(p.tools), project: p.project, tools: p.tools, backup: P.tilde(bdir), entries: [], exclude: null, pr: p.files.filter(f => f.action === 'pr').map(f => f.path), complete: false };
  const save = () => fs.writeFileSync(rp, JSON.stringify(receipt, null, 1) + '\n');
  const backup = rel => { const b = path.join(bdir, 'files', rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(path.join(dir, rel), b, fs.constants.COPYFILE_EXCL); return P.tilde(b); };
  const todo = p.files.filter(f => f.action === 'edit' || f.action === 'create');
  const isConfig = f => CONFIGS.includes(f.path);
  const order = [...todo.filter(f => f.from), ...todo.filter(f => f.text !== undefined), ...todo.filter(f => f.path === '.claude/settings.json'), ...todo.filter(f => isConfig(f) && f.path !== '.claude/settings.json')];
  save();
  try {
    for (const f of order) {
      const abs = path.join(dir, f.path);
      if (f.names) { // a folder copy: add the missing names
        const e = { path: f.path, action: 'names', dirs: [], names: [] };
        receipt.entries.push(e);
        for (const n of f.names) {
          const rel = `${f.path}/${n}`, dst = path.join(dir, rel);
          if (fs.existsSync(dst)) throw new Error(`${rel} appeared since the plan`);
          e.dirs.push(...mkdirs(dir, rel));
          fs.cpSync(path.join(f.from, n), dst, { recursive: true, errorOnExist: true, force: false });
          e.names.push({ name: n, hash: unitHash(dst) });
          save();
        }
      } else if (f.from) { // one file: created, or a known vendor copy refreshed (D25)
        const e = { path: f.path, action: f.refresh ? 'refresh' : 'create', sha_before: f.sha };
        if ((fs.existsSync(abs) ? sha(abs) : null) !== f.sha) throw new Error(`${f.path} changed since the plan`);
        if (f.refresh) e.backup = backup(f.path); else e.dirs = mkdirs(dir, f.path);
        receipt.entries.push(e);
        fs.copyFileSync(f.from, abs);
        e.sha_after = sha(abs);
        save();
      } else if (f.text !== undefined) { // a small file written whole
        if (fs.existsSync(abs)) throw new Error(`${f.path} appeared since the plan`);
        const e = { path: f.path, action: 'create', dirs: mkdirs(dir, f.path) };
        receipt.entries.push(e);
        atomic(abs, f.text, 0o644);
        e.sha_after = sha(abs);
        save();
      } else { // a configuration file: adds-only merge
        const c = configText(dir, f);
        const e = { path: f.path, action: c.existed ? 'edit' : 'create', sha_before: f.sha };
        if (c.existed) e.backup = backup(f.path); else e.dirs = mkdirs(dir, f.path);
        receipt.entries.push(e);
        atomic(abs, c.text, c.existed ? fs.statSync(abs).mode & 0o777 : 0o644);
        e.sha_after = sha(abs);
        save();
      }
    }
    if (p.exclude.length) {
      const gp = execFileSync('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim();
      const ex = path.resolve(dir, gp);
      fs.mkdirSync(path.dirname(ex), { recursive: true });
      const before = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : null;
      const block = `# workstation-steward onboard ${stamp} (receipt ${P.tilde(rp)})\n${p.exclude.join('\n')}\n# end workstation-steward onboard ${stamp}\n`;
      receipt.exclude = { file: P.tilde(ex), existed: before !== null, block };
      save();
      fs.writeFileSync(ex, (before === null ? '' : before.endsWith('\n') || !before ? before : before + '\n') + block);
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

// changedSince(receipt) — touched paths that no longer match what apply wrote
function changedSince(rc) {
  const dir = P.untilde(rc.project), out = [];
  for (const e of rc.entries) {
    if (e.names) for (const n of e.names) { if (unitHash(path.join(dir, e.path, n.name)) !== n.hash) out.push(`${e.path}/${n.name}`); }
    else if (e.sha_after && sha(path.join(dir, e.path)) !== e.sha_after) out.push(e.path);
  }
  if (rc.exclude && !fs.readFileSync(P.untilde(rc.exclude.file), 'utf8').includes(rc.exclude.block)) out.push(rc.exclude.file);
  return out;
}

// undo(receipt) — reverse a receipt's entries, last first: remove what was created, restore what was backed up
function undo(rc) {
  const dir = P.untilde(rc.project);
  if (rc.exclude) {
    const ex = P.untilde(rc.exclude.file);
    if (fs.existsSync(ex)) {
      const t = fs.readFileSync(ex, 'utf8').replace(rc.exclude.block, '');
      if (!rc.exclude.existed && !t.trim()) fs.unlinkSync(ex); else fs.writeFileSync(ex, t);
    }
  }
  for (const e of [...rc.entries].reverse()) {
    const abs = path.join(dir, e.path);
    if (e.names) for (const n of [...e.names].reverse()) fs.rmSync(path.join(abs, n.name), { recursive: true, force: true });
    else if (e.backup) fs.copyFileSync(P.untilde(e.backup), abs);
    else fs.rmSync(abs, { force: true });
    for (const d of [...(e.dirs || [])].reverse()) { try { fs.rmdirSync(path.join(dir, d)); } catch { /* not empty: something else lives there now */ } }
  }
}

module.exports = { plan, apply, undo, changedSince, refusals, addOnly, mergeHooks, unitHash, profileHashes, target, midOperation, CONFIGS };
