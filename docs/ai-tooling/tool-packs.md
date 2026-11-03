# Tool packs: what the steward knows about one AI tool, kept as data

![Revision 1](https://img.shields.io/badge/Revision-1-blue) ![Proposed 2026-11-03](https://img.shields.io/badge/Proposed-2026--11--03-blue)

> [!IMPORTANT]
> **Proposed, not built.** Tracked in [#105](https://github.com/pacphi/workstation-steward/issues/105), for 0.12.0. The
> decision row in [`architecture.md`](../architecture.md) comes next, then the schema, tests and code, one PR at a
> time. Until then, a new Brain release follows the hand recipe in the runbook's
> [Brain](../../skills/ai-tooling/runbook.md#a-new-brain-release-by-hand) section.

## Situation

The AI-tooling add-on ([D1 and D39](../architecture.md)) knows its tools by name. `['ruflo', 'aqe', 'brain']` is written into
`lib/registry.js` and `lib/profiles.js`; AQE has its own qualify and promote scripts (D32) and hook transport (D24);
in all, 17 files under `lib/` mention the tools 107 times (most in `lib/brief.js`, `lib/profiles.js`, `lib/projects.js` and `lib/pins.js`). Supply chain works the other way: the
engine knows *package managers*, and your files name the packages. `[[updater]]` ([D52, D72](../release-classes.md)) works that way too, and
D52 rejected tool-specific commands.

Taking a new Brain release on 2026-11-03 took about 12 steps and 5 yeses, and four traps were known only from notes:

- the installer upgrades a package in `~/.claude/model-router` (aidefence 3.1.0, 2.66 days old) past the gate;
- Brain's background auto-update runs `ruvnet-brain@latest --update` unless `~/.cache/ruvnet-brain/.auto-update-pref`
  says `no`;
- every installer run writes a user-level Codex `[mcp_servers.ruvnet-brain]` block, which D55 keeps off;
- the knowledge base's runtime stamp must move before a newer corpus is accepted.

## Opportunity

**One folder per tool, holding what the steward knows about it as data, run by verbs that name no tool.**

```text
ai-tooling/packs/
  brain/
    pack.toml        what it is, how to check, qualify, promote and guard it
    profile.toml     what onboarding writes into a project (today's projects/profiles/brain.toml)
  aqe/
    pack.toml
    profile.toml
    hooks/           only where data isn't enough: AQE's gates G1-G8 (today's qualify/aqe/)
  ruflo/
    pack.toml
    profile.toml
```

The engine gets three verbs that work for any pack, plus a way back:

| Verb | Writes | What it does |
| --- | --- | --- |
| `steward ai check [<tool>]` | nothing | Installed, pinned and newest versions, release ages, upstream state, and the age of every side dependency the pack names. One line per tool, and the next step. |
| `steward ai qualify <tool> <version>` | a sandbox and a record only | Builds a sandbox from APFS copies of the pack's `seed` paths (never its `never_copy` ones), runs the pack's `apply` there, stops anything left running, checks the pack's `accept` lines, proves the real `HOME` unchanged (a fingerprint before and after), and writes a qualification record. |
| `steward ai promote <tool>` | the real machine, after a yes | Refuses unless a qualification record and the CLI pin both name the version, and every side dependency is past the gate. Backs up the pack's `backup` paths, runs `apply`, runs the `after` steps, checks `accept` again, and writes a receipt. |
| `steward ai promote <tool> --rollback <receipt>` | the real machine, after a yes | Puts the backups back, refusing any file changed since. |

`steward ai drift` reads each pack's `[guards]`, and `steward projects onboard` reads each pack's `profile.toml`. The
tool list is the set of packs found, so a new tool is a new folder and a PR, not new engine code.

## A pack, by example

```toml
# ai-tooling/packs/brain/pack.toml
name = "brain"
title = "RuvNet Brain"

[cli]                                   # the gated CLI; Renovate moves the pin (D2)
mise = "npm:ruvnet-brain"

[runtime]                               # what the CLI installs outside mise; Brain has two parts that move apart
parts = [
  { name = "knowledge base", json = "~/.cache/ruvnet-brain/kb/SOURCE.json", key = "brainVersion" },   # moves at apply
  { name = "spine", json = "~/.cache/ruvnet-brain/active.json", key = "version",
    staged = { run = "node {cli_dir}/plugin/scripts/update-apply.mjs --doctor", line = "staged" } },  # moves at the next hook call
]
# {cli} is the pinned mise install (mise exec npm:ruvnet-brain@{version}), never whatever is first on PATH
apply = "{cli} --version v{version} --no-nightly-prompt --no-telemetry --no-stack --no-enhance --no-statusline"
backup = ["~/.claude/plugins/installed_plugins.json", "~/.claude/plugins/marketplaces/ruvnet-brain",
          "~/.codex/config.toml", "~/.claude/model-router", "~/.claude/settings.json"]
upstream = { github = "stuinfla/ruvnet-brain", plugin_from = "main" }   # check: main is the tag
side_deps = [{ npm_dir = "~/.claude/model-router" }]                       # every package past the gate

[qualify]
seed = ["~/.cache/ruvnet-brain/{active.json,versions,install-state.json,host-convergence.json,knowledge-signature.json,kb,.auto-update-pref}",
        "~/.claude/plugins/{installed_plugins.json,known_marketplaces.json,marketplaces/ruvnet-brain}",
        "~/.claude/settings.json", "~/.claude/model-router", "~/.codex/config.toml"]
never_copy = ["learn*", "evidence.jsonl", "decision-*", "*.jsonl", "*.db"]
accept = [
  { part = "knowledge base", equals = "{version}" },
  { part = "spine", equals_or_staged = "{version}" },
  { unchanged_or_absent = "~/.cache/ruvnet-brain/.ruvnet-brain-rejected-release.json" },   # no new refusal
  { no_processes_left = true },                                                              # nothing detached
]

[after]                                 # run after apply, in order
remove_toml_block = { file = "~/.codex/config.toml", markers = "# --- ruvnet-brain" }   # D55

[guards]                                # steward ai drift checks these
files = [{ path = "~/.cache/ruvnet-brain/.auto-update-pref", equals = "no",
           why = "else Brain's SessionStart runs ruvnet-brain@latest --update, past the gate" }]

[never]                                 # not checkable by drift: what the skill and the verbs refuse to run
run = ["--update --plan", "--auto", "--yes", "--force", "npx ruvnet-brain"]
```

**What "installed" means.** `ai check` and the brief show both parts: "knowledge base 4.7.28, spine 4.7.21 (4.7.28
staged)". A pack whose runtime has one part lists one.

**No terminal, so defaults.** `qualify` and `promote` run `apply` without a terminal, so the installer takes each
option's default. That keeps both runs the same, and the sandbox shows what those defaults write before the real run.

**Which CLI.** `qualify` installs the CLI into the sandbox from the registry, with install scripts blocked, because the
pin may not have moved yet. `promote` uses only the pinned mise install, and refuses if the pin names another version.

Every field is one the engine already has a reader for somewhere (`[[updater]]` `installed`, `backup` and `verify`;
profiles; D55's `[user_off]`), so the loader mostly reuses them.

## A pack or an `[[updater]]`?

An `[[updater]]` is one source with one check and one apply: Claude Code's build, Brain's knowledge base. A pack is a
tool with a CLI pin in mise, plus at least one of a sandbox qualification, after-steps, or an onboarding profile. So
Claude Code stays an updater, and Brain's knowledge base stays the `brain-kb` updater beside the Brain pack.

## Records and receipts

Qualification records go to `[paths] state/qualify/<tool>-<version>…/receipt.json`, the path `lib/brief.js` already
reads for AQE, so the brief and the AQE move keep working. Promote receipts go under the backups folder as
`<tool>-promote-<stamp>`, next to today's `aqe-promote-*`.

## Hooks, when data isn't enough

AQE's qualification builds a patched tarball and runs eight gates on synthetic stores. That is code, and it stays
code, as `hooks/qualify.sh` in the AQE pack. The contract is narrow:

- the engine calls a hook with the sandbox's environment already built (`HOME`, `XDG_*`, `MISE_*`, the dead proxy
  AQE uses) and the version;
- a hook prints progress on stderr and its evidence as JSON on stdout; exit 0 means passed;
- the engine, not the hook, writes the record or receipt, and only the engine touches the real machine.

## How it looks for a novice

```text
$ steward
  …
  next: Brain 4.7.28 is ready to qualify            → steward ai qualify brain 4.7.28
$ steward ai qualify brain 4.7.28                   (yes #1: a sandbox only)
  ✓ upgraded a copy of your install, 4.7.21 → 4.7.28; your real files unchanged
  ! ~/.claude/model-router: @claude-flow/aidefence 3.1.0 clears the gate at 12:47 pm
  next: tick npm:ruvnet-brain on your Renovate dashboard, merge, then steward config sync
$ steward ai promote brain                          (yes #2, after 12:47 pm)
  backup → install → Codex block off → checks → receipt
  next: steward sc upgrade takes the new knowledge base (brain-kb)
```

With Claude, the ai-tooling skill says the same in one sentence and asks the two yeses.

## Trust

Packs ship inside the engine, so they reach you through the npm release, the release-age gate and a reviewed PR, like
any engine code. A hook runs only from the engine's own folder. Packs from anywhere else (npm, your instance) are
deferred: they would need their own pins, gate and review, and every tool so far comes from one vendor family.

## Migration, one PR at a time

1. The loader, the schema test and `ai check` (read-only), plus the Brain pack and its `.auto-update-pref` guard in
   drift.
2. `ai qualify` for data-only packs (Brain).
3. `ai promote` and `--rollback`, a `lib/brief.js` detector ("pin is X, runtime is Y"), and the skill's
   "A new tool release" section.
4. The AQE pack: `qualify/aqe/` becomes its hooks, and `promote.sh` its promote. Receipts keep their old names.
5. The Ruflo pack, and the `TOOLS` lists replaced by the packs found. `projects/profiles/` keeps working through
   these moves.

## Rejected

- **Tool-named commands** (`steward ai brain`): D52 rejected them, and each new tool would add more.
- **Stretching `[[updater]]`:** a runtime's version follows the CLI pin, not npm dates, and qualifying in a sandbox
  doesn't fit an updater's check-and-apply.
- **Packs from outside the engine, now:** a second supply-chain surface for a need nobody has yet.

## Open questions (one at a time, for the owner)

1. The verb names: `check`, `qualify`, `promote` (AQE's words today), or others? `steward ai check` would sit beside
   the top-level `steward check`, which means something else (config format and projects), so `ai status` may be
   clearer.
2. Should `ai promote` also run the pack's side-dependency gate inside `steward upgrade` (D61), or stay its own step?
3. Where the pack's onboarding profile lives during the move: copied into the pack, or linked from
   `projects/profiles/` until step 5?
4. Should `ai qualify` be allowed unattended (D58) when `[autonomy]` permits, since it writes only a sandbox?
