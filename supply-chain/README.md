# Supply chain

Everything installed on your Mac that isn't AI tooling or a project: the mise toolchain, the npm -g hybrids,
Homebrew, apps, the App Store, macOS, trust stores, Docker images and indicators of compromise. AI tooling
(Ruflo, AgentDB, AQE, Brain, RuVector) is installed through mise and the hybrids too. The AI area owns
those, so their upgrades follow its rules.

A normal week here: `steward sc audit` checks the whole machine against your policy and lists what needs you,
with the next step for each. After an upgrade, the old versions stay through the soak; when it ends, `steward sc prune`
shows what it would remove, asks, and removes it.

![steward sc audit: a row per check with what it found in columns, and three actions listed under what to do about each; steward sc plan previews the upgrade: a formula held, the declared updater brain-kb taken because signed_data skips the gate, and mise itself taken; three days later the soak is over, and steward sc prune removes two old versions after a yes](../docs/assets/steward-supply-chain.svg)

## Policy

| File | Governs |
| --- | --- |
| `../mise/config.toml`, `../mise/mise.lock` | mise tools: versions, `minimum_release_age = "3d"`, install-script allow-lists, trust exceptions |
| `../steward.toml` | `[policy] min_release_age_days`: the release-age gate for every area (default 3). `steward sc release-age <days>` sets it and mise's and Renovate's copies. |
| `host-defaults.toml` (engine) | The shared host policy every machine gets: `always_current` browsers, apps with a bundled Node (`vendored_node`), the Electron window, distrusted roots, IOC sets, and declared update sources (`[[updater]]`, active only where their tool is installed). A release brings the newest |
| `host.toml` (instance) | Yours, on top of the defaults: additions (your own `[[updater]]` too), a same-name entry replaces a default, `[off]` turns defaults off; dated security exceptions. An entry for some platforms only says `platforms = ["macos"]` (D43); on Linux, `families = ["debian"]` beside `platforms = ["linux"]` narrows it to those families (D63). `steward sc host` shows the merged result and each value's source |
| `hybrids.toml` | CLIs that need `npm install -g` into the active Node, with each one's reason, upstream issue and allowed install scripts |
| `verify.tsv` | Expected output for every CLI, used by `steward sc verify` |
| `vendor/` | `github-token-utilities-3.4.0.tgz` (not on the npm registry) |

**The rules:**

- **Node:** pinned to the major line (`"26"`), with `mise.lock` recording the exact version. Same-day
  security releases go in as an exact pin (`steward sc node-patch x.y.z`). Relax back to `"26"` once the release
  is 3 days old.
- **npm:** a mise tool. CLIs use mise's `npm:` backend (aube) with exact versions. aube runs install scripts
  only for packages listed in `allow_builds`.
- **Release age:** never prune on upgrade (`--no-prune`); old versions stay as rollback until `steward sc prune`,
  which waits out the soak (`steward.toml` `soak_days`, default 3) after every upgrade, Node patch, hybrid
  install or repin. A version younger than 3 days comes in only as the first patched release for an advisory
  (GHSA, RustSec or OSV), recorded with an expiry. Browsers are never held.
- **Trust exceptions** (`trust_policy_excludes`) take exact versions only, and only after `steward sc trust-review`.
- **Hybrids** install one per command with their reviewed allow-list, and each install writes a receipt.
  Ruflo's policy folders are backed up before any version change. `steward sc prune` refuses until the
  receipts match.

Procedures: [`../skills/supply-chain/runbook.md`](../skills/supply-chain/runbook.md). Claude skill:
[`../skills/supply-chain/`](../skills/supply-chain/README.md) (`supply-chain`).

## Commands

```sh
steward sc audit                              # read-only: Homebrew, apps, App Store, macOS, trust stores, Docker, IOCs
steward sc audit --verbose                    # the same, with the lines each check folds away on a terminal
steward sc verify                             # read-only: every CLI, native addons, npm doctor
steward sc plan                               # read-only: what `upgrade` would take, what's held and why, then Node
                                              # security releases, hybrids, vendored Node (it took over sc status)
steward upgrade                               # a Node security release or hybrids out of step first, then sc upgrade:
                                              # every plan, then one yes (D61)
steward sc upgrade                            # apply the plan (asks first); verify once at the end; exit 1 if a step failed
steward sc upgrade-tool npm:typescript        # one tool: newest version older than 3 days; verify; lock
steward sc upgrade-tool npm 12.3.0            # one tool, exact pin (e.g. a security fix)
steward sc upgrade-tool mise                  # mise itself: the release past the gate; backup, verify, receipt (D38)
steward sc rollback mise                      # put the previous mise binary back
steward sc node-patch 26.12.2                 # checksum-verified Node patch + hybrid reinstall + verify + lock
steward sc install-hybrids                    # reinstall the npm -g hybrids into the active Node (plans, asks)
steward sc retire-hybrid ruflo npm:ruflo@3.60.0   # move a hybrid to mise once upstream fixes the blocker
steward sc release-age                        # show the release-age gate in steward.toml, mise and Renovate
steward sc release-age 5                      # set it in all three (plan, asks, backs up)
steward sc tool-age npm:renovate 44.181.0 # age of every package a new npm: tool version pulls in (sandbox install)
steward sc trust-review pkg@1.2.3             # evidence check before adding a trust exception
steward sc soak                               # is a soak running (prune waits), and which receipts started it
steward sc prune                              # after the soak: remove versions no config needs, and updater copies older than the soak (asks first)
steward sc rollback                           # restore the newest config/lock backup
steward sc rollback <receipt>                 # put back what a declared updater's apply replaced
steward sc link                               # re-link ~/.config/mise to ../mise
```

Every mutating recipe backs up `config.toml` and `mise.lock` to `~/.config/mise/backups/` first. A mise update backs
up the binary to `~/.local/state/workstation-steward/backups/mise-self-update-*`.

## Package sources

Each package manager, and each kind of package it handles, is a *source* (`lib/providers/index.js`, D64): Homebrew
formulae and Homebrew casks today; apt, dnf and zypper next ([`../docs/platforms/parity.md`](../docs/platforms/parity.md)).
`steward sc audit` and `steward sc plan` show a section for each source that applies on this machine, and judge each
package in it the same way: taken once it is at least the release-age gate's days old, or when an unexpired
`security_exception` names that version; held otherwise. A source that isn't installed says so and is skipped. One
that needs root is listed with its exact `sudo` command for you to run; the steward never runs `sudo` itself (D-b).
mise is not a source: it applies the gate itself.

## What may skip the gate

Every update source has one **release class** (D52, [`release-classes.md`](../docs/release-classes.md)), and only
`gated` waits for the release-age gate. Every class still gets a backup before it changes anything, and a receipt.

| Class | Gate | For |
| --- | --- | --- |
| `gated` | waits | everything, by default |
| `always_current` | never held | browsers: nearly every release is a security release |
| `signed_data` | skips it; starts no soak | data, never code: signed by a key the entry pins, checked against the gated runtime that reads it. Brain's knowledge base, a new corpus about daily, is the first |
| `exception` | skips it until it expires | the first patched release for an advisory (`[[security_exception]]`), or a declared source with a written reason |

Sources the steward doesn't install itself are declared as `[[updater]]` entries: `steward sc audit` runs each
`check`, `steward sc plan` lists what `upgrade` would apply and why, and `steward sc upgrade` copies the `backup`
paths, runs `apply`, refuses unless `require_output` appears, stops if the signing key changed, and writes a receipt.
The schema is in [`examples/supply-chain/host.toml`](../examples/supply-chain/host.toml).

## When a Renovate PR arrives

1. Read the PR: release notes, age, provenance.
2. Merge it, then run `git pull && mise install && steward sc verify`. For Node, run `steward sc node-patch <version>`
   instead, because the hybrids have to be reinstalled.
3. If anything fails: `steward sc rollback`.

## Known exceptions

- **Hybrids (`hybrids.toml`):**
  - `agentdb` ([ruvnet/agentdb#34](https://github.com/ruvnet/agentdb/issues/34));
  - `ruflo` ([ruvnet/ruflo#4371](https://github.com/ruvnet/ruflo/issues/4371));
  - `github-token-utilities` (moves to mise after `mise self-update`).
- **`ruvector`:** exact `trust_policy_excludes` for `@ruvector/core@0.1.33` and the `ruvector-core-*@0.1.31`
  platform binaries ([ruvnet/RuVector#1250](https://github.com/ruvnet/RuVector/issues/1250)).
- **Standalone `agentdb`** has no `better-sqlite3` on Node 26, so it falls back to sql.js. ruflo's bundled
  agentdb is fine (ruflo pins `better-sqlite3 >= 12.8`; see ruvnet/ruflo#2219).
- **`dotnet` and android-sdk:** `dotnet` is on `core:dotnet`, and android-sdk is on
  `vfox:mise-plugins/vfox-android-sdk`. The old asdf/vfox plugins broke on mise 2026.8.2 and cmdline-tools 23.0.
