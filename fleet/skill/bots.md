# Dependabot and Renovate

Both bots are supported. The consolidation itself is the same for both: take each PR's bump at
manifest level, in-major, at least 3 days old. They differ in which PRs count and, above all, in
how superseded PRs get closed.

## Discovery

```bash
gh pr list -R <repo> --author app/dependabot --state open --json number,title,headRefName,updatedAt
gh pr list -R <repo> --author app/renovate   --state open --json number,title,headRefName,updatedAt
```

`gh` reports the authors as `app/dependabot` and `app/renovate`; the git actors are
`dependabot[bot]` and `renovate[bot]`.

## Dependabot PR shapes

- One package per PR, or a `groups:` PR that bumps many (in a private Rust + Svelte app, one consolidation superseded a 9-of-11 "rust group"
  and a "js group"). Take the in-major part of a group and defer the rest; the PR is then only
  partly superseded (emailibrium#308: #300 and #303).
- Dependabot's version updates don't bump lockfile-only (transitive) crates, so RustSec findings
  on those never get a Dependabot PR (ampel triage, notes-B).
- Bot commits carry no `Signed-off-by`, so in DCO repos every Dependabot PR fails sign-off
  (a private TypeScript + Postgres app).

## Renovate PR shapes

Branch prefix `renovate/`. What each shape means for consolidation:

| Shape | How to recognise it | Consolidate? |
|---|---|---|
| Group | `groupName` in `renovate.json`; branch `renovate/<group>` (the fleet config groups `github-actions`, `rust`, `js`, `docker` per ecosystem) | Yes, the in-major part |
| Single update | branch `renovate/<package>-<major>.x` | Yes, if in-major |
| Security | title ends `[security]` or `[SECURITY]`; branch `renovate/<manager>-<package>-vulnerability` (a private Rust + Svelte app, ampel#88). Bypasses `minimumReleaseAge` | Yes; take the same or a newer in-major version and list it as "covered by this PR". If it's a major (ampel#88 proposed i18next-http-backend v4), defer it like any major |
| Lock-file maintenance | branch topic `lock-file-maintenance`, title "Lock file maintenance"; Renovate deletes and regenerates the lockfile ([docs](https://docs.renovatebot.com/configuration-options/#lockfilemaintenance)) | No. Leave it as its own PR, and check it with `scripts/lock-age.sh` before merging, since a full regeneration can pull versions newer than the policy allows |
| Onboarding | branch `renovate/configure`, title "Configure Renovate" | **Never.** Not a dependency PR. Leave it alone |
| Dependency Dashboard | an issue, not a PR | Read it: it lists pending, rate-limited and approval-gated updates. Majors gated by `dependencyDashboardApproval` are requested by ticking their box there ([docs](https://docs.renovatebot.com/key-concepts/dashboard/)) |

## Closing superseded PRs: the crucial difference

### Dependabot: close them

After the consolidation PR merges, close each fully superseded Dependabot PR with
`Superseded by #N.` (`scripts/merge-and-close.sh --superseded ...` does this). Leave deferred
majors and partly superseded PRs open (emailibrium#308's #300 and #303). Once
`.github/dependabot.yml` is gone, deferred majors come back through Renovate instead, so closing
Dependabot PRs then loses nothing (a private Rust + Svelte app's consolidation report).

### Renovate: don't close them by hand

Renovate keeps no state; it finds its PRs by branch name and title. **Closing a Renovate PR is how
you tell it to ignore that update**: "Close a Renovate PR to ignore it", and for a major, "Renovate
won't create any update PRs for `v4` of `lodash`, even if there are newer versions of `v4`"
([Pull requests](https://docs.renovatebot.com/key-concepts/pull-requests/), "Ignoring PRs").
A hand-closed Renovate PR then shows under "Closed/Ignored" on the Dependency Dashboard, where
ticking its box gets a new PR ([Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/)).

Instead, merge the consolidation and let Renovate clean up: on its next run, when a PR's update
is no longer needed, "Renovate either autocloses the PR and deletes the branch, or, if the branch
has been modified, flags the PR as abandoned" (same page, "Abandoned PRs"). So don't push to a
Renovate branch you want autoclosed.

Observed in the fleet: ampel#87 merged at 2026-10-22T15:25:01Z; at 15:26:21Z `renovate[bot]`
renamed ampel#88 to "…[SECURITY] - autoclosed" and closed it
(`gh api repos/pacphi/ampel/issues/88/events`). The " - autoclosed" title suffix is what Renovate
does in practice; the docs page doesn't name it.

To check after the merge:

```bash
gh pr view <n> -R <repo> --json state,title     # CLOSED + "- autoclosed" = done
gh api repos/<repo>/issues/<n>/events --jq '.[] | select(.event=="closed") | .actor.login'
```

**Closing by hand is acceptable only** when the base branch already contains the PR's version (or
newer) for every package in it. Then the ignore is harmless, but say in the closing comment that
Renovate won't re-propose that version. In a private Rust + Svelte app, three Renovate security PRs were closed by hand 40 seconds
after its consolidation merged; it already had vite 8.3.4, brace-expansion 5.0.12 and kit 2.70.3, so
nothing was lost, but those three versions are now ignored. Never hand-close a Renovate PR for a
deferred major: that would silence the whole major line.

## Configuration facts that affect consolidation

- **Config is read from the default branch only.** For repos that integrate on `develop`, the
  `renovate.json` on `main` must carry `"baseBranchPatterns": ["develop"]`, byte-identical on
  both branches (AGENTS.md; finima#171, ruflo-local#34's companion config PR). Check parity:
  `gh api repos/<r>/contents/renovate.json?ref=<branch> --jq .sha`.
- The fleet config (`renovate.json` in each repo, e.g. a Rust + Svelte app) sets `minimumReleaseAge: "3 days"`,
  `osvVulnerabilityAlerts: true` and `vulnerabilityAlerts`, which bypass the age gate.
- Repo-level `pnpm-workspace.yaml` `minimumReleaseAgeExclude` entries that Renovate added for
  specific versions go stale once those versions leave the lockfile; remove them when you touch
  the file (slappy#66, a private TypeScript + Postgres app; neon-drift#14 left two inert ones).

## Gaps neither bot covers

- **GitHub security alerts are computed on the default branch only.** Fixes merged to `develop`
  don't clear alerts until they reach `main` (finima#170). A dependency-only backport to `main`
  clears them without a release (emailibrium#313).
- **Renovate's security PRs don't fire for RustSec-only advisories or transitive-only crates.**
  The rustls, webpki and quinn-proto findings in ampel, emailibrium and finima had no GitHub alert
  and no bot PR (triage notes-C). Run `cargo audit` yourself.
- The reverse also happens: rmcp's four GHSAs had no RustSec entry, so `cargo audit` stayed green
  while GitHub alerted (emailibrium#308).
- A bot PR can't go green on its own when the repo audits a whole directory and other advisories
  remain there. A JavaScript archiver's 18 Dependabot PRs all failed `check-npm-audit` until one PR fixed
  everything (a private JavaScript archiver). That deadlock is the main reason to consolidate.

## Mixed repos (both bots have open PRs)

Happens during a Dependabot → Renovate migration. A private Rust + Svelte app consolidated 9 Dependabot PRs and
listed Renovate security PRs #127, #129 and #131 as covered, with the versions taken. Consolidate
both sets at manifest level, then close per bot as above: Dependabot ones with "Superseded by #N.",
Renovate ones left to autoclose. In the fleet, `.github/dependabot.yml` was removed by separate
migration PRs (a private Rust + Svelte app), not by the consolidations.
