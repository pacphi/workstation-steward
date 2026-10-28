# Projects runbook

![Revision 16](https://img.shields.io/badge/Revision-16-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

Procedures for the projects under the roots in `steward.toml` (`[projects] roots`). The registry is
`projects/registry.toml` in your instance ([an example](../../examples/projects/registry.toml)), and its fields are described in
[`../../projects/README.md`](../../projects/README.md). `steward` commands run from any folder.

## Contents

- [New projects appear](#new-projects-appear)
- [What onboarding adapts to](#what-onboarding-adapts-to)
- [Check projects against their profiles](#check-projects-against-their-profiles)
- [Plan onboarding a project](#plan-onboarding-a-project)
- [Apply and roll back](#apply-and-roll-back)
- [Reconcile after a promotion](#reconcile-after-a-promotion)
- [Offboard a project with no AI tools](#offboard-a-project-with-no-ai-tools)
- [Decide a project](#decide-a-project)
- [Confirm a seeded project](#confirm-a-seeded-project)
- [A project disappears](#a-project-disappears)
- [What may be written into a project](#what-may-be-written-into-a-project)

## New projects appear

1. `steward` prints `!! N new project(s) under <root>` when the scan finds any.
2. Run `steward projects scan` (read-only). For each new project it shows:
   - its kind (`git`, `worktree`, `submodule`, `nested-git` or `dir`);
   - its parent, for worktrees and submodules;
   - its stack (see below);
   - which AI tools it already shows.

## What onboarding adapts to

`steward projects facets` (read-only) shows, for every registered project, what onboarding reads from the project
itself instead of copying another project:

- **Stack:** marker files at the root (`package.json`, `pom.xml`, `build.gradle*`, `go.mod`, `Cargo.toml`,
  `pyproject.toml`, …). A Node workspace (`pnpm-workspace.yaml`, `workspaces`, turbo, nx, lerna) or a Cargo
  `[workspace]` makes a monorepo; AI files then go at the repo root. Markers found only one folder down show as
  `subdirs:…` (polyglot).
- **Node:** the version mise resolves in that folder, which is what hooks that run a bare `node` get there.
- **Git state of each AI file:** tracked (a PR or a manual step), ignored or untracked (may be edited in place,
  adds only), absent (may be created, with a `.git/info/exclude` entry unless the repo already ignores it).

`steward projects facets <path>` shows one project in full, with what each file's state allows.

## Check projects against their profiles

`steward projects profile-check` (read-only) renders each onboarded project's chosen tools from
`projects/profiles/` and sorts every difference with what the project has:

| Bucket | Meaning | What to do |
| --- | --- | --- |
| `add` | onboarding would add it | nothing yet: `steward projects onboard` shows it in the plan |
| `refresh` | an unedited older vendor file (D25) | onboarding replaces it, in the plan, with a backup |
| `older` | an older Ruflo or AQE generation (millisecond timeouts, no-op Ruflo hooks, an older hook file or hook form) | kept; onboarding adds the current piece beside it, except a hook that already does the same work (below) |
| `init` | written by `ruflo init`, `aqe init` or `@claude-flow/codex` | kept; never reproduced |
| `own` | the project's own choice, the user's trust and permission settings, or copied files that differ from the qualified source (another chosen tool's copy of a name the first tool owns, D26; or an older generation or an edit, which a hash can't tell apart) | kept |
| `keepoff` | breaks the keep-off list | fix through a reviewed change |
| `latest` | an unpinned `@latest` launcher | `steward projects onboard <path> --remove-unpinned` for `ruflo`, `ruv-swarm` and `flow-nexus` (D30); a project's own server is its decision |
| `unexplained` | none of the above | a finding: look at it before onboarding the project |

`--detail` lists every item; `steward projects profile-check <path>` shows one project.

## Plan onboarding a project

`steward projects onboard <path>` shows what onboarding would do, and changes nothing; `--apply` applies exactly
this plan (next section). `--all` gives one line per project; `--json` the plan as data.

- **Per file, from its Git state (D6):**

  | State | Action |
  | --- | --- |
  | ignored, untracked, not in Git | `edit` in place (backup and receipt at apply) |
  | absent | `create`, plus a `.git/info/exclude` entry when the new file would add a line to `git status`; none when an untracked folder above it is already listed (`?? .claude/`: the `.gitignore` audit decides those) or outside Git |
  | absent but ignored by the repo | `create`, no exclude entry |
  | tracked | `PR` |
  | a new name in a folder Git tracks part of | `edit` when the repo already ignores it (it tracks only its own files there); `PR` when it would show in `git status` |
  | exists but doesn't parse | `MANUAL`: never merged into |

- **Adds only.** Keys, servers and approvals a file lacks; names a copied folder lacks (a `.LOCKED` folder too); the
  unedited vendor files of D25 refreshed, and an edited one only with `--refresh <file>`.
- **Hooks aren't doubled.** A profile hook is skipped when the project already runs the same script and subcommand
  on that event in another form: other quoting, transport v1's inline env, `npx agentic-qe hooks <sub>`, or an
  older matcher (`^Task$`). The matcher counts only where the profile splits a hook by it (PreCompact manual and
  auto). The plan lists each one it kept.
- **`--fix-keep-off`** sets each keep-off entry with a required value (`claudeFlow.daemon.autoStart`, the two idle
  auto-assign keys, all `false`) to that value in the settings files, shown as `~ key: true → false (keep-off: why)`.
  Without it, the plan reports those breaks and leaves them. Every other key keeps its value.
- **`--remove-unpinned`** (5b, D30) removes `ruflo`, `ruv-swarm` and `flow-nexus` launchers that fetch `@latest` from
  `.mcp.json` and the Codex config, as `- mcpServers.<name> (…): removed (keep-off: why)`. A project's own server
  stays, `@latest` or not. A Codex table goes with its sub-tables (its tool approvals).
- **`--replace-older`** swaps three known older forms for the profile's hook: transport v1 set inline (it overrides
  `settings.local.json`), `npx agentic-qe hooks <sub>` (an unpinned fetch on every hook) and the `^Task$` matcher
  (it misses the Agent tool). The plan marks each kept hook it would replace, and shows each replacement as `~ hook`
  with the reason. Any other older form is still kept. Like every apply: a backup, a receipt and `--rollback`.
- **Reported, never changed:** keep-off breaks already in the project (`autoAssignOnIdle = true`), and files that
  already show in `git status` (left for the `.gitignore` audit).
- **The hooks' Node:** hooks run a bare `node`, so the plan shows what mise resolves in the folder, warns below a
  tool's `engines` minimum (Ruflo ≥20.0.0, AQE ≥22.13.0) and when mise can't resolve it.
- **Stops:** not in the registry, not onboarded, no tools chosen, a repo mid-merge, rebase or cherry-pick, a Claude
  Code agent worktree (D19), or a worktree whose main checkout isn't onboarded yet. A worktree takes its tools from
  its main checkout (D15).
- **Manual steps** (trusting servers and hooks, Ruflo's policy anchor) are listed, never run.

`steward projects onboard --all` and `profile-check` render the same profiles with the same adds-only rule; their add
and refresh counts agree file by file.

## Apply and roll back

`steward projects onboard <path> --apply` shows the plan, asks `[y/N]` (`DRY_RUN=1` stops there), then makes the `edit`
and `create` changes. `PR` items are listed and left for the rollout's pull requests.

- **Refuses** when a file is `MANUAL`, the plan stops (above), or the project uses AQE and the hook transport isn't
  installed as the repo's copy (`steward ai transport`, then `--apply`). Each file's hash is checked against the plan's
  just before it's written: a file changed since the plan stops the apply.
- **Order:** copied files and folders, whole files, `settings.json` (its hooks call those files), the other
  configuration files, then the `.git/info/exclude` block (one marked block per apply, naming its receipt).
- **Writing:** JSON keeps the file's indent, final newline and key order; new keys go last. TOML is never rewritten:
  new keys are inserted as lines under their table's header, new tables appended, so comments and order stay. Each
  result is parsed and must equal the planned object, or nothing is written.
- **Backups and receipt:** `~/.local/state/workstation-steward/backups/onboard-<project>-<time>/`, with every edited
  file's copy and a `receipt.json` written as the apply goes. A failure partway undoes what was applied.
- **Check:** after applying, the plan runs again and should have nothing left.
- **What's left for a PR:** the receipt's `pr` list names the tracked items the apply skipped; the rollout builds
  each repo's pull request from it.
- **Roll back:** `steward projects onboard --rollback <receipt>` refuses if anything it wrote has changed since, then
  restores the backups, removes what it created and the exclude block.
- **Afterwards:** Claude Code picks up changed `settings.json` hooks when it next starts in the project, and asks to
  trust them (the plan's manual steps).

The engine's tests (`just test` in a checkout) run the merge rules and writers, then onboarding end to end on throwaway Node, Maven and Rust repos:
apply, a second plan with nothing left, an AQE hook run through transport v2, rollback to the exact starting state,
a failure partway, and a file changed after the plan.

## Reconcile after a promotion

D42 in [`docs/architecture.md`](../../docs/architecture.md). What it does to a project and why, in plain words:
[`docs/ai-tooling/upstream-and-reconcile.md`](../../docs/ai-tooling/upstream-and-reconcile.md#what-reconcile-does-to-your-project-in-plain-words). After a new Ruflo, AQE or Brain
version is promoted, the copies onboarding made (helpers, skills, commands, agents, AQE's two hook files) may be
behind.

1. The `steward` banner, `steward check` and `steward review` say when projects are behind. Every full plan
   (`check`, `review`, `--all`) notes what it found and the installs it compared against, under the state folder
   (`reconcile/seen.json`); the banner reads only that note. `steward projects reconcile --all` plans every
   onboarded project in one table: per project, how many units would
   update (including copies with no receipt that match a published release byte for byte), how many you edited
   (kept), how many have no baseline (yours), and how many are missing, no longer shipped,
   tracked or current. `steward projects reconcile <path>` lists one project's units.
2. For a kept unit, `--diff <unit>` shows your copy against the new source; `--take <unit>` takes the new version.
3. `steward projects reconcile <path> --apply` (or `--all --apply`) asks once, then gives each project a backup and a
   receipt, which starts the soak. `--rollback <receipt>` undoes one project's reconcile and refuses if anything it
   wrote has changed since.
4. Missing names come back with `steward projects onboard <path>`. Settings values are not reconciled yet: use the
   fixers (`steward ai timeouts`, `steward ai approvals`, `steward projects onboard --replace-older`).

## Offboard a project with no AI tools

D31 in [`docs/architecture.md`](../../docs/architecture.md). For a registered project whose entry has `ai = []` but still has
the tools' wiring or files (drift lists it as beyond its choice).

1. `steward projects offboard <path>` shows the plan. It stops when tools are chosen for the project, the repo is
   mid-merge or rebase, or Claude Code, Codex or Node is running in it (`lsof`).
   - `edit`: the launcher and settings files lose the tools' entries (`ai-tooling.toml` `[offboard]`): MCP servers,
     plugins and marketplaces, `claudeFlow`/`aqe`/`v3*` keys, the tools' env keys, hooks and status line that run
     their helpers, their approval rules, and Codex's server, plugin and env tables. The project's own entries stay,
     in the file's own format. A file left empty moves whole instead.
   - `move`: stores wherever they sit (`.claude-flow`, `.swarm`, `.agentic-qe`, `ruvector.db`, `agentdb.rvf` …, never
     inside `node_modules`), the tools' helper folders and files, and every untracked unit in `.claude/agents`,
     `commands`, `skills` and `.agents/skills` that a qualified install ships by that name, that is a Codex copy of a
     Ruflo command, or whose SKILL.md says `author: rUv`.
   - `left in place`: anything tracked, and untracked files offboarding doesn't recognize. Name one with
     `--also <path>` to move it too (tracked paths are always refused).
   - The project-scope plugin installs Claude Code recorded, as `claude plugin uninstall <plugin> --scope project`
     commands for the user to run in the project **before** `--apply`: they edit `.claude/settings.json` too, and
     run afterwards they would change a file the receipt recorded, so the rollback would refuse.
2. `--apply` asks `[y/N]`, then edits the configs first (so no hook calls a helper that's gone), moves the paths into
   `~/.local/state/workstation-steward/backups/offboard-<project>-<time>/moved/` (0700) and removes folders the moves
   emptied. The receipt is written as it goes; a failure partway undoes what was done. Contents are never opened.
3. The plan runs again afterwards and should have nothing left; `git status` loses only the untracked paths that moved.
4. `steward projects offboard --rollback <receipt>` refuses if a moved path exists again or an edited file changed since,
   then moves everything back and restores the edited files.

The engine's tests cover it on a throwaway repo where the project's own tracked files sit in the same folders as the
copies: apply, a second plan with nothing left, and a rollback to the exact starting state; a plain folder with a
file changed after the plan; and the running-process stop.

## Decide a project

Each project gets one decision:

| Decision | Meaning |
| --- | --- |
| `onboarded` | Managed: `ai` lists the AI tools it uses (empty is fine), and supply-chain steps apply (Renovate, `.nvmrc`/`mise.toml` alignment) |
| `ignored` | Never prompt again (scratch folders, copies, generated output) |
| `deferred` | Ask again after the date in `until` |

**Recording the decision:**

1. Present the options to the user, with the evidence `scan` shows.
   - **Worktrees:** no decision needed; they follow their main checkout (`projects.worktrees = "inherit"`).
   - **Submodules:** offer "inherit the parent's decision" first.
   - **Tools:** offer each one separately (`ruflo`, `aqe`, `brain`), defaulting to none. Not every project
     uses them.
2. Record the answer with `steward projects decide`, for example:
   - `steward projects decide <path> --decision onboarded --ai aqe,brain`;
   - `--decision ignored`;
   - `--decision deferred --until <date>`;
   - `--inherit` for worktrees and submodules;
   - `--batch <file.json>` for several at once.

   It validates the entry, shows the change and asks before writing. Then commit the registry through a PR,
   since the registry is the record of the user's decisions.
3. Onboarding itself means writing the chosen tools' files and settings into the project:
   `steward projects onboard <path>` shows the exact plan, and `--apply` asks `[y/N]` and keeps a backup, a receipt and
   a rollback ([Apply and roll back](#apply-and-roll-back)).

## Confirm a seeded project

Seeded entries are `unconfirmed`; `ai_seed` is the seed list's choice.

1. `steward projects list` shows `ai` (chosen), `seed` and `shows` (what the project has today) side by side.
2. Ask the user to confirm or change the tools per project. Set `decision` and `ai`, keep `ai_seed` as the
   history, and add `decided`.
3. `steward ai drift` then checks each confirmed project against its own choice instead of the seed.

## A project disappears

`scan` lists registered projects that are no longer on disk. Ask whether it moved or was deleted.

- **Moved:** update `path` in the registry.
- **Deleted:** remove the entry; git history keeps the record.

## What may be written into a project

D6 in [`docs/architecture.md`](../../docs/architecture.md#projects-detection-and-onboarding):

- **Untracked or gitignored tooling files** (`.mcp.json`, `.codex/config.toml`, `.claude/settings*.json`,
  `node_modules/.bin` shims): edited in place only after the plan and the user's `[y/N]`, with a backup, a
  receipt and a rollback. Reconciling (D42) replaces only the steward's own unedited copies, unless the user names
  one with `--take`. Offboarding (D31) also moves the tools' untracked stores and copies into its backup.
- **Refused:** tracked files, and any repo in the middle of a merge or rebase.
- **Tracked files** (`AGENTS.md`, `CLAUDE.md`, `renovate.json`, `.nvmrc`): changed through a pull request from a
  scratch clone, per the [fleet runbook](../../docs/fleet/runbook.md).
- **No remote:** list the change as a manual step for the user.
