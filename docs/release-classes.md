# Release classes: what may skip the release-age gate

> [!NOTE]
> **Design, not built (D52).** This page proposes the model for review. Nothing here exists in the engine yet.

The steward holds every new release for the release-age gate (`[policy] min_release_age_days`, 3 days by default) and
keeps old installs for the soak after a change. Two exceptions exist today, each a special case: `always_current`
(browsers, never held) and `security_exception` (one version, one advisory, an expiry). A third kind of update doesn't
fit either: **signed data that its publisher replaces daily**, such as a knowledge base or a signature database.
Brain's knowledge base is the first: a new corpus is published about once a day, its updater installs only the newest,
so a 3-day gate can never be met.

This page makes the exceptions one rule: every update source has exactly one **release class**, and the class says
whether it waits for the gate. Updates the steward doesn't install itself (a data bundle with its own updater) are
**declared** in your config, so the engine stays free of tool-specific commands.

## Two clocks, kept apart

| Clock | What it protects | Which classes |
| --- | --- | --- |
| **Release-age gate** | You don't take a release in its first days, when a bad or malicious publish is most often caught | `gated` waits; the other three may not |
| **Soak** | You can still roll back: old installs aren't pruned until a change has run for `soak_days` | every class: a skip of the gate never skips the backup, the receipt or the soak |

## The classes

| Class | Gate | What it needs | Today's equivalent |
| --- | --- | --- | --- |
| `gated` (the default) | waits | nothing | everything not listed below |
| `always_current` | none | a reason (security fixes ship in nearly every release) | `always_current = […]` in `host.toml` |
| `signed_data` | none | **all of:** signed by a key the updater pins, content-addressed, checked against the installed runtime before it lands, and backed up first. The runtime that reads the data stays `gated` | new |
| `exception` | none until it expires | an advisory (GHSA, RustSec or OSV) or a written reason, and an expiry date | `[[security_exception]]` |

`signed_data` is deliberately narrow. Code never qualifies, however it is signed: a signature proves who published it,
not that the release is good, and the gate is what catches a bad release. Data qualifies because the runtime that reads
it is gated, and because the updater refuses data that runtime can't read.

## Declaring an update source

A source the steward doesn't install itself goes in your `supply-chain/host.toml` as an `[[updater]]`. The steward runs
its commands; it doesn't know what the tool is.

```toml
[[updater]]
name = "brain-kb"
class = "signed_data"
why = "Brain's corpus: Ed25519-signed, content-addressed (corpus-sha256-<hash>), checked against the pinned runtime"
check = "node ~/.cache/ruvnet-brain/kb/forge-update.mjs --check"     # exit 0 = up to date, 10 = behind
apply = "node ~/.cache/ruvnet-brain/kb/forge-update.mjs --apply"
require_output = "source: live release asset"                        # refuse a fallback to a moving branch
backup = ["~/.cache/ruvnet-brain/kb"]                                # the steward copies it first (about 1.4 GB)
self_update_off = { file = "~/.cache/ruvnet-brain/.auto-update-pref", value = "no" }
```

- **`steward sc audit`** runs each `check` (read-only) and reports a source that's behind, with its class.
- **`steward sc plan`** lists what `upgrade` would run and why each is allowed: "signed_data: skips the gate".
- **`steward sc upgrade`** asks, runs `apply`, refuses unless `require_output` appears, and writes a receipt
  (the before and after identities, the class, the command's output).
- **`self_update_off`** is checked by the audit like any keep-off setting, so the tool's own updater can't take
  releases behind the steward's back.
- **`backup`** lists the paths the steward copies before `apply`. It can't be left to the updater: Brain's makes
  rollback copies for the length of one run and deletes them when it succeeds. `steward sc rollback <receipt>` puts
  the copy back. Copies older than the soak are removed by `steward sc prune`, so a daily source keeps a few, not
  dozens.

## Brain, as the first case

| Part | Class | How it updates |
| --- | --- | --- |
| `ruvnet-brain` CLI (`npm:ruvnet-brain` in mise) | `gated` | a mise pin, through Renovate (an `ai-tooling` PR when ticked) |
| Brain's runtime (plugin and hooks in `~/.cache/ruvnet-brain`) | `gated` | the pinned CLI's installer, for a `v…` release past the gate |
| Brain's knowledge base (`kb/`) | `signed_data` | the `[[updater]]` above, through `steward sc upgrade` |

## Compatibility

`always_current = […]` and `[[security_exception]]` keep working as they are: the engine reads them as the
`always_current` and `exception` classes. The `[[updater]]` table is new; an older engine ignores it (an unknown
table), so it can't skip a gate it doesn't know about.

## Open questions

1. **Does a `signed_data` update restart the soak?** It would, for any change today. A source updated daily would then
   keep the soak running for good, and the prune would never come. The proposal: it writes its receipt but doesn't
   restart the soak, because the soak protects installs that `prune` removes; the data has its own copies (above),
   pruned on the same `soak_days`.
2. **Where the evidence lives.** The steward can't check Brain's signature itself. `why` and `require_output` record
   what was reviewed, the way `trust_policy_excludes` does; a change to an `[[updater]]` is a config-repo PR.

## Rejected

- **Tool-specific commands** (a `steward ai brain-update`): each new data source would need engine code.
- **Gating the data anyway**: a daily source whose updater takes only the newest would never qualify.
- **A one-off exception per update**: daily approvals for the same, unchanged kind of risk.
