---
name: projects-scan
description: "Read-only scan of ~/Development: new projects not in the registry, and registered ones no longer on disk. Runs `steward projects scan` and summarizes it; changes nothing."
disable-model-invocation: true
allowed-tools: Bash(steward projects scan) Bash(steward projects scan *)
argument-hint: "[flags]"
---

Run `steward projects scan $ARGUMENTS` from the root of this repo. It's read-only.

List the new projects by kind, with their parent for worktrees and submodules, and which AI tools each already shows; then any vanished ones.

End with the next step the owner might want. Don't take it. Anything that changes state belongs to the
`projects-steward` skill and its runbook, one approved step at a time.
