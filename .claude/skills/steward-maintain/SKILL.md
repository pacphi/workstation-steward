---
name: steward-maintain
description: >
  The engine maintainer's routine after pull requests merge, run on the owner's behalf: bring the engine checkout in
  step (fast-forward main, delete merged branches), watch a release until npm lists it and verify what was published
  (npm latest, provenance commit = the tag's, GitHub release), repin `steward` to a verified release with a backup and
  a receipt, and take the config repo's merged changes with steward config sync. Each flow is a script that prints its
  plan, refuses anything outside its scope, and stops on any failed check. Use when the owner says "I merged #N",
  "pull and clean up", "watch the release", "repin", "sync the config", or runs /steward-maintain.
argument-hint: "[merged <pr>… [repin]] [release <X.Y.Z>] [repin <X.Y.Z>] [config] [fix]"
allowed-tools: Bash(steward brief --json) Bash(steward-dev brief --real --json) Bash(.claude/skills/steward-maintain/bin/status.sh) Bash(.claude/skills/steward-maintain/bin/after-merge.sh) Bash(.claude/skills/steward-maintain/bin/after-merge.sh *) Bash(.claude/skills/steward-maintain/bin/release.sh *) Bash(.claude/skills/steward-maintain/bin/repin.sh *) Bash(.claude/skills/steward-maintain/bin/config-sync.sh)
metadata:
  author: pacphi
---

# /steward-maintain

The maintainer's routine for this repository, run from the engine checkout. Each flow is a script in `bin/`. They are
authorized by the owner in their own rules (the owner's private `AGENTS.md`, "Maintainer flows"); without that, run
nothing here and hand the owner the command instead.

## Reading the arguments

The arguments are a short sentence: `$ARGUMENTS`. Run the flows it names, in this order, and stop at the first failure.

| Words | Flow |
| --- | --- |
| *(none)* | `steward brief --json` first (a release before 0.10.0 has no `brief`: then `steward-dev brief --real --json`), then `bin/status.sh`. Lead with the brief's `next`, then suggest the next command in this table |
| `merged <pr>…` | `bin/after-merge.sh <pr>…`. Each line `release: X.Y.Z` it prints means a release PR merged: go on to `release` for X.Y.Z |
| `release <X.Y.Z>` | `bin/release.sh X.Y.Z` (it waits up to 40 minutes: run it in the background and wait to be told it finished) |
| `repin`, with a version or after a `release:` line | `bin/repin.sh X.Y.Z --why "<the owner's whole message>"`, only after `release.sh` verified X.Y.Z |
| `config` | `bin/config-sync.sh` |
| `fix` | Work the list: `steward fix --json` (a release before 0.10.0 has none: `steward-dev fix --real --json`), then the fix skill's steps (`/steward:fix`) with `--apply`. A step it hands back as `/steward-maintain merged`, `release` or `config` runs as that flow here; `repin` only when this message asks for it. Every other step is the owner's usual ask |

So `/steward-maintain merged 41 39 repin` is: after-merge for #41 and #39; #39 printed `release: 0.4.1`, so release.sh
0.4.1; it verified, and the owner said `repin`, so repin.sh 0.4.1. Without `repin`, stop after the release verifies and
say it's ready to repin.

| Script | What it may change |
| --- | --- |
| `status.sh` | nothing |
| `after-merge.sh [<pr>…]` | the engine checkout: fast-forwards `main`, deletes merged branches, prunes worktree records |
| `release.sh <X.Y.Z> [--verify-only]` | nothing (it waits and verifies) |
| `repin.sh <X.Y.Z> --why "…"` | the release channel (`~/.local/share/workstation-steward/release`) and the two launchers, after a backup |
| `config-sync.sh` | the config checkout: a fast-forward, or finishing a merged send; `mise install` when `mise/` changed |

When the brief's `next.skill` is `steward-maintain`, a repin stopped midway:

- `repin-unfinished`: the release channel isn't at the commit the last repin receipt names. Finish it with
  `bin/repin.sh <tag>` (only if the owner asks in this message), or hand the owner the receipt's rollback.
- `backup-no-receipt` for a repin: `steward version` shows which release runs; then repin again, or copy the launchers
  back from the backup the finding names.

## Reporting

Read all of each script's output: it prints the plan of every steward command before it answers that command's
`[y/N]`. Then tell the owner, in plain words, what moved, the receipt or backup path, and the rollback a step printed.

**A failure stops the flow.** Report it with its output. Don't retry with other flags, don't run the underlying
command by hand, and don't work around a refusal: those are the owner's call.

## Never, in any flow

- `git reset`, `rebase`, `merge`, `commit`, `push --force`, or deleting a branch with work that isn't merged.
- A repository other than this engine checkout and the config instance `steward config` names.
- A repin the owner didn't ask for in this message, or to a release `release.sh --verify-only` hasn't verified.
- Sending local config edits (`steward config sync` with `send` in its plan): that opens a PR, so it stops for the owner.

Everything else, including any command these scripts don't run, still goes through the owner's usual ask.
