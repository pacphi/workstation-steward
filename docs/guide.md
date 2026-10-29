# Start here

![Revision 3](https://img.shields.io/badge/Revision-3-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

This guide is for you, after time away or new to the steward. It says why the repo exists, what it
looks after, how to start, and what a normal week looks like. For how each part works, follow the links to the area
runbooks.

## Why it exists

A Mac runs hundreds of tools from many sources: language runtimes, CLIs, Homebrew formulae, desktop apps, AI
coding tools and the projects' own dependencies. Each one updates on its own schedule, and some of those updates
are attacks or carry flaws. In October 2026 alone:

- LiteLLM's Docker tags were hijacked;
- advisories landed in the middle of a rollout;
- AI tools quietly installed their own updates, and launchers fetched `@latest` on every start.

workstation-steward is the one place that decides **what is allowed on your machine, and when**, and that makes
every change reversible. Without it, the decisions are scattered across tools' own updaters, and nobody sees them.

## What it looks after

| Area | In plain words | Commands |
| --- | --- | --- |
| Supply chain | The command-line tools (mise), the global npm tools, Homebrew, apps, macOS, trust stores, Docker images, and known signs of compromise | `steward sc …` |
| AI tooling | Ruflo, AQE, Brain and RuVector: which versions are qualified, how projects launch them, and the guards that keep them from updating or spending tokens on their own | `steward ai …` |
| Projects | Every project under `~/Development`: found automatically, each with your decision (which AI tools, if any), and its tool files kept to that decision | `steward projects …` |
| Fleet | The GitHub side: Renovate for dependency updates, and one consolidated PR per repo when bot PRs pile up | the `pr-consolidation` skill |

## The rules it lives by

- **Nothing changes without your yes.** Every command that changes something first shows a plan, then asks
  `[y/N]`. `DRY_RUN=1` shows the plan and stops.
- **Every change can be undone.** A backup and a receipt come first, and each command prints its own rollback.
- **New versions wait 3 days** (the release-age gate): most hijacked releases are caught and pulled within days.
  The exception is the first release that fixes a published advisory.
- **Old versions stay 3 days after a change** (the soak), so going back is a link away, not a reinstall.
- **GitHub is the record.** Updates arrive as Renovate PRs. Decisions that wait are issues labelled
  `owner-decision`. Files tracked in a repo change only through PRs.
- **Nothing runs on its own.** No launchd or cron. The reminders are the `steward` banner and a weekly
  GitHub issue.

## First run

On a new machine, or the first time on this one:

1. `node lib/doctor.js` (or `steward doctor`): check the prerequisites. The order to install them on a new Mac is in
   [`prereqs.md`](prereqs.md).
2. `steward config`: check the paths `steward.toml` resolves to (project roots, state, mise, the AI tooling root).
3. `steward sc link`: point `~/.config/mise/` at this repo's `mise/config.toml` and `mise.lock`.
4. `steward sc audit`: see what's out of date or at risk. It only reads.
5. `steward ai drift`: check the AI tooling against its policy. It only reads.
6. `steward projects scan`, then `steward projects decide <path>` for each new project.
7. `steward review`: the combined list. From now on this is the weekly habit.

## The routine

**Weekly, about 15 minutes.** `steward` says "review due" after 7 days (`[policy] review_days`). Each Monday a GitHub
issue, "Steward review", lists what GitHub can see on its own: releases past the gate, advisories, and open bot
PRs and security alerts across the repos.

1. Run `steward review` (or `steward review --quick` without the audit). It lists every item that needs a decision,
   grouped under the command that acts on it (or the step to take by hand), and the fleet as one table, worst first.
2. Decide each one: act now, defer it with a reason, or make it an `owner-decision` issue so it isn't lost.
3. Handle the week's Renovate PRs in this repo ([supply-chain runbook: A Renovate PR arrives](../skills/supply-chain/runbook.md#a-renovate-pr-arrives)).

**When something happens:**

| Event | Do |
| --- | --- |
| A security advisory or incident report | [Supply-chain runbook](../skills/supply-chain/runbook.md): verify against primary sources, sweep, patch within policy |
| A Node security release | `steward sc node-patch <x.y.z>`, never `mise upgrade node` |
| A new AQE or Ruflo release past the gate | [AI tooling runbook](../skills/ai-tooling/runbook.md): qualify (`ai-tooling/qualify/aqe/run.sh`), then promote |
| A new project appears (`steward` says so) | `steward projects scan`, then `decide`, then `onboard` or `offboard` |
| A soak ends | `DRY_RUN=1 steward sc prune`, then `steward sc prune` |
| Bot PRs pile up in a repo | the `pr-consolidation` skill ([fleet runbook](fleet/runbook.md)) |

**Monthly:** `steward sc plan`, then `steward sc upgrade` for everything past the gate. Then `steward ai drift` for AI tool
releases waiting to be qualified, and `steward projects list` to recheck project decisions.

## Words you'll see

| Word | Meaning |
| --- | --- |
| Release-age gate | A version must be 3 days old before it's taken (`[policy] min_release_age_days`) |
| Soak | The 3 days after a change when old installs are kept for rollback; `steward sc prune` waits for it |
| Receipt | A JSON record of what a command changed and where its backup is; rollback reads it |
| Drift | A difference between what policy says and what's on the machine (`steward ai drift`) |
| Qualification | Proving a new AI tool release safe in a sandbox before any project uses it |
| Hybrid | A global npm tool installed outside mise because mise can't build it (`supply-chain/hybrids.toml`) |
| Onboard / offboard | Writing a project's chosen AI tool files, or taking them out when it has none |
| Keep-off | Settings the steward never turns on, whatever a tool defaults to (`ai-tooling.toml`) |

## Where to read more

- The design and every decision (D1 onward): [`architecture.md`](architecture.md).
- The runbooks:
  - [supply chain](../skills/supply-chain/runbook.md);
  - [AI tooling](../skills/ai-tooling/runbook.md);
  - [projects](../skills/projects/runbook.md);
  - [fleet](fleet/runbook.md).
- Everything else, indexed: [`README.md`](README.md).
- Rules for agents working here: [`../AGENTS.md`](../AGENTS.md).
