// Text writers for onboarding's adds-only merges (lib/onboard.js): the merged object goes back to disk without
// disturbing what the project had. JSON keeps the file's indent, trailing newline and key order. TOML is never
// re-serialized: new keys are inserted as lines into the file's own text, so its comments, layout and order stay.
// Both are checked by parsing the result and comparing it with the merged object (canon).
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// canon(v) — JSON text with object keys sorted, for comparing parsed results regardless of key order
const canon = v => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));

// ordered(have, next) — next with have's keys first, in have's order (recursively), then the keys onboarding added
function ordered(have, next) {
  if (!isObj(have) || !isObj(next)) return next;
  const out = {};
  for (const k of Object.keys(have)) if (k in next) out[k] = ordered(have[k], next[k]);
  for (const k of Object.keys(next)) if (!(k in out)) out[k] = next[k];
  return out;
}

// jsonText(originalText, have, next) — next as JSON in the original file's style (indent, final newline); a new
// file gets two spaces and a final newline
function jsonText(original, have, next) {
  const indent = original ? ((original.split('\n').find((l, i) => i > 0 && /^\s+\S/.test(l)) || '').match(/^\s*/)[0] || '  ') : '  ';
  return JSON.stringify(ordered(have, next), null, indent) + (original === null || original.endsWith('\n') ? '\n' : '');
}

// TOML pieces
const bare = k => /^[A-Za-z0-9_-]+$/.test(k);
const key = k => (bare(k) ? k : JSON.stringify(k));
function value(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return String(v);
  if (Array.isArray(v) && v.every(x => ['string', 'boolean', 'number'].includes(typeof x))) return `[${v.map(value).join(', ')}]`;
  throw new Error(`no TOML form for ${JSON.stringify(v)}`);
}

// headerPath(line) — the key path of a `[a."b.c".d]` table header, or null (array-of-tables headers are null too)
function headerPath(line) {
  const m = line.match(/^\s*\[(?!\[)(.*)\]\s*(#.*)?$/);
  if (!m) return null;
  const out = [];
  const s = m[1].trim();
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      let j = i + 1, part = '';
      for (; j < s.length && s[j] !== q; j++) {
        if (q === '"' && s[j] === '\\') { part += JSON.parse(`"${s.slice(j, j + 2)}"`); j++; } else part += s[j];
      }
      out.push(part);
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== '.' && s[j] !== ' ') j++;
      out.push(s.slice(i, j));
      i = j;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '.') i++;
  }
  return out;
}

const getPath = (o, p) => p.reduce((v, k) => (isObj(v) ? v[k] : undefined), o);

// tomlAdd(text, have, next) — text with every leaf of next that have lacks inserted: under the table's own header
// when it already has one, otherwise as new [table] blocks at the end. Throws when a key would have to go into a
// table the file defines without a header (inline or dotted), which a text insertion can't extend safely.
function tomlAdd(text, have, next) {
  const groups = new Map(); // parent path (joined) → {path, entries: [[key, value]]}
  (function walk(h, n, p) {
    for (const [k, v] of Object.entries(n)) {
      if (isObj(h) && k in h) { if (isObj(v) && isObj(h[k])) walk(h[k], v, [...p, k]); continue; }
      if (isObj(v)) {
        const id = JSON.stringify([...p, k]);
        if (!groups.has(id)) groups.set(id, { path: [...p, k], entries: [] });
        walk({}, v, [...p, k]);
      } else {
        const id = JSON.stringify(p);
        if (!groups.has(id)) groups.set(id, { path: p, entries: [] });
        groups.get(id).entries.push([k, v]);
      }
    }
  })(have, next, []);
  const lines = (text || '').split('\n');
  const tail = [];
  for (const g of groups.values()) {
    const existing = getPath(have, g.path);
    if (existing !== undefined) {
      if (!g.path.length) throw new Error('adding top-level keys to an existing TOML file is not supported');
      const at = lines.findIndex(l => { const hp = headerPath(l); return hp && JSON.stringify(hp) === JSON.stringify(g.path); });
      if (at < 0) throw new Error(`[${g.path.join('.')}] has no header line to add under`);
      let end = at + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
      while (end > at + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
      lines.splice(end, 0, ...g.entries.map(([k, v]) => `${key(k)} = ${value(v)}`));
    } else {
      tail.push('', `[${g.path.map(key).join('.')}]`, ...g.entries.map(([k, v]) => `${key(k)} = ${value(v)}`));
    }
  }
  let out = lines.join('\n');
  if (tail.length) out = out.replace(/\n*$/, '\n') + tail.join('\n').replace(/^\n/, out.trim() ? '\n' : '') + '\n';
  return out;
}

// tomlRemoveTables(text, have, prefix) — text without the table at key path `prefix` and every sub-table under it:
// each header line from `[prefix]` (or `[prefix.…]`) up to the next header is dropped, with the comment and blank
// lines directly above it. Throws when the table is also defined without a header (inline or dotted keys), which a
// line removal can't reach.
function tomlRemoveTables(text, prefix) {
  const lines = text.split('\n');
  const under = hp => hp && hp.length >= prefix.length && prefix.every((k, i) => hp[i] === k);
  const keep = new Array(lines.length).fill(true);
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!under(headerPath(lines[i]))) continue;
    removed++;
    let j = i;
    while (j > 0 && keep[j - 1] && /^\s*(#.*)?$/.test(lines[j - 1]) && !headerPath(lines[j - 1])) j--;
    let k = i + 1;
    while (k < lines.length && !/^\s*\[/.test(lines[k])) k++;
    // keep a blank line that separates what follows, unless the removed block ran to the end
    for (let x = j; x < k; x++) keep[x] = false;
    if (k < lines.length && j > 0) keep[j] = true, lines[j] = '';
  }
  if (!removed) throw new Error(`[${prefix.join('.')}] has no header line to remove`);
  return lines.filter((_, i) => keep[i]).join('\n').replace(/\n{3,}/g, '\n\n');
}

// tomlSet(text, table, key, v) — text with `key` in the top-level `[table]` set to v, one line changed: the value is
// replaced where the key is (its trailing comment kept in its column), else the key goes under the table's header,
// else a new [table] goes at the end. For steward.toml's single-line values (init's answers, D48).
function tomlSet(text, table, key, v) {
  const lines = text.split('\n');
  const want = value(v);
  let inTable = false, header = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[\[/.test(lines[i])) { inTable = false; continue; }
    const h = headerPath(lines[i]);
    if (h) { inTable = h.length === 1 && h[0] === table; if (inTable) header = i; continue; }
    const m = inTable && lines[i].match(/^(\s*([A-Za-z0-9_-]+)\s*=\s*)(.*?)(\s+)(#.*)$|^(\s*([A-Za-z0-9_-]+)\s*=\s*)(.*?)\s*$/);
    if (!m || (m[2] || m[7]) !== key) continue;
    lines[i] = m[1] ? `${m[1]}${want}${' '.repeat(Math.max(1, m[4].length + m[3].length - want.length))}${m[5]}` : `${m[6]}${want}`;
    return lines.join('\n');
  }
  if (header >= 0) { lines.splice(header + 1, 0, `${key} = ${want}`); return lines.join('\n'); }
  return `${text}${text.endsWith('\n') || !text ? '' : '\n'}\n[${table}]\n${key} = ${want}\n`;
}

module.exports = { canon, ordered, jsonText, tomlAdd, tomlRemoveTables, tomlSet, headerPath };
