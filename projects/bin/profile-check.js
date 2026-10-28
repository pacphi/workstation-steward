#!/usr/bin/env node
// Compare what each project has with what its chosen tools' profiles would give it (projects/profiles/, D18), and
// say why every difference exists. Read-only. This is the proof that the profiles aren't one project's copy: each
// difference must land in a known bucket, and anything that doesn't is listed as unexplained.
// Usage: profile-check.js [<path>] [--detail] [--json]
//   buckets: add (onboarding would add it), refresh (an unedited older vendor file onboarding would replace, D25), older (an older Ruflo/AQE generation), init (written by ruflo/aqe init
//   or @claude-flow/codex, which onboarding never runs), own (the project's own choice, or the owner's trust and
//   permission settings; and copied files that differ from the qualified source: kept), keepoff (breaks the keep-off list: fix through a reviewed change), latest (an
//   unpinned @latest launcher, 5b), unexplained
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../../lib/projects.js');
const { progress } = require('../../lib/progress.js');
const F = require('../../lib/profiles.js');

const args = process.argv.slice(2);
const detail = args.includes('--detail'), json = args.includes('--json');
const target = args.find(a => !a.startsWith('--'));

// Ruflo hook-handler subcommands older generations wire that 3.59.8's helper no longer handles.
const RUFLO_NOOP = new Set(['notify', 'status', 'compact-manual', 'compact-auto', 'pre-edit', 'post-bash']);
const INIT_TOP = new Set(['aqe', 'v3Configuration', 'v3Learning', 'model', 'mcpServers']);
const OWN_TOP = new Set(['permissions', 'enabledMcpjsonServers', 'includeCoAuthoredBy', 'enableAllProjectMcpServers', 'attribution']);
const DUAL_MODE_ENV = new Set(['ENABLE_CLAUDE_CODE', 'ENABLE_CODEX', 'CLAUDE_FLOW_DB_PATH']);

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function leaves(o, pre = '', out = {}) {
  if (isObj(o) && Object.keys(o).length) for (const [k, v] of Object.entries(o)) leaves(v, pre ? `${pre}.${k}` : k, out);
  else out[pre] = o;
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
// unitHash(p) — a file's sha256, or a folder's (each file's relative path and sha256, sorted)
const unitHash = p => {
  try {
    if (!fs.statSync(p).isDirectory()) return sha(p);
    const c = crypto.createHash('sha256');
    for (const f of F.listFiles(p).sort()) c.update(`${f}\0${sha(path.join(p, f))}\0`);
    return c.digest('hex');
  } catch { return null; }
};

function check(r) {
  const dir = r.abs, tools = r.ai || [];
  const want = F.render(tools, dir);
  const items = [];
  const put = (bucket, where, what) => { if (!items.some(i => i.bucket === bucket && i.where === where && i.what === what)) items.push({ bucket, where, what }); };
  const read = f => P.readJSON(path.join(dir, f)) || {};
  const s = read('.claude/settings.json'), sl = read('.claude/settings.local.json'), mcp = read('.mcp.json');
  const cx = P.toml(path.join(dir, '.codex/config.toml')) || {};
  const short = v => { const t = JSON.stringify(v); return t === undefined ? 'absent' : t.split(P.HOME).join('~').slice(0, 90); };

  // settings.json and settings.local.json, key by key (hooks below)
  for (const [file, have, wantObj] of [['settings.json', s, want.settings], ['settings.local.json', sl, want.settings_local]]) {
    const w = leaves(wantObj), h = leaves(Object.fromEntries(Object.entries(have).filter(([k]) => k !== 'hooks')));
    for (const [k, v] of Object.entries(w)) {
      if (k === '') continue;
      if (same(h[k], v)) continue;
      if (h[k] === undefined) { put('add', file, k); continue; }
      if (/agentTeams.*autoAssign/.test(k) && h[k] === true) put('keepoff', file, `${k} = true`);
      else if (/^claudeFlow\.modelPreferences\.default$/.test(k)) put('own', file, `${k} = ${short(h[k])}`);
      else if (k.startsWith('statusLine.')) put('own', file, `${k} differs (a project's own statusline)`);
      else put('unexplained', file, `${k}: has ${short(h[k])}, profile ${short(v)}`);
    }
    for (const k of Object.keys(h)) {
      if (k === '' || k in w || Object.keys(w).some(x => x.startsWith(k + '.') || k.startsWith(x + '.'))) continue;
      const top = k.split('.')[0];
      if (OWN_TOP.has(top)) put('own', file, `${top} (the owner's trust or permission settings)`);
      else if (INIT_TOP.has(top)) put('init', file, top);
      else if (/^env\.AQE_/.test(k)) put(file === 'settings.json' ? 'init' : 'own', file, k);
      else if (/^env\./.test(k) && DUAL_MODE_ENV.has(k.slice(4))) {
        const v = String(h[k]);
        if (k === 'env.CLAUDE_FLOW_DB_PATH' && !v.startsWith(dir + '/')) put('unexplained', file, `${k} points outside the project: ${short(v)}`);
        else put('init', file, `${k} (@claude-flow/codex dual mode)`);
      } else if (top === 'enabledPlugins') put('own', file, `${k.slice(15)} plugin`);
      else if (top === 'statusLine') put('own', file, `${k} (a project's own statusline)`);
      else put('unexplained', file, `${k} = ${short(h[k])}`);
    }
  }
  // hooks
  const have = [];
  for (const [ev, groups] of Object.entries(s.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) have.push({ event: ev, matcher: g.matcher || '', command: h.command, timeout: h.timeout });
  const used = new Set();
  for (const w of want.hooks) {
    const i = have.findIndex((h, j) => !used.has(j) && h.event === w.event && h.matcher === w.matcher && h.command === w.command);
    // the same work in an older form (F.hookKey; the matcher counts only when the profile splits a key by it):
    // onboarding keeps it and doesn't add a second (lib/onboard.js mergeHooks)
    const k = F.hookKey(w.command);
    const split = want.hooks.filter(x => x.event === w.event && F.hookKey(x.command) === k).length > 1;
    const o = i < 0 && k ? have.findIndex((h, j) => !used.has(j) && h.event === w.event && F.hookKey(h.command) === k && (!split || h.matcher === w.matcher)) : -1;
    if (o >= 0) { used.add(o); put('older', 'hooks', `${w.tool} ${w.event} ${k}: an older form${have[o].matcher !== w.matcher ? ` (matcher ${have[o].matcher || 'none'})` : ''}; kept, not doubled`); continue; }
    if (i < 0) { put('add', 'hooks', `${w.tool} ${w.event}${w.matcher ? ` ${w.matcher}` : ''} ${(w.command.match(/(hook-handler\.cjs|auto-memory-hook\.mjs|aqe-hook\.cjs|brain-checkpoint\.cjs)"?'? ([a-z-]+)/) || []).slice(1).join(' ')}`); continue; }
    used.add(i);
    const t = have[i].timeout;
    if (t !== w.timeout) put(t >= 1000 ? 'older' : 'unexplained', 'hooks', `${w.event} ${w.command.match(/([a-z-]+)(\.cjs|\.mjs)"?'? ([a-z-]+)/)?.[3] || ''}: timeout ${t} (profile ${w.timeout}s)${t >= 1000 ? ', milliseconds-shaped' : ''}`);
  }
  have.forEach((h, j) => {
    if (used.has(j)) return;
    const sub = (h.command.match(/(?:hook-handler\.cjs|auto-memory-hook\.mjs)"?'? ([a-z-]+)/) || [])[1];
    const label = `${h.event}${h.matcher ? ` ${h.matcher}` : ''} ${sub || h.command.slice(0, 50)}`;
    if (/hook-handler\.cjs/.test(h.command) && RUFLO_NOOP.has(sub)) put('older', 'hooks', `${label} (no-op under Ruflo 3.59.8)`);
    else if (/auto-memory-hook\.mjs.*sync/.test(h.command) && h.event === 'SessionEnd') put('older', 'hooks', `${label} (the minimal set syncs on SessionEnd; 3.59.8 on Stop)`);
    else if (/auto-memory-hook\.mjs.*import/.test(h.command)) put('older', 'hooks', `${label} timeout ${h.timeout}`);
    else if (/npx agentic-qe hooks/.test(h.command)) put('older', 'hooks', `${h.event} AQE via npx (older AQE wiring)`);
    else if (/AQE_HOOK_BUNDLE=.*transports\/v1/.test(h.command)) put('older', 'hooks', `${h.event} AQE via transport v1 inline env`);
    else if (/aqe-hook\.cjs|brain-checkpoint\.cjs/.test(h.command) && !tools.includes('aqe')) put('unexplained', 'hooks', `${label} (AQE not chosen)`);
    else put('unexplained', 'hooks', `${label}: ${h.command.split(P.HOME).join('~').slice(0, 80)}`);
  });
  // .mcp.json
  for (const [name, w] of Object.entries(want.mcp.mcpServers)) {
    const h = (mcp.mcpServers || {})[name];
    if (!h) { put('add', '.mcp.json', name); continue; }
    for (const [k, v] of Object.entries(leaves({ command: w.command, args: w.args, env: w.env }))) {
      const hv = leaves({ command: h.command, args: h.args || [], env: h.env || {} })[k];
      if (same(hv, v) || (k === 'env' && !Object.keys(h.env || {}).length)) continue;
      if (hv === undefined) put('add', '.mcp.json', `${name} ${k}`);
      else if (k === 'env.AQE_EMBEDDER_ENDPOINT') put('own', '.mcp.json', `${name}: its own embedder endpoint`);
      else if (k === 'command' && name === 'agentic-qe' && hv === 'aqe-mcp') put('own', '.mcp.json', `${name}: bare aqe-mcp (gap 1, known)`);
      else put('unexplained', '.mcp.json', `${name} ${k}: ${short(hv)}`);
    }
    for (const k of Object.keys(h.env || {})) if (!(k in (w.env || {}))) put(/^(AQE_LEARNING_ENABLED|AQE_WORKERS_ENABLED|NODE_ENV|AQE_V3_MODE)$/.test(k) ? 'init' : 'unexplained', '.mcp.json', `${name} env.${k}`);
  }
  for (const [name, h] of Object.entries(mcp.mcpServers || {})) {
    if (name in want.mcp.mcpServers) continue;
    const cmd = [h.command, ...(h.args || [])].join(' ');
    if (/@latest|^npx /.test(cmd)) put('latest', '.mcp.json', `${name}: ${cmd.slice(0, 50)}`);
    else if (h.type === 'http' || name === path.basename(dir)) put('own', '.mcp.json', `${name} (the project's own server)`);
    else put('unexplained', '.mcp.json', `${name}: ${cmd.split(P.HOME).join('~').slice(0, 60)}`);
  }
  // .codex/config.toml
  const wc = want.codex;
  for (const [k, v] of Object.entries(leaves(wc.plugins || {}))) if (!same(leaves(cx.plugins || {})[k], v)) put('add', 'codex', `plugins.${k}`);
  for (const k of Object.keys(cx.plugins || {})) if (!(k in (wc.plugins || {}))) put('own', 'codex', `plugin ${k}`);
  for (const [name, w] of Object.entries(wc.mcp_servers || {})) {
    const h = (cx.mcp_servers || {})[name];
    if (!h) { put('add', 'codex', `mcp_servers.${name}`); continue; }
    const { tools: wt = {}, ...wr } = w, { tools: ht = {}, ...hr } = h;
    const hl = leaves({ ...hr, args: hr.args || [] });
    for (const [k, v] of Object.entries(leaves({ ...wr, args: wr.args || [] }))) {
      if (same(hl[k], v) || (k === 'env' && !Object.keys(hr.env || {}).length)) continue;
      if (hl[k] === undefined) put('add', 'codex', `${name} ${k}`);
      else if (k === 'env.AQE_EMBEDDER_ENDPOINT') put('own', 'codex', `${name}: its own embedder endpoint`);
      else if (k === 'command' && hl[k] === 'aqe-mcp') put('own', 'codex', `${name}: bare aqe-mcp (gap 1, known)`);
      // a relative store path resolves against the project (Codex and the server start there)
      else if (k === 'env.AQE_MEMORY_PATH' && hl[k] && !path.resolve(dir, String(hl[k])).startsWith(dir + path.sep)) put('unexplained', 'codex', `${name} ${k} points outside the project`);
      else if (k === 'env.AQE_MEMORY_PATH') put('own', 'codex', `${name} ${k} = ${short(hl[k])} (inside the project)`);
      else put('unexplained', 'codex', `${name} ${k}: ${short(hl[k])}`);
    }
    for (const k of Object.keys(hr.env || {})) if (!(k in (wr.env || {}))) put(/^(AQE_V3_MODE|AQE_LEARNING_ENABLED|AQE_WORKERS_ENABLED)$/.test(k) ? 'init' : 'unexplained', 'codex', `${name} env.${k}`);
    for (const k of Object.keys(hr)) if (!(k in wr) && !['env', 'args'].includes(k)) put(k === 'startup_timeout_sec' ? 'own' : 'unexplained', 'codex', `${name} ${k}`);
    const missing = Object.keys(wt).filter(t => !(t in ht)), extra = Object.keys(ht).filter(t => !(t in wt));
    const prompted = Object.entries(ht).filter(([t, v]) => t in wt && v && v.approval_mode !== 'approve').map(([t]) => t);
    if (missing.length) put('add', 'codex', `${name}: ${missing.length} approval(s)`);
    if (extra.length) put('unexplained', 'codex', `${name}: ${extra.length} approval(s) beyond the vetted set: ${extra.slice(0, 4).join(', ')}`);
    if (prompted.length) put('own', 'codex', `${name}: ${prompted.join(', ')} kept on prompt (stricter)`);
  }
  for (const k of Object.keys(cx.mcp_servers || {})) if (!(k in (wc.mcp_servers || {}))) put('unexplained', 'codex', `mcp_servers.${k} (not in the chosen profiles)`);
  for (const k of Object.keys(cx).filter(k => !['mcp_servers', 'plugins'].includes(k))) put('own', 'codex', `${k} (the project's own Codex policy)`);
  // files written whole
  for (const w of want.writes) {
    const f = path.join(dir, w.path);
    if (!P.exists(f)) { put('add', 'files', w.path); continue; }
    if (w.path.endsWith('.json')) {
      const hv = P.readJSON(f) || {}, wv = JSON.parse(w.text);
      for (const [k, v] of Object.entries(wv)) if (!same(hv[k], v)) put('unexplained', 'files', `${w.path} ${k}: ${short(hv[k])}`);
      const extra = Object.keys(hv).filter(k => !(k in wv));
      if (extra.length) put('init', 'files', `${w.path}: ${extra.join(', ')} (written by ruflo init)`);
    }
  }
  // files copied from the qualified installs: a .LOCKED folder is owner-managed (names only, never content)
  for (const c of want.copies) {
    const isDir = fs.existsSync(c.from) && fs.statSync(c.from).isDirectory();
    const to = path.join(dir, c.to);
    if (!isDir) {
      if (!P.exists(to)) put('add', 'files', c.to);
      else if (sha(to) !== sha(c.from)) {
        const k = F.knownVendor().get(sha(to));
        if (k && k.file === c.to) put('refresh', 'files', `${c.to}: unedited vendor copy (${k.origin}); onboarding would refresh it`);
        else put('own', 'files', `${c.to}: an edited copy; kept unless named (--refresh ${c.to})`);
      }
      continue;
    }
    const locked = P.exists(path.join(to, '.LOCKED'));
    const src = F.names(c);
    const present = new Set(F.names({ ...c, exclude: [] }, to));
    const missing = src.filter(n => !present.has(n));
    if (missing.length) put('add', 'files', `${c.to}: ${missing.length} of ${src.length} from ${c.tool}${locked ? ' (locked folder: adds names only)' : ''}`);
    if (locked) continue;
    // Unlocked: compare each present unit with its owner's source (D26). Another chosen tool's copy of a name this
    // tool owns, or a copy that matches neither, is kept (adds only); which it is can't be told from an edit.
    const others = want.copies.filter(o => o !== c && o.to === c.to);
    let other = 0, neither = 0;
    for (const n of src.filter(n => present.has(n))) {
      const h = unitHash(path.join(to, n));
      if (h === unitHash(path.join(c.from, n))) continue;
      if (others.some(o => P.exists(path.join(o.from, n)) && h === unitHash(path.join(o.from, n)))) other++;
      else neither++;
    }
    const by = others.map(o => o.tool).join('/');
    if (other) put('own', 'files', `${c.to}: ${other} ${c.tool}-owned name(s) hold ${by}'s copy; kept (adds only, D26)`);
    if (neither) put('own', 'files', `${c.to}: ${neither} ${c.tool} name(s) differ from the qualified source (an older generation or an edit); kept`);
  }
  return items;
}

const rows = P.loadRegistry()
  .filter(r => r.decision === 'onboarded' && (r.ai || []).length && P.exists(r.abs))
  .filter(r => !target || r.abs === P.userPath(target));
if (target && !rows.length) { console.error(`not an onboarded project with AI tools in the registry: ${target}`); process.exit(1); }
const B = ['add', 'refresh', 'older', 'init', 'own', 'keepoff', 'latest', 'unexplained'];
const st = progress(1).stage(`check ${rows.length} project(s)`);
const results = rows.map((r, i) => { st.detail(`${i + 1}/${rows.length} ${r.path}`); return { path: r.path, ai: r.ai, items: check(r) }; });
st.done(`${results.length} checked`);
// No process.exit after output: a pipe is written asynchronously and would be cut off.
if (json) console.log(JSON.stringify(results, null, 1));
else {
  console.log(`${'project'.padEnd(46)} ${B.map(b => b.padStart(Math.max(b.length, 5))).join(' ')}`);
  const total = Object.fromEntries(B.map(b => [b, 0]));
  const short = P.shortener(results.map(x => x.path));
  for (const x of results) {
    const c = Object.fromEntries(B.map(b => [b, x.items.filter(i => i.bucket === b).length]));
    for (const b of B) total[b] += c[b];
    console.log(`${short(x.path).padEnd(46)} ${B.map(b => String(c[b] || '·').padStart(Math.max(b.length, 5))).join(' ')}`);
    if (detail || target) for (const b of B) for (const i of x.items.filter(i => i.bucket === b)) console.log(`    ${b.padEnd(11)} ${i.where.padEnd(19)} ${i.what}`);
  }
  console.log(`${'total'.padEnd(46)} ${B.map(b => String(total[b]).padStart(Math.max(b.length, 5))).join(' ')}`);
  const un = results.flatMap(x => x.items.filter(i => i.bucket === 'unexplained').map(i => ({ ...i, path: x.path })));
  if (un.length && !detail && !target) {
    console.log(`\nunexplained (${un.length}):`);
    for (const i of un) console.log(`  ${short(i.path)}  ${i.where}  ${i.what}`);
  }
}
