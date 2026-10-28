---
name: ai-drift
description: "Read-only AI-tooling drift: the machine and every project's AI tooling against ai-tooling.toml and each project's chosen tools. Runs `steward ai drift` and summarizes it; changes nothing."
disable-model-invocation: true
allowed-tools: Bash(steward ai drift) Bash(steward ai drift *)
argument-hint: "[flags]"
---

Run `steward ai drift $ARGUMENTS` from the root of this repo. It's read-only.

Summarize DRIFT first, then WARN, grouped by area (AQE runtime and PATH, hybrids, guards, upstream, watched threads, projects). For projects, group by kind of finding with counts and name a few examples, rather than listing every line.

End with the next step the owner might want. Don't take it. Anything that changes state belongs to the
`ai-tooling-steward` skill and its runbook, one approved step at a time.
