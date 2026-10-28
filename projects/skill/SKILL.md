---
name: projects-steward
description: >
  Discovers projects under ~/Development (Git repos, worktrees, submodules, and marked non-Git folders),
  surfaces new and vanished ones, and records the owner's decision for each (onboarded with its chosen AI
  tools, ignored, or deferred) in workstation-steward's projects/registry.toml. Presents each new project
  with its evidence and options, says exactly what would happen if applied, and asks before acting. Not
  every project uses ruflo, AQE or Brain; the default is none. Use when `steward` reports new projects, or when
  asked "what new projects are there", "onboard this repo", "ignore that folder", "which tools does this
  project use", or "confirm the project registry".
metadata:
  author: pacphi
  version: "1.0"
  license: MIT
---

# projects-steward

Run the projects area of workstation-steward. The procedures are in
`docs/projects/runbook.md`, the registry is
`projects/registry.toml`, and the design is D4–D6 in
`docs/architecture.md#projects-detection-and-onboarding`.

## Where to run

Paths in this skill are relative to the workstation-steward checkout. A session started in that repo is
already there; the skill loads from its `.claude/skills/`. From anywhere else (a personal install), move into
the checkout first:

```sh
cd "$(dirname "$(readlink -f ~/.claude/skills/projects-steward/SKILL.md)")/../.."
```

## The prompt for a new project

For each project `steward projects scan` reports, ask with the question tool, one project at a time:

- **Say what it is:** path, kind, parent (worktrees and submodules), remote, and which AI tools it already
  shows.
- **Offer options,** strongest first:
  - "inherit the parent's decision" for a worktree or submodule;
  - onboard;
  - ignore;
  - defer, with a date;
  - not now.
- **For onboard, ask about each AI tool separately** (`ruflo`, `aqe`, `brain`), defaulting to none. Offer a
  tool as recommended only when the project already shows it, and say so.
- **Before anything is applied, show exactly what would happen:**
  - the registry entry;
  - each file that would be written;
  - backups and rollback;
  - what needs a PR because it's tracked.

## What needs approval

| Step | Approval |
| --- | --- |
| `steward projects scan`, `steward projects list`, `steward projects facets`, `steward projects profile-check`, `steward projects onboard <path>` and `steward projects reconcile <path>` or `--all` without `--apply` (and its `--diff`), `just test` | Not needed. Read-only (`just test` uses throwaway repos). |
| Recording decisions in `projects/registry.toml` | The owner's answer to the prompt, recorded with `steward projects decide … --yes` (the answer is the approval), then a branch and a PR. Ask before pushing. |
| Writing into a project: `steward projects onboard <path> --apply`, `steward projects reconcile <path> --apply` (or `--all --apply`, one yes for the listed projects), either's `--rollback <receipt>` | The plan, then the owner's yes for that project (or that list), then its `[y/N]`. Reconcile replaces only copies the steward wrote and nobody edited, unless the owner names one with `--take`. Untracked or ignored files only, with a backup and a receipt; tracked files go through a fleet PR. Repos mid-merge or mid-rebase are refused. |
| `steward ai transport --apply` (needed once before onboarding a project with AQE) | The owner's yes: it writes into the shared AQE runtime. |

## Never

- Assume a project should have AI tooling, or add tools it didn't choose.
- Remove tools from a project without a separate, explicit owner decision.
- Edit tracked files in a checkout under `~/Development/active`, or touch a repo in the middle of a merge or
  rebase.
- Run agentic-kit commands or scripts (see the `ai-tooling-steward` skill).

## Done when

Every project the scan reported has an owner decision recorded, or is explicitly left for later, and the
registry change is committed or awaiting the owner's approval to push.
