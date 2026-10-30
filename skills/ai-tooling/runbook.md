# AI tooling runbook

![Revision 20](https://img.shields.io/badge/Revision-20-green) ![Revised 2026-10-30](https://img.shields.io/badge/Revised-2026--10--30-green)

Procedures for the AI-tooling area: Ruflo and AgentDB, AQE, RuvNet Brain, RuVector, the shared launchers and
the guards. The policy is `ai-tooling/ai-tooling.toml` in your instance ([an example](../../examples/ai-tooling/ai-tooling.toml)). Why it looks
the way it does is in [`architecture.md`](../../docs/architecture.md); the full qualification recipe is in
[`qualification.md`](qualification.md). `steward` commands run from any folder.

**Never, under any circumstances:**

- start a launcher with `@latest`;
- run anything on the NEVER lists ([`qualification.md`](qualification.md#standing-guards)). For Ruflo that includes `init --force`, `update*`,
  `daemon start-all` and `config set|init|reset|import`. For Brain it includes `--update --plan`, `--auto`,
  `--yes`, `--force` and plain `npx ruvnet-brain`.

## Contents

- [Routine check](#routine-check)
- [A new AQE release](#a-new-aqe-release)
- [A Ruflo version change](#a-ruflo-version-change)
- [After a promotion: bring projects in step](#after-a-promotion-bring-projects-in-step)
- [An upstream fix lands: retire a patch](#an-upstream-fix-lands-retire-a-patch)
- [Brain](#brain)
- [Launcher and project drift](#launcher-and-project-drift)
- [Hook timeouts in milliseconds](#hook-timeouts-in-milliseconds)
- [Brain's Codex approvals](#brains-codex-approvals)
- [A guard is missing](#a-guard-is-missing)
- [Rollback](#rollback)

## Routine check

`steward ai drift` is read-only; `--offline` skips the network reads. It reports four levels:

- **DRIFT:** differs from policy. Fix it, or change the policy on purpose.
- **WARN:**
  - a newer upstream release whose notes mention security;
  - a watched thread that closed;
  - a project showing tools beyond its choice.
- **info:** context, such as release ages and the Brain knowledge base's age.
- **ok:** matches policy.

Per-project checks follow each project's chosen tools in `projects/registry.toml`. Until a project is
confirmed, they follow its seed (`ai_seed`) instead. A tool a project shows but didn't choose is reported,
never removed.

## A new AQE release

`drift` lists every release newer than the runtime's base, with its age against the 3-day gate and whether its
notes mention security.

1. **Wait until it's past the gate,** unless it's the first patched release for an advisory in GHSA, RustSec
   or OSV.
2. **Qualify a new local release,** following
   [the AQE recipe](qualification.md#aqe-the-shared-patched-runtime):
   - re-fit each patch with `git apply --check`, dropping any patch upstream has superseded;
   - build;
   - run gates G1–G8 in a sandbox;
   - back up every store;
   - install into `releases/`;
   - switch `current`;
   - verify through real projects.

   `ai-tooling/qualify/aqe/run.sh <version> build`, then `smoke`, `g1` … `g8` and `receipt`, does all of it in
   a workspace under `[paths] cache` (README there). `promote.sh <version>` then backs up every store, installs
   the release and switches `current` after the user's yes; `promote.sh --rollback <receipt>` relinks the
   previous one. If a promote stopped part-way, it says so on the next run and won't build on what was left: a
   leftover `releases/<release>.partial` means it stopped while installing (`current` never moved), so remove that
   folder and run it again. A `releases/<release>` that `current` doesn't point to is either kept by a rollback or
   left before the switch; it is never overwritten. A release that says to re-run `aqe init` (3.15.12 does, for its worker-daemon script) skips that:
   `init` is on the never list, and the shared runtime keeps workers off (G8).
3. Update `[aqe]` in `ai-tooling.toml` (`current`, `based_on`, `patches`) in the same PR as the receipt's
   summary, and move the stock `npm:agentic-qe` pin in `mise/config.toml` to the same base version (`mise lock
   --global npm:agentic-qe`, sandbox install, the gate on its new packages). The stock copy stays managed so it can
   take over when the patches retire; until then the shared runtime is first on `PATH` (`[env] _.path`, D33), and
   drift checks both.

## A Ruflo version change

1. Read the source changes between the versions. Watch for policy-state migrations, which older Ruflo can't
   read back.
2. Change `version` for ruflo in `supply-chain/hybrids.toml`. Keep `allow_scripts` at the qualified list unless
   a new qualification widens it.
3. `DRY_RUN=1 steward sc install-hybrids`, then `steward sc install-hybrids`. The version change triggers the backup
   of every Ruflo policy folder and `~/.config/ruflo` before the install, and a receipt after it.
4. Pilot one project read-only. Then `steward sc verify` and `steward ai drift` (the hybrid receipt should be
   `ok`).
5. Keep `CLAUDE_FLOW_AUTO_UPDATE=false` in place throughout.

**Ruflo's Claude plugins** (`ruflo-mods`, `ruflo-swarm`, `ruflo-console`) come from a pinned marketplace: an untouched
checkout of `github.com/ruvnet/ruflo` at one commit, in `~/.local/share/ai-tooling/ruflo/marketplaces/<sha>`
(`[ruflo] marketplace`). Projects name it in `.claude/settings.json` `extraKnownMarketplaces.ruflo`. Their own
updater stays off (D29); getting current is a qualification:

1. Choose the upstream commit: a release, at least 3 days old. Read each plugin's changes since the pinned commit;
   these are 0.x plugins, so a minor is a major and is taken deliberately. Watch the mods' declared capabilities
   (the "ruflo mod trust" lines at session start) for new ones.
2. Snapshot it: clone at that commit into `marketplaces/<full sha>`, never edited afterwards, and record a file
   inventory with hashes.
3. Qualify it in a throwaway HOME and project: add the directory marketplace at project
   scope, install the three plugins at project scope, list them, start one session.
4. In a PR: point `[ruflo] marketplace` at the new directory and add a `[[repin]]` rule from the old path to the
   new one. `steward ai repin` then moves each project's `extraKnownMarketplaces.ruflo` (plan, yes, backup, receipt).
5. In each project, `claude plugin marketplace update ruflo` and `claude plugin update <plugin>@ruflo --scope
   project`, then restart the session. `steward ai drift` ("ruflo plugins") shows any project still on the old
   version.
6. Keep the old marketplace directory through the soak; rolling back is the reverse repin.

## After a promotion: bring projects in step

After a new AQE, Ruflo or Brain version is promoted on the machine, the copies onboarding put into projects may be
behind. Why and how: [`upstream-and-reconcile.md`](../../docs/ai-tooling/upstream-and-reconcile.md).

1. `steward check`, `steward review` and the `steward` banner list the projects behind; `steward ai drift` and
   `steward projects profile-check` give each difference and its reason.
2. `steward projects reconcile --all` shows, per project, which of the steward's own copies it would update, which
   you edited (kept; `--diff <unit>` shows the change, `--take <unit>` takes the new version for one unit), which have
   no baseline, and which are missing or no longer shipped. `steward projects reconcile <path>` lists one project's
   units. Missing names come back with `steward projects onboard <path>`.
3. Apply with the user's yes; each project gets a backup, a receipt and a rollback, and the soak starts.
4. Settings whose meaning changed use their fixers: `steward ai timeouts`, `steward ai approvals`,
   `steward projects onboard --replace-older`.

## An upstream fix lands: retire a patch

When a release fixes something a local patch or workaround covers (each is listed in `ai-tooling.toml` `[[watch]]`):

1. **Wait out the gate,** then qualify the **whole** release ([`qualification.md`](qualification.md)). Step 1 re-fits
   every patch: a patch the fix made redundant no longer applies; drop it from `ai-tooling/qualify/aqe/patches/` and
   from `[aqe] patches`, and remove its `[[watch]]` entry. A patch that fails for another reason is rewritten and
   reviewed, not dropped.
2. **Promote** the qualified release, then bring projects in step (above).
3. **No patches left?** Follow `[[retire]]` in `ai-tooling.toml`: its `when` list must all hold, then its `steps` run in
   order, each with its own plan and yes (for AQE: drop the `_.path` line, repin launchers, remove the transport with
   `steward projects onboard --replace-older`).
4. **A CLI on the hybrid list because of an upstream packaging bug:** once a fixed version qualifies,
   `steward sc retire-hybrid <name> <spec>` moves it to mise's `npm:` backend.
5. Record what retired, and why, in your instance's records.

## Brain

Brain has three parts, each updated its own way (D52, [`release-classes.md`](../../docs/release-classes.md)):

- **The CLI** (`npm:ruvnet-brain` in mise) is `gated`. It's AI-owned, so it arrives as an `ai-tooling` Renovate PR
  only when ticked on the dashboard.
- **The runtime** (the plugin and hooks in `~/.cache/ruvnet-brain`) is `gated`: the pinned CLI's installer, for a
  release past the gate.
- **The knowledge base** (`kb/`) is a declared `signed_data` source, `brain-kb` in the engine's host defaults.
  `steward sc audit` reports it behind; `steward sc upgrade` applies it after the owner's yes, with a copy of `kb/`
  and a receipt, and refuses a fallback source or a changed signing key. An agent runs only the read-only audit and
  plan. An old updater can fail on a newer bundle: if `apply` fails, update the runtime first (it's gated), then try
  again. `steward sc rollback <receipt>` puts the old `kb/` back.

## Hook timeouts in milliseconds

Claude Code reads a hook's `timeout` in **seconds** (default 600). Ruflo writes milliseconds: `5000` means 83 minutes and
`60000` means 16 hours, so a hung hook is never cut off. Values already in seconds
(AQE's `5`, `30`) are left as they are.

- **Find them:** `steward ai drift` shows one `hook timeouts` line; `steward ai timeouts` lists every file and the change (`5000→5`,
  rounded up). A value of 1000 or more counts as milliseconds, since no hook should run for 16 minutes.
- **Fix them:** `steward ai timeouts --apply` asks once, backs up each file, rewrites only the timeout numbers, checks that nothing else
  moved, and writes a receipt. It edits only files Git does not track (D6). A tracked file, a file a rewrite would reformat, and a
  repo mid-merge are listed and skipped; a tracked file needs a PR.
- **Undo:** `steward ai timeouts --rollback <receipt>` restores the backups, and refuses any file changed since.
- **Running sessions** keep their old hooks until restarted.
- **It can come back:** Ruflo writes milliseconds whenever it writes hooks. Drift shows it again if it does; never run `ruflo init`.

## Brain's Codex approvals

Brain's Codex server exposes four tools. Three are read-only. `ruvnet_cli_run` is declared destructive: it runs any
subcommand of ruflo, claude-flow, agentic-flow, agentic-qe, ruvector, agent-browser or ruv-swarm with arbitrary arguments and
no shell, gated only by having read that subcommand's help in the last 24 hours. That reaches commands the NEVER rules
forbid (`init`, daemon start). An `approve` copied from an older global registration into each project carries that
with no vetting; the vetted Ruflo approvals are all read-only.

- **The rule** (`ai-tooling.toml` `[[codex_prompt]]`, D37): `ruvnet_cli_run` is `prompt`, so you confirm each run. `search_ruvnet`
  stays `approve`. The server launches the stable Node link (`[[codex_stable_node]]`), because Brain's installer writes a bare
  `node`, which a minimal PATH cannot find.
- **Existing projects:** `steward ai approvals` plans, `--apply` asks once, backs up each `.codex/config.toml`, edits the text (comments
  and order stay), checks that only those keys moved, and writes a receipt; `--rollback <receipt>` undoes it. Untracked files only
  (D6). Restart Codex sessions afterwards.
- **New projects:** the Brain profile (`projects/profiles/brain.toml`) now renders `prompt` and the stable node, even with
  `--no-approvals`, since it restricts rather than grants.
- **Drift** shows one `codex approvals` line until every project matches.

## Launcher and project drift

- **A per-project-only tool switched on at user level** (`ai drift` "user-level off", D55): Brain, and Ruflo's
  Claude plugins, are switched on in each project that chose them, never for the whole user. Brain's installer, in
  any mode, writes a `[mcp_servers.ruvnet-brain]` block into `~/.codex/config.toml`, and then Brain's tools load in
  every Codex session. The DRIFT line names the file and the key. Remove the block (the lines between its
  `# --- ruvnet-brain` markers, markers included), or set the plugin to `false`. These are the user's own files, so
  drift only reports; the user makes the edit, after a backup. Then run `steward ai drift` again.
- **Launchers pinned to a version-specific install** (`ai drift` "pinned launchers"): run `steward ai repin` and
  read the plan. Every file must show `apply`, or a reason it can't be applied: tracked, mid-merge, an
  unmapped path, or a missing target. Then run `steward ai repin --apply`, which asks first. Each file is backed up
  and parse-checked, and a receipt is written. Afterwards, `steward ai drift` should show no pinned launchers
  except the skipped files. Open one Codex or Claude session in a repinned project to confirm the servers
  start. Undo with `steward ai repin --rollback <receipt>`. Tracked files are skipped. If the plan says their pins come only from uncommitted local
  edits, repin them by name with `steward ai repin --apply --tracked-local <file>…` (D13). If the committed
  version holds the paths, change it through a PR in that repo. A reference inside a settings file's
  `permissions` is reported as info: it launches nothing and doesn't block a prune.
  The same check covers the scripts launchers run: each project's AQE hook shim (`node_modules/.bin/agentic-qe`)
  and `bin/aqe` and `bin/aqe-mcp` in every release under the shared AQE runtime (old releases too, since an AQE
  rollback relinks `current`). Shell scripts get a `sh -n` check instead of a parse check. After repinning
  them, confirm `aqe-mcp` starts and lists its tools, and that a project's shim reaches the runtime.
- **Launcher targets that don't exist** (`ai drift` "launcher targets"): a launcher config names a path under
  `~/.local/share` that isn't there. Stable links (`node/26/…`, `npm-ruvector/0.3/…`) survive prunes but not a
  layout change inside a new version, for example a Ruflo upgrade that moves `@claude-flow/memory`. A missing
  `.claude-flow/memory-package.json` `distPath` doesn't fail loudly: the Ruflo memory hook falls back and
  self-learning can stop. Add a `[[repin]]` rule to `ai-tooling/ai-tooling.toml` for the new path and run
  `steward ai repin`, or roll back the upgrade while the soak still holds the old install.
- **Unpinned launchers** (D30): `ruflo`, `ruv-swarm` or `flow-nexus` in `.mcp.json` or the Codex config that fetch
  `@latest`, or run `npx` with no version at all (`npx -y ruv-swarm`, which is just as unpinned), as an older `ruflo init`
  wrote them (current `init`, 3.63.1 included, still writes `npx -y ruflo@latest` under `claude-flow`, plus `ruv-swarm`
  and `flow-nexus@latest` with its full preset). `steward projects onboard <path> --remove-unpinned` removes them; a
  project's own servers stay. Claude gets Ruflo's hooks and plugins, not an MCP server; Codex has the pinned `ruflo`
  server.
- **An `mcpServers` block in `.claude/settings.json`** (drift info): an older `ruflo init` wrote `npx ruflo@3.5.18`
  there, but Claude Code reads MCP servers only from `.mcp.json` and `~/.claude.json`, so it launches nothing. Delete
  it when convenient; tracked files change through a PR.
- **AQE servers off the shared runtime, missing hook shims or `autoStart`:** fixing these
  edits project files. The allowed way is in [`docs/architecture.md`](../../docs/architecture.md#projects-detection-and-onboarding):
  - untracked or ignored files are edited in place, after the plan and `[y/N]`, with a backup and a receipt;
  - tracked files change through a pull request.

  `steward ai repin` and `steward projects onboard` do this, one project at a time with the user's yes.
- **A project showing a tool it didn't choose:** confirm the project's tools first ([projects
  runbook](../projects/runbook.md)). Removal is always a separate, explicit decision.
- **A project that chose a tool but has none of its files:** decided, never onboarded (or removed by hand):
  `steward projects onboard <path>`. Claude Code agent worktrees are skipped (D19).
- **AQE hooks without `AQE_HOOK_BUNDLE` = transport v2** in `.claude/settings.local.json` (D24): the hooks may reach
  the stock `aqe` on `PATH`. `steward projects onboard <path>` sets it.
- **AQE hooks with transport v1 inline (WARN) or `npx agentic-qe hooks` (DRIFT):** older forms that onboarding
  keeps rather than doubling; an inline env wins over `settings.local.json`, and `npx` fetches an unpinned AQE on
  every hook. `steward projects onboard <path> --replace-older` swaps them for the profile's (its own plan and yes).
- **Keep-off breaks** (`keep-off: …`): a project value that `ai-tooling.toml` `[[keep_off]]` says must be otherwise
  (idle auto-assign on). Plain onboarding only reports them; `steward projects onboard <path> --fix-keep-off` sets them
  (its own plan and yes, a backup and a receipt).
- **Retire conditions** (info): what retires a steward workaround (`[[retire]]`). Check them by hand at each AQE
  qualification, alongside the watched threads.

## A guard is missing

- **`CLAUDE_FLOW_AUTO_UPDATE` not `false`** in `~/.claude/settings.json` (env) or `~/.zshenv`: restore it after
  backing up the file. Without it, Ruflo installs patch releases on startup.
- **AQE hook transport v2 missing or different** from `ai-tooling/transports/aqe-hook-bundle.cjs` (D24): `steward ai
  transport --apply` installs it (asks, backs up, receipt; `steward ai transport --rollback <receipt>`). Onboarding a
  project with AQE refuses until it matches.
- **npx ask rules missing** from `~/.claude/settings.json` `permissions.ask` (D27): `steward ai guard` shows which,
  `steward ai guard --apply` adds them (asks first, backs up, writes a receipt; `steward ai guard --rollback <receipt>`
  undoes it). Without them, agents run the unpinned `npx` that Ruflo's and AQE's skills name, unprompted wherever a
  project allows `Bash(npx @claude-flow*)`.
- **ruflo-console updater not off** (D29): `updates` in `~/.claude/plugins/store/ruflo-console_ruflo-*.json` isn't
  `"off"`, so the plugin offers (or auto-installs) versions from the tip of upstream's main. `steward ai guard --apply`
  sets it. Never answer its prompt with "Always auto-update"; "Not now" is safe.
- **A Ruflo plugin installed at a version the pinned marketplace doesn't have** ("ruflo plugins"): an update
  outside qualification. Find how it got there before anything else, then reinstall from the pinned marketplace.
- **git ignore rules not in effect** (D28): AI tool output (`.claude-flow/`, `.agentic-qe/`, AgentDB and RuVector
  stores, the per-machine `.mcp.json` and `.codex/`…) shows in projects' `git status`. Drift asks git itself, so a
  `core.excludesFile` pointing elsewhere shows up too. `steward ai guard --apply` writes the marked block in the user's
  git ignore file (asks, backs up, receipt; `--rollback <receipt>` undoes it); the user's own lines are kept.
- **`aqe`, `aqe-mcp` or `agentic-qe` resolving to a stock install** ahead of the shared runtime (`ai drift` "aqe on
  PATH"): `mise/config.toml` `[env] _.path` puts the runtime's `bin` first (D33). Check that
  line is still there and that `~/.config/mise/config.toml` is this repo's (`steward sc link`), then open a new shell. A
  project's AQE server that runs a bare name is judged by this same resolution, so it shows as drift only while the
  bare name reaches a stock install (or nothing).

## Rollback

- **AQE runtime:** point `~/.local/share/ai-tooling/aqe/current` back at the previous `releases/<version>`.
  Every old release is kept. Restore stores from the backup taken before the switch.
- **Ruflo:**
  - reinstall the previous version (`supply-chain/hybrids.toml`, then `steward sc install-hybrids`);
  - restore each project's `.claude-flow/policy` and `~/.config/ruflo` together from
    `~/.local/state/workstation-steward/backups/ruflo-policy-*`, with Ruflo stopped.
- **A project file:** restore it from the backup its receipt names.
