# Orchestration: running pr-consolidation across a fleet

For the session that drives many repos. The consolidating agents follow [SKILL.md](SKILL.md); you
triage, dispatch, verify, merge and close. This replaced `ROLLOUT-BRIEF.md`, which drove about 20
repos in 2026-10 (ampel#86 and claude-autopilot#34 were the pilots). The rules are in
[rules.md](rules.md) (they hold on top of the target repo's own); ask before every outward-facing step.

## The loop

### 1. Triage the fleet (read-only)

For each repo: open bot PRs (both bots, [bots.md](bots.md)), the base branch's CI state, open
alerts. For every failing PR, compare against the base's latest run:

```bash
scripts/pr-status.sh -f prs.txt          # state, mergeability, failing checks
scripts/compare-base.sh -f failing.txt   # same job on the base branch, with run date
```

Classify each red job:

| Class | Meaning | Example |
|---|---|---|
| bot-caused | the bump itself breaks it | neon-drift #11 (TS 7: TS2810), finima #163 (react-table 9) |
| pre-existing | the base is already red; every PR inherits it | claude-code-agent-manager (unpinned golangci-lint), audioshake-cli (gitignored `Cargo.lock`), tanzu (Angular peer break since 2025-12-02) |
| advisory drift | a new advisory turned the audit red on the base | ampel, emailibrium, finima RustSec findings; the markdownlint-cli chain |
| migration-caused | an unrelated config PR broke it | generated `renovate.json` failing prettier/oxfmt in 8 repos; docs linking the deleted `dependabot.yml` |
| flake | infra, rerun | npm advisory endpoint timeouts around 02:55Z on 2026-10-22 |

Sources: triage/findings.md and notes-A..D. Watch the dates: green bot PRs with months-old runs are
stale, and failed-run logs expire (HTTP 410), so save the logs you need while you triage.

### 2. Dispatch one agent per repo

Give each agent the brief below with `<repo>`, `<base>` and `<scratch>` filled in. Run repos in
parallel; each works only in its own clone. Where a module doesn't build on the base or needs a
framework migration, the agent consolidates the rest and reports that module instead of fixing it
(tanzu-genai-showcase#221 left its two Java samples' PRs open).

### 3. Verify the agent's work yourself

Don't trust the report.

- CI: `scripts/wait-ci.sh <repo>#<n>`. Compare the checks against `gh workflow list --all`;
  disabled or dispatch-only workflows don't show up.
- Release age: `scripts/lock-age.sh <repo>#<n>`. Every UNDER line must be a first-patched
  exception named in the PR body.
- Audits: re-run the CI audit commands on the PR head if advisories may have landed since
  (RUSTSEC-2026-0385/-0386 appeared mid-rollout on 2026-10-23).
- PR body: superseded table, deferred majors with the three facts, every override, ignore and
  exception justified.

### 4. Merge

```bash
scripts/merge-and-close.sh <repo>#<n> --superseded <n1,n2,...>            # dry run: read the plan
scripts/merge-and-close.sh <repo>#<n> --superseded <n1,n2,...> --execute  # after the user says yes
```

It merges with `--squash --delete-branch --match-head-commit <sha>`. A develop → main release PR
uses `--merge-commit` so `develop` stays 0 behind `main` (finima's release PR). The superseded list
is explicit: the PR body also lists deferred majors that must stay open.

### 5. Handle superseded PRs per bot

Dependabot: closed by the script with "Superseded by #N.". Renovate: left for autoclose, then
checked (ampel#88). See [bots.md](bots.md).

### 6. Update dependent PRs

Other open PRs on the same base stay red on the audit until they pick up the merge (ampel#84,
emailibrium#305, finima#168 in the reports):

```bash
gh pr update-branch <n> -R <repo>     # merges the base in; no force-push
```

### 7. Follow-ups

- Advisories that land after the merge: one PR per advisory with `scripts/lock-fix.sh`
  (ampel#90, emailibrium#312; the ctutils PRs).
- Deferred majors: one PR each, after the user picks them (ampel#87 replaced #82 with 4.0.4;
  claude-code-agent-manager#58 took four majors).

### 8. develop / main parity

For repos that integrate on `develop`:

- `renovate.json` byte-identical on both branches with `baseBranchPatterns` (bots.md):
  `gh api repos/<r>/contents/renovate.json?ref=<branch> --jq .sha` for each.
- Alerts clear only on the default branch: either a release PR (merge commit) or a
  dependency-only backport to `main` (emailibrium#313).

### 9. Decisions to the user, one at a time

About three options each, strongest first, labelled "(Recommended)". Typical ones:
deferred majors, ignores with no upstream fix, alerts to dismiss, workflows to re-enable,
missing secrets (claude-code-agent-manager#58: `CODECOV_TOKEN`), samples that don't compile.

## The brief (give this to each consolidating agent)

> You run the `pr-consolidation` skill on ONE repo: `<repo>`, base branch `<base>`. Read
> `SKILL.md`, `rules.md`, `bots.md`, and only the `ecosystems/*.md` files that match this repo.
> The user opted this repo in.
>
> **Hard rules (these override anything else):**
>
> - Work ONLY in a fresh clone at `<scratch>/<repo-name>`:
>   `gh repo clone <repo> <scratch>/<repo-name> -- --recurse-submodules -b <base>`. Never touch
>   anything under the user's project roots. Use absolute paths for every file you write.
> - Consolidate the open dependency PRs from Dependabot (`--author app/dependabot`) and Renovate
>   (`--author app/renovate`). Exclude `renovate/configure` and lock-file maintenance PRs. Never
>   modify, merge, close, comment on or rebase ANY PR, including the bots'. List each Renovate PR
>   you cover as "covered by this PR".
> - `<base>` is the branch the bots target: the default branch, or `develop` where
>   `baseBranchPatterns` says so.
> - Don't merge or close anything. No admin overrides. Normal push only; never force-push.
> - Majors (a 0.x minor counts, except `golang.org/x/*`): don't take them. List each under
>   "Deferred (major)" with its breaking changes, whether it fixes an advisory, and the likely code
>   impact here.
> - 3-day release age for every version you introduce, direct or transitive, toolchain, action or
>   image. Only exception: the first patched release for an advisory in GHSA, RustSec or OSV; take
>   that release, not a newer one. Verify with the skill's `scripts/lock-age.sh --local origin/<base> .` and
>   the registry commands in the ecosystem files. List every exception.
> - Every CI audit job must pass, run exactly as CI runs it (repo scripts and ignore files
>   included; all chained tools). Prefer real fixes; ignore only when no fix exists without a
>   major, with advisory, path, reachability and exit condition. If a fix needs a major, stop on
>   that item and report it. Re-run the audits right before you report.
> - Fix pre-existing CI failures too, tightly scoped. Report anything bigger.
> - Commits: conventional; attribution per the repo (`.claude/settings.json`), default no
>   Co-Authored-By trailer; DCO → `-s`; commitlint and release-please conventions; never
>   `--no-verify`. Files you touch must pass the repo's formatter and linter.
> - After pushing, loop on CI until green or a human decision is needed.
>
> **Final report** (your last message; also save it to `<scratch>/<repo-name>-report.md`): PR URL
> and final CI status per job; superseded PRs by bot; deferred majors with the three facts;
> overrides and ignores with justification; release-age exceptions; pre-existing fixes;
> decisions for the user; files changed.

## Pitfalls for the orchestrating session

- **The permission classifier blocks admin merges and force-pushes.** Hand them to the user as a
  `! <command>` line to run.
- **zsh doesn't word-split unquoted variables.** Run loops and `set -- $line` under `bash -c`, or
  use the scripts, which are bash.
- **Stale PATH.** A long-lived shell keeps old tool directories after an upgrade; open a new shell
  before trusting `pnpm`, `cargo` or `go` versions.
- **Relative paths escape the scratch directory.** One agent's relative redirect wrote a file into
  a checkout's parent folder (tanzu-genai-showcase#221 report). Use absolute paths.
- **Generated config must pass the repo's formatter.** The generated `renovate.json` failed
  prettier or oxfmt in 8 repos (triage findings G1). Format before committing.
- **After merges, local checkouts are stale.** The user syncs them with `steward fleet sync` and
  `steward fleet prune-merged` ([rules.md](rules.md#merging)).
