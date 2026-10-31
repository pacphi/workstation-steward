# fix

**From "here's what needs you" to done.** `/steward:fix` works the steward's list for you: what `steward brief`
found, or everything a `steward review` turned up. It runs what your `[autonomy]` level lets run, asks you about the
rest one step at a time, hands you the steps only you can take, and stops at the first failure with its way back.

```text
you:    fix it
Claude: 4 steps. 2 run on their own (a config sync pull, a reconcile), 1 needs your yes (deleting merged branches),
        1 is yours (a merge on GitHub). Start?
```

## How it works

The skill drives one engine command, `steward fix`. That command only ever runs `steward` commands. A step's shell
command (`rm`, `mv`, `git`) is never run for you; it's handed to you.

| Step | What happens |
| --- | --- |
| Read-only, or a class your level allows | It runs, with `--unattended`; its receipt says so |
| A change that needs your yes | Claude asks you; on a yes it runs that one step (`--only <id> --yes-to <class>`) |
| A command that asks its own questions | You run it in your terminal (or `steward fix --apply` there asks you) |
| A merge, `sudo`, a trust store, anything by hand | Yours: the exact command, and which terminal |
| A fleet repo's bot PRs, a sandbox qualification | The skill may hand each to a sub-agent; nothing is pushed without your yes |

Every step still plans, backs up and writes a receipt. `steward fix` keeps a record of the run, with each step's
log, under `<state>/backups/fix-<time>/`.

## In a terminal

`steward fix` shows the plan. `steward fix --apply` works it and asks at the terminal for each step that needs you.
`steward fix --from <file>` works a list `steward review --json` saved.

The levels, the classes and `--unattended` are in
[the briefing guide](https://github.com/pacphi/workstation-steward/blob/main/docs/briefing.md#who-does-each-step).
