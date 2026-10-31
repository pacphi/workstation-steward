# Changelog

All notable changes to workstation-steward. From 0.1.0 on, release-please writes each release's section from the
Conventional Commit titles of the pull requests merged since the one before it (D46).

## [0.10.1](https://github.com/pacphi/workstation-steward/compare/v0.10.0...v0.10.1) (2026-10-31)


### Bug Fixes

* the session hook says how it raised a step, and a mention nobody saw comes back ([#80](https://github.com/pacphi/workstation-steward/issues/80)) ([d9ece23](https://github.com/pacphi/workstation-steward/commit/d9ece23b4bc2914fe2c7e4e250c3c28363f2df5d))


### Documentation

* the film as the GitHub Pages site, with the pilot that comes aboard ([#77](https://github.com/pacphi/workstation-steward/issues/77)) ([df2f0aa](https://github.com/pacphi/workstation-steward/commit/df2f0aaa465ac8654ff7a38b1e5bfb700c6c320d))

## [0.10.0](https://github.com/pacphi/workstation-steward/compare/v0.9.0...v0.10.0) (2026-10-31)


### Features

* a smaller command surface: tiers, groups, old names, and an eight-command help (D60) ([#72](https://github.com/pacphi/workstation-steward/issues/72)) ([7cbb381](https://github.com/pacphi/workstation-steward/commit/7cbb38122e44d991d6a7e35dcf022c2de8e371a4))
* bare steward shows the briefing: one process, the one next step, about 8x faster ([#69](https://github.com/pacphi/workstation-steward/issues/69)) ([eb5f50f](https://github.com/pacphi/workstation-steward/commit/eb5f50fc9d14a39fc099cae04c443a201b2356c8))
* bundled commands: ai fix, fleet tidy, projects apply and upgrade, one yes for all (D61) ([#73](https://github.com/pacphi/workstation-steward/issues/73)) ([74b2a9f](https://github.com/pacphi/workstation-steward/commit/74b2a9f10189c03cad1f0ef9bcbc03f220bd3cdb))
* steward brief names the one next step, read from disk without the network ([#62](https://github.com/pacphi/workstation-steward/issues/62)) ([ac8862c](https://github.com/pacphi/workstation-steward/commit/ac8862c3a6c20fad33d5c0fc01dd0495bde86c8a))
* steward brief refreshes its view in the background, read-only; nothing changes on its own (D57) ([#65](https://github.com/pacphi/workstation-steward/issues/65)) ([1ed2378](https://github.com/pacphi/workstation-steward/commit/1ed2378ac274eb51ce13737c6fc8760b1258a3cd))
* steward fix works the list, and the fix skill drives it (D59) ([#71](https://github.com/pacphi/workstation-steward/issues/71)) ([62f2c20](https://github.com/pacphi/workstation-steward/commit/62f2c20dc9669f7c6ec9ce4fb0ad48061987a37e))
* the engine labels who takes each step; [autonomy] and --unattended (D58) ([#70](https://github.com/pacphi/workstation-steward/issues/70)) ([d538fb0](https://github.com/pacphi/workstation-steward/commit/d538fb0ebad27c97733b2a5e9533fb6c1ed3b619))
* the steward plugin's session-start hook hands Claude the briefing, once, then quiet (D48) ([#67](https://github.com/pacphi/workstation-steward/issues/67)) ([52869fc](https://github.com/pacphi/workstation-steward/commit/52869fcbe5812330c2048bc5fe470ac8f44b761c))


### Bug Fixes

* docs match the shipped command surface; help and briefing wording ([#75](https://github.com/pacphi/workstation-steward/issues/75)) ([a0796c9](https://github.com/pacphi/workstation-steward/commit/a0796c95c6f44f72b79f75323de745b02ae5561d))
* progress everywhere, so no command looks hung ([#66](https://github.com/pacphi/workstation-steward/issues/66)) ([56f4619](https://github.com/pacphi/workstation-steward/commit/56f461981c62737b400b7b1561fd5f60f567052f))
* promote.sh refuses what a stopped run left behind, and runs with no AQE stores ([#63](https://github.com/pacphi/workstation-steward/issues/63)) ([d40c229](https://github.com/pacphi/workstation-steward/commit/d40c229abaa6381dc51df80d16d14bfa84902356))
* three writers get the plan, yes, backup, receipt and way back every writer has (D62) ([#74](https://github.com/pacphi/workstation-steward/issues/74)) ([d717968](https://github.com/pacphi/workstation-steward/commit/d717968baeb4ea27965b4027138e13e843a6a104))

## [0.9.0](https://github.com/pacphi/workstation-steward/compare/v0.8.1...v0.9.0) (2026-10-30)


### Features

* steward review and the banner show what the release-age gate holds back (D56) ([#59](https://github.com/pacphi/workstation-steward/issues/59)) ([df4a84c](https://github.com/pacphi/workstation-steward/commit/df4a84ca8d01f6f4366bef78cfac740cfb3b2cdd))


### Bug Fixes

* onboarding recognizes AQE 3.15.12 and 3.15.16 vendor files; the defaults follow the qualified release ([#60](https://github.com/pacphi/workstation-steward/issues/60)) ([e6be10e](https://github.com/pacphi/workstation-steward/commit/e6be10e48ad889933caca7da861aa99648c8c086))

## [0.8.1](https://github.com/pacphi/workstation-steward/compare/v0.8.0...v0.8.1) (2026-10-30)


### Maintenance

* rebuild known-units after qualifying ruflo 3.63.4 ([#55](https://github.com/pacphi/workstation-steward/issues/55)) ([8e68db1](https://github.com/pacphi/workstation-steward/commit/8e68db13580a8abe926e9f966ea7acf57907b7a7))

## [0.8.0](https://github.com/pacphi/workstation-steward/compare/v0.7.0...v0.8.0) (2026-10-30)


### Features

* ai drift flags a per-project tool switched on at user level ([#51](https://github.com/pacphi/workstation-steward/issues/51)) ([2f81309](https://github.com/pacphi/workstation-steward/commit/2f81309e1699664306db93e67c7a001af6b196d2))


### Bug Fixes

* config sync pulls and finishes a send around local edits git can combine ([#54](https://github.com/pacphi/workstation-steward/issues/54)) ([3fd47f3](https://github.com/pacphi/workstation-steward/commit/3fd47f3fe3162a588a83aac0b59e27f8a9b3f79c))
* sc upgrade reports a failed tool and exits non-zero, and verifies once ([#52](https://github.com/pacphi/workstation-steward/issues/52)) ([d65db84](https://github.com/pacphi/workstation-steward/commit/d65db84cb0bd94dca05f9e6c50766340f7a31dc3))

## [0.7.0](https://github.com/pacphi/workstation-steward/compare/v0.6.0...v0.7.0) (2026-10-29)


### Features

* weekly upstream watch for shipped key pins, and the maintainer runbook (D52) ([#50](https://github.com/pacphi/workstation-steward/issues/50)) ([210c2bc](https://github.com/pacphi/workstation-steward/commit/210c2bc3ae16f2dad0adf528d9c69357f81f6dec))


### Documentation

* the supply-chain animation shows declared updaters (D52) ([#48](https://github.com/pacphi/workstation-steward/issues/48)) ([e3a8ac0](https://github.com/pacphi/workstation-steward/commit/e3a8ac09af039f56ef1c9559ed0a2e330eec11b2))

## [0.6.0](https://github.com/pacphi/workstation-steward/compare/v0.5.0...v0.6.0) (2026-10-29)


### Features

* release classes and declared updaters, Brain's knowledge base the first (D52) ([#44](https://github.com/pacphi/workstation-steward/issues/44)) ([77b7ef2](https://github.com/pacphi/workstation-steward/commit/77b7ef283070746cf24c9dd0fdd799b6a16cf58b))

## [0.5.0](https://github.com/pacphi/workstation-steward/compare/v0.4.1...v0.5.0) (2026-10-29)


### Features

* /steward-maintain, the maintainer's routine after a merge as a project skill (D53) ([#42](https://github.com/pacphi/workstation-steward/issues/42)) ([c8ab031](https://github.com/pacphi/workstation-steward/commit/c8ab03110ca07124218ce402ffba768176d4b4ef))

## [0.4.1](https://github.com/pacphi/workstation-steward/compare/v0.4.0...v0.4.1) (2026-10-29)


### Bug Fixes

* steward review reads the projects behind again; config sync names new and deleted files ([#38](https://github.com/pacphi/workstation-steward/issues/38)) ([7efc537](https://github.com/pacphi/workstation-steward/commit/7efc537aacfef762376b8e0b09b938a73c294e0d))


### Documentation

* a curated, commented-out tool collection in the example mise config ([#40](https://github.com/pacphi/workstation-steward/issues/40)) ([01fb41b](https://github.com/pacphi/workstation-steward/commit/01fb41b9db3c9bc0155e1b904b22ad615af9e90d))

## [0.4.0](https://github.com/pacphi/workstation-steward/compare/v0.3.2...v0.4.0) (2026-10-29)


### Features

* steward sc audit shows its findings in columns, grouped by what to do (D51) ([#36](https://github.com/pacphi/workstation-steward/issues/36)) ([55368c2](https://github.com/pacphi/workstation-steward/commit/55368c25f5f333de4e07484e1dfc57e8a8dc5838))


### Bug Fixes

* an app is no longer compared with another product's cask of the same name ([#37](https://github.com/pacphi/workstation-steward/issues/37)) ([70b9400](https://github.com/pacphi/workstation-steward/commit/70b940062cf7f0a006fc675a7870c6729a407520))
* steward review lists each finding once, under the command that fixes it ([#34](https://github.com/pacphi/workstation-steward/issues/34)) ([d2cb56c](https://github.com/pacphi/workstation-steward/commit/d2cb56c86b5243ed8d009b785e3a56c9c9a4640a))

## [0.3.2](https://github.com/pacphi/workstation-steward/compare/v0.3.1...v0.3.2) (2026-10-29)


### Bug Fixes

* drift and onboarding catch npx launchers with no version, not only [@latest](https://github.com/latest) ([#32](https://github.com/pacphi/workstation-steward/issues/32)) ([e4a0475](https://github.com/pacphi/workstation-steward/commit/e4a04750dbae489ca7cb399682e0536ab8c628d9))

## [0.3.1](https://github.com/pacphi/workstation-steward/compare/v0.3.0...v0.3.1) (2026-10-29)


### Bug Fixes

* steward fleet sync and config sync no longer mistake a leftover REBASE_HEAD for a rebase ([#30](https://github.com/pacphi/workstation-steward/issues/30)) ([d03362e](https://github.com/pacphi/workstation-steward/commit/d03362ecc132e367e7cd00dbacb85e219fb8d1a8))

## [0.3.0](https://github.com/pacphi/workstation-steward/compare/v0.2.2...v0.3.0) (2026-10-29)


### Features

* steward config sync brings your config repo level with GitHub ([#26](https://github.com/pacphi/workstation-steward/issues/26)) ([e19b8e2](https://github.com/pacphi/workstation-steward/commit/e19b8e26ec735e6b1ce8e08064f6203e6d6998f9))
* steward config sync sends this Mac's changes as a pull request ([#28](https://github.com/pacphi/workstation-steward/issues/28)) ([6bcf891](https://github.com/pacphi/workstation-steward/commit/6bcf891610a7f19730aa769321ed3580e74a4bc5))
* the steward knows where your config repo stands (banner, steward config, review) ([#24](https://github.com/pacphi/workstation-steward/issues/24)) ([89657d8](https://github.com/pacphi/workstation-steward/commit/89657d8008f0f5f2b73368ad90422afd377833b1))

## [0.2.2](https://github.com/pacphi/workstation-steward/compare/v0.2.1...v0.2.2) (2026-10-28)


### Bug Fixes

* path arguments from your folder, no hard-coded fleet root, app versions and repo names read right ([#22](https://github.com/pacphi/workstation-steward/issues/22)) ([0ddd85a](https://github.com/pacphi/workstation-steward/commit/0ddd85aec4722667f44314502eb7fad40d359aba))


### Documentation

* a skills README with install, what to ask, and four Claude Code sessions ([#23](https://github.com/pacphi/workstation-steward/issues/23)) ([45547f2](https://github.com/pacphi/workstation-steward/commit/45547f264cae8be7d5fb3334b732889c690a5810))
* an animated everyday task on each area page ([#20](https://github.com/pacphi/workstation-steward/issues/20)) ([2f87d1c](https://github.com/pacphi/workstation-steward/commit/2f87d1ca1f1765718995747752d75578434825b4))
* keep your config in a private Git repo, with an animated walkthrough ([#19](https://github.com/pacphi/workstation-steward/issues/19)) ([b0f70c1](https://github.com/pacphi/workstation-steward/commit/b0f70c1bc939c344f2bedceb9177bd9aa6c5a402))

## [0.2.1](https://github.com/pacphi/workstation-steward/compare/v0.2.0...v0.2.1) (2026-10-28)


### Bug Fixes

* a fresh Mac's first steps: version before init, sc link, verify without the AI tools, the young npm name ([#16](https://github.com/pacphi/workstation-steward/issues/16)) ([b967279](https://github.com/pacphi/workstation-steward/commit/b967279ad71fe6b294d34a05ada1814d7540e146))


### Documentation

* a README that shows the steward working: five animated terminals, the promises with their mechanisms, a guided quick start ([#17](https://github.com/pacphi/workstation-steward/issues/17)) ([ce57a84](https://github.com/pacphi/workstation-steward/commit/ce57a844cd93c338af3d1fea461c571cca830857))

## [0.2.0](https://github.com/pacphi/workstation-steward/compare/v0.1.0...v0.2.0) (2026-10-28)


### Features

* **skills:** install the steward plugin with `steward skills install` and from `steward init` (D48) ([#11](https://github.com/pacphi/workstation-steward/issues/11)) ([511a8d2](https://github.com/pacphi/workstation-steward/commit/511a8d2d4aef04d15b8a8d3bf5cfdfc508062baa))
* **skills:** one skills/ folder as the steward plugin, self-contained, no symlinks (D48) ([#10](https://github.com/pacphi/workstation-steward/issues/10)) ([82c2d73](https://github.com/pacphi/workstation-steward/commit/82c2d73d3b1b01419125091922cf418bdbbcfa31))


### Continuous Integration

* release only when what users get changes (D47) ([#9](https://github.com/pacphi/workstation-steward/issues/9)) ([98a7a98](https://github.com/pacphi/workstation-steward/commit/98a7a981f969eb57e22d6ea94ccc373564ce8666))

## 0.1.0 (2026-10-28)


### Features

* releases through release-please and npm Trusted Publishing, behind a publish guard (D46) ([#3](https://github.com/pacphi/workstation-steward/issues/3)) ([4607b68](https://github.com/pacphi/workstation-steward/commit/4607b68e8caabac0ac1b1bf63bc401f2f2a6e05c))
* workstation-steward, the engine (initial public commit) ([9f2bfd5](https://github.com/pacphi/workstation-steward/commit/9f2bfd57b8133034c30d0f5ef87979b7f608567a))


### Continuous Integration

* the first release is 0.1.0 (release-please initial-version) ([#5](https://github.com/pacphi/workstation-steward/issues/5)) ([fffd5c4](https://github.com/pacphi/workstation-steward/commit/fffd5c49fa5abddb27ce58513ae43edcdedc452f))

## [Before 0.1.0] Private development, 2026-10-21 to 2026-10-27

The steward was built in a private repository before this one existed, and that history stays private. The
decisions it took are in [docs/architecture.md](docs/architecture.md#decisions). Its 82 pull requests, by kind, oldest first:

### Features

* Mise-managed toolchain as source of record
* Manage the Renovate CLI as an npm: tool
* Host policy with on-demand audit-host and host-upgrade
* Version the PR-consolidation skill and rollout brief
* Pr-consolidation v2: polyglot, Dependabot + Renovate
* Protect Ruflo state and the qualified install (P1)
* Read-only AI-tooling drift and project registry (P3)
* Area skills and runbooks (P4)
* Load the area skills in this repo; four read-only commands
* Steward.toml for locations and discovery (D10)
* `just ai repin` for version-pinned launchers (D11, D12)
* Repin tracked files whose pins are only local edits (D13); permission-only refs
* `just projects decide` records the owner's decisions (5a, D14)
* Soak before prune (soak_days) and a launcher-target check in drift (D20)
* Per-tool profiles, stack detection and profile-check; npx ask guard (5a steps 2–3, D21–D27)
* Onboard plan, apply with backups and rollback, AQE transport install, drift checks (5a steps 4–6)
* Onboard --replace-older for known older AQE hook forms; profile-check reads relative store paths
* Onboard --fix-keep-off sets keep-off values a project breaks
* Git ignore and plugin store guards; this repo's .gitignore grouped and commented (D28, D29)
* Onboard --remove-unpinned removes the Ruflo-family @latest launchers (5b, D30)
* Offboard takes AI tools out of a project with none (D31)
* Externalize install roots, tool folders and policy numbers, with defaults
* AQE qualification kit; qualify and promote 3.15.12-local.1; Brain CLI 4.7.17 (D32)
* Start-here guide, just review, and a weekly Steward review issue
* Bare aqe, aqe-mcp and agentic-qe run the shared runtime; stock AQE stays managed (D33)
* Just fleet sync and prune-merged bring checkouts level after merges (D34)
* Just sc tool-age checks the age of every package a new npm: tool version pulls in
* Just doctor checks what the machine needs; --install plans and asks (D35)
* Just ai timeouts turns hook timeouts written in milliseconds into seconds (D36)
* Brain's destructive ruvnet_cli_run asks before it runs; its server launches the stable node (D37)
* Mise itself updates through the steward, age-gated, with a backup and rollback (D38)
* The engine reads policy from an instance; AI tooling and projects are opt-in add-ons (D39, readiness R1)
* The public face: examples/ as a complete instance, neutral citations, LICENSE, SECURITY, CONTRIBUTING, macOS tests (D39, readiness R2)
* The steward client and npm package, alongside just (D40, readiness R3a)
* Two channels: steward runs a pinned release, steward-dev the clone (D41)
* The cutover: user commands are `steward …`; the root justfile keeps only developer tasks (D41)
* The private parts move out of what goes public: archive/, owner/, export and leak-check (D39, readiness R4a)
* The Renovate rules as a preset; the engine repo pins its actions by commit SHA (D39, D40, readiness R4c)
* Shared safety data ships as engine defaults under your host.toml; an unreadable config format is refused (D40, readiness R3b)
* Steward projects reconcile brings the steward's copies in step with a promoted AI tool version (D42, readiness R5b)
* Steward check, review and the banner list the projects a Ruflo or AQE promotion left behind (D42, F2)
* Reconcile recognizes unedited copies of published Ruflo, claude-flow and AQE releases in projects set up before the steward (D42, F3)
* The host audit as checks and providers, beside the Bash audit; platforms keys in host.toml (D43, readiness R5c PR 1)
* Steward sc audit runs the Node checks, after the Bash and Node audits printed identical output on the same Mac (D43, readiness R5c PR 2)
* Steps with a spinner and live timer, aligned rows and a summary table; the audit is the first user (D44)
* Biome and the TypeScript checker over the JavaScript, in just lint and on every PR (D45)
* Steward sc plan and upgrade plan through the providers; the Bash audit and upgrade are retired (D43, readiness R5c PR 3)

### Bug Fixes

* Test the binary mise resolves; warn on stale PATH
* Match mise npm tools by depName; add the 0.x/major rule
* Refuse while launchers point into removable installs (D11)
* Links into prunable installs and Ruflo memory hooks count as pinned
* Scan AQE hook shims and the AQE runtime's start scripts for version pins
* Drift judges a project's bare aqe-mcp server by what a fresh shell runs (D33)
* The Tests workflow runs green on a clean Mac (install step, AI-install tests skip with a reason)
* The soak list counts what onboard and reconcile receipts changed, and names the project

### Documentation

* Record the 2026-10-21 Node security migration (PRs, issues, follow-ups)
* Handoff prompt for the next session
* AGENTS.md as the durable rulebook
* Rename to workstation-steward
* Archive the 2026-10 rollout records cited by the skill
* History of the 2026-10-21..23 toolchain, dependency and security work
* Lessons from the sindri LTS work
* AI tooling ownership and qualification recipe (2026-10-24 record)
* Short titles, with revision and revised date as badges under them
* The lifecycle across releases: install, upgrade, config migration, project reconcile, adding tools (D40)
* The public docs read as the engine's, not one machine's (D39, readiness R4b)
* Upstream fixes and reconciliation for the AI tooling: the three layers, retiring patches, reconcile's scope (D42)
* What reconcile does to a project, in plain words, in the docs and above every plan; leak-check matches private terms as whole names

### Refactoring

* Four-area layout, `just sc` module, docs taxonomy (P2)
* --rollback <receipt> on the command itself; one backup folder per run

### Tests

* Cover pre-existing npm: tools and token CLIs; docs: durable post-merge sync kit
* Stand-ins for the AI tool installs, so the onboarding and offboarding tests run on CI (readiness R5a)

### Maintenance

* Upgrade 12 tools within the 3-day gate
* Host-upgrade 2026-10-24 (14 tools past the 3-day gate)
* Owner's decisions for every project (D14); worktrees follow their parent (D15)
* Consolidate 7 Renovate PRs; re-lock stale platform entries; lock check on every PR
* Update dependency gh to latest
* Markdownlint and lychee, run locally (just docs, just links) and on every PR
* Update dependency npm:@xai-official/grok to v1.0.70
* The private repo was renamed; mise 2026.10.18's lock normalization
* Host.toml keeps only what's yours; the shared policy comes from the engine's defaults (D40)
* Remove the four security exceptions that expired on 2026-10-25
