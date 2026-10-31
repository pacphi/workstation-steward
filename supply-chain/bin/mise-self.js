#!/usr/bin/env node
// mise itself (D38): which release the steward would move the mise binary to, and why. mise pins every other tool,
// but nothing pinned mise: the standalone build sat on 2026.8.2 for 12 weeks (2026-10-27) while ~50 releases shipped.
// Read-only. Usage: mise-self.js           a report for bin/status (steward sc audit)
//                   mise-self.js --plan    one line for audit and upgrade: action<TAB>current<TAB>target<TAB>reason<TAB>auto
// auto: true when mise's own automatic update (self_update.auto, or auto_update before 2026.10) is turned on.
// action: take (an eligible newer release), hold (newer ones exist, all under the gate), ok, brew (Homebrew's
// formula; the Homebrew section judges it), unknown (no answer from GitHub).
// The gate is steward.toml [policy] min_release_age_days. A first patched release younger than that is taken only
// with a host.toml security_exception (kind = "mise", name = "mise"), as for Homebrew. The steward always names the
// version it chose: a bare `mise self-update` before 2026.10.18 takes the newest release with no age gate.
const fs = require('fs');
const { spawnSync } = require('child_process');
const C = require('../../lib/config.js');

const DAY = 86400e3;

// parse('v2026.10.18') — [2026, 10, 18], or null for anything that isn't a mise calendar version
function parse(v) {
  const m = String(v || '').trim().match(/^v?(\d{4})\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}
function cmp(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// inRange('2026.8.2', '>= 2026.3.15, < 2026.6.4') — the GitHub Advisory DB's vulnerable_version_range form
function inRange(v, range) {
  const parts = String(range || '').split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(c => {
    const m = c.match(/^(<=|>=|<|>|=)?\s*v?(\S+)$/);
    if (!m || !parse(m[2])) return false;
    const d = cmp(v, m[2]);
    switch (m[1]) {
      case '<': return d < 0;
      case '<=': return d <= 0;
      case '>': return d > 0;
      case '>=': return d >= 0;
      default: return d === 0;
    }
  });
}

// choose({ current, releases, now, days, advisories, exceptions }) — the plan for mise itself
//   releases: [{ version, at: Date }] (stable only); advisories: [{ id, fixed }] that affect current
//   exceptions: host.toml security_exception entries (expired ones are ignored here)
function choose({ current, releases, now = new Date(), days, advisories = [], exceptions = [] }) {
  const cutoff = new Date(now.getTime() - days * DAY);
  const newer = releases.filter(r => cmp(r.version, current) > 0).sort((a, b) => cmp(b.version, a.version));
  const age = r => Math.floor((now.getTime() - r.at.getTime()) / DAY);
  const today = now.toISOString().slice(0, 10);
  const exc = v => exceptions.find(e => e.kind === 'mise' && e.name === 'mise' && e.version === v && String(e.expires) >= today);
  let target = newer.find(r => r.at <= cutoff);
  let why = target ? `${age(target)}d old` : '';
  const notes = [];
  // A first patched release past the gate is at or below `target` already; one under it needs an exception.
  for (const a of advisories) {
    if (!a.fixed || (target && cmp(target.version, a.fixed) >= 0)) continue;
    const r = newer.find(x => x.version === a.fixed);
    const e = r && exc(a.fixed);
    if (e) { target = r; why = `${a.id}: first patched release, ${age(r)}d old (security exception: ${e.advisory})`; }
    else notes.push(`${a.id} is fixed in ${a.fixed}${r ? ` (${age(r)}d old)` : ''}: a host.toml security_exception (kind = "mise") takes it before the gate`);
  }
  const base = { current, newest: newer[0] ? newer[0].version : current, behind: newer.length };
  const tail = notes.length ? `; ${notes.join('; ')}` : '';
  if (target) return { ...base, action: 'take', target: target.version, reason: `${why}; newest ${base.newest}, ${newer.length} release(s) behind${tail}` };
  if (newer.length) return { ...base, action: 'hold', target: current, reason: `${newer.length} newer release(s), all under the ${days}d gate (oldest ${age(newer[newer.length - 1])}d)${tail}` };
  return { ...base, action: 'ok', target: current, reason: `newest release${tail}` };
}

module.exports = { parse, cmp, inRange, choose };

if (require.main === module) {
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts });
  const json = (r) => { try { return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
  const plan = process.argv.includes('--plan');
  const out = (action, current, target, reason, auto = false) => { console.log([action, current, target, reason, auto].join('\t')); process.exit(0); };

  const which = run('/bin/sh', ['-c', 'command -v mise']).stdout.trim();
  const bin = which ? fs.realpathSync(which) : '';
  const ver = run(bin || 'mise', ['--version']);
  const current = ((ver.stdout || '').match(/\b(\d{4}\.\d+\.\d+)\b/) || [])[1];
  if (!current) { if (plan) out('unknown', '?', '?', 'mise --version gave no version'); console.log('  mise --version gave no version'); process.exit(0); }
  const prefix = run('brew', ['--prefix']).stdout.trim();
  if (prefix && bin.startsWith(`${prefix}/`)) {
    if (plan) out('brew', current, current, 'Homebrew formula: judged with the formulae');
    console.log(`  mise ${current} from Homebrew (${C.tilde(bin)}): judged with the Homebrew formulae`);
    process.exit(0);
  }

  const days = C.load().values.policy.min_release_age_days;
  // --jq: the full page (release notes included) is several MB
  const rel = json(run('gh', ['api', 'repos/jdx/mise/releases?per_page=100', '--jq', '[.[] | {tag_name, published_at, draft, prerelease}]']));
  if (!rel) { if (plan) out('unknown', current, current, 'GitHub releases unavailable (gh api failed)'); console.log(`  mise ${current} (${C.tilde(bin)}): GitHub releases unavailable`); process.exit(0); }
  const releases = rel.filter(r => !r.draft && !r.prerelease && parse(r.tag_name)).map(r => ({ version: r.tag_name.slice(1), at: new Date(r.published_at) }));

  // Advisories for the running version: the GitHub Advisory DB, and OSV, which carries RustSec (crates.io "mise").
  const advisories = [];
  for (const a of json(run('gh', ['api', 'advisories?ecosystem=rust&affects=mise&per_page=100'])) || []) {
    for (const v of a.vulnerabilities || []) {
      if (v.package && v.package.name === 'mise' && inRange(current, v.vulnerable_version_range)) advisories.push({ id: a.ghsa_id, fixed: v.first_patched_version, severity: a.severity });
    }
  }
  const osv = json(run('curl', ['-fsS', '-m', '20', 'https://api.osv.dev/v1/query', '-d', JSON.stringify({ package: { name: 'mise', ecosystem: 'crates.io' }, version: current })]));
  for (const v of (osv && osv.vulns) || []) {
    if ([v.id, ...(v.aliases || [])].some(id => advisories.some(a => a.id === id))) continue;
    const fixed = (v.affected || []).flatMap(x => (x.ranges || []).flatMap(r => r.events || [])).map(e => e.fixed).filter(Boolean).sort(cmp)[0];
    advisories.push({ id: v.id, fixed, severity: 'see OSV' });
  }
  const exceptions = (C.policy('supply-chain/host.toml') || {}).security_exception || [];
  const p = choose({ current, releases, days, advisories, exceptions });
  // Automatic updates replace the binary on mise's schedule, past this plan and its backup. Off by default.
  const auto = ['self_update.auto', 'auto_update'].some(k => run(bin, ['settings', 'get', k]).stdout.trim() === 'true');
  if (plan) out(p.action, current, p.target, p.reason, auto);

  console.log(`  mise ${current} (standalone, ${C.tilde(bin)}); newest ${p.newest}, ${p.behind} release(s) behind`);
  console.log(advisories.length ? `  ADVISORIES on ${current}: ${advisories.map(a => `${a.id} (${a.severity}; fixed in ${a.fixed || '?'})`).join(', ')}` : `  advisories: none for ${current} (GitHub Advisory DB, OSV)`);
  console.log(`  ${p.action === 'take' ? `take ${p.target}: ${p.reason} → steward sc upgrade-tool mise` : `${p.action}: ${p.reason}`}`);
  if (auto) console.log('  WARN self_update.auto is on: mise updates itself without a backup or receipt; turn it off');
}
