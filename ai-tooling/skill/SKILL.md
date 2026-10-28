---
name: ai-tooling-steward
description: >
  Keeps this Mac's AI tooling consistent with policy: Ruflo and AgentDB, the shared patched AQE runtime and
  CLI, RuvNet Brain, RuVector, the shared Ruflo launcher, the auto-update and daemon guards, and each
  project's AI launchers and hook shims. Reports drift read-only (steward ai drift), tracks upstream AQE releases
  and watched issues, and walks the qualification recipe for a new AQE or Ruflo version with backups and
  receipts. Respects each project's own tool choice: not every project uses ruflo, AQE or Brain. Use when
  asked "is the AI tooling OK", "check drift", "a new agentic-qe release is out", "upgrade ruflo", "why does
  this project use npx ruflo@latest", or "qualify AQE 3.15.x".
metadata:
  author: pacphi
  version: "1.0"
  license: MIT
---

# ai-tooling-steward

Run the AI-tooling area of workstation-steward. The procedures are in
`docs/ai-tooling/runbook.md`, and the policy is
`ai-tooling/ai-tooling.toml`. The record of why things are this way, including the
qualification recipe and the decisions not to reopen, is
`archive/ai-tooling-ownership-and-qualification.md`.

## Where to run

Paths in this skill are relative to the workstation-steward checkout. A session started in that repo is
already there; the skill loads from its `.claude/skills/`. From anywhere else (a personal install), move into
the checkout first:

```sh
cd "$(dirname "$(readlink -f ~/.claude/skills/ai-tooling-steward/SKILL.md)")/../.."
```

## Never

These hold even when a command is described as read-only, and even when asked to "just check":

- Run `ak` (`ak sync`, `ak status` …) or any agentic-kit CLI or script. The owner is unwinding agentic-kit's
  user-level controls. Its registry and docs are reference data to read, never tools to run.
- Start or write a launcher that uses `@latest`.
- Run anything on the ledger's NEVER lists. For Ruflo: `init --force`, `update*`, `daemon start-all`,
  `config set|init|reset|import` and the rest. For Brain: `--update --plan`, `--auto`, `--yes`, `--force`,
  plain `npx ruvnet-brain`. The Brain knowledge-base update is owner-run only.
- Print or copy private configuration, credentials, learned records or memory-store contents. Never open the
  SQLite stores.
- Remove a tool from a project because it isn't in the project's choice. Report it; removal is a separate
  owner decision.
- Assume a project uses Ruflo, AQE or Brain. Check `projects/registry.toml` (`ai`, or `ai_seed` while
  unconfirmed).

## What needs approval

| Step | Approval |
| --- | --- |
| `steward ai drift` (and `--offline`, `--json`) | Not needed. Read-only. |
| A Ruflo version change (`supply-chain/hybrids.toml`, then `steward sc install-hybrids`) | Show the dry run, including the policy backup, and ask. |
| Qualifying or promoting an AQE release; switching `aqe/current` | Ask at each step: build, gates, store backups, switch. Keep receipts. |
| Editing a project file (launcher, shim, settings) | Show the plan, ask `[y/N]`, back up, write a receipt. Untracked or ignored files only; tracked files go through a PR. |
| `ai-tooling.toml` policy changes, commits, PRs, merges | Ask first. |

## Procedures

Follow the runbook section that matches the request:

- Routine check (`docs/ai-tooling/runbook.md#routine-check`): read the DRIFT and WARN lines and summarize
  them by area;
- A new AQE release (`docs/ai-tooling/runbook.md#a-new-aqe-release`);
- A Ruflo version change (`docs/ai-tooling/runbook.md#a-ruflo-version-change`);
- Launcher and project drift (`docs/ai-tooling/runbook.md#launcher-and-project-drift`);
- A guard is missing (`docs/ai-tooling/runbook.md#a-guard-is-missing`);
- Rollback (`docs/ai-tooling/runbook.md#rollback`).

`ai repin`, `ai guard` and `ai transport` change things after a plan and the owner's yes, with a backup and a
receipt. `ai qualify` and `ai promote` arrive in 5c; until then, follow the recipe by hand, one approved step at a
time.

## Done when

- The owner has the drift summary.
- Each approved change has a backup, a receipt, and a check that ran after it: `steward ai drift`, plus
  `steward sc verify` for installs.
- Whatever remains open is listed with what it's waiting on.
