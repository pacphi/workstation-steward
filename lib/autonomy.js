#!/usr/bin/env node
// Autonomy (D58, docs/briefing.md "Who does each step"): which steps may run without the user's yes. The engine, not
// the model, labels every step of the work list (`steward brief --plan`, `steward review --json`) with its class and
// its actor, and a writing command run with --unattended takes a yes only for a class the policy allows.
//   class  what kind of change a step makes (CLASSES). A read-only step has none; a human-only step has none either,
//          and so can never be allowed: merges, sudo, trust stores, closing sessions, interactive installers,
//          dashboard ticks, anything by hand, and any shell command the engine didn't write as a steward command
//   actor  agent: read-only, or a class the policy allows · agent-with-yes: an engine command that writes, with a
//          plan, a backup and a receipt, run only after the user's yes · human: the user does it; it is handed over
// steward.toml [autonomy]: level = ask | safe | maintainer (LEVELS), allow and deny (lists of classes), subagents.
// Fixed, whatever it says: a plan, a backup and a receipt for every write; stop on a failure; the release-age gate.
// Usage: autonomy.js                     the classes, and which ones this instance allows
//        autonomy.js --answer <class> <question>
//                                        for a question a bash command asks under --unattended (lib/lib.sh
//                                        confirm): exit 0 when the policy allows the class, else say why and exit 4
const path = require('path');

// CLASSES — every class a step can have, and what it covers
const CLASSES = {
  pull: 'config sync: fast-forward your config repo to GitHub, or finish after its pull request merged',
  reconcile: "projects reconcile: bring a project's copied tool files in step with the qualified installs",
  prune: 'sc prune: remove old installs once the soak has ended',
  qualify: 'a sandbox qualification of a new AQE or Ruflo release (writes only its own workspace)',
  'pr-prep': 'prepare a pull request in a scratch clone (nothing is pushed)',
  'after-merge': 'fleet sync and fleet prune-merged: fast-forward a checkout, delete branches whose PR merged',
  'release-verify': '/steward-maintain release: watch a release and verify what npm published',
  repin: 'repin the release channel to a verified release (maintainers)',
  push: 'push a branch and open a pull request',
  install: 'install tools: doctor --install, mise install after a config sync',
  'install-hybrids': 'sc install-hybrids: reinstall the npm -g hybrids',
  'node-patch': 'sc node-patch: a Node security release',
  upgrade: 'sc upgrade and sc upgrade-tool: upgrades under the release-age gate',
  toolchain: 'sc retire-hybrid and sc link: change how a tool is installed or found',
  policy: 'sc release-age: change the release-age gate',
  promote: "promote.sh: switch the shared AQE runtime to a qualified release",
  'ai-fix': 'ai repin, guard, timeouts, approvals and transport: fix AI tooling settings',
  registry: "projects decide: record a project's decision",
  onboard: 'projects onboard: add the chosen AI tools to a project',
  offboard: 'projects offboard: take the AI tools out of a project',
  rollback: 'any --rollback, and sc rollback: undo what a receipt recorded',
};

// LEVELS — what each [autonomy] level allows. safe is the default; the owner's instance sets maintainer
const SAFE = ['pull', 'reconcile', 'prune', 'qualify', 'pr-prep'];
const LEVELS = { ask: [], safe: SAFE, maintainer: [...SAFE, 'after-merge', 'release-verify', 'repin'] };

// allowed(a) — the classes [autonomy] a (level, allow, deny) lets run without a yes: the level's, plus allow, minus deny
function allowed(a) {
  const set = new Set([...(LEVELS[a.level] || []), ...(a.allow || [])].filter(c => c in CLASSES));
  for (const c of a.deny || []) set.delete(c);
  return set;
}

// problems(a) — what is wrong with an [autonomy] table, as config errors (lib/config.js)
function problems(a) {
  const out = [];
  if (!(a.level in LEVELS)) out.push(`autonomy.level must be ${Object.keys(LEVELS).join(', ')}, got ${a.level}`);
  for (const k of ['allow', 'deny']) {
    for (const c of a[k] || []) {
      if (!(c in CLASSES)) out.push(`autonomy.${k}: unknown class "${c}" (steward config lists them; human-only steps have none)`);
    }
  }
  return out;
}

// what a /steward-maintain flow word does, and the engine scripts a finding can name
const MAINTAIN = { merged: 'after-merge', release: 'release-verify', repin: 'repin', config: 'pull' };
// read-only commands a finding names that aren't steward commands
const READ_ONLY = /^(gh (pr|issue) (view|list)\b|git -C \S+ (status|log|stash list)\b|cat |ls )/;

// segment(s) — one step of a command: 'read', a class, or 'human'
function segment(s) {
  let t = s.trim();
  if (!t) return 'human';
  const dry = /^DRY_RUN=1 /.test(t);
  t = t.replace(/^(\w+=\S* )+/, '');
  if (t.startsWith('steward ') || t.startsWith('steward-dev ')) {
    const words = t.split(/\s+/).slice(1);
    if (['version', 'check', 'help'].includes(words[0])) return 'read';
    const hit = require('./commands.js').find(words);
    if (!hit) return 'human';
    if (dry) return 'read';
    if (hit.cmd.area === '' && hit.cmd.name === 'doctor' && words.includes('--install')) return 'install';
    if (!hit.cmd.writes) return 'read';
    if (words.includes('--rollback')) return 'rollback';
    return hit.cmd.class || 'human';
  }
  if (t.startsWith('/steward-maintain')) {
    const flows = t.split(/\s+/).slice(1).filter(w => w in MAINTAIN).map(w => MAINTAIN[w]);
    return flows.length ? worst(flows) : 'read';
  }
  if (/^just release-worktree /.test(t)) return 'repin';
  if (/\/qualify\/aqe\/promote\.sh( |$)/.test(t)) return 'promote';
  if (/\/qualify\/aqe\/run\.sh( |$)/.test(t)) return 'qualify';
  if (READ_ONLY.test(t)) return 'read';
  return 'human';
}

// worst(classes) — the step that needs the most: human, then a class, then read-only. Among classes the first wins;
// classify() decides which of them the policy allows
function worst(cs) {
  if (cs.includes('human')) return 'human';
  return cs.find(c => c !== 'read') || 'read';
}

// classify(cmd, a) — {class, actor, steps} for the command a finding names, under [autonomy] a. A command of several
// steps ("x, then y") takes the actor its most demanding step needs. No command: nothing to run (null, null)
function classify(cmd, a) {
  if (!cmd) return { class: null, actor: null, steps: [] };
  const ok = allowed(a);
  const steps = String(cmd).split(/,\s*then\s+|;\s+/).map(segment);
  if (steps.includes('human')) return { class: null, actor: 'human', steps };
  const needs = steps.filter(c => c !== 'read');
  if (!needs.length) return { class: null, actor: 'agent', steps };
  const held = needs.find(c => !ok.has(c));
  return { class: held || needs[0], actor: held ? 'agent-with-yes' : 'agent', steps };
}

// check(cls, a) — {ok, why}: may a step of class cls take a yes without the user, under [autonomy] a
function check(cls, a) {
  if (!cls || !(cls in CLASSES)) return { ok: false, why: `${cls ? `"${cls}" is not a class` : 'this step has no class'}: a person answers it` };
  if (allowed(a).has(cls)) return { ok: true, why: `[autonomy] allows ${cls}` };
  const lvl = Object.keys(LEVELS).find(l => LEVELS[l].includes(cls));
  return { ok: false, why: `[autonomy] level = "${a.level}" doesn't allow ${cls}${(a.deny || []).includes(cls) ? ' (it is in deny)' : ''}. To let it run unattended: allow = ["${cls}"] in steward.toml${lvl ? `, or level = "${lvl}"` : ''}` };
}

const policyNow = () => require('./config.js').load().values.autonomy;

// unattended() — is this run unattended (bin/steward.js sets STEWARD_UNATTENDED=1 after checking the command's class)
const unattended = () => process.env.STEWARD_UNATTENDED === '1';

// answer(cls, q) — for a question a writing command asks: null when a person is there to answer it; true when the
// run is unattended and [autonomy] allows cls; otherwise it says why and exits 4 (the runner tells "waiting on you"
// from "failed" by that code). The class is checked here again, so the environment alone can't widen the policy
const REFUSED = 4;
function answer(cls, q) {
  if (!unattended()) return null;
  q = String(q).trim();
  const r = check(cls, policyNow());
  if (r.ok) { console.error(`unattended: yes to "${q}" (${r.why})`); return true; }
  console.error(`unattended: not answering "${q}": ${r.why}. Nothing more was changed.`);
  process.exit(REFUSED);
}

module.exports = { CLASSES, LEVELS, allowed, problems, classify, check, answer, unattended, REFUSED };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--answer') { answer(args[1], args.slice(2).join(' ') || '(question)'); process.exit(unattended() ? 0 : REFUSED); }
  const a = policyNow();
  const ok = allowed(a);
  console.log(`[autonomy] level = "${a.level}" (${path.basename(require('./config.js').load().file)}): these run unattended when the runner asks`);
  for (const [c, d] of Object.entries(CLASSES)) console.log(`  ${ok.has(c) ? 'unattended' : 'asks      '}  ${c.padEnd(16)} ${d}`);
  console.log('Read-only steps always may; human-only steps (merges, sudo, trust stores, by hand) never do.');
}
