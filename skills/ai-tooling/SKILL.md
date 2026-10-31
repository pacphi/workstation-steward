---
name: ai-tooling
description: >
  Keeps this machine's AI tooling consistent with policy: Ruflo and AgentDB, the shared patched AQE runtime and
  CLI, RuvNet Brain, RuVector, the shared Ruflo launcher, the auto-update and daemon guards, and each
  project's AI launchers and hook shims. Reports drift read-only (steward ai drift), tracks upstream AQE releases
  and watched issues, and walks the qualification recipe for a new AQE or Ruflo version with backups and
  receipts. Respects each project's own tool choice: not every project uses ruflo, AQE or Brain. Use when
  asked "is the AI tooling OK", "check drift", "a new agentic-qe release is out", "upgrade ruflo", "why does
  this project use npx ruflo@latest", or "qualify AQE 3.15.x".
argument-hint: "[drift] [flags]"
allowed-tools: Bash(steward ai drift) Bash(steward ai drift *) Bash(steward config) Bash(steward config *)
metadata:
  author: pacphi
  version: "2.0"
  license: MIT
---

# ai-tooling

Run the AI-tooling area of workstation-steward, an add-on (`[profiles] ai_tooling` in `steward.toml`). The
procedures are in `${CLAUDE_SKILL_DIR}/runbook.md` ([`runbook.md`](runbook.md)), and the qualification recipe and
the standing guards in `${CLAUDE_SKILL_DIR}/qualification.md` ([`qualification.md`](qualification.md)).

If the session's context holds a `<steward-brief>` whose `next.skill` is this skill, start from its `next`; show the
plan (`DRY_RUN=1`) before any write. A step that stopped midway is in the runbook's Finishing a half-done step
(`runbook.md#finishing-a-half-done-step`).

## Where things are

All commands are `steward ai …`; `steward ai` lists them. The policy is `ai-tooling/ai-tooling.toml` in the user's
config folder, which `steward config` names, and each project's chosen tools are in that folder's
`projects/registry.toml`. Paths in the runbook are relative to the config folder.

## Drift report

With arguments `drift` (and its flags), run `steward ai $ARGUMENTS` first. Other arguments are the request itself.

Summarize DRIFT first, then WARN, grouped by area: AQE runtime and PATH, hybrids, guards, upstream, watched
threads, projects. For projects, group by kind of finding with counts and a few examples rather than every line.
End with the next step the user might want, and don't take it without their yes.

## Never

These hold even when a command is described as read-only, and even when asked to "just check":

- Start or write a launcher that uses `@latest`.
- Run anything on the NEVER lists in `qualification.md` (standing guards). For Ruflo: `init --force`, `update*`,
  `daemon start-all`, `config set|init|reset|import` and the rest. For Brain: `--update --plan`, `--auto`,
  `--yes`, `--force`, plain `npx ruvnet-brain`. The Brain knowledge-base update is run by the user only.
- Print or copy private configuration, credentials, learned records or memory-store contents. Never open the
  SQLite stores.
- Remove a tool from a project because it isn't in the project's choice. Report it; removal is a separate
  decision for the user.
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

- Routine check (`runbook.md#routine-check`): the drift report above;
- A new AQE release (`runbook.md#a-new-aqe-release`);
- A Ruflo version change (`runbook.md#a-ruflo-version-change`);
- Launcher and project drift (`runbook.md#launcher-and-project-drift`);
- A guard is missing (`runbook.md#a-guard-is-missing`);
- Rollback (`runbook.md#rollback`).

`ai repin`, `ai guard` and `ai transport` change things after a plan and the user's yes, with a backup and a
receipt. `ai qualify` and `ai promote` arrive in 5c; until then, follow the recipe by hand, one approved step at a
time.

## Done when

- The user has the drift summary.
- Each approved change has a backup, a receipt, and a check that ran after it: `steward ai drift`, plus
  `steward sc verify` for installs.
- Whatever remains open is listed with what it's waiting on.
