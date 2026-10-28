# pr-consolidation

A Claude Code skill that folds a repo's open Dependabot and Renovate PRs into one verified PR: bumps
applied in-major at manifest level, locks regenerated once, CI and every CI audit job green, a
3-day release-age gate, and a PR body that justifies every override, ignore and deferred major.
It works across Rust, Node, Go, JVM, Python, .NET, PHP, Ruby, GitHub Actions and Docker, and
covers both a single repo and a fleet run with one agent per repo.

It came out of a rollout across about 20 repos in October 2026 (for example pacphi/ampel#86,
a private Rust + Svelte app, cf-toolsuite/tanzu-genai-showcase#221). Every lesson in it cites the PR or report
it came from. The owner's policies live in [`AGENTS.md`](../../AGENTS.md); the skill links to them
rather than copying them.

**It is not installed by default.** This directory is the source; Claude Code only sees the skill
after you install it as below.

## Files

| Path | What it is |
|---|---|
| `SKILL.md` | The skill: roles, ecosystem routing, the phases. Loaded when the skill triggers. |
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

In this repo it loads automatically: `.claude/skills/pr-consolidation` links to this folder. To use it
elsewhere, install it personally or per project.

Claude Code discovers skills at `~/.claude/skills/<name>/SKILL.md` (personal, all projects) and
`<repo>/.claude/skills/<name>/SKILL.md` (project). A skill directory may be a symlink. See
<https://code.claude.com/docs/en/skills>.

Personal install, tracking this repo (recommended). Run from this repo's root, whatever the
checkout is called:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/fleet/skill" ~/.claude/skills/pr-consolidation
```

If the checkout directory is later renamed or moved, the link breaks; recreate it with
`ln -sfn "$PWD/fleet/skill" ~/.claude/skills/pr-consolidation`.

Project install, for one repo only (a copy, so that repo doesn't depend on this checkout's path).
Run from this repo's root:

```bash
mkdir -p <repo>/.claude/skills
cp -R "$PWD/fleet/skill" <repo>/.claude/skills/pr-consolidation
```

The links from `SKILL.md` and `ORCHESTRATION.md` to `../../AGENTS.md` resolve only through the
symlink (they point into this repo). In a copy, read AGENTS.md from this repo directly.

## Check that Claude Code sees it

- Start a new Claude Code session and type `/`: `pr-consolidation` should be in the list.
- Invoke it with `/pr-consolidation`, or ask something that matches its description ("consolidate
  the Dependabot PRs in owner/repo"); Claude loads it through the Skill tool.
- Not listed? Check that `~/.claude/skills/pr-consolidation/SKILL.md` resolves
  (`ls -L ~/.claude/skills/pr-consolidation/SKILL.md`). If `~/.claude/skills` didn't exist when
  the session started, start a new session. `claude --debug` logs skill loading.

## Update

With the symlink, `git pull` in this repo is the update; Claude Code picks up edits to skill files
without a restart. For a copied project install, copy the directory again.

## Uninstall

```bash
rm ~/.claude/skills/pr-consolidation                      # removes the symlink only
rm -r <repo>/.claude/skills/pr-consolidation              # a copied project install
```
