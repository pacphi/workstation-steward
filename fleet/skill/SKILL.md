---
name: pr-consolidation
description: >
  Consolidates open Dependabot and/or Renovate dependency PRs in one GitHub repo, in any
  ecosystem (Rust, Node/pnpm/npm, Go, Java/Maven/Gradle, Python, .NET, PHP, Ruby, GitHub Actions,
  Docker), into one verified PR on a fresh branch. Applies the bumps at manifest level within the
  current major, regenerates locks once, fixes upgrade-caused and pre-existing CI failures, makes
  every CI audit job pass, enforces a 3-day release-age gate, and writes a PR body that justifies
  every override, ignore and exception. Use when asked to "consolidate the Dependabot PRs",
  "combine the Renovate PRs", "roll the dependency PRs into one", "clear the security audit and
  the bot PRs", or to run a dependency-hygiene pass on a repo or across a fleet of repos.
metadata:
  author: pacphi
  version: "2.0"
  license: MIT
---

# pr-consolidation

Turn a pile of bot dependency PRs into one PR that is green in CI, secure by the repo's own audit
gates, and honest about what it deferred. The owner's rules live in
workstation-steward's `AGENTS.md` (the checkout this skill is installed from, not the target repo's own; release age, majors, merging, attribution, Renovate); this skill
applies them and doesn't restate them.

## Roles

- **Consolidating agent** (one per repo): phases 0 to 10 below, in a fresh clone. It pushes a
  branch and opens one PR. It **never merges, never closes, never comments on** other PRs, never
  force-pushes, never uses admin overrides.
- **Orchestrator** (the session that dispatched the agent, or the owner): verifies CI and the PR
  body itself, merges, then handles the superseded PRs per [bots.md](bots.md). Its loop and the
  brief it hands each agent are in [ORCHESTRATION.md](ORCHESTRATION.md).

If you were invoked directly on one repo with no orchestrator, stop after phase 10 and put the
merge and the closing of superseded PRs to the owner as a decision.

## Load only what applies

Detect the repo's ecosystems, then read ONLY the matching files. Always read [bots.md](bots.md).

| Files present (any directory) | Read |
|---|---|
| `Cargo.toml`, `Cargo.lock` | [ecosystems/rust.md](ecosystems/rust.md) |
| `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `package.json` | [ecosystems/node.md](ecosystems/node.md) |
| `go.mod` | [ecosystems/go.md](ecosystems/go.md) |
| `pom.xml`, `build.gradle(.kts)` | [ecosystems/jvm.md](ecosystems/jvm.md) |
| `requirements*.txt`, `pyproject.toml`, `uv.lock`, `poetry.lock` | [ecosystems/python.md](ecosystems/python.md) |
| `*.csproj`, `Directory.Packages.props` | [ecosystems/dotnet.md](ecosystems/dotnet.md) |
| `composer.json` | [ecosystems/php.md](ecosystems/php.md) |
| `Gemfile` | [ecosystems/ruby.md](ecosystems/ruby.md) |
| `.github/workflows/*`, `Dockerfile*`, `compose*.yml`, `docker-compose*.yml` | [ecosystems/actions-docker.md](ecosystems/actions-docker.md) |

`git ls-files | grep -E '(Cargo.lock|pnpm-lock.yaml|package-lock.json|yarn.lock|go.mod|pom.xml|build.gradle|requirements.*\.txt|pyproject.toml|uv.lock|poetry.lock|\.csproj|Directory.Packages.props|composer.json|Gemfile|Dockerfile|compose.*\.ya?ml)$'`
Monorepos mix several (tanzu-genai-showcase#221 had Go, Python, .NET, PHP, Ruby, Java and Angular).

## Scripts

All in [scripts/](scripts/), bash 3.2-safe, each with usage in its header.
`lock-age.sh` (release-age check of new lockfile entries), `pr-status.sh`, `wait-ci.sh`,
`compare-base.sh` (is this failure already on the base branch?), and, for the orchestrator only,
`merge-and-close.sh` and `lock-fix.sh`.

## Phases

Track them with a todo list. Show real command output before claiming anything passes.

**0. Discover.** Work only in a fresh clone outside `~/Development`:
`gh repo clone <repo> <scratch>/<name> -- --recurse-submodules -b <base>` (submodules can be Cargo
path dependencies: emailibrium's `ruvector`). Then:

- List bot PRs: `gh pr list -R <repo> --author app/dependabot` and `--author app/renovate`
  (see [bots.md](bots.md) for which Renovate PRs count; `renovate/configure` never does).
- For each, read the real bump: `gh pr diff <n> -R <repo>`, ignoring lockfile noise.
- Read every CI workflow and Makefile/justfile/package script that CI calls. CI is the definition
  of "passing"; mirror its commands, versions and flags verbatim later.
- Note the base's current CI state (`compare-base.sh`). Green bot PRs with old runs are stale: a
  run from before this week's advisories proves nothing (rust-optimizer#10's #5, triage notes A/B).
- Read repo policy: `.claude/settings.json` `attribution`, DCO/sign-off checks, commitlint,
  release-please/semantic-release, `CONTRIBUTING.md`.

**1. Branch.** `chore/deps-consolidate-<lowPR>-<highPR>`, or a descriptive name for one PR.

**2. Apply at manifest level.** Don't merge the bot branches; they all touch the lockfile and
conflict. Edit the manifests directly: each package at the newest version **in its current
major** that is at least 3 days old (newer than the bot proposed is fine). A 0.x minor is a
major (exception: `golang.org/x/*`). Majors are deferred, not taken.

**3. Regenerate locks once** with the repo's pinned package manager, then refresh transitive
entries needed for advisories (ecosystem file has the command). Run
`scripts/lock-age.sh --local origin/<base> .` and fix every UNDER entry.

**4. Propagate version references.** Grep workflows, Dockerfiles, Makefiles, docs, `.nvmrc`,
`rust-toolchain*`, `go.mod`, `engines`, `packageManager` for anything whose version moved.
Library bumps rarely have references; toolchain bumps usually do (claude-code-agent-manager#56
moved Go in go.mod, every workflow, the Dockerfile, docs and scripts). Some repos require docs to move with dependencies
(a private TypeScript site, a private TypeScript + Postgres app). Say which categories needed changes.

**5. Fix failures, upgrade-caused and pre-existing.** Run the full CI gate locally. For each
failure find the root cause; keep fixes minimal and idiomatic. Pre-existing fixes go in their own
commit and PR-body section. Typical pre-existing causes: unpinned `@latest` CI tools, audits that
went red when new advisories landed, slow-runner test timeouts. Anything bigger than a small,
scoped fix: stop and report it.

**6. Security audit.**

- Run every audit tool CI runs, exactly as CI runs it: repo scripts and their ignore files
  included (emailibrium's `.github/scripts/cargo-audit.sh` reads `backend/audit-ignore`). A job
  may chain tools, and a later one can be masked by an earlier failure (`cargo deny` after
  `cargo audit` on ampel#86). All of them must pass.
- Also check the advisory sources CI doesn't: GitHub alerts
  (`gh api repos/<repo>/dependabot/alerts`), RustSec, OSV. They disagree (rust.md).
- For each finding: confirm the advisory (GHSA/RustSec/OSV/NVD), the dependency path, whether
  the vulnerable code is reachable here, and the first patched version. Check that the "patched"
  version actually exists in the registry: braces 3.0.4 and smol-toml 1.8.1 were listed as fixes
  but never published (ampel#86, claude-autopilot#34).
- Prefer in-range lock refreshes, then in-major bumps, then overrides kept inside the current
  major. If the only fix crosses a major (including forcing a transitive dependency across one),
  stop on that item and report it.
- Ignore an advisory only when no fix exists without a major. Each ignore carries the advisory
  link, dependency path, why it can't be fixed now, reachability, and the exit condition, inline
  where the format allows (finima#170, slappy#66).
- **Re-run every audit right before you report.** Advisories land mid-run: RUSTSEC-2026-0385
  and -0386 appeared on 2026-10-23 and turned fresh runs red (emailibrium#312, ampel#90).

**7. Release-age gate (3 days).** Every version you introduce, direct or transitive, plus
toolchain, action and image pins, must be at least 3 days old by registry publish time.

- `scripts/lock-age.sh` checks lockfiles; the ecosystem files give the registry command for
  everything else. Resolver age settings are not proof (node.md).
- The only exception: the **first** patched release for an advisory listed in the GitHub Advisory
  DB, RustSec or OSV. Check all three. Take that release, not a newer one: ctutils 0.4.4, not
  0.4.5 published three hours later (a private Rust + Svelte app).
- Record every exception with its advisory and publish time.

**8. Commit, push, open the PR.** Conventional commits; stage only intended files; let hooks
run. Attribution per AGENTS.md (default: no Co-Authored-By trailer). DCO → `git commit -s`
(a private TypeScript + Postgres app: every bot PR failed sign-off). release-please → `chore(deps)` for dev-only
changes (claude-autopilot#34). Normal push only. The PR body has:

- a table of superseded PRs, split into Dependabot and Renovate ("covered by this PR");
- deferred majors, each with breaking changes, whether it fixes an advisory, and likely code
  impact here;
- every override and ignore with its justification and exit condition;
- every release-age exception;
- pre-existing fixes, and audit counts before and after;
- verification: the exact commands and their results;
- last line: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

**9. CI loop.** `scripts/wait-ci.sh <repo>#<n>`. On red: read the log, separate real failures
from flakes (the npm advisory endpoint timed out fleet-wide around 02:55Z on 2026-10-22), rerun
only flaky jobs (`gh run rerun <id> --failed`), push fixes for real ones. Schedule- or
dispatch-only workflows can be started on the branch with `gh workflow run <wf> --ref <branch>`
(a Rust + Svelte app's `ci-deps`). Workflows disabled for inactivity don't run at all; report them
(actions-docker.md).

**10. Hand-off.** Final message (also saved to `<scratch>/<repo>-report.md`): PR URL; final
status per CI job; superseded PRs by bot; deferred majors with the three facts; overrides,
ignores and exceptions; pre-existing fixes; files changed; decisions the owner must make.
The orchestrator merges and closes; see [ORCHESTRATION.md](ORCHESTRATION.md) and [bots.md](bots.md).

## Done when

- One open PR from you; nothing else touched.
- Every CI job green, or each red job explained as pre-existing with evidence and handed over.
- Every audit tool CI runs passes on a run made just before reporting.
- Every new version passes the release-age gate or is a recorded first-patched exception.
- Every deferred major, override and ignore is written up with its reason and exit condition.
