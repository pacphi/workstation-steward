# Fleet runbook

![Revision 2](https://img.shields.io/badge/Revision-2-green) ![Revised 2026-10-26](https://img.shields.io/badge/Revised-2026--10--26-green)

Procedures for the GitHub side of the repos under `~/Development`. The rules are in
[`../../AGENTS.md`](../../AGENTS.md): Renovate, Repos under ~/Development, Repos with long-lived version lines.
This page gives the steps in order and doesn't restate the rules.

## Contents

- [Bring a repo under Renovate](#bring-a-repo-under-renovate)
- [Bot PRs have piled up](#bot-prs-have-piled-up)
- [Merge](#merge)
- [After merging](#after-merging)
- [A repo with long-lived version lines](#a-repo-with-long-lived-version-lines)

## Bring a repo under Renovate

Follow AGENTS.md "Onboarding a repo added later":

1. Make sure the Renovate app covers the repo.
2. Add `renovate.json` to the default branch, copied from a sibling repo. Add `baseBranchPatterns` if the repo
   integrates on `develop`.
3. Delete `.github/dependabot.yml`.
4. Align `.nvmrc` or `mise.toml` with the global Node line.
5. Run the repo's own audit gates once.
6. Enable Dependabot alerts in the repo settings.

Make every change in a scratch clone, through a PR. Before merging a config change, check it with Renovate's
local platform (AGENTS.md: "Verify a config change before merging it").

## Bot PRs have piled up

Use the [`pr-consolidation` skill](../../fleet/skill/README.md). It opens one PR per repo, superseding the open
Dependabot and/or Renovate PRs, with every CI audit gate green and majors deferred with analysis. It never
merges. The orchestrator verifies, merges, then handles the superseded PRs:

- **Dependabot:** close each with "Superseded by #N.".
- **Renovate:** leave them to autoclose.

## Merge

1. Re-run every audit tool right before merging; advisories land mid-rollout.
2. Get the head commit: `gh pr view <n> --json headRefOid`. You need the full 40-character ID.
3. Merge with `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`.
   - A develop→main release PR uses `--merge` and keeps `develop`.
   - A release-prep PR uses `--rebase`.
4. Admin merges and force-pushes are blocked for agents. Hand those to the owner as `! <command>`.

## After merging

The owner syncs local checkouts and tidies their branches (D34). Each recipe shows a plan; `--apply` asks, backs up, and writes a receipt. Agents run the plan only.

```sh
steward fleet sync ai/my-app                    # plan: what upstream moved, which local edits it already has
steward fleet sync ai/my-app --apply            # asks, backs up what it drops, fast-forwards
steward fleet sync ai/my-app --apply --replace .nvmrc   # also drop an edit you name that differs from upstream
steward fleet prune-merged ai/my-app            # plan: local branches whose PR merged
steward fleet prune-merged ai/my-app --apply    # asks, records each branch tip, deletes
```

- **What sync drops:** a local edit only where upstream changes the same path, and only when it matches upstream byte for
  byte, as JSON, or is already inside upstream (a 3-way merge gives upstream). A local delete that upstream also made, and an
  untracked file upstream now adds with the same content, count too. Anything that differs blocks the sync until you look at
  it and name it with `--replace`. Edits upstream doesn't touch stay.
- **What sync refuses:** a detached HEAD, a merge or rebase in progress, local commits, a diverged history, no upstream.
- **What prune-merged deletes:** a branch whose remote branch is gone, with a merged PR on GitHub, and no commit newer
  than the PR's head. Never the current or default branch, or one checked out in another worktree.
- **Undo:** a dropped edit is copied back from the backup named in the receipt; a deleted branch returns with
  `git branch <name> <tip>` (the tip is in the receipt).

## A repo with long-lived version lines

sindri is the reference: its `SECURITY.md` says which versions are supported. Follow AGENTS.md "Repos with
long-lived version lines":

- fix each line on its own branch, with no crossing streams;
- cut patch releases from `vN.M.x` branches;
- give every base branch a `renovate.json`;
- audit each branch;
- require checks that bind admins;
- follow the release checklist.
