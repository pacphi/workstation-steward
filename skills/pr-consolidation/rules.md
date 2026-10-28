# Rules for dependency PRs

The rules this skill applies to every repo it touches: release age, majors, merging, attribution, CI audits and
Renovate. [`SKILL.md`](SKILL.md) says how to work; this file says what must hold. The target repo's own rules
(its `CONTRIBUTING.md`, commit checks, CI) come on top of these, never instead of them.

## Contents

- [Release age](#release-age)
- [Majors](#majors)
- [Changing a repo](#changing-a-repo)
- [Merging](#merging)
- [Renovate](#renovate)
- [GitHub](#github)

## Release age

- **The gate.** Take the newest version published at least N days ago, where N is
  `[policy] min_release_age_days` in the user's `steward.toml` (`steward config` shows it; the default is 3). It
  applies to every version a PR introduces, direct or transitive, and to toolchain, action and image pins.
- **The exception:** a version that is the first patched release for an advisory listed in the GitHub
  Advisory DB, **RustSec** or **OSV**. Check all three, because the GitHub DB lags RustSec (seen with
  webpki-roots and rustls-webpki in 2026-10). Take the first patched release, not a newer one (ctutils 0.4.4,
  not 0.4.5). Record every exception with its advisory in the PR body.
- **Verify every new lockfile entry by its registry publish time** (`scripts/lock-age.sh`). Resolver settings
  such as `pnpm --config.minimum-release-age` are not proof.
- **Advisories land mid-rollout** (RUSTSEC-2026-0385 and -0386 appeared on 2026-10-23). Re-run every audit tool
  right before merging, and fix new advisories in the repo where they occur.

## Majors

- **Majors are deliberate.** A 0.x minor bump counts as a major; the exception is `golang.org/x/*`.
- A consolidation PR defers majors and reports, for each, its breaking changes, whether it fixes an advisory, and
  its likely code impact in this repo.

## Changing a repo

- Work in a fresh clone in a scratch folder, never in a checkout under the user's project roots. Push a branch and
  open a PR.
- **Commit attribution follows the repo:** check `.claude/settings.json` `attribution`, DCO or sign-off checks
  and commitlint. Default to no Co-Authored-By trailer unless the repo asks for one.
- **Mirror the repo's CI audit commands exactly,** including its own scripts and ignore files (for example
  `.github/scripts/cargo-audit.sh` with `audit-ignore`). A job may chain several tools; make them all pass. Add
  ignores only when no fix exists without a major, each with its advisory, dependency path, reachability and exit
  condition.

## Merging

- Merge with `gh pr merge --squash --delete-branch --match-head-commit <sha>`; `<sha>` must be the full
  40-character commit ID (`gh pr view <n> --json headRefOid`), since a short SHA is rejected.
- A develop→main release PR uses `--merge` (a merge commit) and must not delete `develop`; a release-prep PR uses
  `--rebase`.
- Close superseded **Dependabot** PRs with a "Superseded by #N." comment. Leave superseded **Renovate** PRs to
  autoclose: closing one by hand tells Renovate to ignore that version ([`bots.md`](bots.md)).
- After merges, the user brings local checkouts up to date with `steward fleet sync <repo>` and tidies branches
  with `steward fleet prune-merged <repo>`. Both plan first; run them without `--apply` only.

## Renovate

- Use Renovate (the Mend app) for version updates, not Dependabot's. Its config is `renovate.json` with
  `minimumReleaseAge` set to the gate and vulnerability alerts on, which bypass the age gate.
- **Renovate and Dependabot read config only from the default branch.** For repos that integrate on `develop`,
  put a byte-identical `renovate.json` on `main` and `develop` with `"baseBranchPatterns": ["develop"]`. Verify
  parity with `gh api repos/<r>/contents/renovate.json?ref=<branch> --jq .sha`.
- **GitHub security alerts are computed on the default branch only.** Fixes merged to `develop` don't clear
  alerts until they reach `main`; a dependency-only backport to `main` clears them without a release.
- **Renovate's security PRs don't fire** for advisories that exist only in RustSec, or for transitive-only
  crates. Run `cargo audit` yourself.
- **The app is installed with selected repositories.** A repo that isn't selected gets nothing: no onboarding PR,
  no dashboard.
- **Use `docker:pinDigests`** where compose files run images; pin `tag@sha256:digest`. Tags can be re-pushed
  (LiteLLM's tags were hijacked on 2026-10-21); digests can't.
- **0.x rule:** write it as `"matchCurrentVersion": "/^v?0\\./"`. The range form `"<1.0.0"` silently fails for
  versioning schemes that don't support ranges (uv, kind).
- **Matching mise tools by name:** for `npm:<pkg>` (and other backend-prefixed) tools, Renovate's packageName is
  the bare `<pkg>`, so match on `matchDepNames`, not `matchPackageNames`. Use a regex (`"/^npm:/"`), not a glob:
  `*` doesn't match the `/` in scoped names like `npm:@openai/codex`.
- **Security PRs ignore `enabled: false` package rules.** Renovate still proposes a vulnerability fix that
  crosses a major or touches an excluded folder. Keep files out with `ignorePaths`, which stops the file being
  read at all, and treat a security PR that proposes a major as a decision.
- **Verify a config change before merging it** with Renovate's local platform: check out the branch, commit the
  effective `renovate.json` locally (the local platform reads committed files only), and run
  `renovate --platform=local`. Read "Filtered out N disabled update(s)" and "flattened updates found" in the
  debug log. A dry run with the config passed as global config is not faithful: the repo's own config and presets
  override it.

## GitHub

- Workflows disabled for inactivity need `gh workflow enable` plus a PR close and reopen (or a push) to fire.
- Dependency Review reports `golang.org/x/*` as `LicenseRef-scancode-google-patent-license-golang` (Go's PATENTS
  grant); allowlist those purls in `allow-dependencies-licenses`.
