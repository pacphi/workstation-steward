# The briefing: `steward brief`

![Revision 1](https://img.shields.io/badge/Revision-1-green) ![Revised 2026-10-30](https://img.shields.io/badge/Revised-2026--10--30-green)

**One question, answered in under a second: what needs me, and what do I run next?** `steward brief` reads what is
already on your disk and names **one** next step, with its exact command. When nothing needs you, it says so in one
line.

```text
$ steward brief
steward config: 1 newer commit(s) on origin/main (as of 2026-10-30 09:12): supply-chain/hybrids.toml
next: steward config sync, then steward sc install-hybrids
+1 more: steward brief --all
```

> [!IMPORTANT]
> The briefing never fixes anything. It reads, and it tells you. Every command it names still shows its plan, asks for
> your yes, backs up first and writes a receipt.

## Why it exists

The pieces were already there: the `steward` banners, `steward review`, `steward check` and the receipts each command
writes. But they were spread out, some were slow, and none of them noticed when a step went wrong or ran out of
order. For example:

- the hybrids were installed **before** the config sync that brought their new versions;
- a promote stopped halfway and left a half-copied release behind;
- a config sync stopped with your edits set aside in `git stash`.

Each of these leaves evidence on disk. The briefing reads that evidence and names the step that finishes the job, or
the receipt's way back.

## What it reads

Everything is local. It uses no network and starts no slow scan.

| Source | Where |
| --- | --- |
| The soak | the receipts under `[paths] state` (the same as `steward sc soak`) |
| Your config repo | `git status` and the commits GitHub has, **as of the last fetch** (`steward review` fetches) |
| The npm -g hybrids | each receipt in `<state>/hybrids/` against `supply-chain/hybrids.toml` |
| The shared AQE runtime | what `current` points at, the `releases/` folder and `[aqe]` in `ai-tooling/ai-tooling.toml` (AI tooling add-on) |
| Every receipt and backup | `<state>/backups/*` |
| Projects behind the AI tools | what the last full `steward projects reconcile --all` noted (it never plans again) |
| The release-age gate | the queue the last `steward review` saved |
| The weekly review | when the last one ran |

It writes nothing, not even a record of its own run.

### Old caches wait

Two of these are caches another command wrote: the gate's queue (`steward review`) and the projects behind (the last
full `steward projects reconcile --all`). When a cache is older than `stale_hours`, its finding says "as of" when it
was written, and it becomes a **wait**: it is shown, but it is never the next step. Run the command that writes it to
bring it up to date. Set the number in your `steward.toml`; `0` means a cache never goes stale:

```toml
[brief]
stale_hours = 48    # the default
```

A finding that compares today's installs, such as "aqe changed since the last reconcile check", is read now, so it
never goes stale.

## What it checks

Each check is a **detector**. A detector looks at what was read and either finds something or stays quiet. Each has a
**severity**, which sets the order:

- **fix**: a step stopped midway or broke. These come first.
- **act**: something is out of step, and other steps wait on it.
- **do**: routine work.
- **wait**: nothing for you to do yet. A wait is never the next step.

| Detector | Severity | What it catches | What it names |
| --- | --- | --- | --- |
| `receipt-unfinished` | fix | A receipt still marked unfinished, at least 15 minutes old | The recovery for its kind. A config sync gets `steward config sync` and where your set-aside edits are, never `--rollback` (that refuses an unfinished sync) |
| `backup-no-receipt` | fix | A backup folder a steward command made, with no receipt. Hand-made backups and Ruflo policy backups are left alone | For a promote that stopped after the store backup: promote again |
| `aqe-partial` | fix | `releases/<r>.partial` in the AQE runtime | Remove it, then promote again |
| `repin-unfinished` | fix | Maintainers only: the release channel isn't at the commit the last repin receipt names | Finish the repin, or its rollback |
| `aqe-vs-policy` | act | AQE promoted but `ai-tooling.toml` not updated, or the other way round | The matching step: update the policy, promote, or qualify first |
| `hybrid-vs-policy` | act | A hybrid behind, ahead of or missing from `hybrids.toml`, or GitHub has a newer `hybrids.toml` | `steward sc install-hybrids`, after the config sync when one is waiting |
| `config-behind`, `config-changed`, `config-ahead`, `config-pr` | act, do | Your config repo: newer on GitHub (with the files that changed), changed here, not pushed, or a pull request waiting | `steward config sync` |
| `soak` | do, wait | The soak ended, so old installs can be pruned (or it is still running: wait) | The prune, after any hybrid is back in step |
| `projects-behind` | do | Projects behind the qualified AI tools | `steward projects reconcile --all` |
| `gate-cleared` | do | Updates the gate held that have cleared it since the last review | `steward review` |
| `review-due` | do | The weekly review is due | `steward review` |

A started step is not called unfinished for its first 15 minutes, since it may still be running. A stopped run that a
later run of the same command finished is history, and isn't shown.

### Steps that wait on another

Some steps only make sense after another. A detector can say so with `after`. When both are found, the later one is
folded into the earlier as "then …", so you see one line in the right order:

```text
config-behind  ←  hybrid-vs-policy  ←  soak
next: steward config sync, then steward sc install-hybrids, then DRY_RUN=1 steward sc prune, then steward sc prune
```

- **Sync before install.** If GitHub has a newer `hybrids.toml`, installing first would install the old policy.
- **Install before prune.** `steward sc prune` refuses until every hybrid has a matching receipt.

## Output

| Command | What you get |
| --- | --- |
| `steward brief` | At most three lines: what happened, `next: <command>`, and `+N more` when there is more. One quiet line when nothing needs you |
| `steward brief --all` | Every finding, each with its command and why |
| `steward brief --json` | The same as data: `{v, at, next, more, findings}` |

`more` counts the findings besides `next`; when `next` is null, they are all waits. Each finding has an `id`, a
`severity`, a stable `key` (it changes only when what it points at changes), the `text`, the
`cmd`, `writes` (true when the command can change your machine, projects or config; it still asks first), the `skill`
that covers it, `why`, and a `rollback` when there is one. Text taken from receipts and paths is cleaned before it is
shown: no control characters or escape codes, your home folder as `~`, and at most 200 characters.

For Claude Code, the engine can also wrap the data in a `<steward-brief v="1">…</steward-brief>` block, with three
short rules: offer the finding's skill, show its command exactly, and never run a command with `writes: true` without
your yes. Nothing hands that block to Claude yet.

## Adding a detector

A command that writes should be able to say when it stopped halfway. So **a new command that writes adds a detector
for its half-finished states**, with a test (`AGENTS.md`).

1. Write down the evidence the command leaves when it stops midway: a receipt field (`complete: false`,
   `outcome: "started"`), a folder, a link.
2. If `facts()` in `lib/brief.js` doesn't read it yet, add the read there. Reads only: local files and local `git`,
   no network, no plans that walk every project.
3. Add an entry to `DETECTORS`: an `id`, a `severity`, any `after`, and `check(facts)`. It returns nothing, one
   finding or a list. For an unfinished receipt, add its kind to `recover()` instead.
4. In `test/brief.test.js`, build the facts with the field names the real receipt uses, and show the detector both
   finding it and staying quiet.
