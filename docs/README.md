# Docs index

![Revision 6](https://img.shields.io/badge/Revision-6-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

Every public doc, by kind. Each doc shows its revision and revision date in badges under the title. The number changes only when the
content does; moving a file or fixing a link doesn't count. The rules are in
[`architecture.md`](architecture.md#docs).

## Start here

| Doc | Rev | What it is |
| --- | --- | --- |
| [`guide.md`](guide.md) | 3, 2026-10-27 | Why the steward exists, what it looks after, the rules, first run, the weekly routine and what to do when something happens, words you'll see |
| [`prereqs.md`](prereqs.md) | 3, 2026-10-27 | Everything the steward needs on the machine, the order to install it on a new Mac, and `steward doctor` |

## Design

| Doc | Rev | What it is |
| --- | --- | --- |
| [`lifecycle.md`](lifecycle.md) | 13, 2026-10-28 | Install, set up, use, upgrade, migrate the config, reconcile projects, add tools, roll back, and the two channels (a worktree or npm for the release): the promises across releases, each marked built or planned (D40, D41) |
| [`maintainers.md`](maintainers.md) | 1, 2026-10-28 | Releasing: the release PR, Conventional Commit titles, the one-time npm setup (placeholder and Trusted Publishing), the publish guard, a pre-push leak check (D46) |
| [`architecture.md`](architecture.md) | 33, 2026-10-27 | The four areas, how they meet, the engine and the instance (`steward.toml`), project onboarding, layout, the docs rules, and every decision D1–D42 |

## Living docs by area

| Area | Doc | Rev | What it is |
| --- | --- | --- | --- |
| Supply chain | [`../supply-chain/README.md`](../supply-chain/README.md) | — | Policy files, rules and commands |
| AI tooling | [`../ai-tooling/README.md`](../ai-tooling/README.md) | — | Policy file, what `steward ai drift` checks |
| AI tooling | [`../skills/ai-tooling/qualification.md`](../skills/ai-tooling/qualification.md) | 2, 2026-10-27 | What has to be true before a new AQE or Ruflo version reaches a project, and the standing guards |
| AI tooling | [`ai-tooling/upstream-and-reconcile.md`](ai-tooling/upstream-and-reconcile.md) | 5, 2026-10-27 | The three layers (upstream, your machine, each project), from an upstream ask to a retired patch, what `projects reconcile` adds, challenges and mitigations (D42) |
| Projects | [`../projects/README.md`](../projects/README.md) | — | What counts as a project, the registry fields, `scan` and `list` |
| Projects | [`../projects/profiles/README.md`](../projects/profiles/README.md) | — | The per-tool onboarding profiles and how they're filled in |
| Fleet | [`../fleet/README.md`](../fleet/README.md) | — | `fleet sync` and `prune-merged` after merges; Renovate and PR consolidation, with links to the runbook and the skill's rules |

## Runbooks

| Area | Doc | Rev | Covers |
| --- | --- | --- | --- |
| Supply chain | [`../skills/supply-chain/runbook.md`](../skills/supply-chain/runbook.md) | 7, 2026-10-27 | Routine check, upgrades, mise itself, Renovate PRs, Node security releases, advisories, trust exceptions, prune, changing the release-age gate, rollback |
| AI tooling | [`../skills/ai-tooling/runbook.md`](../skills/ai-tooling/runbook.md) | 18, 2026-10-27 | Drift, new AQE releases, Ruflo version changes, bringing projects in step after a promotion, retiring a patch when an upstream fix lands, Brain, launcher drift, guards, rollback |
| Projects | [`../skills/projects/runbook.md`](../skills/projects/runbook.md) | 16, 2026-10-27 | New projects, decisions, vanished projects, onboarding and offboarding, what may be written |
| Fleet | [`fleet/runbook.md`](fleet/runbook.md) | 2, 2026-10-26 | Bringing a repo under Renovate, bot-PR consolidation, merging, syncing checkouts and pruning merged branches, long-lived lines |

## Skills

The Claude Code skills are a plugin named `steward`, in [`../skills/`](../skills/): one folder per skill, each with
the runbook it follows beside it (D48 in [`architecture.md`](architecture.md#decisions)). `just claude` starts a
session with this checkout's skills loaded, ahead of any installed release; after editing one, run `/reload-plugins`.
Anywhere else, `steward skills install` (or `--project <path>`, from your own terminal) installs them through the
installed steward's own copy of [`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), and they
follow the installed steward.

| Skill | Area | Read-only reports | Folder |
| --- | --- | --- | --- |
| `/steward:supply-chain` | Supply chain | `audit`, `plan`, `status`, `verify` | [`../skills/supply-chain/`](../skills/supply-chain/README.md) |
| `/steward:ai-tooling` | AI tooling | `drift` | [`../skills/ai-tooling/`](../skills/ai-tooling/README.md) |
| `/steward:projects` | Projects | `scan`, `list` | [`../skills/projects/`](../skills/projects/README.md) |
| `/steward:pr-consolidation` | Fleet | (none) | [`../skills/pr-consolidation/`](../skills/pr-consolidation/README.md) |

Claude also starts a skill on its own when a request matches its description.

Records of what happened on a particular machine (migrations, rollouts, evidence) belong in that machine's instance,
not here.
