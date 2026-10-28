# ai-tooling

A Claude Code skill for workstation-steward's AI tooling add-on (Ruflo, AgentDB, AQE, Brain, RuVector, launchers, guards). [`SKILL.md`](SKILL.md) is the skill itself; the procedures it
follows are in [`runbook.md`](runbook.md), and the qualification recipe in [`qualification.md`](qualification.md).

## Install

It ships with workstation-steward as part of its Claude Code skills (D48 in
[`docs/architecture.md`](../../docs/architecture.md#decisions)). Install it with `steward skills install` (from your own terminal). In a checkout of this repo, `just claude` loads it
as `/steward:ai-tooling`. Its read-only reports take an argument: `/steward:ai-tooling drift`.
