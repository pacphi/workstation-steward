# workstation-steward

Keeps a Mac's software supply chain current, within a policy you set, without surprises. It looks after your mise
toolchain, Homebrew, apps, trust stores and the projects in your development folders, and it answers one question
every week: *what needs updating, is it safe yet, and what changes if I say yes?*

- **Nothing changes without asking.** Every command that writes shows its plan, waits for your yes, backs up first,
  writes a receipt, and can be undone. No background jobs, no auto-updates.
- **New releases wait.** Tools come in once they're 3 days old (you choose the number), unless the release is the
  first fix for a published advisory. Even the steward itself waits.
- **Old versions stay for a while.** After any change, the previous install stays on disk through a soak, so going
  back is a link away instead of a reinstall.
- **Your data stays yours.** The engine holds none of it; your config lives in your own folder (an *instance*), best
  kept in a private Git repo.

**Status:** pre-release, macOS only. Linux and Windows follow, one package manager at a time
([`docs/lifecycle.md`](docs/lifecycle.md#platforms)).

## Try it

```sh
git clone https://github.com/pacphi/workstation-steward && cd workstation-steward
node bin/steward.js init          # creates ~/.config/workstation-steward from examples/; shows the plan and asks
node bin/steward.js doctor        # what this machine still needs (mise, Homebrew, gh …)
node bin/steward.js sc audit      # read-only: what needs updating, and why
```

Once it's on npm: `mise use -g npm:workstation-steward@<version>`, and then just `steward`. Edit
`~/.config/workstation-steward/steward.toml` for your project roots, and turn on the optional areas there.

## What it looks after

| Area | Covers | Commands |
| --- | --- | --- |
| [Supply chain](supply-chain/README.md) | mise tools and mise itself, npm -g CLIs, Homebrew, apps and their bundled runtimes, the App Store, macOS, trust stores, Docker, indicators of compromise | `steward sc …` |
| [AI tooling](ai-tooling/README.md) (add-on) | Ruflo and AgentDB, AQE, RuvNet Brain, RuVector: qualification before a version reaches a project, launchers, guards, drift | `steward ai …` |
| [Projects](projects/README.md) (add-on) | Finding every project under your roots, a registry of your decisions, onboarding each project's chosen tools | `steward projects …` |
| [Fleet](fleet/README.md) | The GitHub side: Renovate patterns, consolidating dependency PRs, bringing checkouts level after merges | `steward fleet …` |

`steward` on its own lists every command and says when something needs you (new projects, a soak ending, a review
due). `steward review` gathers what needs a decision across every area. The Claude Code skills are in
[`skills/`](skills/), one per area plus PR consolidation, each with its runbook; `just claude` loads them from a
checkout as `/steward:supply-chain` and the rest, and `steward skills install` installs them for you (or one
project) from your own terminal.

## Read next

- [`docs/guide.md`](docs/guide.md): why it exists, first run, and the weekly routine.
- [`docs/lifecycle.md`](docs/lifecycle.md): install, upgrade, config migration, rollback, and the promises behind them.
- [`docs/architecture.md`](docs/architecture.md): how it's built, and every design decision (D1–D41).
- [`examples/README.md`](examples/README.md): what goes in your instance.
- [`docs/README.md`](docs/README.md): every doc.

## Layout

| Path | What it is |
| --- | --- |
| `bin/steward.js`, `lib/commands.js` | The `steward` client and its list of commands |
| `lib/` | Shared code: configuration and the instance, bash helpers, discovery, onboarding, the soak, the review |
| `supply-chain/`, `ai-tooling/`, `projects/`, `fleet/` | Each area's scripts (`bin/`), Claude skill (`skill/`) and README |
| `examples/` | A complete example instance; the tests run against it |
| `docs/` | The guide, design, lifecycle, prerequisites and one runbook per area |
| `tools/`, `justfile`, `test/` | Developer tasks: `just test`, `lint`, `docs`, `leak-check`, `release-worktree` |
| `package.json` | The npm package: engine files only, no dependencies (Node's type definitions for the type check live apart, in `tools/types/`, D45) |

The steward keeps its own state outside any repo: receipts and backups in `~/.local/state/workstation-steward/`
(mode 0700), and copies of your mise config in `~/.config/mise/backups/` before every change.

## Contributing and security

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setting up, testing against `examples/`, and the shape every changing
command follows. Report vulnerabilities privately: [`SECURITY.md`](SECURITY.md). MIT licensed ([`LICENSE`](LICENSE)).
