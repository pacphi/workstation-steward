# workstation-steward

[![npm](https://img.shields.io/npm/v/workstation-steward?label=npm&color=3fb950)](https://www.npmjs.com/package/workstation-steward)
[![Tests](https://github.com/pacphi/workstation-steward/actions/workflows/test.yml/badge.svg)](https://github.com/pacphi/workstation-steward/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Your Mac's software supply chain, kept current on your terms.** One command, `steward`, looks after your mise
toolchain, Homebrew, apps, the App Store, macOS, trust stores and Docker, and, if you want, your AI tools and every
project under your development folders. Each week it answers one question: *what needs updating, is it safe yet, and
what changes if I say yes?*

> [!IMPORTANT]
> workstation-steward is 0.x and runs on macOS. Linux and Windows follow, one package manager at a time
> ([`docs/lifecycle.md`](docs/lifecycle.md#platforms)).

![A first session: install through mise, check the version, steward init's guided setup, then a first upgrade plan](docs/assets/steward-onboarding.svg)

> [!TIP]
> mise is the recommended way in, because it keeps the steward current under the same release-age gate as your other
> tools. Plain `npm install -g` works too, and `npx` lets you try it without installing:
> [ways to install, and to upgrade](#ways-to-install-and-to-upgrade).

## Why it's different

The steward aims for *safe, explained and reversible*, not merely *newest*.

- **Nothing changes without asking.** Every command that writes shows its plan, waits for your yes, backs up first,
  writes a receipt, and has a way back (`--rollback`, `--undo` or `steward sc rollback`). There are no background jobs
  and no auto-updates; `DRY_RUN=1` previews anything.
- **New releases wait.** A version comes in once it is 3 days old (you choose the number, once, in `steward.toml`),
  so a hijacked or broken release has time to be caught. The exception is the first patched release for an advisory
  in the GitHub Advisory Database, RustSec or OSV. Majors are always your call. Even the steward itself waits.
- **The old version stays for a while.** After an upgrade, a Node patch or a reinstall, the previous install stays on
  disk through a soak (3 days by default), so going back is a config restore, not a reinstall.
- **Your data stays yours.** The engine holds none of it. Your config (an *instance*: roots, policy, the registry of
  your projects) lives in your own folder, best kept in a private Git repo.
- **Releases you can verify.** Every release from 0.1.0 is built and published by this repo's GitHub workflow, never
  from someone's laptop, and carries a *provenance attestation*: a signed record of the commit and workflow that built
  it, which anyone can check.

> [!TIP]
> To check a release is genuine, read its provenance record. It should name this repository and its release workflow.
> On npmjs.com, a version that has one shows a green check; from a terminal (with `jq`):
>
> ```sh
> curl -s https://registry.npmjs.org/-/npm/v1/attestations/workstation-steward@<version> |
>   jq -r '.attestations[] | select(.predicateType | test("slsa"))
>          | .bundle.dsseEnvelope.payload | @base64d | fromjson
>          | .predicate.buildDefinition.externalParameters.workflow | "\(.repository) \(.path)"'
> # https://github.com/pacphi/workstation-steward .github/workflows/release.yml
> ```

## See it work

### The weekly review

`steward review` runs every area's read-only checks and returns one list of what needs you, each item with the command
that acts on it. The `steward` banner says when a review is due.

![steward review: seven read-only stages, then four items to decide, each with its command](docs/assets/steward-review.svg)

### A safe upgrade, and its undo

`steward sc upgrade` takes only what passed the gate, asks before acting, backs up your mise config, upgrades without
pruning, and verifies every tool once at the end. If a step fails, the rest still run, and the end lists what failed
with its way back. `steward sc rollback` puts the config back.

![steward sc upgrade: the plan, a yes, a backup, the upgrade and a verify; then steward sc rollback](docs/assets/steward-upgrade.svg)

### Patching Node

A Node release that can't wait goes through `steward sc node-patch`: it checks the official tarball against
nodejs.org's checksums, confirms the installed binary is byte-identical, reinstalls the global CLIs the steward manages
(its npm -g *hybrids*) one by one, and keeps the previous Node for a rollback.

![steward sc node-patch 26.13.0: checksum, install, byte-identical check, pin, reinstall, verify](docs/assets/steward-node-patch.svg)

### PR consolidation, in Claude Code

`/steward:pr-consolidation` turns a repo's pile of Dependabot and Renovate PRs into one PR with every CI audit green:
in-major bumps past the age gate, majors deferred with their breaking changes written up, and every exception
justified. This animation retells a real run,
[`pacphi/ampel#86`](https://github.com/pacphi/ampel/pull/86).

![Claude Code consolidating three Dependabot PRs and twelve RustSec fixes into pacphi/ampel#86](docs/assets/steward-pr-consolidation.svg)

## Quick start

**1. Install** the `steward` command through [mise](https://mise.jdx.dev), the tool manager that keeps your other CLIs
current. mise then keeps the steward current too, under the same release-age gate:

```sh
mise use -g npm:workstation-steward@<version>
```

> [!NOTE]
> Until 2026-11-27, add an approval: `mise use -g 'npm:workstation-steward[allow_low_downloads=true]@<version>'`.
> By default mise won't install a package whose name is less than 30 days old, and this one was first published on
> 2026-10-28.

**2. Check it.** `steward version` says which release is running and where your config will live:

```sh
steward version
```

**3. Set up.** `steward init` creates your config in `~/.config/workstation-steward`, shows every file it will write,
and asks first. Then it walks the rest of setup one question at a time (the AI tooling add-on, the projects add-on
and where your projects live, the Claude Code skills); each answer changes one line of `steward.toml`. Then keep
that config in a private Git repo, so it has a history, Renovate, and a second Mac in minutes:
[`docs/config-repo.md`](docs/config-repo.md).

```sh
steward init
```

**4. Take a first look.** Both are read-only:

```sh
steward doctor        # what this machine still needs (--install fixes it)
steward sc plan       # what an upgrade would take, hold or skip, and why
```

**5. Or just ask.** With the Claude Code skills installed (`steward init` offers them, or run `steward skills install`),
open Claude Code in any folder and ask in plain words: *"what needs updating on this Mac?"* The skill runs the right
commands, explains what they found, and asks before it changes anything
([what you can ask](skills/README.md#things-you-can-ask)).

> [!TIP]
> `steward` on its own lists every command and tells you when something needs you: new projects, a soak ending, a
> review due.

### Ways to install, and to upgrade

The steward runs on Node 26 or later. Pick one way to install:

```sh
mise use -g npm:workstation-steward@<version>      # mise (recommended)
npm install -g workstation-steward@<version>       # npm
npx workstation-steward@<version> version          # npx: try it without installing
```

Contributors run it from a clone instead: `git clone`, then `npm link` ([`CONTRIBUTING.md`](CONTRIBUTING.md#set-up)).
Upgrade the same way you installed:

| Way | How it upgrades | Release-age gate |
| --- | --- | --- |
| mise | `steward sc upgrade` takes it with your other tools once it's old enough (or just it: `steward sc upgrade-tool npm:workstation-steward`); Renovate proposes it too, if your config is in a Git repo | Yes |
| npm | `npm install -g workstation-steward@<newer version>`; `npm outdated -g` shows when there is one | No: check a release's age yourself |
| npx | Name the newer version | No |
| A clone | `git pull` | No |

There's no `curl … | sh` installer, on purpose: running a download straight into a shell is what the steward guards
against. Working on the steward itself? Run it as `steward-dev` alongside a pinned release
([`docs/lifecycle.md`](docs/lifecycle.md#two-channels)).

## What it looks after

| Area | Covers | Commands |
| --- | --- | --- |
| [Supply chain](supply-chain/README.md) | mise tools and mise itself, npm -g CLIs, Homebrew, apps and their bundled runtimes, the App Store, macOS, trust stores, Docker, indicators of compromise | `steward sc …` |
| [AI tooling](ai-tooling/README.md) (add-on) | Ruflo and AgentDB, AQE, RuvNet Brain, RuVector: qualification before a version reaches a project, launchers, guards, drift | `steward ai …` |
| [Projects](projects/README.md) (add-on) | Every project under your roots, a registry of your decisions, onboarding each project's chosen tools | `steward projects …` |
| [Fleet](fleet/README.md) | The GitHub side: Renovate patterns, consolidating dependency PRs, bringing checkouts level after merges | `steward fleet …` |

The add-ons are off until you turn them on, in `steward init` or in `steward.toml`.

## Claude Code skills

**Ask in plain words, without learning the commands.** The steward ships as a Claude Code plugin, `steward`, with one
skill per area. Each turns a question like *"what needs updating?"* into the right `steward` commands, runs the
read-only ones, explains what they found, and asks before anything changes. It follows the runbook (or, for PR
consolidation, the rules) beside it, so it keeps the same release-age gate and the same plan, yes, backup and receipt.

![Claude Code: asked what needs updating, the supply-chain skill audits and plans, sorts the results, then upgrades gh after a yes and verifies](docs/assets/steward-skills-updates.svg)

| Skill | What to ask it |
| --- | --- |
| `/steward:supply-chain` | "what needs updating", "audit the machine", "a Node security release is out" |
| `/steward:ai-tooling` | "is the AI tooling OK", "qualify AQE 3.15.x" (with the AI tooling add-on) |
| `/steward:projects` | "what new projects are there", "onboard this repo" (with the projects add-on) |
| `/steward:pr-consolidation` | "consolidate the Dependabot PRs in owner/repo" (with `[skills] pr_consolidation`) |

`steward skills install` installs it for you (every session) or, with `--project <path>`, for one project. The plugin
runs your installed `steward` to build itself each session, so the skills always match your version and the add-ons
you've turned on.

> [!CAUTION]
> Run `steward skills install` in your own terminal, not from inside a Claude Code session. Claude Code accepts a
> plugin's command only from a person, so the install stops and tells you so.

[`skills/README.md`](skills/README.md) has more to ask each skill, what they will and won't do, and three more
sessions to watch: an advisory check, setting up a new repo, and the AI tooling.

## Read next

| Doc | What it covers |
| --- | --- |
| [`docs/guide.md`](docs/guide.md) | Why the steward exists, the first run, and a normal week |
| [`docs/lifecycle.md`](docs/lifecycle.md) | Install, upgrade, config formats, rollback, the two channels, and the promises behind them |
| [`docs/architecture.md`](docs/architecture.md) | How it's built, and every design decision with its reason |
| [`docs/prereqs.md`](docs/prereqs.md) | What the steward needs on the machine (`steward doctor` checks it) |
| [`docs/config-repo.md`](docs/config-repo.md) | Keeping your config in a private Git repo, and in step across your Macs |
| [`skills/README.md`](skills/README.md) | The Claude Code skills: install, what to ask, and what they do |
| [`examples/README.md`](examples/README.md) | What goes in your instance |
| [`docs/maintainers.md`](docs/maintainers.md) | How releases are made, published and checked on a clean Mac |
| [`docs/README.md`](docs/README.md) | Every doc, the runbooks and the skills |

## Repository layout

| Path | What it is |
| --- | --- |
| `bin/steward.js`, `lib/commands.js` | The `steward` client and its list of commands |
| `lib/` | Shared code: configuration and the instance, bash helpers, discovery, onboarding, the soak, the review, the skills plugin |
| `supply-chain/`, `ai-tooling/`, `projects/`, `fleet/` | Each area's scripts (`bin/`) and README |
| `skills/`, `.claude-plugin/` | The Claude Code skills, each with its runbook, and the plugin and marketplace manifests |
| `examples/` | A complete example instance; the tests run against it |
| `docs/` | The guide, design, lifecycle, prerequisites and maintainer docs; `docs/assets/` holds these animations |
| `tools/`, `justfile`, `test/` | Developer tasks: `just test`, `lint`, `docs`, `leak-check`, `release-worktree`, `terminal-svg` |
| `package.json` | The npm package: engine files only, no dependencies |

The steward keeps its own state outside any repo: receipts and backups in `~/.local/state/workstation-steward/`
(mode 0700), and copies of your mise config in `~/.config/mise/backups/` before every change.

## Contribute

The steward changes people's machines, so every change is judged first on whether it stays safe: read-only by
default, and a plan, a yes, a backup and a receipt for anything that writes. AI-assisted contributions are welcome
under the same bar: you've read and run what you submit.

| You want to… | Start here |
| --- | --- |
| Set up a clone and run the checks | [Set up](CONTRIBUTING.md#set-up): point `STEWARD_INSTANCE` at `examples/`, then `just test`, `just lint`, `just docs` |
| Change how the steward behaves | [Making a change](CONTRIBUTING.md#making-a-change): the shape every writing command follows, and a test with every fix |
| Open a pull request | [Pull requests](CONTRIBUTING.md#pull-requests): one topic, and a Conventional Commits title, which versions the release |

## Security

> [!WARNING]
> Found a vulnerability? Please don't open a public issue. Report it privately through
> **[Security → Report a vulnerability](https://github.com/pacphi/workstation-steward/security/advisories/new)**.
> Expect an acknowledgement within a few days and a fix or a plan within two weeks; [`SECURITY.md`](SECURITY.md) says
> what counts.

## License

MIT. See [`LICENSE`](LICENSE).
