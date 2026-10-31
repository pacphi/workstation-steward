// Every user command the `steward` client runs (bin/steward.js), in one list: its area, name, the script it runs and
// from which folder, whether it can change anything, the add-on it needs, and its usage. `steward help` and the
// add-on gate come from here. Scripts run from their area's folder, as the just recipes they replace did.
// Fields: area ('' = top level) · name · cwd (engine-relative) · run (argv, relative to cwd) · env · min (required
//         arguments) · usage · writes (can change something; still plans and asks first) · profile · desc
//         class (what kind of change it makes, lib/autonomy.js; none on a writing command a person runs: skills)
//         unattended (takes --unattended: answers its own questions where [autonomy] allows their class, D58)
//         runner (runs other commands, each under its own class: steward fix, D59)
//         tier (everyday: EVERYDAY lists them, in help order · advanced, the default · internal: help --internal only)
//         group (the heading in `steward help --all`, GROUPS; from the area unless given) · when (an everyday command's
//         one line on when to use it) · aliasOf (an old name: it runs that command, with a one-line notice) · undo
//         (its way back, when the usage doesn't name a --rollback) · parent (the bundled command that runs this one with
//         others, lib/coarse.js, D61; a bundled command's class is that of its most demanding part)
const AREAS = {
  '': 'Everywhere',
  sc: 'Supply chain: mise, Homebrew, apps, App Store, macOS, trust stores, Docker, IOCs',
  ai: 'AI tooling: Ruflo, AgentDB, AQE, Brain, RuVector, launchers, guards',
  projects: 'Projects: discovery, the registry, onboarding',
  skills: 'Claude Code skills: the steward plugin (D48)',
  fleet: 'Fleet: local checkouts after PRs merge',
  config: 'Your config repo: this Mac and GitHub in step (D50)',
};

// GROUPS — the headings of `steward help --all`, in order; an area's commands go under its group
const GROUPS = {
  next: 'Briefing and diagnostics',
  sc: 'Supply chain',
  ai: 'AI tooling',
  projects: 'Projects',
  fleet: 'Fleet',
  config: 'Config and skills',
};
const AREA_GROUP = { '': 'next', sc: 'sc', ai: 'ai', projects: 'projects', fleet: 'fleet', config: 'config', skills: 'config' };
// EVERYDAY — the commands bare `steward help` shows, in its order ('' is bare `steward`, the briefing)
const EVERYDAY = ['', 'review', 'fix', 'upgrade', 'config sync', 'projects', 'rollback', 'doctor'];
const MISE_BACK = 'steward rollback puts back the mise config and lock from before (mise itself: steward rollback mise; Homebrew keeps no old versions)';

const sc = (name, run, o) => ({ area: 'sc', name, cwd: 'supply-chain', run, ...o });
const ai = (name, o) => ({ area: 'ai', name, cwd: 'ai-tooling', run: ['node', `bin/${name}.js`], profile: 'ai_tooling', ...o });
const pr = (name, run, o) => ({ area: 'projects', name, cwd: 'projects', run, profile: 'projects', ...o });
const sk = (name, o) => ({ area: 'skills', name, cwd: '.', run: ['node', 'lib/skills.js', name], ...o });

const COMMANDS = [
  { area: '', name: 'review', cwd: '.', run: ['node', 'lib/review.js'], usage: '[--quick] [--json]',
    when: 'Weekly, or when the banner says one is due: everything waiting on a decision',
    desc: 'Read-only: one list of what needs a decision across every area, each with its command; --json as the work list, each item with who does it (D58)' },
  { area: '', name: 'brief', cwd: '.', run: ['node', 'lib/brief.js'], usage: '[--all | --plan] [--json] [--refresh]',
    desc: 'Read-only: the one next step, if anything needs you, from what is on disk; --all lists every finding; --plan the work list, each step with who does it (D58); --refresh checks the network first (D57)' },
  { area: '', name: 'fix', cwd: '.', run: ['node', 'lib/fix.js'], usage: '[--apply [--only <id> [--yes-to <class>]…]] [--from <file>] [--json]', writes: true, runner: true,
    when: 'Work the list: run what [autonomy] allows, ask you for the rest',
    desc: 'Work the list (steward brief --plan, or --from a review): run what [autonomy] allows, ask for the rest, hand over what is yours, stop at a failure (D59)' },
  { area: '', name: 'doctor', cwd: '.', run: ['node', 'lib/doctor.js'], usage: '[--area <a,b>] [--install]',
    when: 'First run, or when something seems off: your config, add-ons and missing tools',
    desc: 'Read-only: the engine version, your config\'s format and add-ons, then what the steward needs on this machine and what is missing; --install plans, asks, installs' },
  { area: '', name: 'upgrade', cwd: '.', run: ['node', 'lib/coarse.js', 'upgrade'], usage: '[--unattended]', writes: true, class: 'upgrade', unattended: true, group: 'sc', undo: MISE_BACK,
    when: 'Bring tools up to date under the release-age gate; shows the plan, asks first',
    desc: 'A Node security release (sc node-patch) or hybrids out of step (sc install-hybrids), then sc upgrade: every plan, then one yes (D61)' },
  { area: '', name: 'rollback', cwd: 'supply-chain', run: ['bin/rollback'], usage: '[backup | mise | <updater receipt>]', writes: true, class: 'rollback', group: 'sc',
    when: 'Undo the last upgrade or Node patch, mise itself, or an updater; asks first',
    desc: "Restore the newest config and lock backup (or a named one), the mise binary, or what a declared updater replaced; asks first. Other commands' --rollback <receipt> undo their own" },
  { area: '', name: 'projects', cwd: 'projects', run: ['node', 'bin/projects.js', 'scan'], usage: '[--apply] [--json]', profile: 'projects', group: 'projects', writes: true, class: 'registry',
    when: 'When the banner names new projects: what is new or gone; --apply asks each decision',
    desc: "New projects under the roots, and registered ones that are gone; --apply asks each new one's decision, then records them in registry.toml (shows the change, asks)" },
  { area: '', name: 'config', cwd: '.', run: ['node', 'lib/config.js'], usage: '[--json | --check]', group: 'config',
    desc: 'Read-only: the effective configuration, where the instance is, and where each value came from' },

  sc('audit', ['node', 'bin/audit.js'], { desc: 'Read-only: Homebrew, apps, App Store, macOS, trust stores, Docker, IOCs and declared updaters against host.toml (plus status)' }),
  sc('plan', ['bin/plan'], { env: { DRY_RUN: '1' }, desc: 'Read-only: the upgrade plan (eligible Homebrew formulae and casks, mise tools, mise itself; what is held and why), then Node security releases, the hybrids and vendored Node runtimes' }),
  sc('upgrade', ['node', 'bin/upgrade.js'], { writes: true, class: 'upgrade', undo: MISE_BACK, unattended: true, parent: 'upgrade', desc: 'Upgrade everything eligible under the release-age gate; shows the plan and asks first' }),
  sc('upgrade-tool', ['bin/upgrade-tool'], { min: 1, usage: '<tool> [version]', writes: true, class: 'upgrade', undo: MISE_BACK, desc: 'Upgrade one tool (age-gated), or pin an exact version (a security fix); mise itself: upgrade-tool mise' }),
  sc('status', ['bin/plan'], { env: { DRY_RUN: '1' }, aliasOf: 'sc plan', desc: 'Now steward sc plan, which shows what this showed' }),
  sc('verify', ['bin/verify'], { desc: 'Read-only: every CLI in verify.tsv, native add-on loads, npm doctor (safe subset)' }),
  sc('node-patch', ['bin/node-patch'], { min: 1, usage: '<x.y.z>', writes: true, class: 'node-patch', undo: 'steward rollback: the mise config and lock from before (the old Node and its hybrids stay installed)', unattended: true, parent: 'upgrade', desc: 'Same-day Node security release: verify, install, reinstall hybrids, pin, lock' }),
  sc('install-hybrids', ['bin/install-hybrids'], { writes: true, class: 'install-hybrids', unattended: true, parent: 'upgrade', desc: '(Re)install the npm -g hybrids from hybrids.toml into the active Node (Ruflo policy backup, receipts)' }),
  sc('retire-hybrid', ['bin/retire-hybrid'], { min: 2, usage: '<name> <spec>', writes: true, class: 'toolchain', desc: "Move a hybrid to mise's npm: backend once upstream is fixed" }),
  sc('release-age', ['bin/release-age'], { usage: '[days]', writes: true, class: 'policy', desc: 'Show the release-age gate in steward.toml, mise and Renovate, or set all three' }),
  sc('trust-review', ['bin/trust-review'], { min: 1, usage: '<package@version>', desc: 'Read-only: evidence check before a trust_policy_excludes entry' }),
  sc('prune', ['bin/prune'], { usage: '[tool…] [--unattended]', writes: true, class: 'prune', unattended: true, desc: "Remove versions no config needs, and declared updaters' copies older than the soak; waits out the soak, then asks" }),
  sc('host', ['node', '../lib/host.js'], { desc: 'Read-only: the host policy the audit uses, each value marked default (the engine), yours, or off' }),
  sc('soak', ['node', '../lib/soak.js'], { desc: 'Read-only: is a soak running (prune waits), and which receipts started it' }),
  sc('rollback', ['bin/rollback'], { usage: '[backup | mise | <updater receipt>]', writes: true, class: 'rollback', desc: "Restore the newest config and lock backup (or a named one), the mise binary, or what a declared updater replaced; asks first" }),
  sc('link', ['bin/link'], { writes: true, class: 'toolchain', desc: "Point ~/.config/mise/{config.toml,mise.lock} at the instance's mise/ (idempotent)" }),
  sc('tool-age', ['node', 'bin/tool-age.js'], { min: 2, usage: '<npm:tool> <version> [-d days]', desc: "Read-only: the age of every package a mise npm: tool's new version pulls in, in a sandbox" }),

  { area: 'ai', name: 'fix', cwd: '.', run: ['node', 'lib/coarse.js', 'ai fix'], usage: '[--unattended]', profile: 'ai_tooling', writes: true, class: 'ai-fix', unattended: true,
    desc: 'ai repin, guard, timeouts, approvals and transport: every plan, then one yes (D61)' },
  ai('drift', { usage: '[--offline] [--json]', desc: "Read-only: the machine's and every project's AI tooling against ai-tooling.toml" }),
  ai('repin', { usage: '[--apply | --rollback <receipt>]', writes: true, class: 'ai-fix', unattended: true, parent: 'ai fix', desc: 'Repin launcher configs to stable paths ([[repin]])' }),
  ai('guard', { usage: '[--apply | --rollback <receipt>]', writes: true, class: 'ai-fix', unattended: true, parent: 'ai fix', desc: 'The npx ask guard in ~/.claude/settings.json' }),
  ai('timeouts', { usage: '[--apply | --rollback <receipt>]', writes: true, class: 'ai-fix', unattended: true, parent: 'ai fix', desc: 'Hook timeouts written in milliseconds where the field is seconds' }),
  ai('approvals', { usage: '[--apply | --rollback <receipt>]', writes: true, class: 'ai-fix', unattended: true, parent: 'ai fix', desc: 'The Codex MCP settings the policy sets' }),
  ai('transport', { usage: '[--apply | --rollback <receipt>]', writes: true, class: 'ai-fix', unattended: true, parent: 'ai fix', desc: 'The AQE hook transport v2 in the shared AQE runtime' }),

  { area: 'projects', name: 'apply', cwd: '.', run: ['node', 'lib/coarse.js', 'projects apply'], usage: '[--unattended]', profile: 'projects', writes: true, class: 'onboard', unattended: true,
    desc: 'Bring each project to its registry decision: onboard, offboard, then reconcile --all; every plan, then one yes (D61)' },
  pr('scan', ['node', 'bin/projects.js', 'scan'], { usage: '[--json]', desc: 'Read-only: new projects under the roots, and registered ones that are gone' }),
  pr('decide', ['node', 'bin/projects.js', 'decide'], { min: 1, usage: '<path> --decision onboarded|ignored|deferred [--ai a,b] | --batch <file>', writes: true, class: 'registry', desc: 'Record decisions in registry.toml (shows the change, asks)' }),
  pr('list', ['node', 'bin/projects.js', 'list'], { usage: '[--json]', desc: 'Read-only: every registered project, its decision, tools and what it shows today' }),
  pr('facets', ['node', 'bin/projects.js', 'facets'], { usage: '[<path>] [--json]', desc: 'Read-only: what onboarding adapts to in each project (stack, workspace, Node, AI files)' }),
  pr('profile-check', ['node', 'bin/profile-check.js'], { usage: '[<path>] [--detail] [--json]', desc: "Read-only: what each project has against its tools' profiles, and why each difference exists" }),
  pr('onboard', ['node', 'bin/onboard.js'], { min: 1, usage: '<path> [--apply] … | --all | --rollback <receipt>', writes: true, class: 'onboard', unattended: true, parent: 'projects apply', desc: 'Onboard a project: the plan per file; --apply asks, backs up, writes a receipt' }),
  pr('reconcile', ['node', 'bin/reconcile.js'], { usage: '<path> [--take <unit>…] [--diff <unit>] [--apply] | --all [--apply [--unattended]] | --rollback <receipt>', writes: true, class: 'reconcile', unattended: true, parent: 'projects apply', desc: "Bring a project's copied tool files in step with the qualified installs; edited copies are kept and reported" }),
  pr('offboard', ['node', 'bin/offboard.js'], { min: 1, usage: '<path> [--apply] | --rollback <receipt>', writes: true, class: 'offboard', unattended: true, parent: 'projects apply', desc: 'Take the AI tools out of a project that has none chosen' }),

  sk('path', { tier: 'internal', desc: "Read-only: build the steward plugin's folder from this engine and your add-ons, and print where it is (Claude Code runs this)" }),
  sk('install', { usage: '[--project <path>] [--yes]', writes: true, desc: "Install the steward's Claude Code skills for you, or in one project only; from your own terminal" }),
  sk('uninstall', { usage: '[--project <path>] [--yes]', writes: true, desc: 'Uninstall them (the way back from install)' }),

  { area: 'fleet', name: 'tidy', cwd: '.', run: ['node', 'lib/coarse.js', 'fleet tidy'], min: 1, usage: '<repo> [--unattended]', writes: true, class: 'prune-merged', unattended: true,
    desc: 'fleet sync, then prune-merged: both plans, then one yes (D61)' },
  { area: 'fleet', name: 'sync', cwd: 'fleet', run: ['node', 'bin/sync.js'], min: 1, usage: '<repo> [--apply [--unattended]] [--replace <path>]', writes: true, class: 'fleet-sync', unattended: true,
    parent: 'fleet tidy',
    desc: 'Fast-forward a checkout after merges, dropping only local edits upstream already has' },
  { area: 'fleet', name: 'prune-merged', cwd: 'fleet', run: ['node', 'bin/prune-merged.js'], min: 1, usage: '<repo> [--apply [--unattended]]', writes: true, class: 'prune-merged', unattended: true,
    parent: 'fleet tidy',
    desc: 'Delete local branches whose PR merged, whose remote is gone, and that hold nothing newer' },

  { area: 'config', name: 'sync', cwd: '.', run: ['node', 'lib/configsync.js'], usage: '[--apply [--unattended]] | --rollback <receipt>', writes: true, class: 'pull', unattended: true,
    when: 'When the banner says your config repo moved: bring it level with GitHub',
    desc: 'Bring your config repo level with GitHub: fast-forward only, then mise install and steward check' },
];

// BUILTINS — the commands bin/steward.js answers itself, for help
const BUILTINS = [
  { area: '', name: 'version', desc: 'The engine version, where your config is, and its format' },
  { area: '', name: 'check', desc: 'Is your config in a format this release reads? What a release wants from you' },
  { area: '', name: 'init', usage: '[folder] [--yes]', writes: true, group: 'config', desc: 'Create your config from the examples (plans, asks, never overwrites)' },
  { area: '', name: 'help', usage: '[--all [--internal] | <area> | <command>]', desc: 'The everyday commands; --all every one, by area; or one area or command' },
];
const BRIEFING = { area: '', name: '', desc: "Read-only: the one next step, if anything needs you (the briefing; steward brief takes its flags)",
  when: "What's next: the one next step, if anything needs you" };

const key = c => `${c.area ? `${c.area} ` : ''}${c.name}`.trim();
for (const c of [...COMMANDS, ...BUILTINS, BRIEFING]) {
  c.group = c.group || AREA_GROUP[c.area];
  c.tier = EVERYDAY.includes(key(c)) ? 'everyday' : c.tier || 'advanced';
}

// find(words) — { cmd, args, alias } for `steward <area> <name> …` or `steward <name> …` (top level), or null. An
// area's command wins over a top-level one of the area's name: `steward config sync` is sync, `steward config` is
// config; and an area's name followed by a word that isn't one of its commands is no command (`steward projects x`).
// An old name (aliasOf) gives the command it now is, and alias, the old entry, for the notice.
function find(words) {
  const [a, b, ...rest] = words;
  const cmd = COMMANDS.find(c => c.area === a && c.name === b);
  if (cmd) return cmd.aliasOf ? { ...find([...cmd.aliasOf.split(' '), ...rest]), alias: cmd } : { cmd, args: rest };
  if (a in AREAS && a && b !== undefined && !b.startsWith('-')) return null;
  const top = COMMANDS.find(c => c.area === '' && c.name === a);
  return top ? { cmd: top, args: [b, ...rest].filter(x => x !== undefined) } : null;
}

// everyday() — the everyday commands, in help order, bare `steward` first
const everyday = () => EVERYDAY.map(k => (k ? [...COMMANDS, ...BUILTINS].find(c => key(c) === k) : BRIEFING));
// listed({internal}) — what `steward help --all` lists: every command and built-in but the old names, and the internal
// ones only when asked; bare `steward` first
const listed = (o = {}) => [BRIEFING, ...COMMANDS, ...BUILTINS].filter(c => !c.aliasOf && (o.internal || c.tier !== 'internal'));

module.exports = { AREAS, GROUPS, AREA_GROUP, COMMANDS, BUILTINS, BRIEFING, find, everyday, listed, key };
