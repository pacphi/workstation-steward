// Per-tool profiles (projects/profiles/<tool>.toml, D18): load them, fill in a project's placeholders, merge the
// chosen tools into one per-file view, and check the result against the keep-off list (ai-tooling.toml, D23).
// Read-only: nothing here writes. `steward projects profile-check` compares the result with what projects have, and
// `steward projects onboard` applies it (adds only).
// Usage: profiles.js --check    lint: every profile parses, fills, and violates no keep-off entry (exit 1 if not)
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./config.js');
const P = require('./projects.js');

const DIR = path.join(C.REPO_ROOT, 'projects', 'profiles');
const TOOLS = ['ruflo', 'aqe', 'brain'];
const POLICY = C.policy('ai-tooling/ai-tooling.toml') || {};

function load(tool) {
  const p = P.toml(path.join(DIR, `${tool}.toml`));
  if (!p) throw new Error(`projects/profiles/${tool}.toml is missing or doesn't parse`);
  return p;
}

// placeholders(dir) — {{NAME}} → value for one project, from ai-tooling.toml and this machine
function placeholders(dir) {
  const u = C.untilde;
  const L = POLICY.launch || {};
  const aqe = path.join(u(POLICY.aqe.runtime), 'current');
  return {
    HOME: C.HOME,
    PROJECT: dir,
    NODE: u(L.node),
    RUFLO: u(L.ruflo),
    RUFLO_CLI: path.join(u(L.ruflo), 'node_modules', '@claude-flow', 'cli'),
    RUVECTOR: u(L.ruvector),
    AQE: aqe,
    AQE_PKG: path.join(aqe, 'node_modules', 'agentic-qe'),
    AQE_HOOK_TRANSPORT: u(POLICY.aqe.hook_transport),
    RUFLO_CORE: path.join(u(POLICY.ruflo_core.runtime), 'current'),
    RUFLO_MARKETPLACE: u(POLICY.ruflo.marketplace),
    BRAIN_CODEX_SERVER: u(POLICY.brain.codex_server),
    OS: process.platform,
    ARCH: process.arch,
    SHELL: path.basename(process.env.SHELL || 'sh'),
  };
}

function fill(v, ph) {
  if (typeof v === 'string') return v.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in ph) || ph[k] === undefined) throw new Error(`unknown placeholder ${m}`);
    return ph[k];
  });
  if (Array.isArray(v)) return v.map(x => fill(x, ph));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ph)]));
  return v;
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  return out;
}

// render(tools, dir, {approvals}) — the chosen tools' profiles filled in for one project:
// { settings, settings_local, mcp, codex, hooks: [{tool, event, matcher, command, timeout, continueOnError}],
//   copies: [{tool, from, to, exclude}], writes: [{tool, path, text}], manual: [{tool, text}] }
// Shared names (D26): when two chosen tools copy into the same folder, the first in TOOLS order owns every name its
// install ships there (Ruflo, for the Claude-Flow skills, commands and agents AQE also bundles); later tools' copies
// exclude those names. Computed from the installed sources, so it follows a qualified upgrade.
function render(tools, dir, opts = {}) {
  const ph = placeholders(dir);
  const out = { settings: {}, settings_local: {}, mcp: { mcpServers: {} }, codex: {}, hooks: [], copies: [], writes: [], manual: [] };
  for (const tool of TOOLS.filter(t => tools.includes(t))) {
    const p = fill(load(tool), ph);
    out.settings = merge(out.settings, p.settings);
    out.settings_local = merge(out.settings_local, p.settings_local);
    out.mcp.mcpServers = merge(out.mcp.mcpServers, p.mcp);
    const codex = { ...(p.codex || {}) };
    const approve = codex.approve || {};
    const prompt = codex.prompt || {}; // tools that must ask (D37): written even with --no-approvals, since they restrict
    delete codex.approve;
    delete codex.prompt;
    const tools = {};
    if (opts.approvals !== false) for (const [srv, names] of Object.entries(approve)) for (const n of names) (tools[srv] = tools[srv] || {})[n] = { approval_mode: 'approve' };
    for (const [srv, names] of Object.entries(prompt)) for (const n of names) (tools[srv] = tools[srv] || {})[n] = { approval_mode: 'prompt' };
    for (const [srv, t] of Object.entries(tools)) codex.mcp_servers[srv].tools = t;
    out.codex = merge(out.codex, codex);
    for (const h of p.hook || []) out.hooks.push({ tool, matcher: '', continueOnError: undefined, ...h });
    for (const c of p.copy || []) out.copies.push({ tool, exclude: [], ...c });
    for (const w of p.write || []) out.writes.push({ tool, path: w.path, text: w.text !== undefined ? w.text : JSON.stringify(w.json, null, 2) + '\n' });
    for (const m of p.manual || []) out.manual.push({ tool, text: m.text });
  }
  out.copies.forEach((c, i) => {
    for (const o of out.copies.slice(0, i)) if (o.to === c.to && o.tool !== c.tool) c.exclude = [...new Set([...c.exclude, ...names(o)])];
  });
  return out;
}

// listFiles(d) — every file under d, as paths relative to it
function listFiles(d, rel = '') {
  let out = [];
  let es; try { es = fs.readdirSync(path.join(d, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const r = rel ? `${rel}/${e.name}` : e.name; out = e.isDirectory() ? out.concat(listFiles(d, r)) : out.concat(r); }
  return out;
}

// byEntry(to) — whether a copied folder's unit is a top-level entry (a helper, or a skill's whole folder) rather than
// each file (commands and agents, nested in category folders)
const byEntry = to => /(^|\/)(helpers|skills)$/.test(to);

// names(copy, root) — the units a folder copy ships (root = its source), or a project has (root = the project's
// folder at c.to), minus its excludes
function names(c, root = c.from) {
  let es;
  try { es = byEntry(c.to) ? fs.readdirSync(root) : listFiles(root); } catch { return []; }
  return es.filter(n => !c.exclude.includes(n));
}

// hooksObject(hooks) — Claude Code's settings.json hooks shape: {Event: [{matcher?, hooks: [{type, command, …}]}]}
function hooksObject(hooks) {
  const out = {};
  for (const h of hooks) {
    const groups = (out[h.event] = out[h.event] || []);
    let g = groups.find(x => (x.matcher || '') === h.matcher);
    if (!g) { g = h.matcher ? { matcher: h.matcher, hooks: [] } : { hooks: [] }; groups.push(g); }
    g.hooks.push({ type: 'command', command: h.command, timeout: h.timeout, ...(h.continueOnError ? { continueOnError: true } : {}) });
  }
  return out;
}

// hookKey(command) — what a hook runs, independent of how it's written: '<script> <subcommand>' for the helper and
// hook scripts (hook-handler.cjs post-edit, aqe-hook.cjs route…), with the older `npx agentic-qe hooks <sub>` wiring
// counted as aqe-hook.cjs. Two hooks on one event with the same key do the same work, so onboarding never adds a
// second one (an older form with other quoting, an inline env or another matcher is kept instead).
function hookKey(command) {
  const c = String(command || '');
  // the last script with a subcommand is the one that runs: inline env values before it can end in .cjs too
  const all = [...c.matchAll(/([A-Za-z0-9_-]+\.(?:cjs|mjs))["']?\s+([a-z][a-z-]*)/g)];
  if (all.length) { const m = all[all.length - 1]; return `${m[1]} ${m[2]}`; }
  const m = c.match(/agentic-qe\s+hooks\s+([a-z-]+)/);
  return m ? `aqe-hook.cjs ${m[1]}` : null;
}

// get(obj, 'a.b.c') — a value by dotted path; keys may contain dots only via the profiles' quoted names, which the
// keep-off list never uses
const get = (o, key) => key.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);

// keepOff(rendered) — [{file, key, why, found}] for every keep-off entry the rendered profiles break
function keepOff(r) {
  const files = { settings: { ...r.settings, hooks: hooksObject(r.hooks) }, settings_local: r.settings_local, mcp: r.mcp, codex: r.codex };
  const out = [];
  for (const k of POLICY.keep_off || []) {
    const v = get(files[k.file], k.key);
    if (v === undefined) continue;
    if (!('value' in k) || JSON.stringify(v) !== JSON.stringify(k.value)) out.push({ ...k, found: v });
  }
  return out;
}

// knownVendor() — Map sha256 → {file, origin} for vendor files onboarding may refresh (known-vendor-files.toml, D25)
let known = null;
function knownVendor() {
  if (known) return known;
  const k = P.toml(path.join(DIR, 'known-vendor-files.toml'));
  known = new Map(((k && k.known) || []).map(e => [e.sha256, e]));
  return known;
}

// knownUnits() — Map unit → Map(sha256 → origin) for every unit a published Ruflo, claude-flow or AQE release shipped
// (known-units.json, built by tools/known-units.js; D42): reconcile counts a project's copy with no receipt baseline
// as unedited when its hash is listed for that unit
let units = null;
function knownUnits() {
  if (units) return units;
  const k = P.readJSON(path.join(DIR, 'known-units.json'));
  units = new Map(Object.entries((k && k.units) || {}).map(([u, hs]) => [u, new Map(Object.entries(hs))]));
  return units;
}

module.exports = { TOOLS, POLICY, load, placeholders, render, hooksObject, hookKey, keepOff, get, knownVendor, knownUnits, names, byEntry, listFiles };

if (require.main === module && process.argv[2] === '--check') {
  let bad = 0;
  try {
    const r = render(TOOLS, path.join(os.tmpdir(), 'profile-check-project'));
    for (const v of keepOff(r)) { bad++; console.error(`keep-off: ${v.file} ${v.key} = ${JSON.stringify(v.found)} (${v.why})`); }
    for (const h of r.hooks) if (!(h.timeout > 0 && h.timeout <= 600)) { bad++; console.error(`${h.tool} hook ${h.event}: timeout ${h.timeout} isn't seconds`); }
    if (!knownVendor().size) { bad++; console.error('known-vendor-files.toml is missing or empty'); }
    const seen = new Map();
    for (const c of r.copies) if (fs.existsSync(c.from) && fs.statSync(c.from).isDirectory()) for (const n of names(c)) {
      const k = `${c.to}/${n}`;
      if (seen.has(k) && seen.get(k) !== c.tool) { bad++; console.error(`${k} is copied by both ${seen.get(k)} and ${c.tool}`); }
      seen.set(k, c.tool);
    }
    console.log(`profiles: ${TOOLS.join(', ')}: ${r.hooks.length} hooks, ${Object.keys(r.mcp.mcpServers).length} .mcp.json and ${Object.keys(r.codex.mcp_servers || {}).length} Codex servers, ${r.copies.length} copies; ${bad ? `${bad} problem(s)` : 'keep-off ok'}`);
  } catch (e) { bad++; console.error(`profiles: ${e.message}`); }
  process.exit(bad ? 1 : 0);
}
