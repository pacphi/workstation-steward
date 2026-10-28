# projects

A Claude Code skill for workstation-steward's projects add-on (discovery under the project roots, the registry, decisions). [`SKILL.md`](SKILL.md) is the skill itself; the procedures it
follows are in [`runbook.md`](runbook.md).

## Install

It ships with workstation-steward as part of its Claude Code skills (D48 in
[`docs/architecture.md`](../../docs/architecture.md#decisions)). Install it with `steward skills install` (from your own terminal). In a checkout of this repo, `just claude` loads it
as `/steward:projects`. Its read-only reports take an argument: `/steward:projects scan` or `list`.
