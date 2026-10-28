# Architecture

![Revision 33](https://img.shields.io/badge/Revision-33-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

How workstation-steward is divided, how the parts meet, and the decisions behind it. Each decision has a number
(D1, D2 …) that code comments and docs cite; the table at the end says what was decided and why.
[`lifecycle.md`](lifecycle.md) is the contract across releases.

## Contents

- [Why four areas](#why-four-areas)
- [The four areas](#the-four-areas)
- [How the areas meet](#how-the-areas-meet)
- [Engine and instance](#engine-and-instance)
- [Projects: detection and onboarding](#projects-detection-and-onboarding)
- [Repo layout](#repo-layout)
- [Docs](#docs)
- [Decisions](#decisions)

## Why four areas

A machine has several software supply chains, and they drift in different ways: a toolchain falls behind, an app
bundles an old runtime, an AI tool updates itself, a project pins a path that a prune removes. Left to one script,
they overlap without knowing about each other: a general upgrade can reinstall a tool with install scripts its own
qualification had blocked. Giving each supply chain its own area, policy file and commands makes the drift visible
and the rules enforceable (D1).

## The four areas

| Area | Owns | Policy (in the instance) | Commands |
| --- | --- | --- | --- |
| **Supply chain** | mise tools, npm -g hybrids, Homebrew, apps, App Store, macOS, trust stores, Docker, IOCs, and mise itself. AI command-line clients count as ordinary tools here | `mise/`, `supply-chain/host.toml`, `supply-chain/hybrids.toml` | `steward sc …` |
| **AI tooling** (add-on) | Ruflo and AgentDB, AQE (a shared, patched runtime and CLI), RuvNet Brain, RuVector, the shared launchers, the guards (auto-update off, daemon autoStart off, hook shims), and each project's AI launchers | `ai-tooling/ai-tooling.toml` | `steward ai …` |
| **Projects** (add-on) | Discovering every project under `[projects] roots`, the registry of decisions, per-project onboarding that calls the other areas | `projects/registry.toml` | `steward projects …` |
| **Fleet** | The GitHub side: Renovate config, PR consolidation, required checks, local checkouts after merges | each repo's `renovate.json` | `steward fleet …`, `skills/pr-consolidation/` (its `rules.md`) |

## How the areas meet

- **Supply chain decides *when*, AI tooling decides *whether*.** A version may come in only once it is 3 days
  old, or is the first patched release for an advisory. AI tooling never installs a version supply chain
  hasn't cleared, and adds its own qualification on top.
- **AI packages stay where they install (D2).** mise or npm -g installs them, but `ai-tooling.toml` lists them
  as AI-owned. `steward sc upgrade` skips them, and Renovate opens their PRs only on dashboard approval.
- **Node patches carry AI state safely.** `steward sc node-patch` reinstalls the hybrids; for Ruflo, that path backs
  up every policy folder before a version change and installs only the qualified scripts.
- **Projects run the per-project steps of both areas.** Each project chooses its own AI tools, or none.

## Engine and instance

The engine (this repo) holds no one's data. Everything about a machine lives in the **instance** (D39): a folder
holding `steward.toml` and the policy files, at the same relative paths as here — `mise/`, `renovate.json`,
`supply-chain/{host,hybrids}.toml`, `supply-chain/verify.tsv`, `supply-chain/vendor/`, `ai-tooling/ai-tooling.toml`
and `projects/registry.toml`. [`examples/`](../examples/README.md) is a complete one. The engine finds it at
`$STEWARD_INSTANCE`, else in its own folder when that holds a `steward.toml`, else in `~/.config/workstation-steward`.
Keep yours in a private Git repo: it names your projects.

**`steward.toml` (D10)** says where things are; the area files say what's allowed.

- **What it holds:**
  - `schema`: the file's format (D40);
  - `[projects]`: roots, excluded paths, depth, extra skip folders and markers, and the worktree rule (D15);
  - `[paths]`: state and cache (both default to XDG), the mise config folder, and where the tools keep installs
    and settings: `mise_data_dir`, `ai_tooling_root`, `claude_dir`, `claude_json`, `codex_home`,
    `ruflo_config_dir` (mise, Claude Code and Codex defaults follow `MISE_DATA_DIR`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`);
  - `[policy]`: `min_release_age_days`, `soak_days` and `review_days`, the policies every area shares;
  - `[profiles]`: the optional areas, `ai_tooling` and `projects`, both off unless turned on. An area that is off
    refuses its commands with the reason, and `steward review` and the notices skip it;
  - `[launchers]`: extra folders searched for launcher configs;
  - `[ioc]`: extra sweep roots.
- **How it's read:** `lib/config.js` overlays the file on built-in defaults (`$STEWARD_CONFIG` points at another
  settings file; the policy files still come from the instance). Node reads instance files through `C.policy()` and
  `C.instance()`; bash through `INSTANCE_ROOT` and `SC_INSTANCE` in `lib/lib.sh`. `steward config` shows every
  effective value and where it came from; `just lint` fails on unknown keys, wrong types or unknown sections.
- **Paths in `ai-tooling.toml`** are `{{NAME}}` placeholders for the roots above (`{{AI_TOOLING_ROOT}}/aqe`,
  `{{CLAUDE_DIR}}/settings.json`); `C.policy()` fills them and fails on an unknown name.
- **The release-age gate** (`[policy] min_release_age_days`, default 3) applies to every area. mise and Renovate
  can't read `steward.toml`, so they keep copies: `steward sc release-age <days>` sets all three, and `steward sc
  audit` flags any disagreement.
- **The soak** (`[policy] soak_days`, default 3; D20): after anything changes what runs, the old installs stay that
  long, so going back is a link away instead of a reinstall. A soak starts at the newest receipt (a tool upgrade, a
  Node patch, a hybrid install, a repin, an onboarding, the AQE hook transport, mise itself); offboarding, the
  guards and `init` don't start one. `steward sc prune` refuses while one runs, and `steward sc soak` shows it.

## Projects: detection and onboarding

- **What counts as a project (D4):** any Git root under the roots (primaries, linked worktrees, nested repos),
  and non-Git folders with project markers (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, `pyproject.toml`,
  `AGENTS.md`, `.claude/`, `.mcp.json` …) that aren't inside another project. The scan skips dependency, build and
  cache folders and `[projects] exclude`.
- **When detection runs:** on demand only, never in the background. `steward` with no command prints a notice
  such as "2 new projects"; `steward projects scan` lists them.
- **The registry (D5):** `projects/registry.toml` in the instance. Each entry records the path, kind, remote,
  decision (onboarded, ignored, or deferred until a date) and the AI tools chosen. Backups and receipts go to the
  state folder, never a repo.
- **Per-project tool choice:** not every project has Ruflo, AQE or Brain, and none has to. New projects default to
  none; onboarding asks tool by tool with the evidence; drift checks only the tools a project chose and reports,
  never removes, the others.
- **What onboarding gives a project (D16, D18, D21–D26):** the per-tool profiles in
  [`../projects/profiles/`](../projects/profiles/README.md), filled in per project and merged by adding only, with
  the keep-off list winning. `steward projects facets` shows what each project adapts to (stack, monorepo, Node,
  each file's Git state); `steward projects profile-check` compares every project with its profiles and gives a
  reason for each difference.
- **What may be written (D6):** untracked or gitignored tooling files, in place, after the plan and a yes, with a
  backup, a receipt and a rollback. Tracked files go through a PR from a scratch clone; the commands refuse tracked
  files and repos mid-merge.

## Repo layout

```text
bin/steward.js          the steward client; lib/commands.js lists every command (D40, D41)
lib/                    config.js (the instance and steward.toml), lib.sh (bash helpers), projects.js (discovery,
                        registry), onboard.js / offboard.js, doctor.js and prereqs.json, soak.js, review.js …
supply-chain/           bin/ (audit, upgrade, mise-self, verify …), checks/, host-defaults.toml, README.md
ai-tooling/             bin/ (drift, repin, guard …), qualify/ (the AQE qualification kit), transports/, README.md
projects/               bin/, profiles/ (per-tool onboarding profiles), README.md
fleet/                  bin/ (sync, prune-merged), README.md
skills/                 the Claude Code skills, one per area plus pr-consolidation, each with its runbook (D48)
.claude-plugin/         the plugin and marketplace manifests (D48)
examples/               a complete example instance; the tests run against it
docs/                   README.md (index), architecture.md, lifecycle.md, prereqs.md, fleet/runbook.md, assets/
tools/                  developer tasks: release-worktree, export, leak-check, public.txt
test/                   node:test suites, run by `just test`
justfile                developer tasks only: test, lint, docs, links, release-worktree, export, leak-check
package.json            the npm package: engine files only, no dependencies
```

## Docs

- **Filenames are plain names (D8), without dates.**
- **The H1 is a short name for what the doc contains.** The revision goes in badges on the line under it
  (shields.io: `Revision` and `Revised`), never in the title. `AGENTS.md` and `CLAUDE.md` carry none.
- **Revision numbers change only with content.** Moving a file or fixing a link doesn't count.
- **Docs are checked.** `just docs` runs markdownlint (`.markdownlint-cli2.jsonc`) and lychee offline
  (`lychee.toml`) over every Markdown file, and the Docs check workflow runs the same on every PR. `just links` also
  fetches external URLs. A broken link between docs, a bad #fragment or a dead URL fails the run.
- **Where docs live:** living docs (reference, runbooks) in `docs/<area>/`; every doc listed in
  [`README.md`](README.md). Records of what happened on a particular machine belong in that machine's instance.

## Decisions

Newest first. Some record one-off choices; they keep their numbers because code and docs cite them.

| # | Decision | Chosen, and why |
| --- | --- | --- |
| D48 | Where the Claude Code skills live and how they load | **One `skills/` folder, and the repo is a Claude Code plugin named `steward`** (`.claude-plugin/plugin.json`): `supply-chain`, `ai-tooling`, `projects` and `pr-consolidation`, invoked as `/steward:<name>`. Each skill is self-contained: its runbook (and for AI tooling the qualification recipe; for PR consolidation its `rules.md`, which left `AGENTS.md`) sits beside its `SKILL.md`, it reads them through `${CLAUDE_SKILL_DIR}`, and it finds the user's files with `steward config`, so it works from an npm install, not only a checkout. The four read-only shortcuts (`/sc-audit`, `/sc-plan`, `/ai-drift`, `/projects-scan`) folded into their area skills, which take the command as an argument and pre-approve their read-only commands. No symlinks: `just claude` (`claude --plugin-dir .`) loads a checkout's skills in place, ahead of an installed release. Users install it through a marketplace whose one entry is a command, `steward skills path`. `steward skills install` registers the installed engine's own copy of that file (`.claude-plugin/marketplace.json`, copied to a fixed folder under the state folder), never one fetched from GitHub, so the command accepted on the user's yes is exactly the one the age-gated release ships; the copy on GitHub serves people adding the marketplace by hand in Claude Code, which shows them the command to review. Claude Code runs the command each session and copies the folder it prints, so the skills always match the installed (age-gated) steward and hold only what the config turns on (supply-chain always; ai-tooling and projects with their add-ons; pr-consolidation with `[skills] pr_consolidation`, off by default, rather than a second plugin). `steward init` walks the rest of setup, each answer one line in the new `steward.toml` (`lib/setup.js`): the AI tooling and projects add-ons and where the projects live, then the install (everywhere, one project in Claude's local scope so only its untracked `settings.local.json` changes, or not now) and whether to include PR consolidation; `steward skills install` and `uninstall` do it later, with a plan, a backup and a receipt. Claude Code accepts a plugin's command only from a person in their own terminal, so the install refuses inside a session. Rejected: skills beside their areas with links into `.claude/skills/` (links break when mise moves to a new version folder, and the skills pointed at files npm users don't get); `.claude/skills/` as the source (hidden, and not the plugin layout); fetching the plugin from npm by a pinned version (skips the release-age gate, and can disagree with the installed CLI) |
| D47 | Which changes cut a release | **Only changes to what users get**: the npm package (the plugin's `.claude-plugin/` included), and the Renovate preset config repos extend at a tag. release-please's `exclude-paths` skips commits whose files all sit in folders that never ship (`.github`, `docs`, `test`, `tools`); they neither open nor update the release PR, and they don't appear in `CHANGELOG.md` (the release's compare link still lists them). A release with the same code under a new number would restart every user's 3-day wait for nothing. release-please matches folders only, so an edit to a top-level file that doesn't ship (`AGENTS.md`, `justfile`) still updates the release PR; merge it only when something users get has changed. `test/release.test.js` keeps the list clear of the package. Rejected: hiding changelog sections by type (it trusts every title's label, and Renovate's `chore(deps)` workflow bumps would still cut releases); moving release-please's own files into `.github/` (edits the release workflow for a file that rarely changes) |
| D46 | How releases are made and published | **release-please**: one release PR, kept current from the Conventional Commit titles merged since the last release, with a rolling `CHANGELOG.md` grouped by type; merging it is the release (tag, GitHub release). GitHub holds the checks of a PR the workflow opens or updates until a maintainer approves them; the approved runs are the PR's required checks (checks dispatched by the workflow didn't count, so that step went). The tagged commit is tested on macOS, then published by **npm Trusted Publishing** (OIDC, no token) with provenance, behind `tools/publish-guard.js` (only `release.yml` of this repository, exactly the tag, a clean checkout, a package that passes the leak check, a version npm doesn't have; it also runs as `prepublishOnly`). The name was reserved with an empty `0.0.0` published by hand, because npm can only trust a workflow for a package that exists. PR titles are checked; merges are squash-only with the PR title as the commit. Rejected: semantic-release (publishes on every qualifying push, no review step), changesets (built for multi-package repos), a long-lived npm token. `docs/maintainers.md` is the runbook |
| D45 | Linting and type-checking the JavaScript | **Biome** (one native binary through mise, no npm dependencies) with its recommended rules, minus the ones that would only move the code to another style (`biome.jsonc` names each and why); a warning fails as an error does. **`tsc --checkJs`** (TypeScript 7, non-strict to start) reads the JavaScript and its JSDoc types with no build step; Node's type definitions (`@types/node` and `undici-types`, type files only) live in their own dev manifest, `tools/types/package.json`, pinned with checksums in its lockfile and installed with scripts off; the shipped `package.json` keeps no dependencies at all and stays macOS-only, which is why they can't live there (npm refuses a macOS-only package on the Linux lint runner). Both run in `just lint` and in the Lint workflow on every PR, on Linux, so a private copy runs it too. The first run found dead code and typing gaps, no bugs. Rejected: ESLint (about 100 npm packages), hand-written Node type stubs (they drift) |
| D44 | How long commands show progress | **In-house, no dependencies** (`lib/ui.js`): a step per stage; a spinner and a live timer once a step takes 3 s (a shorter one prints only its finished row, so nothing flickers); rows and tables in aligned columns; plain Unicode symbols (✔ ⚠ ✖) rather than emoji, which take two columns in many terminals, with an ASCII fallback for a non-UTF-8 locale or `TERM=dumb`; colour only adds to a symbol and its word, and `NO_COLOR` turns it off. Off a terminal nothing is drawn and the plain lines stay exactly as they were, because `steward review` and `just audit-parity` read them. The audit is the first user; reconcile, check, review, onboard, plan and upgrade follow. Rejected: listr2, @clack/prompts, ora with cli-table3, Ink: each would be the package's first runtime dependencies, which every release would then have to gate, audit and keep current |
| D43 | Platforms and package managers (R5c) | **Checks and providers:** the host audit is a set of checks (`supply-chain/checks/`), each listing the platforms it applies to, and each package manager is a provider (`lib/providers/`: Homebrew and mise first) that lists what is installed and outdated, dates a version for the release-age gate, and says whether it can roll back. **Platform keys per entry, no format bump:** a host.toml entry for some platforms only says `platforms = ["macos"]` (a table, or a list item written as one); without the key it holds everywhere, which is what every entry meant before, so existing files and older releases read the same values. Rejected: per-OS sections, which either need a schema bump or let an older release skip values silently (the R3b hazard). **Side by side, then switch:** the Node audit ran next to the Bash one until a run on the same machine gave identical output (2026-10-27: 121 lines, 21 actions, 0 alerts), then `steward sc audit` switched; `plan` and `upgrade` followed (2026-10-28: the same 82 plan lines, a clock stamp aside), and the Bash audit, upgrade and Homebrew helpers were retired. Applying still runs the Bash steps that back up, record and verify (`upgrade-tool`, `mise-self-update`, `verify`). v1 stays macOS; Linux (by package manager), then Windows 11 and WSL, then NixOS follow, one provider per PR |
| D42 | Keeping projects in step with the qualified AI tools, and retiring patches | `steward projects reconcile` compares, for every unit the steward copied into a project, its receipt baseline, disk and the newly qualified source: an untouched copy is updated with a backup; an edited one is kept and reported (`--take` takes one); a unit with no baseline is yours and left alone, unless it is an unedited copy of a published Ruflo, claude-flow or AQE release (`known-units.json`, built from each release's published file hashes by `just known-units`), which counts as the steward's own; tracked files are left alone. A folder holding `.LOCKED` (Ruflo's helpers) is updated like any other: the marker turns Ruflo's own refresh off, and reconcile is the reviewed, backed-up refresh it asks for. **Copied units first; settings values join once receipts record a baseline per key**, which the AQE transport's retirement will also use; until then settings stay adds-only with their fixers. A local patch lives only until a qualified whole release carries its upstream fix: every qualification re-fits the patches and drops superseded ones, and `[[retire]]` unwinds the custom pieces when none are left. See [`ai-tooling/upstream-and-reconcile.md`](ai-tooling/upstream-and-reconcile.md) |
| D41 | Working on the steward and using it on the same machine | **Two channels:** `steward` runs a pinned release, `steward-dev` the working clone; `steward version` names the build. Until the npm release, the release is a detached worktree at a tag, set up with `just release-worktree <tag>`, which writes both launchers. A dev build uses `examples/` and its own state unless given `--real`; with a real config, a command that can change things first names the dev build, and nothing may leave the config in a format the pinned release can't read. See [`lifecycle.md`](lifecycle.md#two-channels) |
| D40 | Keeping users, their config and their projects safe over successive releases | Shared safety data (IOCs, distrusted roots, browsers, the Electron window) ships as engine defaults under the user's overrides. The config is versioned (`schema`), read for at least one major after it's replaced, and changed only by `steward migrate` with a plan and a yes. Receipts record the engine version, onboarding receipts each profile's hash; `projects reconcile` updates only what the steward wrote and nobody touched, and reports a user-edited file. New AI tools arrive as profiles, new package managers as providers. v1 is macOS; Linux and then Windows follow by package manager, not distribution. See [`lifecycle.md`](lifecycle.md) |
| D39 | Making the steward usable by others | A public engine repo with no one's data in it; each user's config lives in their own instance, best kept in a private repo. MIT. All four areas ship, AI tooling and projects as add-ons, off by default. Installed from npm through mise, so the release-age gate and Renovate cover the steward itself. `tools/public.txt` decides what is public; `just leak-check` checks it. Renovate's rules ship as a preset (`renovate/steward.json`) that config repos extend at a release tag; the engine repo pins its GitHub Actions by commit SHA |
| D38 | How mise itself is updated | The standalone build, updated through the steward: `mise-self.js` picks the newest release past the gate (or a first patched release under a `security_exception`), `steward sc upgrade` or `upgrade-tool mise` applies it with the version named, a binary backup, verification and a receipt; `steward sc rollback mise` restores it. A bare `mise self-update` took the newest release with no gate before 2026.10.18 |
| D37 | Brain's Codex approvals and launcher | Brain's destructive `ruvnet_cli_run` must `prompt`, never `approve`, and its server launches the stable Node link (`ai-tooling.toml` `[[codex_prompt]]`, `[[codex_stable_node]]`); `steward ai approvals` fixes existing projects with a plan, a backup and a receipt |
| D36 | Hook timeouts written in milliseconds (the field is seconds: 5000 is 83 minutes) | `steward ai timeouts` rewrites only the numbers (1000 or more counts as milliseconds), in untracked files only, with a plan, one ask, backups, a receipt and a rollback |
| D35 | What the steward needs on a machine | One list, `lib/prereqs.json`, read by `steward doctor` (plain Node, so it runs before `yq`) and printed into [`prereqs.md`](prereqs.md); `--install` plans only the missing mise and Homebrew tools and asks |
| D34 | How local checkouts catch up after merges | `steward fleet sync` only fast-forwards, dropping a local edit only where upstream already has its content (or the user names it); `steward fleet prune-merged` deletes only branches whose PR merged and whose remote is gone. Both plan, ask and keep a receipt |
| D33 | What a bare `aqe`, `aqe-mcp` or `agentic-qe` runs | The shared, patched runtime, first on `PATH` through mise's `[env] _.path`; the stock package stays installed and tracked by Renovate, pinned to the runtime's base version, so updates stay visible |
| D32 | How a new AQE release is qualified and promoted | The gate scripts in `ai-tooling/qualify/aqe/` (build, smoke, gates on synthetic stores), then `promote.sh`, with paths from the config |
| D31 | Projects recorded with no AI tools that still carry them (one-off) | `steward projects offboard` takes the wiring out of untracked or ignored files and moves stores and copies into the run's backup, never deleting; the rollback moves them back |
| D30 | `@latest` launchers that `ruflo init` writes | Removed, not pinned (`projects onboard --remove-unpinned`): the profile gives Claude Ruflo's hooks and plugins and Codex a pinned server |
| D29 | ruflo-console's own updater | Off, kept off by `steward ai guard`; Ruflo's plugins change only by qualifying a new pinned marketplace commit |
| D28 | Where ignore rules for AI tool output live | Two layers: machine-wide output in one marked block of the user's git ignore file (`steward ai guard`), and a project's own `.gitignore` for what it tracks or doesn't |
| D27 | Agents told to run unpinned `npx` (`@latest`, `@alpha`) | A user-level `ask` rule per tool family in `~/.claude/settings.json`, added by `steward ai guard` and checked by drift |
| D26 | Skill, command and agent names both Ruflo and AQE ship | Ruflo's, copied unchanged; AQE's copy skips every name the qualified Ruflo ships and keeps its own QE material |
| D25 | Outdated vendor files in a project (`aqe-hook.cjs`, `brain-checkpoint.cjs`) | Refreshed to the qualified copy when the sha256 is a known vendor file (`known-vendor-files.toml`), with a plan, a backup and a yes; an edited copy is kept |
| D24 | How AQE hooks reach the shared runtime | Onboarding copies AQE's own hook files and points `AQE_HOOK_BUNDLE` at one steward-owned transport (`[aqe] hook_transport`); `steward ai transport` installs it. Drift compares it byte for byte |
| D23 | New features as tools add them | The baseline is each qualified install's defaults minus the keep-off list (`[[keep_off]]`), which always wins; drift reports missing and new features, onboarding adds them only after a yes |
| D22 | Which Ruflo helper set onboarding installs | The full set from the qualified install, plus `.LOCKED`; a locked folder only gains missing names |
| D21 | Where RuVector and AgentDB belong | In the Ruflo profile: they are its vector layer and memory backend, not separate tools |
| D20 | Waiting before a prune | The soak: `[policy] soak_days` after the newest change, enforced by `steward sc prune`; drift checks that every path a launcher names still exists |
| D19 | Claude Code agent worktrees (`<repo>/.claude/worktrees/*`) | Not onboarding targets: they're thrown away after the agent's task |
| D18 | Where onboarding's per-tool content comes from | Worktrees copy from their parent; new projects use the per-tool templates plus detected stack facets. Anything needing `ruflo init` or `aqe init` is a manual step |
| D17 | Codex tool approvals when onboarding adds a server | The vetted set, listed in the plan; `--no-approvals` opts out |
| D16 | Onboarding scope | Full per-tool profiles (Ruflo, AQE, Brain), each chosen per project |
| D15 | Worktrees | `projects.worktrees = "inherit"`: a worktree follows its main checkout's decision and tools and never prompts; `ignore` and `prompt` are the alternatives |
| D14 | Confirming the registry (one-off) | One project at a time, with evidence, recorded with `steward projects decide` |
| D13 | Tracked launcher files whose machine paths come only from uncommitted edits | Repinned in place only when the user names the file (`--tracked-local`) and the committed version has none of the paths; otherwise a PR would publish machine paths |
| D12 | Where the RuVector launchers point | mise's normal install, not a preserved copy: fewer custom runtimes |
| D11 | Launchers pinned to a versioned Node path | Repinned to stable paths (`node/26/…`) before onboarding copies them; never mise shims in launchers; the prune refuses while any point into a removable install |
| D10 | Hard-coded locations | `steward.toml` over built-in defaults; policy stays in the area files; the shared release-age gate lives in `steward.toml` |
| D9 | A public plugin | First a public engine (D39); a thin Claude Code plugin and marketplace may follow |
| D8 | Docs taxonomy | Living docs by area, plain filenames, revision badges, one index |
| D7 | Delivery order (one-off) | Protection first, then layout, read-only tools, skills, and changing commands last |
| D6 | What commands may write in a project | Untracked or ignored tooling files in place with a plan, a yes, a backup and a receipt; tracked files through a PR |
| D5 | Where the registry lives | In the instance; receipts and backups in private state |
| D4 | What the scan treats as a project | Git roots (primaries, worktrees, nested) plus marked non-Git folders |
| D3 | Repo layout | Area folders; a clean break when commands move, no aliases (the area `just` modules became `steward` commands, D41) |
| D2 | AI packages installed by mise or npm -g | Stay installed there; AI-owned, skipped by `steward sc upgrade`, Renovate on dashboard approval |
| D1 | How to divide the work | Four areas: supply chain, AI tooling, projects, fleet |
