---
name: projects
description: >
  Discovers projects under the project roots set in steward.toml (Git repos, worktrees, submodules, and marked
  non-Git folders), surfaces new and vanished ones, and records the user's decision for each (onboarded with its
  chosen AI tools, ignored, or deferred) in the config folder's projects/registry.toml. Presents each new project
  with its evidence and options, says exactly what would happen if applied, and asks before acting. Not every
  project uses ruflo, AQE or Brain; the default is none. Use when `steward` reports new projects, or when asked
  "what new projects are there", "scan for projects", "onboard this repo", "ignore that folder", "which tools does
  this project use", or "confirm the project registry".
argument-hint: "[scan | list] [flags]"
allowed-tools: Bash(steward projects scan) Bash(steward projects scan *) Bash(steward projects list) Bash(steward projects list *) Bash(steward projects facets *) Bash(steward projects profile-check *) Bash(steward config) Bash(steward config *)
metadata:
  author: pacphi
  version: "2.0"
  license: MIT
---

# projects

Run the projects area of workstation-steward, an add-on (`[profiles] projects` in `steward.toml`). The
procedures are in `${CLAUDE_SKILL_DIR}/runbook.md` ([`runbook.md`](runbook.md)).

## Where things are

All commands are `steward projects …`; `steward projects` lists them. The registry is `projects/registry.toml` in
the user's config folder, and the roots it scans are `[projects] roots` in that folder's `steward.toml`;
`steward config` names both.

## Scan report

With arguments `scan` or `list` (and their flags), run `steward projects $ARGUMENTS` first. Other arguments are the
request itself.

List the new projects by kind, with their parent for worktrees and submodules, and which AI tools each already
shows; then any vanished ones. Then offer to take them one at a time, as below.

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
| `steward projects scan`, `steward projects list`, `steward projects facets`, `steward projects profile-check`, `steward projects onboard <path>` and `steward projects reconcile <path>` or `--all` without `--apply` (and its `--diff`) | Not needed. Read-only. |
| Recording decisions in `projects/registry.toml` | The user's answer to the prompt, recorded with `steward projects decide … --yes` (the answer is the approval). If the config folder is a Git repo, commit there through a branch and a PR; ask before pushing. |
| Writing into a project: `steward projects onboard <path> --apply`, `steward projects reconcile <path> --apply` (or `--all --apply`, one yes for the listed projects), either's `--rollback <receipt>` | The plan, then the user's yes for that project (or that list), then its `[y/N]`. Reconcile replaces only copies the steward wrote and nobody edited, unless the user names one with `--take`. Untracked or ignored files only, with a backup and a receipt; tracked files go through a PR. Repos mid-merge or mid-rebase are refused. |
| `steward ai transport --apply` (needed once before onboarding a project with AQE) | The user's yes: it writes into the shared AQE runtime. |

## Never

- Assume a project should have AI tooling, or add tools it didn't choose.
- Remove tools from a project without a separate, explicit decision by the user.
- Edit tracked files in a project's checkout, or touch a repo in the middle of a merge or rebase.

## Done when

Every project the scan reported has a decision recorded, or is explicitly left for later, and the registry change
is committed or awaiting the user's approval to push.
