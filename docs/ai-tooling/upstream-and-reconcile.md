# Upstream fixes and reconciliation

![Revision 6](https://img.shields.io/badge/Revision-6-green) ![Revised 2026-10-30](https://img.shields.io/badge/Revised-2026--10--30-green)

How the AI tooling add-on keeps three things in step as Ruflo, AQE (agentic-qe) and RuvNet Brain release: the
upstream packages, the versions qualified on your machine, and the copies inside each onboarded project. It covers
what happens today, how an upstream fix retires a local patch, what `steward projects reconcile` adds, and what can go
wrong with each. The decision behind it is D42 in [`../architecture.md`](../architecture.md#decisions); the
procedures are in [`runbook.md`](../../skills/ai-tooling/runbook.md); the qualification recipe in [`qualification.md`](../../skills/ai-tooling/qualification.md).

## Contents

- [What reconcile does to your project, in plain words](#what-reconcile-does-to-your-project-in-plain-words)
- [Three layers that change at different speeds](#three-layers-that-change-at-different-speeds)
- [What happens today](#what-happens-today)
- [From an upstream ask to a retired patch](#from-an-upstream-ask-to-a-retired-patch)
- [What reconcile adds](#what-reconcile-adds)
- [Challenges and mitigations](#challenges-and-mitigations)
- [Where things stood on 2026-10-27](#where-things-stood-on-2026-10-27)

## What reconcile does to your project, in plain words

**What the files are.** When a project uses Ruflo or AQE, its `.claude/` folder holds files Claude Code reads every
time you work there:

| Kind | What it is |
| --- | --- |
| agents | instructions for sub-agents (`code-review-swarm`, `qe-test-generator` …) |
| commands | your `/slash` commands |
| skills | how-to guides Claude loads when a task calls for one |
| helpers | small scripts your hooks and statusline run |

**Why they go stale.** They were copied in once: by `steward projects onboard`, or earlier by `ruflo init`,
`claude-flow init` or `aqe init`. Nothing updates them afterwards, while the Ruflo and AQE on your machine move on.
The old text can describe commands, flags and behavior the installed tools no longer have.

```text
 an older Ruflo / AQE  ──copied once──►  your-project/.claude/   ◄── frozen since then
 the Ruflo / AQE you run now  ──reconcile──►  the same files, at the version you actually run
```

**What reconcile changes.** Only those files, and only ones nobody edited: copies the steward wrote and you haven't
touched, and copies identical to a file some published release shipped. From your next Claude Code session in the
project, Claude reads the newer instructions and the hooks run the newer helpers.

**What it never changes:**

- files you edited: kept, and listed with `--diff <unit>` to see the difference and `--take <unit>` to update one anyway;
- your settings (`settings.json`, `.mcp.json`, the Codex config);
- anything Git tracks: those would go through a pull request, so in practice `git status` looks the same afterwards.

**Safety.** It shows the plan and asks first. Every file it replaces is copied to a backup, and one command puts them
all back: `steward projects reconcile --rollback <receipt>`.

**How urgent it is.** It's housekeeping, not a fix. Nothing breaks if you wait, but the gap grows with every release.
A good time is right after a new Ruflo or AQE version is promoted (the `steward` banner says so). To look before you
apply, run `steward projects reconcile <path>`, then `--diff <unit>` on a file you care about.

**An example.** The first real run (sindri, 2026-10-27) updated 110 files: 72 commands, 15 agents, 15 skills and 8
helpers, most copied by Ruflo releases 3.0 to 3.37. It kept the 4 that had been customized, and the repo's
`git status` didn't change.

## Three layers that change at different speeds

```text
 1 UPSTREAM                    2 YOUR MACHINE (qualified)            3 EACH ONBOARDED PROJECT
 ┌───────────────────┐  gate  ┌──────────────────────────────┐ onboard ┌───────────────────────────────┐
 │ npm releases of   │ 3 days │ AQE: the shared runtime,     │ copies  │ .claude/helpers, skills,       │
 │  agentic-qe       │ ─────► │  stock + any local patches   │ ──────► │  commands, agents              │
 │  ruflo            │qualify │ Ruflo: the qualified install │ settings│ AQE's aqe-hook.cjs and         │
 │  ruvnet-brain     │        │ Brain: the pinned package    │ keys    │  brain-checkpoint.cjs          │
 └─────────▲─────────┘        │ + the steward's hook         │         │ settings.json, .mcp.json,      │
           │ issues, PRs      │   transport (AQE_HOOK_BUNDLE)│         │  .codex/config.toml launchers  │
           └───────────────── └──────────────────────────────┘         └───────────────────────────────┘
             fixes come back in a release;              reconcile keeps layer 3 in step with layer 2
             a local patch then retires
```

- **Layer 1, upstream,** releases often: Ruflo about weekly, AQE several times a month.
- **Layer 2, your machine,** moves only after the release-age gate and a qualification ([`qualification.md`](../../skills/ai-tooling/qualification.md)),
  with a backup and a way back.
- **Layer 3, each project,** holds what onboarding copied in: files and folders from the qualified installs, and keys
  merged into its settings and launcher files. **Reconciliation** keeps layer 3 in step with layer 2 after layer 2
  moves.

## What happens today

| | AQE | Ruflo | Brain |
| --- | --- | --- | --- |
| **On the machine** | A shared runtime under `{{AI_TOOLING_ROOT}}/aqe`: stock AQE plus any local patches (`ai-tooling/qualify/aqe/patches/`), installed into `releases/<version>` behind a `current` link, so rolling back is relinking | The qualified install, with only the qualified install scripts allowed; every policy folder is backed up before a version change, because its first write migrates the policy state | The pinned package; the AI tooling area owns it, so Renovate opens a PR only on dashboard approval. Its knowledge-base update is deferred and never run by an agent |
| **A new version gets in by** | `ai-tooling/qualify/aqe`: re-fit each patch (`git apply --check`), build, gates G1–G8 in a sandbox, back up the stores, `promote.sh` | reading the source changes, the policy backup, a pilot project, then the install | bumping the pin after the gate |
| **Projects reach it through** | one steward-owned **hook transport** (`AQE_HOOK_BUNDLE`), so no project holds the runtime; projects hold copies of AQE's two hook files and its skills, commands and agents | copies of its helpers (the full set plus `.LOCKED`), skills, commands and agents, and settings keys (hooks, the daemon off, auto-update off) | a Codex server launcher and its approvals (`ruvnet_cli_run` must prompt, D37) |

**What keeps a project current today:**

- `steward ai drift` reports differences; `steward projects profile-check` gives the reason for each.
- `steward projects onboard` **adds** what's missing: new names in a copied folder, new keys in a settings file.
- A file already in a project is **never updated**, with two exceptions: AQE's hook files when their hash is a known,
  unedited vendor copy (D25), and any file you name with `--refresh`.
- Settings values whose meaning changed get a dedicated fixer each: `steward ai timeouts` (milliseconds written into a
  seconds field, D36), `steward ai approvals` (D37), `steward projects onboard --replace-older` (older hook forms).

**What onboarding leaves:** when a new Ruflo or AQE version changes a file the steward copied into a project earlier,
onboarding doesn't update that copy, and drift only says it differs. `steward projects reconcile` closes that gap.

## From an upstream ask to a retired patch

```text
 problem found ──► upstream issue or PR ──► local patch, listed in [[watch]] ──► the fix ships in a release
                                                   │                                    │
                                                   │ every qualification re-fits each   │ the 3-day gate; then the whole
                                                   │ patch: one upstream made redundant │ version is qualified, not just
                                                   │ no longer applies, and is dropped  │ the fix
                                                   ▼                                    ▼
                                           no patches left? ──► [[retire]] runs its steps:
                                                                stock install instead of the custom runtime,
                                                                launchers repinned, the transport removed
```

1. **Report it upstream** with a reproduction: an issue, or a PR when the fix is clear. Ask for the smallest change
   that makes a local patch unnecessary.
2. **Carry a local patch only while you must.** Each lives in `ai-tooling/qualify/aqe/patches/`, is listed in
   `ai-tooling.toml` `[aqe] patches`, and its upstream issue goes in `[[watch]]` with why it matters.
3. **Every qualification re-fits the patches** (`git apply --check` against the new tag). A patch that no longer
   applies because upstream fixed the problem is dropped; one that no longer applies for another reason is rewritten
   and reviewed.
4. **Take the fix in a whole qualified version,** never by cherry-picking it. If the release that fixes it also brings
   changes you don't want, keep the patch until a later qualified version carries the fix. A security fix can come in
   early as the first patched release under the advisory exception.
5. **Retire the custom pieces** when nothing is left to patch: `ai-tooling.toml` `[[retire]]` lists the conditions and
   the steps. For AQE: the stock package runs bare `aqe` again, project launchers are repinned to it, and the
   `AQE_HOOK_BUNDLE` transport is removed from each project's settings (`steward projects onboard --replace-older`).
6. **Leaving the hybrid list** works the same way for a CLI installed with `npm -g` only because of an upstream
   packaging bug: once a fixed version qualifies, `steward sc retire-hybrid` moves it to mise's `npm:` backend.

## What reconcile adds

`steward projects reconcile` (built in R5b) runs after a new version is qualified and promoted on your machine.

1. `steward check`, `steward review` and the `steward` banner list the projects a promotion left behind;
   `steward ai drift` shows the differences.
2. For every **unit the steward copied** into a project (a helper, skill, command or agent, or one of AQE's hook files),
   reconcile compares three things: the **baseline** (its hash in the newest onboarding or reconcile receipt), **disk**
   (now), and the **source** (the newly qualified install).

   | Disk compared with the baseline | The source changed | Result |
   | --- | --- | --- |
   | the same: the steward's untouched copy | yes | **updated**, with a backup |
   | different: you edited it | yes | **kept and reported**, with `--diff <unit>` to see the change and `--take <unit>` to take the new version |
   | no baseline, but an unedited copy of a published release (its hash is in `projects/profiles/known-units.json`) | yes | **updated**, like the steward's own copy |
   | no baseline, any other content (there before the steward) | — | yours, left alone; `--take <unit>` adopts it |
   | already equal to the new source | — | current |
   | missing | — | reported; `steward projects onboard` restores missing names |
   | the source no longer ships it | — | reported only; removal is the deliberate path (`steward projects offboard`) |

3. It plans for one project or `--all`, asks once, then for each project backs up, updates, writes a receipt that
   starts a soak, and can roll back (`--rollback <receipt>`, refused if anything it wrote has changed since).

**A folder with `.LOCKED`** (Ruflo's helpers; onboarding writes the marker) is updated like any other, and the plan
labels its units. The marker turns Ruflo's own refresh (`ruflo init upgrade` and its self-healing) off and asks for "a
reviewed, backed-up tooling migration", which is what reconcile is: a plan, your yes, a backup and a receipt.

**What it doesn't touch:**

- **files from before the steward onboarded the project** (an old `ruflo init`, for example) that you changed: they
  have no baseline, so unless they are byte for byte a published release's copy they count as yours. `profile-check`
  shows them; `--take` adopts one;
- **tracked files:** a change to them goes through a PR, as onboarding's do (D6);
- **settings values** (hooks, launchers, keys): adds-only for now, with the fixers above. They join reconcile once
  receipts record a baseline per key (D42), which is also what retiring the AQE transport will use.

## Challenges and mitigations

| Challenge | Mitigation |
| --- | --- |
| **Fast upstream churn** | the release-age gate; qualification before promotion; pinned versions; Renovate on dashboard approval for AI tools; reconcile in batches after a promotion, not on every upstream release |
| **A release changes a file you edited** | your edit wins: kept and reported, never replaced without `--take` (D40) |
| **Files with no baseline** (copied before the steward onboarded the project) | an unedited copy of a published release is recognized by its hash (`known-units.json`, rebuilt with `just known-units` after each qualification) and updated; anything else is yours and never touched; `--take` adopts one |
| **Upstream renames or removes a unit** | reported, never deleted; `steward projects offboard` is the deliberate way to remove |
| **Tool state migrations** (Ruflo's policy state on its first write; AQE's store schema) | backups before any version change (policy folders, stores); AQE's G5 rollback test; nothing runs on its own |
| **Self-updaters** (Ruflo's auto-update, ruflo-console's updater, Brain's knowledge base) | the guards and the keep-off list (`[[keep_off]]`), which always win; drift checks them |
| **Settings whose meaning changes** (hook commands, millisecond timeouts, approvals, removing the transport) | today, one dedicated fixer each; next, reconcile with per-key baselines (D42) |
| **A patch outliving its need** | `[[watch]]` names each upstream issue; every qualification re-fits the patches and drops superseded ones; `[[retire]]` lists the triggers and steps |
| **The fix arrives with unwanted changes** | qualify the whole version; keep the patch until a qualified version carries the fix; a security fix may come in early under the advisory exception |
| **Ruflo and AQE ship the same names** | AQE skips every name the qualified Ruflo ships (D26); reconcile follows the same ownership |
| **Many projects** | one plan across all of them and one question; a backup, receipt and rollback per project; the soak keeps the old installs on disk |
| **Testing without touching real installs** | the test stand-ins (`test/fixtures.js`) simulate a new release; real installs are never modified by a test |

## Where things stood on 2026-10-27

A snapshot, to make the above concrete. Current values live in `ai-tooling.toml` and `supply-chain/hybrids.toml`.

- **AQE:** the shared runtime was `3.15.12-local.1`, stock 3.15.12 plus two patches: `bootstrap-provenance-guard`,
  waiting on upstream agentic-qe#1188 (open), and `dream-opt-out`. Upstream was at 3.15.16. Earlier patches had
  already retired when upstream fixed agentic-qe#1055, #1060 and #1061.
- **Ruflo:** installed as an npm -g hybrid at 3.59.8 only because of a packaging bug, ruvnet/ruflo#4371, which upstream
  had closed; once a version with the fix qualifies, it can leave the hybrid list. Upstream was at 3.63.5, with a
  qualification of 3.63.x due.
- **Brain:** pinned at 4.7.17; upstream was at 4.7.21.

**Since then (2026-10-30):** AQE moved to `3.15.16-local.1` (both patches still apply; agentic-qe#1188 is still open),
Ruflo to 3.63.5 and Brain to 4.7.21. Ruflo stays an npm -g hybrid on purpose: ruvnet/ruflo#4371 is fixed, but
`steward sc install-hybrids` backs up every Ruflo policy folder before a version change, and a mise install doesn't.
