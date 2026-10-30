# AI tooling qualification

![Revision 3](https://img.shields.io/badge/Revision-3-green) ![Revised 2026-10-30](https://img.shields.io/badge/Revised-2026--10--30-green)

What has to be true before a new AQE or Ruflo version reaches any project, and the guards that stay in place
between versions. The AI tooling add-on's policy (`ai-tooling/ai-tooling.toml` in your instance) records the result;
[`runbook.md`](runbook.md) has the step-by-step procedures, and `ai-tooling/qualify/aqe/` the AQE scripts (D32).

## AQE (the shared patched runtime)

1. **Upstream check:** list the new release's changes and its dependency, engine and bin differences. Check
   whether each local patch still applies to the new tag (`git apply --check`), and drop any patch upstream has
   superseded.
2. **Build** a patched tarball from the tag and compile the native modules with npm 12 `allowScripts`. The
   normalised diff against the official package must show only the intended patches.
3. **Gates G1–G8**, in a sandbox, each recorded in the run's receipt:
   - the matcher passes its cases;
   - offline model processes make no network fetches;
   - a store, then an independent exact and semantic read;
   - project isolation;
   - schema migration on a synthetic store the current runtime writes, then a read and write by the *previous*
     runtime, as the rollback test. A release that changes the schema needs a real-store copy and the user's yes;
   - the dream guard refuses cleanly and keeps concurrent writes;
   - worktree hook paths are accepted;
   - workers stay off.
4. **Back up every store** before switching: an APFS clone of `memory.db` plus `-wal` and `-shm`, not held open
   (`lsof`), and `quick_check` ok.
5. **Install** the release into `releases/<version>`, check its tree hash equals the staged one, and switch the
   `current` link. Keep old releases: rolling back is relinking `current`.
6. **Verify through real consumers:** store and retrieve through several projects' `.mcp.json`, and a hook shim
   resolving to the new version.
7. **Rebuild the release index:** `just known-units`, then commit `projects/profiles/known-units.json`, so
   `steward projects reconcile` recognizes the new release's files in projects set up without the steward.
8. **Update the engine's defaults,** so other users get what you qualified:
   - add the new release's vendor-file hashes to `projects/profiles/known-vendor-files.toml` (`brain-checkpoint.cjs`
     and `aqe-hook.cjs`, from the official tarball and the runtime). Without them, onboarding after the next upgrade
     treats unedited copies as edited and keeps them;
   - set `examples/ai-tooling/ai-tooling.toml` `[aqe] current` and `based_on`, and the qualify README's example;
   - check the onboarding profile (`projects/profiles/aqe.toml`) against the release's `dist/init/phases/07-hooks.js`.

## Ruflo

1. **Read the source changes** between the installed and target versions. This is how two traps were found:
   Ruflo auto-installs its own patch releases, and its first write moves the policy state to a version older
   Ruflo can't read.
2. **Back up** every project's `.claude-flow/policy` folder plus `~/.config/ruflo`. `steward sc install-hybrids` and
   `steward sc node-patch` do this whenever the version changes.
3. **Pilot** one project: verify the policy before and after, a memory round trip, and the helpers unchanged.
4. **Global install** with an exact allow-scripts list (`supply-chain/hybrids.toml`); every other optional install
   script stays blocked.
5. **Verify** the policy ledger check and the Codex path through the shared launcher. Rolling back means
   reinstalling the old version *and* restoring the policy and trust folders together.
6. **Rebuild the release index:** `just known-units`, then commit `projects/profiles/known-units.json`.
7. **Update the engine's defaults:** check the onboarding profile (`projects/profiles/ruflo.toml`) against the
   release's settings generator, and correct any doc that names the old version as current.

## Standing guards

Kept in place between versions; `steward ai drift` checks them.

- **`CLAUDE_FLOW_AUTO_UPDATE=false`** in `~/.claude/settings.json` env and the shell environment. Without it,
  Ruflo installs patch releases on startup.
- **`claudeFlow.daemon.autoStart: false`** in each project's Claude settings. `ruflo daemon start` still works
  when wanted.
- **AQE hook shims** at `node_modules/.bin/agentic-qe` route `npx agentic-qe` to the shared runtime. `npm ci` or a
  reinstall can delete a shim; onboarding puts it back.
- **Never** run Ruflo's or Brain's own maintenance commands: `init --force`, `update*`, `--auto` or `--yes`, or a
  plain `npx ruvnet-brain`. They change installed state outside the steward's plan, backup and receipt.
