# Supply chain runbook

![Revision 7](https://img.shields.io/badge/Revision-7-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

Procedures for the supply-chain area: mise, the npm -g hybrids, Homebrew, apps, the App Store, macOS, trust
stores, Docker and IOCs. The rules behind them are in [`../../AGENTS.md`](../../AGENTS.md) (Toolchain, Release
age); the files and commands are in [`../../supply-chain/README.md`](../../supply-chain/README.md). `steward`
commands run from any folder. Every changing step asks first, and `DRY_RUN=1` previews it.

## Contents

- [Routine check](#routine-check)
- [Apply eligible upgrades](#apply-eligible-upgrades)
- [A Renovate PR arrives](#a-renovate-pr-arrives)
- [A same-day Node security release](#a-same-day-node-security-release)
- [A new advisory or incident report](#a-new-advisory-or-incident-report)
- [A trust exception](#a-trust-exception)
- [A declared source is behind](#a-declared-source-is-behind)
- [Adding an `[[updater]]`](#adding-an-updater)
- [Soak and prune](#soak-and-prune)
- [Change the release-age gate](#change-the-release-age-gate)
- [Rollback](#rollback)

## Routine check

1. `steward sc audit`. It's read-only. Read the summary:
   - **ACTION** lines are things to do; on a terminal the Summary lists them in columns under what to do about each
     (`--verbose` also shows the lines it folds away);
   - **ALERT** means an indicator of compromise matched. Stop and investigate before anything else.
2. **Browsers** (`always_current`): update now from each app's About page. They aren't Homebrew casks, so
   `brew upgrade` doesn't apply.
3. **Other apps** flagged for an old Electron, or behind their vendor's release: update from the app or its
   vendor.
4. **App Store and macOS:** update by hand.
5. **A Docker container on a floating tag:** pin `tag@sha256:digest` the next time it's recreated.

## Apply eligible upgrades

1. `steward sc plan`, read-only. It lists:
   - **take:** past the 3-day gate;
   - **hold:** too young;
   - **skip:** a major, or a 0.x minor;
   - **ai:** owned by AI tooling, see [its runbook](../ai-tooling/runbook.md);
   - **manual:** Node or a tap formula;
   - under **Declared updaters**, each `[[updater]]` that's behind, with its class (see
     [A declared source is behind](#a-declared-source-is-behind)).
2. `steward sc upgrade` applies the take lines after asking. It backs up `config.toml` and `mise.lock`, runs
   `--no-prune`, and verifies after each tool.
3. Commit `mise/config.toml` and `mise/mise.lock` with the list of what moved, and push once the owner
   approves. Renovate then closes its own PRs for versions already applied.
4. **Majors stay deliberate.** Read the release notes, then
   `steward sc upgrade-tool <tool> <version>`.
5. **mise itself** (D38) is the plan's last line: `take mise <current> -> <version>` when a release is past the gate.
   `steward sc upgrade` applies it after the tools; `steward sc upgrade-tool mise` applies it alone. Either one backs up the
   binary to `~/.local/state/workstation-steward/backups/mise-self-update-*`, runs
   `mise self-update --yes --no-plugins <version>`, checks the new version and that the config still reads, runs
   `steward sc verify`, and writes a receipt that starts a soak. Never run a bare `mise self-update`: before 2026.10.18
   it takes the newest release with no age gate, and it updates plugins too. An advisory fixed in a release under the
   gate shows as a note; add a `security_exception` with `kind = "mise"`, `name = "mise"` to `host.toml` to take it.

## A Renovate PR arrives

1. Read it: release notes, publish age and provenance.
   - Tools labelled `review-required` get their own PR.
   - The weekly "mise tools" digest covers the rest.
   - `ai-tooling` PRs open only when ticked on the Dependency Dashboard. Security PRs open at once.
2. Check its **Lock check**: Renovate's hosted bot runs on Linux and can bump a tool's version in `mise.lock` while
   leaving some platforms' download URLs and checksums on the old release (it did for aws, flyctl, powershell, snyk
   and uv on 2026-10-26), so mise would install the old files under the new name. If it's red, re-lock on the Mac
   (`mise lock --global <tool>…`, in a sandbox first) and commit that, or fold the PR into a consolidation that does.
   Several Renovate PRs at once: consolidate them into one branch, one sandbox install and one verify.
3. For an `npm:` tool, check the packages it pulls in: `steward sc tool-age npm:<package> <new version>`. mise gates the tool
   itself, not always its dependencies (renovate 44.181.0 brought five that were under 3 days old on 2026-10-26). It installs
   in a sandbox, lists each new package with its publish time, and exits 1 if any is under the gate. Wait until the
   youngest clears it, or record an advisory exception in the PR body.
4. Merge, then run `git pull && mise install && steward sc verify`.
5. For Node, run `steward sc node-patch <version>` instead, so the hybrids are reinstalled (with the Ruflo policy
   backup and receipts).

## A same-day Node security release

1. Confirm the release on nodejs.org (the `security: true` flag in `dist/index.json`) and read its advisory.
2. `DRY_RUN=1 steward sc node-patch <x.y.z>`, then `steward sc node-patch <x.y.z>`. It does the following:
   - checks the tarball against `SHASUMS256`;
   - installs it and proves the binary is byte-identical to the official build;
   - pins it exactly;
   - reinstalls the hybrids, writing receipts and backing up Ruflo's policy folders on a version change;
   - verifies and locks.
3. After 3 days, relax the pin to the major (`"26"`) and run `mise lock --global node`.

## A new advisory or incident report

1. Verify every claim against primary sources: the vendor advisory, GHSA, RustSec, OSV, NVD, CISA KEV and the
   registries. Social posts exaggerate.
2. Sweep local exposure read-only: `steward sc audit`, plus targeted `find`, `ps` or `docker` checks.
3. **A first patched release younger than 3 days:** add a `[[security_exception]]` to
   `supply-chain/host.toml` with the advisory and an expiry, and use `steward sc upgrade-tool` for mise tools.
4. **Indicators and bad certificates:** add `[[ioc]]` and `[[distrusted_root]]` entries, so later audits keep
   checking.
5. Record what happened, and what was verified, in `docs/`.

## A trust exception

mise's `trust_policy_excludes` takes exact versions only.

1. `steward sc trust-review <pkg@version>` gathers publisher, provenance and commit evidence.
2. Add the exclude only when that evidence holds. Put the reason and the review date in a comment beside it.

## A declared source is behind

`steward sc audit` lists each active `[[updater]]` (D52) under **Declared updaters**:

- **ACTION `<name>: behind (<class>: …)`:** `steward sc plan` shows it as `take`; `steward sc upgrade` applies it after
  your yes. It checks the key pin, copies the `backup` paths to
  `~/.local/state/workstation-steward/backups/updater-<name>-*` (an APFS clone on macOS), runs `apply`, and refuses
  unless the output says `require_output`. The receipt there holds what `check` printed before and after.
- **held `<name> (gated)`:** a declared source has no release date, so the plan never takes it. Read the tool's own
  release notes and run its updater yourself when it's past the gate.
- **ACTION `the signing key … hashes to …`:** the key the updater checks bundles with is not the one reviewed. Stop.
  Confirm the change from the publisher's own release notes or announcement, then update `pin.sha256` in a PR (the
  engine's `host-defaults.toml` for a shipped default, your `host.toml` for yours). If an apply brought the new key,
  the steward has already put the reviewed updater back.
- **ACTION `its own updater isn't off`:** the tool can take releases behind the steward's back. Set the file named
  in `self_update_off` back to its value.
- **info `its check couldn't tell`:** usually offline. Nothing is taken; run the audit again later.

If an apply fails, the receipt says why and how to go back: `steward sc rollback <receipt>`. For Brain, an old updater
can fail on a newer bundle; update the runtime first (it's gated), then try again.

## Adding an `[[updater]]`

1. Read the tool's updater. It qualifies for `signed_data` only if it's data, never code, and **all** of these hold:
   it checks a signature with a key built into the updater, the content is addressed by its hash, it checks the data
   against the installed runtime before it lands, and it refuses an older generation.
2. Write the entry in your `host.toml` (the example in `examples/supply-chain/host.toml` lists every field). `why`
   records what you reviewed: who signs it, how the updater checks it, and why the gate can't apply.
3. Find the text that `require_output` must match in the updater's own output for its normal source, so a fallback
   to a pinned or moving source is refused.
4. Pin the key: `pin.match` finds the key's text in the updater, and `pin.sha256` is the sha256 of that text.
5. `steward sc host` shows the entry, or why it was left out. `steward sc audit --only updaters` runs its `check`.
6. Commit it through a config-repo PR. `why`, `require_output` and `pin` change only that way.

## Soak and prune

1. Wait out the soak. `steward` shows it in a one-line banner, and `steward sc soak` lists the receipts behind it. It
   runs for `steward.toml` `[policy] soak_days` (default 3) after the newest mise upgrade, Node patch, hybrid
   install or launcher repin. During it, check once a day:
   - `steward ai drift --offline` shows no "pinned launchers" and no "launcher targets" DRIFT lines;
   - after restarting a Claude Code or Codex session in a project you use, its servers start (`/mcp`, or
     `codex mcp list`).

   Don't run `ruflo init`, `ruflo doctor --fix` or `aqe init` meanwhile: they rewrite launcher files. If one
   runs, run `steward ai repin` again.
2. `DRY_RUN=1 steward sc prune` lists what would go. While the soak runs, it says until when and checks the rest.
   `STEWARD_SKIP_SOAK=1 steward sc prune` prunes early, when there's a reason to (disk space, a broken version).
3. It refuses in two more cases:
   - any hybrid's receipt doesn't match `supply-chain/hybrids.toml` and the active Node. Run
     `steward sc install-hybrids` first.
   - a project's launcher config (`.mcp.json`, `.codex/config.toml`, `.claude/settings*.json`) points into an
     install it would remove. Repin those launchers to stable paths first; `steward ai drift` lists them.
4. `steward sc prune` asks before deleting. A full prune records itself, which clears the banner.
5. A full prune also lists the copies a declared updater's apply kept, once they're older than `soak_days`, and asks
   before removing them; their receipts stay. A `signed_data` apply doesn't start a soak.

## Change the release-age gate

1. `steward sc release-age` shows the value in `steward.toml` (the authority) and in mise's and Renovate's copies.
2. `DRY_RUN=1 steward sc release-age <days>`, then `steward sc release-age <days>`. It shows the plan, asks, backs up
   all three files to `~/.config/mise/backups/`, edits only the one line in each, and validates `steward.toml`.
3. Commit the three files together, through a PR.

## Rollback

- **mise:** `steward sc rollback` restores the newest `config.toml` and `mise.lock` backup from
  `~/.config/mise/backups/`, or a named one, and reshims. Then run `steward sc verify`.
- **mise itself:** `steward sc rollback mise` restores the binary from the newest
  `~/.local/state/workstation-steward/backups/mise-self-update-*` (copied beside it, then renamed into place: a signed
  binary written over in place gets killed by macOS). Then run `steward sc verify`.
- **A declared updater:** `steward sc rollback <receipt>` (the path its apply printed) puts its copies back; what's
  there now moves beside them in the receipt's folder, so nothing is lost. Then `steward sc audit --only updaters`.
- **Homebrew:** `brew upgrade` cleans up old kegs, so there's no keg rollback. Reinstall the previous bottle if
  needed.
- **Hybrids:** re-run `steward sc install-hybrids` from the restored config. For Ruflo state, restore the
  project's policy folder and `~/.config/ruflo` together from
  `~/.local/state/workstation-steward/backups/ruflo-policy-*`.
