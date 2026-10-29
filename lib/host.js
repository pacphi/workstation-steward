#!/usr/bin/env node
// The host policy the supply chain checks (D40): the engine's shared defaults (supply-chain/host-defaults.toml) under
// the instance's own supply-chain/host.toml. A plain value: the instance wins. A list (always_current, vendored_node,
// vendored_node_dirs): the instance adds. A named entry ([[distrusted_root]], [[ioc]], [[updater]]): the instance adds,
// or replaces the default with the same name. An [[updater]] that's incomplete (lib/updaters.js problems) is left out
// and reported. [off] in the instance turns defaults off by name or value. security_exception is
// the instance's alone. Each merged value records its source, and an [off] that matches no default is reported.
// Platforms (R5c): an entry that holds on some platforms only says so with `platforms = ["macos"]` (a named entry, a
// security_exception, or a list item written as a table: { name = "…", platforms = [...] }, or path = for a path);
// without the key it holds everywhere. Entries for another platform are left out here and shown as elsewhere.
// Usage: host.js --json       the merged policy as JSON, the shape host.toml has (lib/lib.sh host_json reads it)
//        host.js              which value came from where: default, yours, or off
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./config.js');
const PL = require('./platform.js');
const U = require('./updaters.js');

const DEFAULTS_FILE = path.join(__dirname, '..', 'supply-chain', 'host-defaults.toml');
const LISTS = ['always_current', 'vendored_node', 'vendored_node_dirs'];
const NAMED = ['distrusted_root', 'ioc', 'updater'];
const SCALARS = ['electron_supported_majors'];

const toml = f => (fs.existsSync(f) ? JSON.parse(execFileSync('yq', ['-p', 'toml', '-o', 'json', '.', f], { encoding: 'utf8' })) || {} : {});

// value(item) — a list item's value: the string itself, or a table's name, path or value
const value = x => (x && typeof x === 'object' ? x.name ?? x.path ?? x.value : x);

// merge(defaults, mine, platform) — { policy, sources: [{key, item, source}], warnings } (pure; host.test.js)
function merge(defaults, mine, platform = PL.current()) {
  const off = mine.off || {};
  const sources = [], warnings = [];
  // here(e, key, src) — whether an entry holds on this platform; one that doesn't is recorded as elsewhere
  const here = (e, key, src) => {
    if (e && typeof e === 'object' && 'platforms' in e) {
      const bad = [].concat(e.platforms).filter(p => !PL.PLATFORMS.includes(p));
      if (!Array.isArray(e.platforms) || bad.length) warnings.push(`${key} ${value(e)}: platforms must list ${PL.PLATFORMS.join(', ')}${bad.length ? ` (not ${bad.join(', ')})` : ''}`);
    }
    if (PL.applies(e, platform)) return true;
    sources.push({ key, item: String(value(e)), source: 'elsewhere', why: `${src}; platforms = ${JSON.stringify(e.platforms)}` });
    return false;
  };
  const policy = { security_exception: (mine.security_exception || []).filter(e => here(e, 'security_exception', 'yours')) };
  for (const k of Object.keys(off)) if (![...LISTS, ...NAMED].includes(k)) warnings.push(`[off] ${k}: not a key that has defaults (${[...LISTS, ...NAMED].join(', ')})`);
  for (const k of SCALARS) {
    if (k in mine) { policy[k] = mine[k]; sources.push({ key: k, item: String(mine[k]), source: 'yours' }); }
    else if (k in defaults) { policy[k] = defaults[k]; sources.push({ key: k, item: String(defaults[k]), source: 'default' }); }
  }
  for (const k of LISTS) {
    const offs = new Set(off[k] || []);
    const out = [];
    for (const x of defaults[k] || []) {
      const v = value(x);
      if (offs.has(v)) { sources.push({ key: k, item: v, source: 'off' }); continue; }
      if (!here(x, k, 'default')) continue;
      out.push(v); sources.push({ key: k, item: v, source: 'default' });
    }
    for (const x of mine[k] || []) { const v = value(x); if (here(x, k, 'yours') && !out.includes(v)) { out.push(v); sources.push({ key: k, item: v, source: 'yours' }); } }
    for (const v of offs) if (!(defaults[k] || []).some(x => value(x) === v)) warnings.push(`[off] ${k}: "${v}" is not a default (a typo?)`);
    policy[k] = out;
  }
  for (const k of NAMED) {
    const offs = new Set(off[k] || []);
    const mineByName = new Map((mine[k] || []).filter(e => here(e, k, 'yours')).map(e => [e.name, e]));
    const out = [];
    for (const d of defaults[k] || []) {
      if (offs.has(d.name)) { sources.push({ key: k, item: d.name, source: 'off' }); continue; }
      if (!mineByName.has(d.name) && !here(d, k, 'default')) continue;
      if (mineByName.has(d.name)) { out.push({ ...mineByName.get(d.name), _source: 'yours' }); sources.push({ key: k, item: d.name, source: 'yours' }); mineByName.delete(d.name); }
      else { out.push({ ...d, _source: 'default' }); sources.push({ key: k, item: d.name, source: 'default' }); }
    }
    for (const e of mineByName.values()) { out.push({ ...e, _source: 'yours' }); sources.push({ key: k, item: e.name, source: 'yours' }); }
    for (const n of offs) if (!(defaults[k] || []).some(d => d.name === n)) warnings.push(`[off] ${k}: "${n}" is not a default (a typo?)`);
    policy[k] = out;
  }
  policy.updater = policy.updater.filter(u => {
    const bad = U.problems(u);
    for (const p of bad) warnings.push(`updater ${u.name} (${u._source}): ${p}; left out`);
    return !bad.length;
  });
  return { policy, sources, warnings };
}

// load() — merge() of this engine's defaults and the instance's host.toml
const load = () => merge(toml(DEFAULTS_FILE), toml(C.instance('supply-chain/host.toml')));

module.exports = { merge, load, DEFAULTS_FILE };

if (require.main === module) {
  const { policy, sources, warnings } = load();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(policy)); process.exit(0); }
  const count = s => sources.filter(x => x.source === s).length;
  console.log(`host policy (${PL.current()}): ${count('default')} default(s) from the engine, ${count('yours')} of yours, ${count('off')} turned off${count('elsewhere') ? `, ${count('elsewhere')} for other platforms` : ''}`);
  for (const s of sources) console.log(`  ${s.source.padEnd(9)} ${s.key.padEnd(20)} ${s.item}${s.why ? ` (${s.why})` : ''}`);
  for (const w of warnings) console.log(`  WARN ${w}`);
}
