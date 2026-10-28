---
name: supply-chain-steward
description: >
  Keeps this Mac's software supply chain current within policy: the mise toolchain, npm -g hybrids,
  Homebrew formulae and casks, apps (Electron support window), the App Store, macOS, trust stores, Docker
  images and indicators of compromise. Audits read-only, previews and applies age-gated upgrades (3-day
  release age, majors deliberate, advisory exceptions with expiry), patches Node security releases, handles
  Renovate PRs for the toolchain, verifies, prunes and rolls back. Use when asked "what needs updating",
  "audit the machine", "apply the upgrades", "a Node security release is out", "handle this Renovate PR",
  "is this advisory a problem here", or "roll back the last upgrade".
metadata:
  author: pacphi
  version: "1.0"
  license: MIT
---

# supply-chain-steward

Run the supply-chain area of workstation-steward. The procedures are in
`docs/supply-chain/runbook.md`, and the owner's rules are in
`AGENTS.md`. This skill says how to behave while following them; it doesn't restate them.

## Where to run

Paths in this skill are relative to the workstation-steward checkout. A session started in that repo is
already there; the skill loads from its `.claude/skills/`. From anywhere else (a personal install), move into
the checkout first:

```sh
cd "$(dirname "$(readlink -f ~/.claude/skills/supply-chain-steward/SKILL.md)")/../.."
```

All commands are `steward sc …`. `steward sc` lists them.

## What needs approval

| Step | Approval |
| --- | --- |
| Read-only commands: `audit`, `plan`, `status`, `verify`, `DRY_RUN=1 …` | Not needed. Run them freely and report what they show. |
| Changing commands: `upgrade`, `upgrade-tool`, `node-patch`, `install-hybrids`, `retire-hybrid`, `prune`, `rollback`, `link` | Show the dry run and get the owner's yes for *that* step. An approval covers one step, not the next. |
| Commit, push, PR, merge | Ask first. Merging uses the full 40-character head SHA. |
| Policy edits (`host.toml` exceptions, IOCs, distrusted roots, trust excludes) | Show the entry and its primary-source evidence, then ask. |
| Trust-store changes, `sudo`, admin settings | Hand to the owner to run in Terminal.app. |

Present decisions one at a time, with about 3 options, the strongest first and marked "(Recommended)".

## Never

- `mise upgrade node`: use `steward sc node-patch`. Never `mise upgrade` without `--no-prune`.
- Plain `npm doctor`. Never edit `~/.config/mise/config.toml` by hand: it's a symlink into this repo.
- Upgrade AI-owned tools here. `plan` shows them as `ai` lines; they belong to the `ai-tooling-steward` skill.
- Add launchd or cron jobs. Everything is on demand, and GitHub (Renovate) is the source of record.
- Claim success without a check that ran. Report failures with their output.

## Procedures

Follow the runbook section that matches the request:

- "what needs updating" or "audit": Routine check (`docs/supply-chain/runbook.md#routine-check`), then
  Apply eligible upgrades (`docs/supply-chain/runbook.md#apply-eligible-upgrades`) if asked;
- a Renovate PR: A Renovate PR arrives (`docs/supply-chain/runbook.md#a-renovate-pr-arrives`);
- a Node security release: A same-day Node security
  release (`docs/supply-chain/runbook.md#a-same-day-node-security-release`);
- an advisory or incident: A new advisory or incident
  report (`docs/supply-chain/runbook.md#a-new-advisory-or-incident-report`). Verify against primary
  sources before acting;
- a trust exception, pruning or rollback: the sections of those names.

## Done when

- The owner has seen what the read-only commands reported.
- Each change they approved was applied and followed by a passing `steward sc verify`.
- Any `mise/` change is committed, or the owner was asked about committing it.
- Anything held, skipped or manual is listed with its reason.
