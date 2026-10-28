---
name: sc-plan
description: "Read-only upgrade plan: what `steward sc upgrade` would take, and what's held, skipped, AI-owned or manual, and why. Runs `steward sc plan` and summarizes it; changes nothing."
disable-model-invocation: true
allowed-tools: Bash(steward sc plan) Bash(steward sc plan *)
argument-hint: "[flags]"
---

Run `steward sc plan $ARGUMENTS` from the root of this repo. It's read-only.

List what would be taken, then held (too young, with when it clears), skipped (majors and 0.x minors), `ai` lines (owned by AI tooling) and manual items.

End with the next step the owner might want. Don't take it. Anything that changes state belongs to the
`supply-chain-steward` skill and its runbook, one approved step at a time.
