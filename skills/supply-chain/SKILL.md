---
name: supply-chain
description: >
  Keeps this machine's software supply chain current within policy: the mise toolchain, npm -g hybrids,
  Homebrew formulae and casks, apps (Electron support window), the App Store, macOS, trust stores, Docker
  images, indicators of compromise and known vulnerabilities (OSV, nodejs.org, CISA KEV). Audits read-only, previews and applies age-gated upgrades (3-day
  release age, majors deliberate, advisory exceptions with expiry), patches Node security releases, handles
  Renovate PRs for the toolchain, verifies, prunes and rolls back. Use when asked "what needs updating",
  "audit the machine", "what would an upgrade take", "apply the upgrades", "a Node security release is out",
  "handle this Renovate PR", "is this advisory a problem here", "is anything I have vulnerable", "any known CVEs
  in my tools", "check my tools against OSV", or "roll back the last upgrade".
argument-hint: "[audit | plan | status | verify | vulns] [flags]"
allowed-tools: Bash(steward sc audit) Bash(steward sc audit *) Bash(steward sc vulns) Bash(steward sc vulns *) Bash(steward sc plan) Bash(steward sc plan *) Bash(steward sc verify) Bash(steward config) Bash(steward config *)
metadata:
  author: pacphi
  version: "2.1"
  license: MIT
---

# supply-chain

Run the supply-chain area of workstation-steward. The procedures are in the runbook beside this file,
`${CLAUDE_SKILL_DIR}/runbook.md` ([`runbook.md`](runbook.md)). This skill says how to behave while following it; it
doesn't restate it.

If the session's context holds a `<steward-brief>` whose `next.skill` is this skill, start from its `next`; show the
plan (`DRY_RUN=1`) before any write. A step that stopped midway is in the runbook's Finishing a half-done step
(`runbook.md#finishing-a-half-done-step`).

## Where things are

All commands are `steward sc …`; `steward sc` lists them. The user's policy lives in their config folder, which
`steward config` names: `steward.toml`, `supply-chain/host.toml`, `supply-chain/hybrids.toml` and `mise/`. Paths in
the runbook such as `supply-chain/host.toml` are relative to that folder.

## Read-only reports

With arguments that name a read-only command, run `steward sc $ARGUMENTS` first and report it as below. Other
arguments are the request itself.

- **`audit`:** put any ALERT (an indicator of compromise matched) first, as a stop-and-investigate item. Then group
  the ACTION lines by kind: Homebrew, browsers, other apps, App Store, macOS, Docker.
- **`plan`:** list what would be taken, then what's held (too young, with when it clears), skipped (majors and 0.x
  minors), `ai` lines (owned by AI tooling) and manual items.
- **`status` and `verify`:** summarize what's outdated or failing, with its output.
- **`vulns`:** known-exploited findings first, then the other ACTION lines: a tool's own advisory (with the command
  that takes its fix), then each tool whose packages carry serious ones (its next release fixes them; `--verbose`
  lists them). Link each advisory (osv.dev). Say plainly what was **not checked** (a feed with no answer) and what
  is **not covered** (the coverage lines): neither is clean. Say where to look for what isn't covered
  (the runbook's Known vulnerabilities, step 5). A **malicious package** (`MAL-`) goes first of all. Name a tool AI tooling owns as the `ai-tooling`
  skill's. Lower findings and silenced ones (`advisory_ignore`, with their expiry) go last, in one line each. Then
  offer the next step: `steward sc vulns-fix` (its plan) when a line names a fix or an old install, or
  `steward sc isolate <tool>` when a line suggests it.

End with the next step the user might want, and don't take it without their yes.

## What needs approval

| Step | Approval |
| --- | --- |
| Read-only commands: `audit`, `plan` (its old name `status` still works), `verify`, `vulns`, `DRY_RUN=1 …` | Not needed. Run them freely and report what they show. |
| Changing commands: `upgrade`, `upgrade-tool`, `node-patch`, `install-hybrids`, `retire-hybrid`, `prune`, `rollback`, `link`, `vulns-fix`, `isolate` | Show the dry run (for `vulns-fix` and `isolate`, the run without `--apply`) and get the user's yes for *that* step. An approval covers one step, not the next. Each asks its own [y/N], which gets no answer from your shell: after the user's yes, run `sc upgrade`, `node-patch`, `install-hybrids`, `prune`, `vulns-fix --apply` or `isolate … --apply` with `--unattended --yes-to <its class>` (`steward help <command>` names it); hand the others to the user's terminal. On Linux, an `sc upgrade` with apt updates ends "waiting on you" (exit 4) with a `sudo` line: hand the user that exact line for their own terminal, then run `steward sc upgrade --resume` (D76). Never run sudo yourself. |
| `steward upgrade`: a Node security release (`sc node-patch`) or hybrids out of step (`sc install-hybrids`) when there is one, then `sc upgrade`, with one yes | Show `DRY_RUN=1 steward upgrade` (every part's plan) and ask once. After the user's yes: `steward upgrade --unattended --yes-to upgrade`, adding `--yes-to node-patch` or `--yes-to install-hybrids` only when the plan shows that part. |
| Commit, push, PR, merge | Ask first. Merging uses the full 40-character head SHA. |
| Policy edits (`host.toml` exceptions, IOCs, distrusted roots, trust excludes, `advisory_ignore`, `advisory_feed`, `[vulns]`) | Show the entry and its primary-source evidence, then ask. |
| Trust-store changes, `sudo`, admin settings | Hand to the user to run in Terminal.app. |

Present decisions one at a time, with about 3 options, the strongest first and marked "(Recommended)".

## Never

- `mise upgrade node`: use `steward sc node-patch`. Never `mise upgrade` without `--no-prune`.
- Plain `npm doctor`. Never edit `~/.config/mise/config.toml` by hand: it's a link into the config folder
  (`steward sc link`).
- Upgrade AI-owned tools here. `plan` shows them as `ai` lines; they belong to the `ai-tooling` skill.
- Add launchd or cron jobs. Everything is on demand, and GitHub (Renovate) is the source of record.
- Claim success without a check that ran. Report failures with their output.

## Procedures

Follow the runbook section that matches the request:

- "what needs updating" or "audit": Routine check (`runbook.md#routine-check`), then Apply eligible upgrades
  (`runbook.md#apply-eligible-upgrades`) if asked;
- a Renovate PR: A Renovate PR arrives (`runbook.md#a-renovate-pr-arrives`);
- a Node security release: A same-day Node security release (`runbook.md#a-same-day-node-security-release`);
- "is anything vulnerable", "any known CVEs": Known vulnerabilities (`runbook.md#known-vulnerabilities`);
- an advisory or incident: A new advisory or incident report (`runbook.md#a-new-advisory-or-incident-report`).
  Verify against primary sources before acting;
- a trust exception, pruning or rollback: the sections of those names.

## Done when

- The user has seen what the read-only commands reported.
- Each change they approved was applied and followed by a passing `steward sc verify`.
- Any change under the config folder's `mise/` is committed, or the user was asked about committing it.
- Anything held, skipped or manual is listed with its reason.
