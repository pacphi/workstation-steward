#!/usr/bin/env node
// Projects under the configured roots: discovery, the registry, and what each project shows. Read-only except
// `seed` (writes projects/registry.toml once) and `decide` (records the owner's decisions; shows the change, asks).
// Usage: projects.js banner | scan [--json] | list [--json] | facets [<path>] [--json] | seed <allowlist.json>
//        projects.js decide <path> --decision onboarded|ignored|deferred [--ai ruflo,aqe,brain] [--until YYYY-MM-DD]
//                               [--inherit] [--note text] [--yes]
//        projects.js decide --batch <decisions.json> [--yes]     [{path, decision, ai, until, inherit, note}, ...]
//        DRY_RUN=1 previews any write.
const fs = require('fs');
const path = require('path');
const P = require('../../lib/projects.js');

const [cmd = 'list', ...args] = process.argv.slice(2);
const json = args.includes('--json');
const TOOLS = ['ruflo', 'aqe', 'brain'];
// What a file's Git state allows (D6): onboarding edits only files Git doesn't track; new files it creates get a
// .git/info/exclude entry unless the repo's own rules already ignore them.
const MAY = {
  tracked: 'tracked: a PR in that repo, or a manual step',
  ignored: 'ignored: may edit in place (adds only)',
  untracked: 'untracked: may edit in place (adds only)',
  absent: 'absent: may create, plus a .git/info/exclude entry',
  'absent-ignored': 'absent, ignored by the repo: may create',
  'not-git': 'not a Git repo: may edit (adds only)',
};
const SHORT = { tracked: 'T', ignored: 'i', untracked: 'u', absent: '-', 'absent-ignored': '_', 'not-git': 'n' };

function state() {
  const reg = P.loadRegistry();
  const known = new Map(reg.map(r => [r.abs, r]));
  const found = P.discover();
  const onDisk = new Set(found.map(f => f.path));
  return {
    reg, found,
    fresh: found.filter(f => !known.has(f.path) && !(f.kind === 'worktree' && P.WORKTREES !== 'prompt')),
    gone: reg.filter(r => !onDisk.has(r.abs) && !P.exists(r.abs)),
  };
}

function fmtTools(list) { return list && list.length ? list.join(',') : '-'; }

if (cmd === 'banner') {
  // One line for the top of `steward`; silent when nothing is new, and when the projects add-on is off (D39).
  if (!require('../../lib/config.js').load().values.profiles.projects) process.exit(0);
  const { fresh, gone } = state();
  const parts = [];
  if (fresh.length) parts.push(`${fresh.length} new project(s) under ${P.ROOTS.map(P.tilde).join(', ')}`);
  if (gone.length) parts.push(`${gone.length} registered project(s) no longer on disk`);
  if (parts.length) console.log(`\x1b[1;33m!!\x1b[0m ${parts.join('; ')} — steward projects scan\n`);
} else if (cmd === 'scan') {
  const { fresh, gone, reg } = state();
  if (json) { console.log(JSON.stringify({ fresh: fresh.map(f => ({ ...f, path: P.tilde(f.path), parent: f.parent && P.tilde(f.parent), evidence: P.evidence(f.path).ev })), gone: gone.map(g => g.path) }, null, 1)); process.exit(0); }
  console.log(`registry: ${reg.length} project(s); discovered: ${state().found.length}`);
  if (!fresh.length && !gone.length) { console.log('nothing new'); process.exit(0); }
  if (fresh.length) {
    console.log(`\nnew (${fresh.length}) — needs a decision (then steward projects onboard <path>):`);
    for (const f of fresh) {
      const ev = P.evidence(f.path).ev;
      const shows = TOOLS.filter(t => ev[t].length);
      console.log(`  ${f.kind.padEnd(10)} ${P.tilde(f.path)}${f.parent ? `  (inside ${P.tilde(f.parent)})` : ''}  stack: ${P.facets(f.path).label}${shows.length ? `  shows: ${shows.join(',')}` : ''}`);
    }
  }
  if (gone.length) {
    console.log(`\nregistered but no longer on disk (${gone.length}):`);
    for (const g of gone) console.log(`  ${g.path}`);
  }
} else if (cmd === 'list') {
  const { reg } = state();
  const rows = reg.map(r => {
    const ev = P.exists(r.abs) ? P.evidence(r.abs).ev : null;
    return { path: r.path, kind: r.kind, decision: r.decision, ai: r.ai || [], ai_seed: r.ai_seed || [], shows: ev ? TOOLS.filter(t => ev[t].length) : null, stack: ev ? P.facets(r.abs).label : null };
  });
  if (json) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  console.log(`${'decision'.padEnd(12)} ${'kind'.padEnd(10)} ${'ai'.padEnd(16)} ${'seed'.padEnd(16)} ${'shows'.padEnd(16)} ${'stack'.padEnd(26)} path`);
  for (const r of rows) {
    console.log(`${String(r.decision).padEnd(12)} ${String(r.kind).padEnd(10)} ${fmtTools(r.ai).padEnd(16)} ${fmtTools(r.ai_seed).padEnd(16)} ${(r.shows ? fmtTools(r.shows) : 'gone').padEnd(16)} ${String(r.stack || '-').padEnd(26)} ${r.path}`);
  }
  const c = rows.reduce((a, r) => (a[r.decision] = (a[r.decision] || 0) + 1, a), {});
  console.log(`\n${rows.length} project(s): ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')}`);
} else if (cmd === 'facets') {
  facetsCmd();
} else if (cmd === 'decide') {
  decide().catch(e => { console.error(`ERROR ${e.message}`); process.exit(1); });
} else if (cmd === 'seed') {
  // One-time: registry entries for projects both discovered now and listed in the 2026-10 migration's allowlist,
  // with its per-project tool choice as ai_seed. Everything starts unconfirmed; the owner confirms in P5.
  const allowFile = args[0];
  if (!allowFile) { console.error('usage: projects.js seed <project-tooling-allowlist.json>'); process.exit(2); }
  if (P.exists(P.REGISTRY) && process.env.DRY_RUN !== '1') { console.error(`refusing: ${P.tilde(P.REGISTRY)} exists`); process.exit(1); }
  const allow = new Map(JSON.parse(fs.readFileSync(allowFile, 'utf8')).map(a => [fs.existsSync(a.project) ? fs.realpathSync(a.project) : a.project, a]));
  const q = s => JSON.stringify(s);
  const lines = [
    `# Projects under ${P.ROOTS.map(P.tilde).join(', ')} and the owner's decision for each (D5 in docs/architecture.md).`,
    '# decision: unconfirmed | onboarded | ignored | deferred. ai: the AI tools the owner chose for the project.',
    '# ai_seed: the 2026-10-15/21 migration allowlist\'s choice, kept until the owner confirms. seed_status: its status.',
    '# Seeded 2026-10-24 from projects discovered then that the allowlist also listed; the rest show as new.',
    '',
  ];
  let n = 0;
  for (const f of P.discover()) {
    const a = allow.get(fs.realpathSync(f.path));
    if (!a) continue;
    n++;
    const seedTools = TOOLS.filter(t => a[t]);
    lines.push('[[project]]', `path = ${q(P.tilde(f.path))}`, `kind = ${q(f.kind)}`);
    if (f.parent) lines.push(`parent = ${q(P.tilde(f.parent))}`);
    const remote = f.kind === 'dir' ? '' : P.remoteOf(f.path);
    if (remote) lines.push(`remote = ${q(remote)}`);
    lines.push('decision = "unconfirmed"', 'ai = []', `ai_seed = [${seedTools.map(q).join(', ')}]`, `seed_status = ${q(a.status)}`, '');
  }
  const out = lines.join('\n');
  if (process.env.DRY_RUN === '1') { process.stdout.write(out); console.error(`(dry run: ${n} entries, not written)`); }
  else { fs.mkdirSync(path.dirname(P.REGISTRY), { recursive: true }); fs.writeFileSync(P.REGISTRY, out); console.log(`wrote ${n} entries to ${P.tilde(P.REGISTRY)}`); }
} else {
  console.error(`unknown command: ${cmd}`); process.exit(2);
}

// ---- facets ------------------------------------------------------------------------------------------------
// What onboarding adapts to in each project (stack, workspace, Node, each AI file's Git state). Read-only.
function facetsCmd() {
  const target = args.find(a => !a.startsWith('--'));
  if (target) {
    const dir = path.resolve(P.untilde(target));
    if (!P.exists(dir)) { console.error(`no such folder: ${P.tilde(dir)}`); process.exit(1); }
    const f = P.facets(dir, { git: true, node: true });
    if (json) { console.log(JSON.stringify({ path: P.tilde(dir), ...f }, null, 1)); return; }
    console.log(`${P.tilde(dir)}`);
    console.log(`  stack      ${f.label}${f.monorepo ? '  (monorepo: AI files go at the repo root)' : ''}`);
    if (f.sub.length) console.log(`  subfolders ${f.sub.map(s => `${s.dir}: ${s.stacks.join(',')}`).join('; ')}`);
    console.log(`  node       ${f.node} (what mise resolves here; hooks that run a bare \`node\` get this)`);
    for (const file of P.AI_FILES) console.log(`  ${file.padEnd(34)} ${MAY[f.files[file]]}`);
    return;
  }
  // Every registered project still on disk, onboarded ones first.
  const rows = P.loadRegistry().filter(r => P.exists(r.abs))
    .sort((a, b) => (a.decision === 'onboarded' ? 0 : 1) - (b.decision === 'onboarded' ? 0 : 1) || a.path.localeCompare(b.path))
    .map(r => ({ r, f: P.facets(r.abs, { git: true, node: true }) }));
  if (json) { console.log(JSON.stringify(rows.map(({ r, f }) => ({ path: r.path, decision: r.decision, ai: r.ai || [], ...f })), null, 1)); return; }
  console.log(`files: ${P.AI_FILES.map((x, i) => `${i + 1} ${x}`).join(', ')}`);
  console.log(`state: ${Object.entries(SHORT).map(([k, v]) => `${v} ${k}`).join(', ')}\n`);
  console.log(`${'decision'.padEnd(10)} ${'ai'.padEnd(16)} ${'stack'.padEnd(30)} ${'node'.padEnd(9)} ${'files'.padEnd(12)} path`);
  for (const { r, f } of rows) {
    const st = P.AI_FILES.map(x => SHORT[f.files[x]]).join('');
    console.log(`${r.decision.padEnd(10)} ${fmtTools(r.ai).padEnd(16)} ${f.label.slice(0, 30).padEnd(30)} ${String(f.node).padEnd(9)} ${st.padEnd(12)} ${r.path}`);
  }
  const onb = rows.filter(x => x.r.decision === 'onboarded' && (x.r.ai || []).length);
  console.log(`\n${rows.length} project(s). With AI tools: ${onb.length}; Node there: ${Object.entries(onb.reduce((a, x) => (a[x.f.node] = (a[x.f.node] || 0) + 1, a), {})).map(([k, v]) => `${k}×${v}`).join(' ')}`);
}

// ---- decide ------------------------------------------------------------------------------------------------
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

async function decide() {
  const R = require('../../lib/registry.js');
  const list = R.entries();
  const byAbs = new Map(list.map(e => [P.untilde(e.path), e]));
  const found = new Map(P.discover().map(f => [f.path, f]));
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local date
  let wanted;
  if (args.includes('--batch')) wanted = JSON.parse(fs.readFileSync(flag('--batch'), 'utf8'));
  else {
    const target = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--decision' && !['--ai', '--until', '--note', '--batch'].includes(args[args.indexOf(a) - 1]));
    if (!target) throw new Error('usage: decide <path> --decision … (or --batch <file>)');
    wanted = [{ path: target, decision: flag('--decision'), ai: flag('--ai') !== undefined ? flag('--ai').split(',').filter(Boolean) : undefined, until: flag('--until'), inherit: args.includes('--inherit'), note: flag('--note') }];
  }
  const changes = [], problems = [];
  for (const w of wanted) {
    const abs = path.resolve(P.untilde(w.path));
    const before = byAbs.get(abs);
    const disc = found.get(abs);
    if (!before && !disc) { problems.push(`${P.tilde(abs)}: not a discovered project and not in the registry`); continue; }
    const base = before ? { ...before } : { path: P.tilde(abs), kind: disc.kind, parent: disc.parent ? P.tilde(disc.parent) : undefined, remote: disc.kind === 'dir' ? undefined : (P.remoteOf(abs) || undefined) };
    const next = { ...base, decided: today };
    if (w.inherit) {
      const parentAbs = base.parent && P.untilde(base.parent);
      const parent = parentAbs && byAbs.get(parentAbs);
      if (!parent || parent.decision === 'unconfirmed') { problems.push(`${base.path}: --inherit needs a decided parent (${base.parent || 'none'})`); continue; }
      Object.assign(next, { decision: parent.decision, ai: [...(parent.ai || [])], until: parent.until, inherits: parent.path });
    } else {
      next.decision = w.decision;
      next.ai = w.ai !== undefined ? w.ai : (before ? before.ai : []) || [];
      next.until = w.until;
      delete next.inherits;
    }
    if (w.note !== undefined) next.note = w.note;
    if (next.decision !== 'onboarded') next.ai = next.decision === 'deferred' ? next.ai : [];
    const bad = R.validate(next);
    if (bad.length) { problems.push(`${base.path}: ${bad.join('; ')}`); continue; }
    changes.push({ before, next });
  }
  for (const p of problems) console.error(`  refuse ${p}`);
  if (!changes.length) { console.log('nothing to record'); process.exitCode = problems.length ? 1 : 0; return; }
  console.log(`\x1b[1;34m==>\x1b[0m ${changes.length} registry change(s)`);
  for (const c of changes) {
    const old = c.before ? `${c.before.decision} [${(c.before.ai || []).join(', ')}]` : 'new';
    console.log(`  ${c.next.path}: ${old} → ${c.next.decision} [${(c.next.ai || []).join(', ')}]${c.next.until ? ` until ${c.next.until}` : ''}${c.next.inherits ? ` (inherits ${c.next.inherits})` : ''}`);
  }
  if (process.env.DRY_RUN === '1') { console.log('dry run: registry unchanged'); return; }
  if (!args.includes('--yes')) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const a = await new Promise(res => rl.question('Record these in projects/registry.toml? [y/N] ', res)); rl.close();
    if (!/^y$/i.test(a.trim())) { console.log('nothing changed'); return; }
  }
  const updated = list.map(e => { const c = changes.find(x => x.before && P.untilde(x.before.path) === P.untilde(e.path)); return c ? c.next : e; });
  for (const c of changes) if (!c.before) updated.push(c.next);
  updated.sort((a, b) => P.untilde(a.path).localeCompare(P.untilde(b.path)));
  fs.writeFileSync(P.REGISTRY, R.render(updated));
  const check = R.entries().length;
  console.log(`recorded ${changes.length}; registry has ${check} project(s). Commit projects/registry.toml through a PR.`);
}
