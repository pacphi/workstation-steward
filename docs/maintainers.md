# Releasing workstation-steward

![Revision 3](https://img.shields.io/badge/Revision-3-green) ![Revised 2026-10-29](https://img.shields.io/badge/Revised-2026--10--29-green)

How a release happens, and the one-time npm setup behind it (D46 in [`architecture.md`](architecture.md#decisions)),
plus what to do when the weekly upstream watch finds that a shipped default changed (D52). For maintainers of this
repository; users install releases as [`../README.md`](../README.md) describes.

## Contents

- [How a release happens](#how-a-release-happens)
- [Pull request titles](#pull-request-titles)
- [One-time npm setup](#one-time-npm-setup)
- [Publishing an existing release](#publishing-an-existing-release)
- [After each release](#after-each-release)
- [The maintainer skill](#the-maintainer-skill)
- [Checking a release on a clean Mac](#checking-a-release-on-a-clean-mac)
- [The publish guard](#the-publish-guard)
- [A pre-push leak check for your clone](#a-pre-push-leak-check-for-your-clone)
- [A shipped default changed upstream](#a-shipped-default-changed-upstream)

## How a release happens

```text
 PRs merge to main ──► release-please keeps one release PR open:     merge it ──► tag vX.Y.Z + GitHub release
 (Conventional Commit   next version + rolling CHANGELOG.md            │          ──► tests on macOS (the tag)
  titles, squash)       (its checks wait for your approval)            │          ──► publish-guard ──► npm publish
                                                                        └─ when you decide to release      (provenance)
```

1. Every merge to `main` updates the **release PR** (`chore(main): release X.Y.Z`; the first one is 0.1.0, set by
   `initial-version` in `release-please-config.json`, since release-please would otherwise start at 1.0.0): the version follows the commit
   types since the last release (before 1.0, `feat` raises the minor version and `fix` the patch; `feat!` or a
   `BREAKING CHANGE:` footer is called out at the top), and `CHANGELOG.md` gains the grouped entries. A change only to
   folders that never ship (`exclude-paths` in `release-please-config.json`: `.github`, `docs`, `test`, `tools`) leaves the release PR alone and stays out of the changelog (D47). release-please can't skip top-level
   files, so an edit to `AGENTS.md` or the `justfile` still updates the release PR: merge it only when something users
   get (the npm package, or `renovate/steward.json`) has changed.
2. **When you decide to release, approve the release PR's checks.** Each time release-please opens or updates the PR
   (as `github-actions[bot]`), GitHub holds its checks: the PR shows "workflows awaiting approval". Choose *Approve
   workflows to run*; those runs count as the PR's required checks. Wait for them to pass. If the PR shows no checks at
   all, close and reopen it (`gh pr close <n> && gh pr reopen <n>`): the reopen runs them too.
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
5. **Retire the placeholders:** the hand publish of `0.0.0` also left a `0.0.0-stage` version, a by-product of npm's
   background processing (the releases from the workflow left none). Deprecate both:

   ```sh
   npm deprecate workstation-steward@0.0.0 "Placeholder; install 0.1.0 or later"
   npm deprecate workstation-steward@0.0.0-stage "Placeholder; install 0.1.0 or later"
   ```

## Publishing an existing release

If a release was tagged but not published (the publish job failed, or was skipped), start the workflow by hand with
the tag. It runs the same macOS tests, guard and publish against that tag:

```sh
gh workflow run release.yml --repo pacphi/workstation-steward -f tag=v0.1.0
```

## After each release

- The GitHub release and `CHANGELOG.md` carry the same notes.
- **npm finishes the publish in the background.** The publish step can succeed while the registry still shows the
  previous version: its log ends `Your package is being processed and may take a few minutes to become available`, and
  0.2.0 appeared about 3 minutes later. Call it published when the registry says so, not the log:

  ```sh
  npm view workstation-steward dist-tags
  npm view workstation-steward@X.Y.Z dist.attestations --json   # the provenance attestation
  ```

- A config repo that pins the steward through mise gets a Renovate PR once the release is 3 days old.

## The maintainer skill

The routine after a merge is the same each time, so it's a project skill, **`/steward-maintain`**
(`.claude/skills/steward-maintain/`, D53), loaded when Claude Code runs in this repository. Its arguments are a short
sentence naming what happened:

```text
/steward-maintain                       what's waiting: the checkout against GitHub, open PRs, the config plan
/steward-maintain merged 41             after #41 merged: fast-forward main, delete merged branches
/steward-maintain merged 41 39 repin    the same; #39 was the release PR, so watch 0.4.1, verify it, repin
/steward-maintain release 0.4.1         watch and verify only
/steward-maintain repin 0.4.1           verify, then repin
/steward-maintain config                take the config repo's merged changes
```

Each flow is a script that prints its plan, refuses anything outside its scope, and stops on any failed check:

| Flow | Script | What it may change |
| --- | --- | --- |
| What's waiting | `status.sh` | nothing |
| After a merge | `after-merge.sh [<pr>…]` | this checkout: `steward fleet sync` and `steward fleet prune-merged`, fast-forward and merged branches only |
| A release | `release.sh <X.Y.Z>` | nothing: it waits for the run and npm, then verifies npm's latest, the provenance commit (the tag's) and the GitHub release |
| A repin | `repin.sh <X.Y.Z> --why "<your words>"` | the release channel, after a backup of both launchers and a receipt |
| Config sync | `config-sync.sh` | your config checkout: a fast-forward, or finishing a merged send; stops if the plan would send |

The scripts never reset, rebase, merge, force-push or delete unmerged work, and touch only this checkout and the
config instance `steward config` names. The skill pre-approves exactly these five scripts (`allowed-tools`), so an
agent runs them without a prompt, but only where your own rules authorize it (your private `AGENTS.md`); otherwise it
hands you the command. `test/steward-maintain.test.js` holds each refusal.

## Checking a release on a clean Mac

The Install check workflow (`.github/workflows/install-check.yml`) installs a released version on a fresh macOS
runner the way a maintainer's machine runs it, and switches between the two release modes
([`lifecycle.md`](lifecycle.md#two-channels)). Start it by hand:

```sh
gh workflow run install-check.yml --repo pacphi/workstation-steward -f version=X.Y.Z
```

1. Worktree mode: `just release-worktree vX.Y.Z`; `steward version` points at `steward init` while there is no config;
   then `steward init --yes` (a fresh config from the examples), and `steward version` says `release X.Y.Z (vX.Y.Z)`.
2. `steward config --check`, and `steward sc link` points mise at the new config.
3. npm mode: the release's provenance attestation, then
   `steward sc upgrade-tool 'npm:workstation-steward[allow_low_downloads=true]' X.Y.Z` (the approval lets mise's npm
   installer take a package name younger than 30 days); `steward version` says `release X.Y.Z (npm)`.
4. `steward check`, and the plugin folder as Claude Code builds it.
5. The skills plugin: `steward skills install --yes` (a runner is not a Claude Code session), then `claude plugin list`.
6. Back to worktree mode: `steward sc rollback`; `steward version` says `(vX.Y.Z)` again.

The config's release-age gate (3 days) applies to step 3. To check a younger release, set `-f release_age_days=0`:
it lowers the gate for that run only, and the job summary says so. Each step checks its result and adds a line to the
summary.

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

## A shipped default changed upstream

The engine ships a key pin for each signed data source it knows: an `[[updater]]` in
`supply-chain/host-defaults.toml` whose `[updater.pin]` holds the hash of the signing key you reviewed
([`release-classes.md`](release-classes.md), D52). If the publisher changes that key, every machine that gets the new
file refuses it until the pin is updated. You want to hear about that from the watch, not from a user.

**The Upstream watch** (`.github/workflows/upstream-watch.yml`) runs every Monday, and when you start it by hand. Its
script, `tools/upstream-watch.js`, fetches each pin's `watch` URL, finds the key with the pin's `match`, and hashes it
exactly as `steward sc audit` hashes a machine's copy. It only reads: it never changes a file or opens a pull request.

| The run says | What it means | What happens |
| --- | --- | --- |
| unchanged | the publisher's key is the one you reviewed | nothing |
| CHANGED | the key's text now has a different hash | an issue, *Upstream watch: the key pinned for `<name>` changed*, labelled `owner-decision`; the run passes |
| could not check | a network or HTTP error, or `match` found nothing | the run fails and says why; no issue |
| skipped | the pin has no `watch` URL | nothing |

There is one issue per entry. A later run finds it by its title and adds a comment only if the hash has moved again.
The first run that needs the `owner-decision` label creates it. A network error usually clears by the next week; a
"no match" that stays means the publisher reorganized the file, so treat it like a change. To run it now, or locally
(locally it never files an issue; it exits 0 unchanged, 10 changed, 1 could not check):

```sh
gh workflow run upstream-watch.yml --repo pacphi/workstation-steward
node tools/upstream-watch.js
```

### When the issue opens

The watch says the key changed. It can't say whether the change is good: a planned key rotation and a hijacked
publisher look the same from here. So check before you trust it.

1. **Find the change.** The issue links the file's history. Open the commit that changed the key: who made it, when,
   and what else changed with it.
2. **Confirm it from a primary source.** Look for the publisher's own word on the new key: their release notes,
   changelog, security advisory or announcement, on a channel they control (their GitHub releases or their site). A
   social post isn't enough. The new key should appear there, or the rotation should be explained there.
3. **Update the pin in an engine PR**, from a fresh clone on a new branch:
   - in `supply-chain/host-defaults.toml`, set the entry's `[updater.pin] sha256` to the new hash (the issue and
     `node tools/upstream-watch.js` both print it in full);
   - rewrite `why` to say what you reviewed, the date and the version (the current text ends "Reviewed 2026-10-29 at
     runtime 4.7.6");
   - run `node tools/upstream-watch.js`: it must now say `unchanged`; then the usual gates (`just test` runs the
     schema test on every shipped `[[updater]]`);
   - title it `fix: <name>'s key pin, rotated upstream`, link the publisher's announcement and the commit in the body,
     and add `Fixes #<issue>` so the merge closes the issue.
4. **Release it.** Users get the new pin in the next release, after the release-age gate like any engine change.
   Until then, `steward sc audit` reports the mismatch on a machine that has the new file. A user who can't wait can
   review the key and put an `[[updater]]` with the same `name` and the new pin in their own `host.toml`: it replaces
   the default.

**If you can't confirm the change,** don't ship the new hash. Choose one, in an engine PR:

- **Hold it:** set the entry's `class` to `gated`. `steward sc upgrade` never applies a declared `gated` source (the
  plan lists it as held), while the audit keeps checking the pin and that the tool's own updater stays off.
- **Turn it off:** remove the entry from `host-defaults.toml`. A user can do the same on one machine now, with
  `[off] updater = ["<name>"]` in their `host.toml`.

Say which you chose, and why, in the issue before you close it.
