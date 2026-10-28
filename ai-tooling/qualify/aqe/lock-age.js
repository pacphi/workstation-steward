#!/usr/bin/env node
// lock-age.js <stage package-lock.json> <days> [<current release package-lock.json>]
// Every package the stage resolves that the current release doesn't already have (name@version) must be at least
// <days> old by its registry publish time; local file: packages (the patched agentic-qe) are skipped. Prints JSON;
// exits 1 when any is younger or its time can't be read.
const fs = require('fs');
const { execFileSync } = require('child_process');
const [stage, days, current] = process.argv.slice(2);
const entries = f => Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).packages || {})
  .filter(([k, v]) => k && v.version && !v.link && !(v.resolved || '').startsWith('file:'))
  .map(([k, v]) => `${v.name || k.split('node_modules/').pop()}@${v.version}`);
const have = new Set(current && fs.existsSync(current) ? entries(current) : []);
const fresh = [...new Set(entries(stage))].filter(e => !have.has(e)).sort();
const cutoff = Date.now() - Number(days) * 864e5;
const out = { days: Number(days), newSinceCurrent: fresh.length, under: [], unknown: [], ok: [] };
const times = {};
for (const e of fresh) {
  const at = e.lastIndexOf('@'), name = e.slice(0, at), version = e.slice(at + 1);
  try { times[name] = times[name] || JSON.parse(execFileSync('npm', ['view', name, 'time', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { times[name] = {}; }
  const t = times[name][version];
  if (!t) out.unknown.push(e); else if (Date.parse(t) > cutoff) out.under.push(`${e} ${t}`); else out.ok.push(`${e} ${t.slice(0, 10)}`);
}
console.log(JSON.stringify(out, null, 1));
if (out.under.length || out.unknown.length) process.exitCode = 1;
