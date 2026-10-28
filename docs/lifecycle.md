# Lifecycle

![Revision 12](https://img.shields.io/badge/Revision-12-green) ![Revised 2026-10-28](https://img.shields.io/badge/Revised-2026--10--28-green)

How someone installs workstation-steward, sets it up, uses it, and keeps it, their config and their projects safe
over release after release. It is the contract the code is built to: each part is marked **built** or **planned**.
The decisions behind it are D39 and D40 in [`architecture.md`](architecture.md#decisions).

## Contents

- [The three things that change](#the-three-things-that-change)
- [The cycle](#the-cycle)
- [Promises](#promises)
- [Install and set up](#install-and-set-up)
- [Upgrade the steward](#upgrade-the-steward)
- [Your config across releases](#your-config-across-releases)
- [Shared safety data](#shared-safety-data)
- [Onboarded projects across releases](#onboarded-projects-across-releases)
- [Adding tools](#adding-tools)
- [Platforms](#platforms)
- [How releases are tested](#how-releases-are-tested)
- [Two channels](#two-channels)

## The three things that change

| What | Who owns it | Where it lives | How it changes |
| --- | --- | --- | --- |
| **The engine** (this code) | the project | npm `workstation-steward`, installed through mise | a release, after the release-age gate |
| **Your config** (the instance) | you | `~/.config/workstation-steward`, or `$STEWARD_INSTANCE`; best kept in a private Git repo | you edit it, or `steward migrate` proposes a change |
| **Your projects' tool files** | you, written by the steward | untracked or ignored files in each onboarded project | `projects onboard`, then `projects reconcile` after a release |

The engine never holds your data, and your config never holds code. A release changes only the engine; it can
*propose* changes to the other two, and you say yes.

## The cycle

```text
 1 INSTALL         2 SET UP           3 USE              4 UPGRADE            5 CATCH UP
 mise use -g  ──►  steward init  ──►  steward sc audit ──► a newer release ──► steward check
 npm:workstation-  copies the         plans, asks,        past the 3-day gate  ├─ config: steward migrate
 steward@<ver>     examples, asks,    backs up, writes    (Renovate PR or      └─ projects: steward
 (3-day gate)      backs up, doctor   receipts            sc plan); soak           projects reconcile
                                                                ▲                        │
                                                                └──── 6 ROLL BACK ◄──────┘
                                                                  (old version on disk,
                                                                   backups, receipts)
```

## Promises

1. **Nothing changes without asking.** Every command that writes shows a plan, waits for a yes, backs up first,
   writes a receipt, and can be undone. No background jobs, no automatic updates. *Built.*
2. **The steward is held to its own rules.** A new release waits out the same release-age gate as any other tool,
   installs through mise, and the previous version stays on disk through the soak. *Planned (R3, R6).*
3. **Your config is versioned, and never rewritten behind your back.** *The version and `steward check` are built
   (R3a); `steward migrate` arrives with the first format change.*
4. **Shared safety data stays current without overwriting your choices.** *Built (R3b).*
5. **Your edits in a project win over a release.** *Planned (R3 or R5).*
6. **Releases can be checked against their source.** Every npm release carries signed build provenance, and
   `steward doctor` verifies it. *Planned (R6).*
7. **Upgrades are tested, not hoped for.** *Planned (R5, R6).*
8. **The version number tells you the risk.** A patch fixes, a minor adds, a major needs a config migration or
   changes behavior, and its notes say what to run. *Planned (R6).*

## Install and set up

- **Install** with mise, so the release-age gate and Renovate cover the steward like any other tool:
  `mise use -g npm:workstation-steward@<version>`. *The package and the `steward` command are built (R3a); publishing
  to npm is planned (R6). Until then, from a clone: `npm link`.*
- **`steward init`** copies [`examples/`](../examples/README.md) to `~/.config/workstation-steward` (or a folder you
  name), shows what it will write, asks, writes a receipt, and lists the next steps (`steward doctor`, `steward sc
  link`). It never overwrites: it refuses when a `steward.toml` or any file it would create is already there. *Built (R3a).*
  Then it walks the rest of setup, one question at a time (`lib/setup.js`), each answer one line in the new
  `steward.toml`: the AI tooling add-on; the projects add-on and where your projects live; and the Claude Code skills: everywhere (every Claude Code session, turned on in `~/.claude/settings.json`),
  one project (only sessions started in a folder you name, turned on in its `.claude/settings.local.json`), or not now
  (D48), then whether to include PR consolidation, which it records as `[skills] pr_consolidation` in the new
  `steward.toml`. Either way the plugin's files sit in Claude Code's own cache, not in `~/.claude/skills/`. Changing a
  switch later needs no reinstall: the next session picks it up. *Built.*
- **`steward skills install [--project <path>]`** installs the skills as the `steward` plugin, from your own
  terminal (Claude Code takes a plugin's command only from a person); `steward skills uninstall` takes them out. The
  skills then follow the installed steward, with only the add-ons you turned on. *Built.*
- **Where the config is found:** `$STEWARD_INSTANCE`, else the engine's own folder when it holds a `steward.toml`,
  else `~/.config/workstation-steward`. *Built (R1).* `steward config` shows which, and why.
- **Keep the config in Git.** A private repo gives every policy change a review and a history, and lets Renovate
  propose toolchain updates for it. It names your projects, so don't make it public.

## Upgrade the steward

1. A newer release appears. Renovate opens a PR in your config repo once it is 3 days old, or `steward sc plan`
   lists it.
2. You apply it like any tool (`steward sc upgrade-tool npm:workstation-steward`): backup, install, verify,
   receipt, soak. The previous version stays installed until the soak ends.
3. `steward check` says whether the new release wants anything from your config or your projects (below).
4. If something is wrong, roll back: the old version is still on disk, and your config and projects have backups
   and receipts.

## Your config across releases

- `steward.toml` records the config's format: `schema = 1` (a file without the line is format 1). Each release says
  which formats it reads; `steward version` and `steward check` report it, and `check` exits 1 when a release wants
  something from you. *Built (R3a).*
- A release reads the current format and the one before it, for at least one major release, so an upgrade never
  breaks a config on the spot.
- **`steward migrate`** turns an older config into the current format: it shows every change (a renamed key, a new
  section, a moved file), asks, backs up, writes a receipt, and can roll back. It never runs on its own.
- Unknown or misspelled keys are an error, not a silent default. *Built (`steward config --check`).*
- **A release that changes what an existing key means, or lets a config leave out something it used to need, bumps
  `schema`.** An older engine then refuses the newer config instead of half-reading it: an engine from before the
  shared defaults, reading a `host.toml` trimmed to rely on them, would check no IOCs at all and still report none
  found. From R3b on, the engine refuses an area command on a format it doesn't read. (R3b itself didn't bump: no
  engine before it was ever released.)

## Shared safety data

Indicators of compromise, distrusted root certificates, the browsers that are never held, and the supported
Electron window change as advisories land. They ship with the engine as **defaults**; your `host.toml` holds only
your additions and overrides ("also distrust this root", "I don't use that browser"). Each release then brings the
newest data, and `steward sc audit` shows where each value came from: the engine's defaults or your config.
`steward sc host` lists the merged policy. In your `host.toml`, an entry with a default's name replaces it, and
`[off]` turns defaults off by name or value (an `[off]` that matches no default is flagged as a likely typo).
*Built (R3b): the defaults are `supply-chain/host-defaults.toml` in the engine.* An engine older than R3b doesn't
know the defaults, so keep the full copies in your `host.toml` until every engine you run (the release channel
included) has them; from R3b on, the engine refuses to run against a config format it doesn't read.

## Onboarded projects across releases

Onboarding writes tool files into a project: untracked or ignored files only (`.mcp.json`, `.claude/settings.json`,
the tool copies under `.claude/` and `.claude-flow/`, `.git/info/exclude`). Tracked files change only through a PR.

- **Receipts** record every file and folder onboarding wrote, with its hash, the engine version, and a hash of each
  profile used. *Built (R3a; every other receipt records the engine version too).*
- **`steward projects reconcile`**, after a new tool version is promoted, compares three things for each file or
  folder the steward copied into an onboarded project: what the steward wrote last time (the receipt), what is on
  disk now, and what the qualified install ships now. *Built (R5b) for the copied files and folders.*
  - unchanged since the steward wrote it → updated;
  - **edited by you since → left as it is and reported**, with `--diff <unit>` to see it and `--take <unit>` to take
    the new version for that one unit;
  - no baseline (there before the steward onboarded the project) → updated if it is an unedited copy of a published
    release (its hash is in the engine's `known-units.json`), otherwise yours and left alone (`--take` adopts it);
  - missing, or no longer shipped → reported; `projects onboard` restores missing names, `projects offboard` removes.

  It plans across every project, then asks, backs up and writes a receipt per project; each project rolls back on
  its own. Settings values follow once receipts record a baseline per key (D42). *Planned.* How this meets upstream fixes and retiring patches: [`ai-tooling/upstream-and-reconcile.md`](ai-tooling/upstream-and-reconcile.md).
- **`steward check`**, `steward review` and the `steward` banner list the projects a promotion of Ruflo or AQE has
  left behind. *Built (F2).* `check` and `review` plan every project (seconds); the banner only repeats what the last
  full plan found, or says the installs changed since, so it costs nothing. Release notes naming the profiles that
  changed: *Planned (R6).*
- **Offboarding** removes exactly what the receipts say the steward wrote. *Built.*

## Adding tools

- **To your machine** (a mise tool, an npm `-g` hybrid, a Homebrew formula): `steward sc add <tool>` will run the
  whole vetting checklist as one guided command: the release age of the tool *and* everything it pulls in, the
  advisory databases (GitHub, RustSec, OSV), a trust review for any exception, the install scripts it needs found in
  a sandbox, a `verify.tsv` line, then the pin, the lock and a receipt. *Planned (after v1); today these are
  separate commands and the rules in the runbooks.*
- **To the steward** (support for a new kind of tool):
  - a new AI tool is a profile (`projects/profiles/<tool>.toml`) plus a qualification recipe; users turn it on per
    project in their registry;
  - a new package manager is a provider (below).

## Platforms

v1 runs on **macOS**. mise and Homebrew are the first two providers, and both also run on Linux, which comes next,
then Windows. Support follows package managers, not distributions: each package manager (Homebrew, apt, dnf,
pacman, winget, scoop …) is a provider that lists what is installed and outdated, gives publish dates for the
release-age gate, upgrades one package, and says whether it can roll back. The steward reads `/etc/os-release` to
pick Linux providers. The audit becomes a set of checks, each knowing which platforms it applies to (D43).

- The checks (`supply-chain/checks/`), the Homebrew and mise providers (`lib/providers/`), and `platforms` keys in
  host.toml: *Built (R5c).*
- `steward sc audit`, `plan` and `upgrade` run them: *Built (R5c).* Each switched only after the Bash and Node versions
  printed identical output on the same Mac; the Bash audit and upgrade are retired.
- Then, one provider per PR, in this order: *Planned.*
  1. **Linux**, by package manager: apt (Debian, Ubuntu, Linux Mint), dnf (Fedora), zypper (openSUSE), pacman (Arch),
     portage (Gentoo), slackpkg (Slackware), apk (Alpine), xbps (Void);
  2. **Windows 11 and WSL**: winget, Scoop and Chocolatey; inside WSL, the Linux providers apply;
  3. **NixOS** ([nixos.org](https://nixos.org/)): declarative, so its provider plans a dated update of the flake or
     channel as a whole rather than one package at a time, and rolls back to a previous generation.

## How releases are tested

- Every PR in the public repo runs the tests and lint on a clean macOS runner against `examples/`. *Built.* Tests
  that need the AI tool installs run against small stand-ins there and against the real installs on a machine that has
  them (`test/fixtures.js`). *Built (R5a).*
- Each config format has a sample config. CI installs the previous release, upgrades it, migrates the sample, and
  runs the tests. The same goes for sample projects onboarded with the previous release and then reconciled.
  *Planned (R5, R6).*
- Linux and Windows runners join the matrix as their providers land. *Planned.*

## Two channels

For anyone who both works on the steward and uses it on their own machine (D41). *Built.*

```text
 RELEASE  steward      ──► a pinned version: a tagged checkout now, the npm package later ─┐
                                                                                            ├──► your config
 DEV      steward-dev  ──► your working clone, edits and all  ──(--real)─────────────────────┘
                           └─ by default: examples/ and its own state, never your config
```

- **Two names.** `steward` is the release; `steward-dev` is the clone. `steward version` says which build ran:
  `release 0.1.0 (v0.1.0)` or `dev main@1a2b3c4 (+2 uncommitted)`.
- **Pin the release** with `just release-worktree <tag>`: it creates (or moves) a detached checkout at the tag in
  `~/.local/share/workstation-steward/release` and writes both launchers to `~/.local/bin`, after showing its plan
  and asking. Once the steward comes from npm, the release is the mise pin in your config repo and the launchers go.
- **Feature work stays off your machine.** `steward-dev` uses `examples/` and a separate state folder unless you add
  `--real` (or set `$STEWARD_INSTANCE`).
- **Trying a fix on your own machine** with `steward-dev --real`: read-only commands run as usual; a command that can
  change things first prints `DEV BUILD … is about to run …` and then its usual plan and question.
- **The release keeps working.** `steward-dev --real check` reports when your config is in a format the pinned release
  can't read, and `steward migrate` will refuse to go past it.
