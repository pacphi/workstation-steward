---
name: fix
description: >
  Turns what the steward found into done work. Works the steward's work list (`steward brief --plan`, or the items
  of a `steward review --json`) top down through `steward fix`: runs the steps the user's [autonomy] level lets run
  unattended, asks the user for each step that needs a yes, hands over the steps only the user can take (merges,
  sudo, trust stores, anything by hand) as exact commands, stops at the first failure with its rollback, and ends
  with one summary. Independent items (a fleet repo's bot PRs, a sandbox qualification) can go to sub-agents. Use
  when the user says "fix it", "do what's next", "work the list", "handle what the review found", or when a
  `<steward-brief>` names this skill.
argument-hint: "[review]"
allowed-tools: Bash(steward brief) Bash(steward brief *) Bash(steward config)
metadata:
  author: pacphi
  version: "1.0"
  license: MIT
---

# fix

Work the steward's list for the user. The engine decides who takes each step (its `actor`, D58), not you, and
`steward fix` only ever runs `steward` commands. You never run a step's command yourself: you run `steward fix`, and
it runs the step.

## 1. Get the list and show the plan

- With no arguments: `steward fix --json`. It reads `steward brief --plan` and prints each step with `plan.how`.
- With `review`: `steward review --json > <scratch file>`, then `steward fix --from <scratch file> --json`. The review
  reads GitHub and takes minutes; say so first.

Show the user the plan, grouped by `plan.how`, in plain words:

| `plan.how` | What happens |
| --- | --- |
| `run` | runs with no question: read-only, or a class their `[autonomy]` level allows |
| `ask` | you ask them, one step at a time; on a yes it runs |
| `terminal` | they run it in their own terminal: it asks its own questions there |
| `yours` | theirs to do: you hand it over |
| `skill` | you take it, below: a maintainer flow, a qualification or a fleet repo |
| `wait` | nothing to do yet |

Then ask once whether to start. The reply's `subagents` is how many sub-agents you may run at once.

## 2. Run what is allowed

`steward fix --apply --json`. It works the list in order, skips a step whose `after` didn't get done, and stops at the
first failure. Each step's output streams on stderr; the summary is on stdout, with every receipt it wrote.

## 3. Ask for each step that needs a yes

For each result with `outcome: "waiting"` whose `why` names `steward fix --apply --only <id> --yes-to <class>`: ask
the user with the question tool, **one step at a time**. Say what it does, the command, the class, and that it plans,
backs up and writes a receipt. Recommend yes or no on cost, time and risk. On a yes, run exactly the command `why`
names, and nothing wider. On a no, leave it in the summary.

## 4. Hand over what is theirs

For `yours` and `terminal` steps, one block: each exact command, which terminal to run it in (Terminal.app for
`sudo` and trust-store changes, which need a password prompt), and what output to expect. Then wait for them.

## 5. The skill's own steps, and sub-agents

- **`/steward-maintain …`** (the maintainer's flows): only on the maintainer's own machine, where their rules allow
  it. A class says only that no yes is needed; it doesn't make the step due. Repin only when the maintainer asked
  for it in their message.
- **A sandbox qualification** (`…/qualify/aqe/run.sh <version> build`) and **a fleet repo with bot PRs or alerts**
  (the `pr-consolidation` skill): independent of each other, so each may go to a sub-agent, at most `subagents` at
  once. Shared state (mise, the config repo, the release channel) stays with you, one step at a time.

Every sub-agent's brief carries these rules, word for word:

- Work in a fresh clone in a scratch folder, or a copy made with `cp -RL`, never `cp -R`: the config folder can be a
  symlink. Check `realpath` of every folder you write before writing it.
- Use a scratch `XDG_STATE_HOME` and set `STEWARD_NO_REFRESH=1`.
- Run no writing command without `DRY_RUN=1` first.
- Don't push, open a PR or merge: a prepared PR is `pr-prep`; pushing it is `push`, which asks the user per repo.
- Report how you checked that nothing outside the scratch folder changed.

Read each sub-agent's diff yourself and rerun its checks before you tell the user it passed.

## 6. Summary

End with one summary, in four parts: done (with each receipt), waiting on the user (with the command each needs),
failed (with its rollback, from the result), and what's next. Then run `steward brief` again: the list you worked is
out of date now.

## Never

- Run a step's command yourself, or a shell command a step names (`rm`, `mv`, `git`): `steward fix` runs steps.
- Pass `--yes-to` for a class the user didn't say yes to in this conversation, or for more than the one step.
- Retry a failed step with other flags, or work around a refusal (exit 4): those are the user's call.
- Take a `yours` step for the user, even with their yes: merges, sudo, trust stores and dashboard ticks are theirs.
