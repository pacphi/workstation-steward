# pr-consolidation

A Claude Code skill that folds a repo's open Dependabot and Renovate PRs into one verified PR: bumps
applied in-major at manifest level, locks regenerated once, CI and every CI audit job green, a
release-age gate (3 days by default), and a PR body that justifies every override, ignore and deferred major.
It works across Rust, Node, Go, JVM, Python, .NET, PHP, Ruby, GitHub Actions and Docker, and
covers both a single repo and a fleet run with one agent per repo.

It came out of a rollout across about 20 repos in October 2026 (for example pacphi/ampel#86,
a private Rust + Svelte app, cf-toolsuite/tanzu-genai-showcase#221). Every lesson in it cites the PR or report
it came from. The rules it applies are in [`rules.md`](rules.md), beside it, so it works wherever it's installed.

## Files

| Path | What it is |
|---|---|
| `SKILL.md` | The skill: roles, ecosystem routing, the phases. Loaded when the skill triggers. |
| `rules.md` | What must hold in every repo: release age, majors, merging, attribution, CI audits, Renovate. |
| `bots.md` | Dependabot vs Renovate: discovery, PR shapes, and how superseded PRs get closed. |
| `ecosystems/*.md` | One per ecosystem: CI gates, audit commands, transitive bumps, registry publish dates, known traps. The agent reads only the ones that match the repo. |
| `ORCHESTRATION.md` | The orchestrator's loop (triage, dispatch, verify, merge, close) and the brief handed to each agent. |
| `scripts/pr-status.sh` | TSV of merge and check state for PRs. Read-only. |
| `scripts/wait-ci.sh` | Polls until no check is pending; exit code says green, red or timeout. Read-only. |
| `scripts/compare-base.sh` | For each failing check, the same job's result on the base branch. Read-only. |
| `scripts/lock-age.sh` | New lockfile entries between two refs (or in a PR) with registry publish times; flags anything under the cutoff. Read-only. |
| `scripts/merge-and-close.sh` | Orchestrator only. Merges with `--match-head-commit`, closes superseded Dependabot PRs, leaves Renovate PRs to autoclose. Dry run unless `--execute`. |
| `scripts/lock-fix.sh` | Orchestrator only. One advisory, one crate or Go module, one PR, with the release-age check and the repo's audit. Dry run unless `--execute`. |
| `scripts/_lib.sh` | Helpers the scripts source. |

The scripts need `gh` (authenticated), `jq`, `curl` and `git`; `lock-fix.sh` also needs `cargo` or
`go`. They run under macOS bash 3.2 and pass `shellcheck`. Each has usage in its header
(`<script> --help` where it takes options).

## Evidence

Lessons cite merged PRs in public repos as `repo#N`, describe private repos by what they are ("a private Rust + Svelte
app"), and refer to the rollout's working records as "`<repo>` report", "triage notes-X" or "findings". Those records
are kept privately, with the owner's config.

## Install

It ships with workstation-steward as part of its Claude Code skills (D48 in
[`docs/architecture.md`](../../docs/architecture.md#decisions)). Install it with `steward skills install` (from your own terminal); it's off until `[skills] pr_consolidation = true` in `steward.toml`. In a checkout of this repo, `just claude` loads it
as `/steward:pr-consolidation`. Invoke it by name, or ask something that matches its description ("consolidate the
Dependabot PRs in owner/repo").
