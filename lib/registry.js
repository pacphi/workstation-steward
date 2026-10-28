// projects/registry.toml: read, change and write the owner's per-project decisions (D5, D14).
// The writer keeps the file's leading comment block and writes entries in a fixed field order.
const fs = require('fs');
const P = require('./projects.js');

const DECISIONS = ['unconfirmed', 'onboarded', 'ignored', 'deferred'];
const TOOLS = ['ruflo', 'aqe', 'brain'];
const FIELDS = ['path', 'kind', 'parent', 'remote', 'decision', 'ai', 'ai_seed', 'seed_status', 'decided', 'until', 'inherits', 'note'];

function header() {
  if (!fs.existsSync(P.REGISTRY)) return '# Projects and the owner\'s decision for each (D5 in docs/architecture.md).\n\n';
  const lines = fs.readFileSync(P.REGISTRY, 'utf8').split('\n');
  const out = [];
  for (const l of lines) { if (l.startsWith('#') || l === '') out.push(l); else break; }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n\n';
}

const q = s => JSON.stringify(s);
function entry(e) {
  const lines = ['[[project]]'];
  for (const k of FIELDS) {
    if (!(k in e) || e[k] === undefined || e[k] === null || (e[k] === '' && k !== 'decision')) continue;
    const v = e[k];
    lines.push(`${k} = ${Array.isArray(v) ? `[${v.map(q).join(', ')}]` : q(v)}`);
  }
  return lines.join('\n') + '\n';
}

// entries() — registry entries as plain objects (paths in ~ form, as stored)
function entries() { return P.loadRegistry().map(({ abs, ...e }) => e); }

function render(list) { return header() + list.map(entry).join('\n'); }

// validate(e) — list of problems with one entry
function validate(e) {
  const p = [];
  if (!DECISIONS.includes(e.decision)) p.push(`decision must be one of ${DECISIONS.join(', ')}`);
  for (const t of e.ai || []) if (!TOOLS.includes(t)) p.push(`unknown AI tool "${t}" (known: ${TOOLS.join(', ')})`);
  if (e.decision === 'deferred' && !/^\d{4}-\d{2}-\d{2}$/.test(e.until || '')) p.push('deferred needs until = YYYY-MM-DD');
  if (e.decision !== 'deferred' && e.until) p.push('until applies only to deferred');
  return p;
}

module.exports = { DECISIONS, TOOLS, entries, render, validate, entry };
