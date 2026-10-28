# Releasing workstation-steward

![Revision 1](https://img.shields.io/badge/Revision-1-green) ![Revised 2026-10-28](https://img.shields.io/badge/Revised-2026--10--28-green)

How a release happens, and the one-time npm setup behind it (D46 in [`architecture.md`](architecture.md#decisions)).
For maintainers of this repository; users install releases as [`../README.md`](../README.md) describes.

## Contents

- [How a release happens](#how-a-release-happens)
- [Pull request titles](#pull-request-titles)
- [One-time npm setup](#one-time-npm-setup)
- [Publishing an existing release](#publishing-an-existing-release)
- [After each release](#after-each-release)
- [The publish guard](#the-publish-guard)
- [A pre-push leak check for your clone](#a-pre-push-leak-check-for-your-clone)

## How a release happens

```text
 PRs merge to main ──► release-please keeps one release PR open:     merge it ──► tag vX.Y.Z + GitHub release
 (Conventional Commit   next version + rolling CHANGELOG.md            │          ──► tests on macOS (the tag)
  titles, squash)       (the checks are started on it by the workflow) │          ──► publish-guard ──► npm publish
                                                                        └─ when you decide to release      (provenance)
```

1. Every merge to `main` updates the **release PR** (`chore(main): release X.Y.Z`; the first one is 0.1.0, set by
   `initial-version` in `release-please-config.json`, since release-please would otherwise start at 1.0.0): the version follows the commit
   types since the last release (before 1.0, `feat` raises the minor version and `fix` the patch; `feat!` or a
   `BREAKING CHANGE:` footer is called out at the top), and `CHANGELOG.md` gains the grouped entries.
2. **When you decide to release, close and reopen the release PR** (`gh pr close <n> && gh pr reopen <n>`). A PR a
   workflow opens or updates starts no checks, and checks started by hand on its branch don't count for it; your reopen
   runs the required checks. Wait for them to pass.
3. **Merging the release PR is the release.** The workflow tags the commit, creates the GitHub release with the same
   notes, runs the tests and lint on macOS against the tag, then publishes to npm through Trusted Publishing (no token)
   with provenance, after [the publish guard](#the-publish-guard) agrees.

## Pull request titles

Merges are squash-only, and the squash commit takes the PR's title, which release-please reads. Titles follow
[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`,
`build:`, `perf:`, `revert:`, `chore:`. The PR title check flags any other.

## One-time npm setup

npm can only trust a workflow for a package that already exists, and a trust that isn't used within 48 hours expires.
So the name is reserved first with an empty `0.0.0`, published by hand; every real release comes from the workflow.

1. **Reserve the name** from an empty scratch folder (never from a clone):

   ```sh
   mkdir -p ~/scratch/steward-placeholder && cd ~/scratch/steward-placeholder
   printf '%s\n' '{"name":"workstation-steward","version":"0.0.0","description":"Reserved; the first release (0.1.0) follows from https://github.com/pacphi/workstation-steward","license":"MIT","repository":{"type":"git","url":"git+https://github.com/pacphi/workstation-steward.git"},"files":["README.md"]}' > package.json
   printf '%s\n' '# workstation-steward' '' 'Reserved. Install 0.1.0 or later; see https://github.com/pacphi/workstation-steward.' > README.md
   npm login
   npm publish --access public
   ```

   `npm login` opens a browser and asks for two-factor authentication. Expect `+ workstation-steward@0.0.0`.
2. **Trust the release workflow** (npm 11.21 or later, or 12.2 or later; still logged in):

   ```sh
   npm trust github workstation-steward --repository pacphi/workstation-steward --file release.yml --environment npm --allow-publish
   ```

   Or on [npmjs.com](https://www.npmjs.com/package/workstation-steward/access): *Settings → Trusted Publisher →
   GitHub Actions*, with user `pacphi`, repository `workstation-steward`, workflow `release.yml` and environment
   `npm`. Every field is case-sensitive.
3. **Within 48 hours, release 0.1.0:** merge the open release PR. Watch the Release workflow to its end.
4. **Check the trust and the release:**

   ```sh
   npm trust list workstation-steward
   npm view workstation-steward@0.1.0 dist.attestations --json
   ```

   The trust must name `pacphi/workstation-steward` and `release.yml`; the release must carry a provenance
   attestation.
5. **Retire the placeholder:** `npm deprecate workstation-steward@0.0.0 "Placeholder; install 0.1.0 or later"`.

## Publishing an existing release

If a release was tagged but not published (the publish job failed, or was skipped), start the workflow by hand with
the tag. It runs the same macOS tests, guard and publish against that tag:

```sh
gh workflow run release.yml --repo pacphi/workstation-steward -f tag=v0.1.0
```

## After each release

- The GitHub release and `CHANGELOG.md` carry the same notes.
- `npm view workstation-steward version` shows the new version within a few minutes (registry reads lag a publish).
- A config repo that pins the steward through mise gets a Renovate PR once the release is 3 days old.

## The publish guard

[`tools/publish-guard.js`](../tools/publish-guard.js) runs before every publish, as the workflow's step and as npm's
`prepublishOnly`. It refuses unless every condition holds:

- the run is the `release.yml` workflow of this package's own repository, on GitHub Actions;
- `HEAD` is exactly the tag `v<version>`, and the checkout is clean;
- the packed package holds only the allow-listed files and passes the leak check's structural rules;
- npm doesn't already have that version.

So `npm publish` typed in any clone refuses, with its reasons.

## A pre-push leak check for your clone

`just leak-check` checks every tracked file, and every new file Git doesn't ignore, for instance files, home paths
and the private terms in your own config's `leak-terms.txt`. To run it on everything a push sends, file contents and
commit messages alike, add `.git/hooks/pre-push` to your clone:

```sh
#!/bin/sh
zero=0000000000000000000000000000000000000000
root="$(git rev-parse --show-toplevel)"; tmp="$(mktemp -d -t steward-prepush)"; status=0
while read -r lref lsha _rref _rsha; do
  [ "${lsha}" = "${zero}" ] && continue
  dir="${tmp}/$(printf '%s' "${lref}" | tr '/' '_')"; mkdir -p "${dir}"
  git archive "${lsha}" | tar -x -C "${dir}"
  git log --format='%an <%ae>%n%B' "${lsha}" --not --remotes > "${dir}/.outgoing-commit-messages.txt"
  STEWARD_INSTANCE="${HOME}/.config/workstation-steward" node "${root}/tools/leak-check.js" "${dir}" || status=1
done
rm -rf "${tmp}"; exit "${status}"
```

Make it executable (`chmod +x .git/hooks/pre-push`). `git push --no-verify` skips it, deliberately and rarely.
