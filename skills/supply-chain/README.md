# supply-chain

A Claude Code skill for workstation-steward's supply chain (mise, Homebrew, apps, App Store, macOS, trust stores, Docker, IOCs). [`SKILL.md`](SKILL.md) is the skill itself; the procedures it
follows are in [`runbook.md`](runbook.md).

## Install

It ships with workstation-steward as part of its Claude Code skills (D48 in
[`docs/architecture.md`](../../docs/architecture.md#decisions)). In a checkout of this repo, `just claude` loads it
as `/steward:supply-chain`. Its read-only reports take an argument: `/steward:supply-chain audit`, `plan`, `status` or `verify`.
