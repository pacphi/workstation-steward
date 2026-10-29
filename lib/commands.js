// Every user command the `steward` client runs (bin/steward.js), in one list: its area, name, the script it runs and
// from which folder, whether it can change anything, the add-on it needs, and its usage. `steward help` and the
// add-on gate come from here. Scripts run from their area's folder, as the just recipes they replace did.
// Fields: area ('' = top level) · name · cwd (engine-relative) · run (argv, relative to cwd) · env · min (required
//         arguments) · usage · writes (can change something; still plans and asks first) · profile · desc
const AREAS = {
  '': 'Everywhere',
  sc: 'Supply chain: mise, Homebrew, apps, App Store, macOS, trust stores, Docker, IOCs',
  ai: 'AI tooling: Ruflo, AgentDB, AQE, Brain, RuVector, launchers, guards',
  projects: 'Projects: discovery, the registry, onboarding',
  skills: 'Claude Code skills: the steward plugin (D48)',
  fleet: 'Fleet: local checkouts after PRs merge',
  config: 'Your config repo: this Mac and GitHub in step (D50)',
};

const sc = (name, run, o) => ({ area: 'sc', name, cwd: 'supply-chain', run, ...o });
const ai = (name, o) => ({ area: 'ai', name, cwd: 'ai-tooling', run: ['node', `bin/${name}.js`], profile: 'ai_tooling', ...o });
const pr = (name, run, o) => ({ area: 'projects', name, cwd: 'projects', run, profile: 'projects', ...o });
const sk = (name, o) => ({ area: 'skills', name, cwd: '.', run: ['node', 'lib/skills.js', name], ...o });

const COMMANDS = [
  { area: '', name: 'review', cwd: '.', run: ['node', 'lib/review.js'], usage: '[--quick]',
    desc: 'Read-only: one list of what needs a decision across every area, each with its command' },
  { area: '', name: 'doctor', cwd: '.', run: ['node', 'lib/doctor.js'], usage: '[--area <a,b>] [--install]',
    desc: 'Read-only: what the steward needs on this machine and what is missing; --install plans, asks, installs' },
  { area: '', name: 'config', cwd: '.', run: ['node', 'lib/config.js'], usage: '[--json | --check]',
    desc: 'Read-only: the effective configuration, where the instance is, and where each value came from' },

  sc('audit', ['node', 'bin/audit.js'], { desc: 'Read-only: Homebrew, apps, App Store, macOS, trust stores, Docker and IOCs against host.toml (plus status)' }),
  sc('plan', ['node', 'bin/upgrade.js'], { env: { DRY_RUN: '1' }, desc: 'Read-only: the upgrade plan (eligible Homebrew formulae and casks, mise tools, mise itself; what is held and why)' }),
  sc('upgrade', ['node', 'bin/upgrade.js'], { writes: true, desc: 'Upgrade everything eligible under the release-age gate; shows the plan and asks first' }),
  sc('upgrade-tool', ['bin/upgrade-tool'], { min: 1, usage: '<tool> [version]', writes: true, desc: 'Upgrade one tool (age-gated), or pin an exact version (a security fix); mise itself: upgrade-tool mise' }),
  sc('status', ['bin/status'], { desc: 'Read-only: outdated tools, mise itself, Node security status, hybrids, vendored Node runtimes' }),
  sc('verify', ['bin/verify'], { desc: 'Read-only: every CLI in verify.tsv, native add-on loads, npm doctor (safe subset)' }),
  sc('node-patch', ['bin/node-patch'], { min: 1, usage: '<x.y.z>', writes: true, desc: 'Same-day Node security release: verify, install, reinstall hybrids, pin, lock' }),
  sc('install-hybrids', ['bin/install-hybrids'], { writes: true, desc: '(Re)install the npm -g hybrids from hybrids.toml into the active Node (Ruflo policy backup, receipts)' }),
  sc('retire-hybrid', ['bin/retire-hybrid'], { min: 2, usage: '<name> <spec>', writes: true, desc: "Move a hybrid to mise's npm: backend once upstream is fixed" }),
  sc('release-age', ['bin/release-age'], { usage: '[days]', writes: true, desc: 'Show the release-age gate in steward.toml, mise and Renovate, or set all three' }),
  sc('trust-review', ['bin/trust-review'], { min: 1, usage: '<package@version>', desc: 'Read-only: evidence check before a trust_policy_excludes entry' }),
  sc('prune', ['bin/prune'], { usage: '[tool…]', writes: true, desc: "Remove versions no config needs, and declared updaters' copies older than the soak; waits out the soak, then asks" }),
  sc('host', ['node', '../lib/host.js'], { desc: 'Read-only: the host policy the audit uses, each value marked default (the engine), yours, or off' }),
  sc('soak', ['node', '../lib/soak.js'], { desc: 'Read-only: is a soak running (prune waits), and which receipts started it' }),
  sc('rollback', ['bin/rollback'], { usage: '[backup | mise | <updater receipt>]', writes: true, desc: "Restore the newest config and lock backup (or a named one), the mise binary, or what a declared updater replaced; asks first" }),
  sc('link', ['bin/link'], { writes: true, desc: "Point ~/.config/mise/{config.toml,mise.lock} at the instance's mise/ (idempotent)" }),
  sc('tool-age', ['node', 'bin/tool-age.js'], { min: 2, usage: '<npm:tool> <version> [-d days]', desc: "Read-only: the age of every package a mise npm: tool's new version pulls in, in a sandbox" }),

  ai('drift', { usage: '[--offline] [--json]', desc: "Read-only: the machine's and every project's AI tooling against ai-tooling.toml" }),
  ai('repin', { usage: '[--apply | --rollback <receipt>]', writes: true, desc: 'Repin launcher configs to stable paths ([[repin]])' }),
  ai('guard', { usage: '[--apply | --rollback <receipt>]', writes: true, desc: 'The npx ask guard in ~/.claude/settings.json' }),
  ai('timeouts', { usage: '[--apply | --rollback <receipt>]', writes: true, desc: 'Hook timeouts written in milliseconds where the field is seconds' }),
  ai('approvals', { usage: '[--apply | --rollback <receipt>]', writes: true, desc: 'The Codex MCP settings the policy sets' }),
  ai('transport', { usage: '[--apply | --rollback <receipt>]', writes: true, desc: 'The AQE hook transport v2 in the shared AQE runtime' }),

  pr('scan', ['node', 'bin/projects.js', 'scan'], { usage: '[--json]', desc: 'Read-only: new projects under the roots, and registered ones that are gone' }),
  pr('decide', ['node', 'bin/projects.js', 'decide'], { min: 1, usage: '<path> --decision onboarded|ignored|deferred [--ai a,b] | --batch <file>', writes: true, desc: 'Record decisions in registry.toml (shows the change, asks)' }),
  pr('list', ['node', 'bin/projects.js', 'list'], { usage: '[--json]', desc: 'Read-only: every registered project, its decision, tools and what it shows today' }),
  pr('facets', ['node', 'bin/projects.js', 'facets'], { usage: '[<path>] [--json]', desc: 'Read-only: what onboarding adapts to in each project (stack, workspace, Node, AI files)' }),
  pr('profile-check', ['node', 'bin/profile-check.js'], { usage: '[<path>] [--detail] [--json]', desc: "Read-only: what each project has against its tools' profiles, and why each difference exists" }),
  pr('onboard', ['node', 'bin/onboard.js'], { min: 1, usage: '<path> [--apply] … | --all | --rollback <receipt>', writes: true, desc: 'Onboard a project: the plan per file; --apply asks, backs up, writes a receipt' }),
  pr('reconcile', ['node', 'bin/reconcile.js'], { usage: '<path> [--take <unit>…] [--diff <unit>] [--apply] | --all [--apply] | --rollback <receipt>', writes: true, desc: "Bring a project's copied tool files in step with the qualified installs; edited copies are kept and reported" }),
  pr('offboard', ['node', 'bin/offboard.js'], { min: 1, usage: '<path> [--apply] | --rollback <receipt>', writes: true, desc: 'Take the AI tools out of a project that has none chosen' }),

  sk('path', { desc: "Read-only: build the steward plugin's folder from this engine and your add-ons, and print where it is (Claude Code runs this)" }),
  sk('install', { usage: '[--project <path>] [--yes]', writes: true, desc: "Install the steward's Claude Code skills for you, or in one project only; from your own terminal" }),
  sk('uninstall', { usage: '[--project <path>] [--yes]', writes: true, desc: 'Uninstall them (the way back from install)' }),

  { area: 'fleet', name: 'sync', cwd: 'fleet', run: ['node', 'bin/sync.js'], min: 1, usage: '<repo> [--apply] [--replace <path>]', writes: true,
    desc: 'Fast-forward a checkout after merges, dropping only local edits upstream already has' },
  { area: 'fleet', name: 'prune-merged', cwd: 'fleet', run: ['node', 'bin/prune-merged.js'], min: 1, usage: '<repo> [--apply]', writes: true,
    desc: 'Delete local branches whose PR merged, whose remote is gone, and that hold nothing newer' },

  { area: 'config', name: 'sync', cwd: '.', run: ['node', 'lib/configsync.js'], usage: '[--apply] | --rollback <receipt>', writes: true,
    desc: 'Bring your config repo level with GitHub: fast-forward only, then mise install and steward check' },
];

// find(words) — { cmd, args } for `steward <area> <name> …` or `steward <name> …` (top level), or null. An area's
// command wins over a top-level one of the area's name: `steward config sync` is sync, `steward config` is config.
function find(words) {
  const [a, b, ...rest] = words;
  const cmd = COMMANDS.find(c => c.area === a && c.name === b);
  if (cmd) return { cmd, args: rest };
  const top = COMMANDS.find(c => c.area === '' && c.name === a);
  return top ? { cmd: top, args: [b, ...rest].filter(x => x !== undefined) } : null;
}

module.exports = { AREAS, COMMANDS, find };
