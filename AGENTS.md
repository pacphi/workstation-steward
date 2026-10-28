# AGENTS.md

Instructions for coding agents, and people, working on workstation-steward or running it on a machine. Read this
before changing anything here, or in a project on the steward's behalf. `README.md` covers the layout,
`docs/architecture.md` the design, `docs/lifecycle.md` the contract across releases, and `docs/README.md` indexes
the rest. Your own operating rules belong in your instance, not here.

## What this repo is

The engine that keeps a machine's software supply chain current within policy, split into four areas
(`docs/architecture.md`). It holds no one's data: everything about a machine (project roots, paths, the optional
areas, and the policy files) lives in the **instance**, found at `$STEWARD_INSTANCE`, else the engine's own folder
when it holds a `steward.toml`, else `~/.config/workstation-steward` (D39). `steward config` shows the effective
values and where the instance is. Paths below are relative to the instance unless they name engine code.

- **Supply chain (`supply-chain/`, `steward sc …`):**
  - the mise toolchain: `mise/config.toml` and `mise/mise.lock`, symlinked into `~/.config/mise/`
    (`steward sc link`); Renovate watches it and proposes tool updates as PRs;
  - the npm -g hybrids (`supply-chain/hybrids.toml`);
  - host policy (`supply-chain/host.toml`) for Homebrew, apps, trust stores and IOCs, enforced by
    `steward sc audit` (read-only) and `steward sc upgrade` (mutating; `steward sc plan` previews).
- **AI tooling (an add-on, `[profiles] ai_tooling`):** Ruflo, AgentDB, AQE, Brain and RuVector, plus their
  launchers and guards. They install through mise or the hybrids, but their rules come from
  `ai-tooling/ai-tooling.toml` and `ai-tooling/README.md`. `steward ai drift` reports drift read-only. Not every
  project uses these tools; check `projects/registry.toml` before assuming one does.
- **Projects (an add-on, `[profiles] projects`; `projects/`, `steward projects …`):** discovery of every project
  under `[projects] roots` and the registry of decisions (`projects/registry.toml`). `steward projects onboard`
  plans and applies each project's chosen tools, `steward projects reconcile` brings the copies it made in step with
  a newly promoted version, and `steward projects offboard` takes them out of a project with none (the plan, the
  user's yes, a backup and a receipt).
- **Fleet (`fleet/`):** how the repos under the roots get dependency updates (Renovate) and how security fixes are
  consolidated and merged. Those repos are changed through PRs only, never by editing their checkouts directly.

## Working on the engine

- **Commands that write** share one shape: a read-only plan by default; `--apply` (or a `[y/N]`) to act; a backup
  before the first write; a receipt under the state folder, recording the engine version; a way back (`--rollback`,
  `--undo` or `steward sc rollback`). `DRY_RUN=1` previews any of them. Every user command is listed in
  `lib/commands.js`.
- **No machine data in engine code.** Paths and roots come from `steward.toml` (`lib/config.js`); policy comes from
  the instance's files (`C.policy()`, `C.instance()`, `INSTANCE_ROOT`/`SC_INSTANCE` in `lib/lib.sh`). Never
  hard-code a home folder, a project or a repo. `just leak-check` must pass before pushing.
- **Test against the examples:** `STEWARD_INSTANCE=$PWD/examples just test`, plus `just lint` and `just docs`.
  Tests use `node:test`, no network, throwaway folders and temp instances. Every fix comes with the test that would
  have caught it. Tests that need the AI tool installs use the real ones where they exist and small stand-ins elsewhere
  (`test/fixtures.js`; `STEWARD_TEST_FIXTURES=1` forces the stand-ins), so CI runs them too.
- **Two channels (D41):** `steward` is the pinned release, `steward-dev` the clone, which uses `examples/` unless
  given `--real`. Try a change on your own machine with `steward-dev --real`; it names the dev build before any
  command that can change things.
- **Decisions** that change behavior get a row in the table in `docs/architecture.md`, with the reason.
- **Don't edit `ai-tooling/transports/aqe-hook-bundle.cjs` for wording.** `steward ai drift` compares it byte for
  byte with the installed, qualified transport, so even a comment change shows as drift on every machine.
- **Long commands show progress:** a live timer and timed milestones (`lib/progress.js`, `quiet` in `lib/lib.sh`).

## Hard rules

### Toolchain

- Never run `mise upgrade node`: it prunes by default and doesn't reinstall the hybrids. Use
  `steward sc node-patch <x.y.z>`. Always use `--no-prune` on `mise upgrade`; prune only with `steward sc prune`, which
  waits out the soak (`steward.toml` `[policy] soak_days`, default 3) after every upgrade, Node patch, hybrid install
  or repin. Don't skip it (`STEWARD_SKIP_SOAK=1`) without the user's yes.
- Never run a bare `mise self-update`: before 2026.10.18 it takes the newest release with no age gate, and it updates
  plugins. mise itself updates through `steward sc upgrade` or `steward sc upgrade-tool mise` (D38), which name the gated
  version, back up the binary and write a receipt.
- Never run plain `npm doctor`: its cache check garbage-collects `~/.npm`. Use the subset in `supply-chain/bin/verify`.
- Install npm -g hybrids one per command, with the allow-scripts list in `supply-chain/hybrids.toml`. A shared
  transaction dedupes optional deps and changes resolution.
- Ruflo is AI tooling (the add-on; `ai-tooling/README.md`). Install it only through `steward sc install-hybrids` or
  `steward sc node-patch`. Both back up every Ruflo policy folder when the version changes, because the first write
  migrates policy state. Both use only the qualified install scripts and write a receipt to
  `~/.local/state/workstation-steward/hybrids/`. `steward sc prune` refuses until the active Node's hybrids have
  matching receipts.
- npm 12 and aube block install scripts by default. Allow every script a tool actually uses, including
  transitive ones.
- `trust_policy_excludes` takes exact versions only, and only after `steward sc trust-review` plus publisher and
  commit evidence. On REJECT, investigate and ask.
- Test risky installs in an env-redirected sandbox first: `MISE_DATA_DIR`, `MISE_CONFIG_DIR`,
  `MISE_CACHE_DIR`, `MISE_STATE_DIR`, `HOME` **and `XDG_CACHE_HOME`** (aube ignores `HOME`).

### Release age (applies everywhere: mise, Renovate, `host.toml`, dependency PRs)

- **3-day cooldown.** Take the newest version published at least 3 days ago. The number is set once in
  `steward.toml` (`[policy] min_release_age_days`, default 3); `steward sc release-age <days>` changes it there and in
  the copies mise and Renovate need, and `steward sc audit` flags any disagreement.
- **Exception:** the first patched release for an advisory may skip the gate. How to check it (three advisory
  databases) is in `skills/pr-consolidation/rules.md`; on a machine, record it in `host.toml` with an expiry.
- Browsers (`always_current` in `host.toml`) are never held: nearly every release carries security fixes.
- **Majors are deliberate.** A 0.x minor bump counts as a major; the exception is `golang.org/x/*`.

### Changing a project's files

- Agents never edit, commit in or reset a project's checkout. The one exception (D6 in `docs/architecture.md`):
  the steward's own commands (`steward ai repin`, `steward projects onboard`, `reconcile` and `offboard`) may edit
  **untracked or gitignored tooling files** (`.mcp.json`, `.codex/config.toml`, `.claude/settings*.json`, the tool
  copies under `.claude/` and `.claude-flow/`, and the repo's `.git/info/exclude`) in place. They show a plan, get
  the user's yes, back up, check the parse and write a receipt. They refuse tracked files and repos mid-merge;
  tracked changes go through a PR. Narrower still (D13): a tracked file may be repinned only when its committed
  version has none of the paths (they come solely from uncommitted local edits) and the user names it
  (`--tracked-local <file>`). Nothing is staged or committed. Work in fresh clones in a scratch directory, then push
  and open PRs. After merges, the user syncs checkouts with `steward fleet sync <repo>` and tidies branches with
  `steward fleet prune-merged <repo>` (D34). Both fast-forward or delete only after a plan and the user's yes, back
  up or record what they drop in a receipt, and never rebase, reset, merge or commit. Agents run them without
  `--apply` only.
- Dependency PRs in another repo (lockfile ages, majors, merging, attribution, CI audits) follow
  `skills/pr-consolidation/rules.md`.

## Renovate

- Updates come from Renovate (the Mend app), not Dependabot's. A config repo's rules come from the preset
  `renovate/steward.json`, extended at a release tag; until there is one, they are carried inline and
  `test/renovate.test.js` keeps them equal. The engine repo's own config is `.github/renovate.json`, which pins
  GitHub Actions by commit SHA with a version comment.
- How Renovate behaves (config read from the default branch only, security PRs, the 0.x and mise-tool matching
  rules, checking a config change locally) is in `skills/pr-consolidation/rules.md`. Read it before changing
  `renovate/steward.json`.

## Workflows that worked

- **Skills** (`skills/`, the `steward` plugin, D48): `supply-chain`, `ai-tooling` and `projects` each wrap their
  area's `steward` commands and follow the runbook beside them; `pr-consolidation` (v2) turns a repo's bot PRs into
  one verified PR under the rules in its `rules.md`, and never merges (its `ORCHESTRATION.md` covers the merge).
  `just claude` loads this checkout's skills (`claude --plugin-dir .`); after editing one, run `/reload-plugins`.
- **New advisory or incident report:** verify each claim against primary sources, then sweep local
  exposure read-only (`steward sc audit`, plus targeted `find`/`ps`/`docker` checks). Add IOCs and distrusted
  roots to `supply-chain/host-defaults.toml` in the engine (a PR, so every machine gets them with the next release) or,
  for your machine alone, to your instance's `host.toml`; patch within policy, and record what happened in your instance's docs. Social posts
  exaggerate; act on the primary source.
- **Deep code audit:** Cloudflare's `security-audit` skill (github.com/cloudflare/security-audit-skill) is
  for code-level vulnerability hunting in one repo, not dependency hygiene. Use it opt-in for repos with a
  real attack surface, against a scratch clone, pinned to a commit SHA, with the OS sandbox its README requires.

## Environment gotchas

- **Shells:** the default shell is zsh, which doesn't word-split unquoted variables. Run loops and
  `set -- $line` under `bash -c`. macOS bash is 3.2: no `${var,,}`, `mapfile` or associative arrays,
  and `"${arr[@]}"` on an empty array fails under `set -u` (use `${arr[@]+"${arr[@]}"}`).
- **Pipes:** under `pipefail`, `cmd | grep -q` can fail with SIGPIPE when grep exits early. Capture the
  output first.
- **Scripts that edit scripts:** when a heredoc's text itself contains `EOF` lines, give the outer heredoc a
  distinct delimiter (`PYEOF`). For anything with nested quoting, write a script file and run it; don't
  inline it into `bash -c`. The safety check refuses `rm -rf` inside a `bash -c` string, so use a fresh
  directory name instead of clearing one.
- **Stale PATH:** a long-lived shell keeps old install dirs on `PATH` after an upgrade. `supply-chain/bin/verify`
  tests what `mise which` resolves and warns about the mismatch. Open a new shell to pick up upgrades.
- **Homebrew:** the local API cache only refreshes on `brew update`; use the live API
  (`formulae.brew.sh/api/*.json`), which `lib.sh` caches daily. Tap formula short names can collide with
  core names. `brew upgrade` auto-cleans old kegs, so there's no keg rollback. Self-updating casks
  (`auto_updates`) drift from Homebrew's record; judge them by the app bundle.
- **Elevated actions:** the permission classifier blocks admin merges and force-pushes; hand those to the
  user as `! <command>`. `!` can't read a `sudo` password, and macOS admin trust settings need an
  interactive prompt, so those run in Terminal.app.
