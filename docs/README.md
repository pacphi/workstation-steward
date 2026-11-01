# Docs index

![Revision 19](https://img.shields.io/badge/Revision-19-green) ![Revised 2026-11-01](https://img.shields.io/badge/Revised-2026--11--01-green)

Every public doc, by kind. Each doc shows its revision and revision date in badges under the title. The number changes only when the
content does; moving a file or fixing a link doesn't count. The rules are in
[`architecture.md`](architecture.md#docs).

## Start here

| Doc | Rev | What it is |
| --- | --- | --- |
| [`explainer.html`](explainer.html) | — | The film: the whole story in nine interactive acts, published as the GitHub Pages site [pacphi.github.io/workstation-steward](https://pacphi.github.io/workstation-steward/) by an on-demand workflow ([`maintainers.md`](maintainers.md#the-explainer-site)) |
| [`guide.md`](guide.md) | 9, 2026-10-31 | Why the steward exists, what it looks after, the rules, first run, the weekly routine (with what the release-age gate holds back) and what to do when something happens, words you'll see; the eight everyday commands and the bundled ones that take one yes (D60, D61) |
| [`briefing.md`](briefing.md) | 9, 2026-10-31 | `steward brief`: what needs you now as one next step with its command, read from disk without the network; the background refresh that looks at GitHub, npm and your projects (D57); the Claude Code session-start hook, once and then quiet (D48); the checks (detectors), their order, the output, and how to add one; the work list, who does each step and your `[autonomy]` level, `--unattended` (D58); the fix runner, `steward fix` (D59); a bundled command left unfinished (D61); an animated example |
| [`config-repo.md`](config-repo.md) | 7, 2026-10-31 | Keeping your config in a private Git repo: setting it up, Renovate, a second Mac, staying in step, and what the steward tells you about it |
| [`prereqs.md`](prereqs.md) | 5, 2026-10-31 | Everything the steward needs on the machine, the order to install it on a new Mac, the services on GitHub (Renovate), and `steward doctor` (which shows your config and add-ons first) |

## Design

| Doc | Rev | What it is |
| --- | --- | --- |
| [`lifecycle.md`](lifecycle.md) | 21, 2026-11-01 | Install, set up, use, upgrade, migrate the config, keep old command names, reconcile projects, add tools, roll back, and the two channels (a worktree or npm for the release): the promises across releases, day to day (the briefing, the review and the gate, who takes each step, `steward fix`, the bundled commands), each marked built or planned (D40, D41) |
| [`platforms/parity.md`](platforms/parity.md) | 5, 2026-11-01 | Planned: Linux and NixOS parity as a plan and a progress ledger. Why it matters, where it stands, the decisions (D-a to D-g, all made), the bar for the first Linux release (apt, dnf and zypper), the supported distributions and their minimum versions, each capability per platform, the milestones with a checkbox per item, the CI matrix and install checks, and the facts still to verify; every PR in this work updates it |
| [`release-classes.md`](release-classes.md) | 3, 2026-10-29 | Built (D52): what may skip the release-age gate, as one release class per update source, update sources declared in `host.toml`, and the weekly upstream watch on shipped key pins |
| [`maintainers.md`](maintainers.md) | 8, 2026-10-31 | Publishing the explainer site (on demand); releasing: the release PR, Conventional Commit titles, the one-time npm setup (placeholder and Trusted Publishing), the publish guard, a pre-push leak check (D46); the maintainer skill (D53); what to do when the upstream watch finds a shipped default changed (D52); checking that no command looks hung (`just progress-gaps`); trying the session hook before a release (`just try-hook`); Renovate on the engine repo |
| [`architecture.md`](architecture.md) | 50, 2026-11-01 | The four areas, how they meet, the engine and the instance (`steward.toml`), project onboarding, layout, the docs rules, and every decision D1–D64 |

## Living docs by area

| Area | Doc | Rev | What it is |
| --- | --- | --- | --- |
| Supply chain | [`../supply-chain/README.md`](../supply-chain/README.md) | — | Policy files, rules and commands |
| AI tooling | [`../ai-tooling/README.md`](../ai-tooling/README.md) | — | Policy file, what `steward ai drift` checks |
| AI tooling | [`../skills/ai-tooling/qualification.md`](../skills/ai-tooling/qualification.md) | 3, 2026-10-30 | What has to be true before a new AQE or Ruflo version reaches a project, and the standing guards |
| AI tooling | [`ai-tooling/upstream-and-reconcile.md`](ai-tooling/upstream-and-reconcile.md) | 6, 2026-10-30 | The three layers (upstream, your machine, each project), from an upstream ask to a retired patch, what `projects reconcile` adds, challenges and mitigations (D42) |
| Projects | [`../projects/README.md`](../projects/README.md) | — | What counts as a project, the registry fields, `scan` and `list` |
| Projects | [`../projects/profiles/README.md`](../projects/profiles/README.md) | — | The per-tool onboarding profiles and how they're filled in |
| Fleet | [`../fleet/README.md`](../fleet/README.md) | — | `fleet sync` and `prune-merged` after merges; Renovate and PR consolidation, with links to the runbook and the skill's rules |

## Runbooks

| Area | Doc | Rev | Covers |
| --- | --- | --- | --- |
| Supply chain | [`../skills/supply-chain/runbook.md`](../skills/supply-chain/runbook.md) | 9, 2026-10-31 | Routine check, upgrades (one yes with `steward upgrade`), mise itself, Renovate PRs, checking the queue the release-age gate holds, Node security releases, advisories, trust exceptions, prune, changing the release-age gate, rollback |
| AI tooling | [`../skills/ai-tooling/runbook.md`](../skills/ai-tooling/runbook.md) | 21, 2026-10-31 | Drift and `steward ai fix`, new AQE releases, Ruflo version changes, bringing projects in step after a promotion, retiring a patch when an upstream fix lands, Brain, launcher drift, guards, rollback |
| Projects | [`../skills/projects/runbook.md`](../skills/projects/runbook.md) | 17, 2026-10-31 | New projects, decisions (and their rollback), `steward projects apply`, vanished projects, onboarding and offboarding, what may be written |
| Fleet | [`fleet/runbook.md`](fleet/runbook.md) | 4, 2026-10-31 | Bringing a repo under Renovate, bot-PR consolidation, merging, syncing checkouts and pruning merged branches (`steward fleet tidy`), long-lived lines |

## Skills

The Claude Code skills are a plugin named `steward`, in [`../skills/`](../skills/): one folder per skill, each with
the runbook it follows beside it (D48 in [`architecture.md`](architecture.md#decisions)). `just claude` starts a
session with this checkout's skills loaded, ahead of any installed release; after editing one, run `/reload-plugins`.
Anywhere else, `steward skills install` (or `--project <path>`, from your own terminal) installs them through the
installed steward's own copy of [`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), and they
follow the installed steward.

| Skill | Area | Read-only reports | Folder |
| --- | --- | --- | --- |
| `/steward:supply-chain` | Supply chain | `audit`, `plan`, `verify` | [`../skills/supply-chain/`](../skills/supply-chain/README.md) |
| `/steward:ai-tooling` | AI tooling | `drift` | [`../skills/ai-tooling/`](../skills/ai-tooling/README.md) |
| `/steward:projects` | Projects | `scan`, `list` | [`../skills/projects/`](../skills/projects/README.md) |
| `/steward:fix` | Everywhere | the plan (`steward fix`, `steward brief --plan`) | [`../skills/fix/`](../skills/fix/README.md) |
| `/steward:pr-consolidation` | Fleet | (none) | [`../skills/pr-consolidation/`](../skills/pr-consolidation/README.md) |

Claude also starts a skill on its own when a request matches its description. [`../skills/README.md`](../skills/README.md)
is the user's guide: installing them, what to ask, and four sessions to watch.

Records of what happened on a particular machine (migrations, rollouts, evidence) belong in that machine's instance,
not here.
